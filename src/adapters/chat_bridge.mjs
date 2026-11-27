import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { gatewayUrl } from "../providers/magpie_gateway.mjs";

const customParameters = {
  type: "object", properties: { input: { type: "string" } }, required: ["input"], additionalProperties: false,
};

/** 将 Responses 内容块转为 chat 文本和图片，保留角色。 */
function chatContent(content) {
  if (!Array.isArray(content)) return String(content ?? "");
  const parts = content.flatMap((part) => {
    if (typeof part?.text === "string") return [{ type: "text", text: part.text }];
    if (part?.type === "input_image" && part.image_url) {
      return [{ type: "image_url", image_url: { url: part.image_url, detail: part.detail ?? "auto" } }];
    }
    return [];
  });
  return parts.some((part) => part.type === "image_url") ? parts : parts.map((part) => part.text).join("\n");
}

/** 还原 assistant 的并行工具调用和 tool 回填，避免把执行输出误放入用户消息。 */
function chatRequest(body, model) {
  const messages = body.instructions ? [{ role: "system", content: body.instructions }] : [];
  for (const item of Array.isArray(body.input) ? body.input : [{ role: "user", content: body.input }]) {
    if (item.type === "function_call" || item.type === "custom_tool_call") {
      if (messages.at(-1)?.role !== "assistant") messages.push({ role: "assistant", content: null });
      const message = messages.at(-1);
      message.tool_calls ??= [];
      message.tool_calls.push({
        id: item.call_id, type: "function",
        function: { name: item.name, arguments: item.arguments ?? JSON.stringify({ input: item.input }) },
      });
    } else if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
      messages.push({
        role: "tool", tool_call_id: item.call_id,
        content: typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? ""),
      });
    } else if (item.role) {
      const role = item.role === "developer" ? "system" : item.role;
      messages.push({ role, content: chatContent(item.content) });
    }
  }
  const tools = (body.tools ?? []).filter((tool) => ["function", "custom"].includes(tool.type));
  const customTools = new Set(tools.filter((tool) => tool.type === "custom").map((tool) => tool.name));
  const request = { model, messages, stream: false };
  if (tools.length) {
    request.tools = tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name, description: tool.description ?? "",
        parameters: tool.type === "custom" ? customParameters : tool.parameters ?? { type: "object", properties: {} },
      },
    }));
  }
  if (body.reasoning?.effort && body.reasoning.effort !== "none") request.reasoning_effort = body.reasoning.effort;
  if (body.max_output_tokens) request.max_completion_tokens = body.max_output_tokens;
  const format = body.text?.format;
  if (format?.type === "json_schema") {
    const { type, ...json_schema } = format;
    request.response_format = { type, json_schema };
  }
  return { request, customTools };
}

/** 把聊天结果及工具调用转换为 Codex 消费的 Responses SSE。 */
function sendResponse(response, data, customTools, model) {
  const choice = data.choices?.[0];
  const message = choice?.message;
  if (!message) throw new Error("模型网关未返回 assistant 消息");
  const id = `resp_${randomUUID()}`;
  const header = { id, object: "response", created_at: Math.floor(Date.now() / 1000), model, error: null };
  const output = [];
  response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  let sequence = 0;
  const emit = (type, payload) => response.write(
    `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...payload })}\n\n`,
  );
  emit("response.created", { response: { ...header, status: "in_progress", output: [] } });
  if (message.content || message.refusal) {
    const text = message.content || message.refusal;
    const item = { id: `msg_${randomUUID()}`, type: "message", role: "assistant", status: "completed",
      content: [{ type: "output_text", text, annotations: [] }] };
    const output_index = output.push(item) - 1;
    emit("response.output_item.added", { output_index, item: { ...item, status: "in_progress", content: [] } });
    emit("response.content_part.added", { item_id: item.id, output_index, content_index: 0,
      part: { type: "output_text", text: "", annotations: [] } });
    emit("response.output_text.delta", { item_id: item.id, output_index, content_index: 0, delta: text });
    emit("response.output_text.done", { item_id: item.id, output_index, content_index: 0, text });
    emit("response.content_part.done", { item_id: item.id, output_index, content_index: 0, part: item.content[0] });
    emit("response.output_item.done", { output_index, item });
  }
  for (const call of message.tool_calls ?? []) {
    const args = call.function?.arguments ?? "{}";
    const name = call.function?.name;
    if (!name) continue;
    const item = { id: `item_${randomUUID()}`, call_id: call.id || `call_${randomUUID()}`, name, status: "completed" };
    if (customTools.has(name)) {
      let input = args;
      try {
        const parsed = JSON.parse(args);
        if (typeof parsed?.input === "string") input = parsed.input;
      } catch {
        // 部分兼容网关直接回传自定义工具文本。
      }
      Object.assign(item, { type: "custom_tool_call", input });
    } else {
      Object.assign(item, { type: "function_call", arguments: args });
    }
    const output_index = output.push(item) - 1;
    emit("response.output_item.added", { output_index, item: { ...item, status: "in_progress" } });
    emit("response.output_item.done", { output_index, item });
  }
  const usage = data.usage;
  const incomplete = ["length", "content_filter"].includes(choice.finish_reason);
  emit(incomplete ? "response.incomplete" : "response.completed", {
    response: {
      ...header, output, status: incomplete ? "incomplete" : "completed",
      incomplete_details: incomplete ? { reason: choice.finish_reason === "length" ? "max_output_tokens" : "content_filter" } : null,
      usage: usage ? {
        input_tokens: usage.prompt_tokens ?? 0,
        input_tokens_details: { cached_tokens: usage.prompt_tokens_details?.cached_tokens ?? 0 },
        output_tokens: usage.completion_tokens ?? 0,
        output_tokens_details: { reasoning_tokens: usage.completion_tokens_details?.reasoning_tokens ?? 0 },
        total_tokens: usage.total_tokens ?? (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0),
      } : null,
    },
  });
  response.end();
}

/** 每次运行建立专用环回桥，真实密钥留在父进程，取消时中断上游请求。 */
export async function startChatBridge(provider, model) {
  const upstream = gatewayUrl(provider.baseUrl, "chat/completions");
  const token = randomUUID();
  const lifetime = new AbortController();
  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/responses" || req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(404).end();
      return;
    }
    try {
      const body = [];
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 32 * 1024 * 1024) {
          res.writeHead(413).end();
          return;
        }
        body.push(chunk);
      }
      const { request, customTools } = chatRequest(JSON.parse(Buffer.concat(body).toString("utf8")), model);
      const controller = new AbortController();
      res.once("close", () => controller.abort());
      const upstreamResponse = await fetch(upstream, {
        method: "POST", redirect: "error",
        signal: AbortSignal.any([lifetime.signal, controller.signal, AbortSignal.timeout(240_000)]),
        headers: {
          "Content-Type": "application/json",
          ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}),
        },
        body: JSON.stringify(request),
      });
      if (!upstreamResponse.ok) {
        await upstreamResponse.body?.cancel();
        res.writeHead(upstreamResponse.status, { "Content-Type": "application/json" })
          .end(JSON.stringify({ error: { message: `Chat Completions HTTP ${upstreamResponse.status}` } }));
        return;
      }
      sendResponse(res, await upstreamResponse.json(), customTools, model);
    } catch {
      if (!res.headersSent) res.writeHead(502, { "Content-Type": "application/json" })
        .end(JSON.stringify({ error: { message: "Chat Completions 网关响应不可用" } }));
      else res.end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, token,
    close() {
      lifetime.abort();
      server.close();
      server.closeAllConnections();
    },
  };
}
