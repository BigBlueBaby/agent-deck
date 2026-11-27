import { App, applyDocumentTheme, applyHostStyleVariables } from "@modelcontextprotocol/ext-apps";

/** 提取工具的结构化数据，兼容宿主以文本转发的响应，并保留服务端错误。 */
export function toolData(result) {
  const content = result?.content?.find((block) => block.type === "text")?.text;
  if (result?.isError) throw new Error(result.structuredContent?.error || content || "operationFailed");
  if (result?.structuredContent) return result.structuredContent;
  if (content) {
    try {
      return JSON.parse(content);
    } catch {
      return null;
    }
  }
  return null;
}

/** 构造 MCP App 连接，先绑定首屏通知，再进行有时间上限的握手。 */
export function hostApp({ onResult, onInput, onContext }) {
  const app = new App({ name: "AgentDeck", version: "2.0.0" }, {}, { autoResize: false });
  app.ontoolresult = onResult;
  app.ontoolinput = ({ arguments: args }) => onInput(args);
  app.onhostcontextchanged = onContext;
  return app;
}

/** 只应用宿主提供的主题和样式变量。 */
export function hostTheme(context) {
  if (context?.theme) applyDocumentTheme(context.theme);
  if (context?.styles?.variables) applyHostStyleVariables(context.styles.variables);
}

/** 通过宿主调用 app-only 工具。写入超时交由用户核对，避免重复提交。 */
export async function callTool(app, name, args, timeout = 30_000) {
  const result = toolData(await app.callServerTool({ name, arguments: args }, { timeout }));
  if (!result || typeof result !== "object") throw new Error("operationFailed");
  return result;
}

/** 将仓库绝对路径和相对文件名转换为宿主可处理的本地文件链接。 */
export function workspaceFileUrl(repoPath, filePath) {
  const root = String(repoPath ?? "").replaceAll("\\", "/");
  const relative = String(filePath ?? "").replaceAll("\\", "/");
  const parts = relative.split("/");
  if (!relative || /^[\/]|^[a-z]:/i.test(relative) || parts.some((part) => !part || part === "." || part === "..")) return null;
  const suffix = parts.map(encodeURIComponent).join("/");
  if (/^[a-z]:\//i.test(root)) {
    const [drive, ...dirs] = root.split("/").filter(Boolean);
    return `file:///${[drive, ...dirs.map(encodeURIComponent), suffix].join("/")}`;
  }
  if (root.startsWith("//")) {
    const [host, ...dirs] = root.slice(2).split("/").filter(Boolean);
    if (!host || !/^[a-z0-9._-]+$/i.test(host) || !dirs.length) return null;
    return `file://${host}/${[...dirs.map(encodeURIComponent), suffix].join("/")}`;
  }
  if (root.startsWith("/")) return `file:///${[...root.split("/").filter(Boolean).map(encodeURIComponent), suffix].join("/")}`;
  return null;
}
