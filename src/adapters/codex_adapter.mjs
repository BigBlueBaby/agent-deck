import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { spawn, execFile, execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { BaseAdapter } from "./base_adapter.mjs";
import { startChatBridge } from "./chat_bridge.mjs";
import { detectCodexRuntime } from "../providers/codex_plus.mjs";
import { gatewayUrl } from "../providers/magpie_gateway.mjs";
import { buildGuardrailInstructions } from "../guardrails/presets.mjs";
import { createId, nowIso } from "../core/db.mjs";
import { captureBaseline, collectChangesAfterRun } from "../core/git_snapshot.mjs";
import { resolveRoutingDecision, normalizeProvider } from "../core/router.mjs";
import { normalizeUsage, readCodexThreadTelemetry, readLatestCodexQuota } from "../core/telemetry.mjs";

const providerEnv = "AGENT_DECK_PROVIDER_TOKEN";
const activeStatuses = new Set(["queued", "running"]);

/** 从已配置通道获取实际凭据，Magpie 的公开默认标记不作为秘密。 */
export function providerSecrets(config) {
  const magpieKey = config.providers?.magpie?.apiKey;
  const custom = Array.isArray(config.providers?.custom) ? config.providers.custom : [];
  return [magpieKey === "magpie" ? "" : magpieKey, ...custom.map((provider) => provider?.apiKey)]
    .filter((key) => typeof key === "string" && key && !key.includes("••••"))
    .sort((a, b) => b.length - a.length);
}

/** 在持久化和外发前清理密钥，包括 JSON 或 URL 编码后的文本。 */
export function redactProviderSecrets(value, secrets) {
  let text = String(value ?? "");
  for (const key of secrets) {
    const forms = new Set([key, JSON.stringify(key).slice(1, -1), new URLSearchParams({ key }).toString().slice(4)]);
    try {
      forms.add(encodeURIComponent(key));
    } catch {
      // 原始凭据仍可遮盖，孤立 Unicode 代理值没有 URI 编码。
    }
    for (const form of forms) if (form) text = text.replaceAll(form, "••••");
  }
  return text;
}

/** 生成兼容 Codex 模型目录格式的单选项配置，避免任意网关模型回退到官方模型。 */
function writeGatewayCatalog(runtime, task, provider) {
  const configured = provider.catalogPath || path.join(runtime.codexHome, "magpie-desktop-models.json");
  if (task.provider === "magpie" && fs.statSync(configured, { throwIfNoEntry: false })?.isFile()) {
    try {
      const catalog = JSON.parse(fs.readFileSync(configured, "utf8"));
      if (catalog.models?.some((item) => item.slug === task.model && item.shell_type && item.truncation_policy)) {
        return { catalogPath: path.resolve(configured), cleanup() {} };
      }
    } catch {
      // 发现目录不一定是 Codex 可直接消费的目录，缺少执行元数据时按选中项生成。
    }
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-deck-model-"));
  const catalogPath = path.join(dir, "models.json");
  const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
  const effort = task.reasoningEffort;
  try {
    fs.writeFileSync(catalogPath, JSON.stringify({ models: [{
      slug: task.model, display_name: task.model, description: "AgentDeck gateway model",
      default_reasoning_level: effort || null,
      supported_reasoning_levels: effort ? [{ effort, description: effort }] : [],
      shell_type: "shell_command", visibility: "list", supported_in_api: true, priority: 0,
      base_instructions: "You are a coding assistant. Follow the workspace instructions and task boundaries.",
      supports_reasoning_summaries: false, supports_reasoning_summary_parameter: false, support_verbosity: false,
      apply_patch_tool_type: "function", truncation_policy: { mode: "tokens", limit: 10_000 },
      experimental_supported_tools: [], input_modalities: ["text", "image"],
    }] }), { mode: 0o600 });
  } catch (error) {
    cleanup();
    throw error;
  }
  return { catalogPath, cleanup };
}

/** 编码 Codex 命令行覆盖配置，字符串使用 TOML 基本字符串表示。 */
function tomlString(value) {
  return JSON.stringify(String(value)).replace(/\\b/g, "\\u0008").replace(/\\f/g, "\\u000C")
    .replaceAll("\u007f", "\\u007F");
}

/** 构造子进程退出承诺，并在读取 stdout 完成后交给调用方。 */
function childOutcome(child) {
  return new Promise((resolve) => {
    let processError;
    child.once("error", (error) => { processError = error.code || "spawn_failed"; });
    child.once("close", (code, signal) => resolve({ code, signal, processError }));
  });
}

/** 只终止当前 worker 的已知进程树，避免 npm JS 入口留下原生 CLI。 */
function stopWorker(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    execFile("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, (error) => {
      if (error && child.exitCode === null && child.signalCode === null) child.kill();
    });
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
      setTimeout(() => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // worker 可能已在取消期间退出。
        }
      }, 3000).unref();
    } catch (error) {
      if (error.code !== "ESRCH") child.kill();
    }
  }
}

export class CodexAdapter extends BaseAdapter {
  constructor() {
    super("codex", "Codex CLI");
  }

  /** 探测与供应商界面共用的 Codex CLI 入口。 */
  detect(config) {
    return detectCodexRuntime(config);
  }

  /** 为首轮或续跑组装工单范围、验收条件与当前红线。 */
  buildPrompt(task, brief, isResume, guardrailsConfig) {
    return [
      isResume ? "【继续工单】" : "【协同工单】",
      `任务：${task.title}`,
      `级别：${task.tier} | 沙箱：${task.sandbox} | 轮次：${task.currentRound}/${task.maxRounds}`,
      task.sandbox === "read-only" ? "此任务只允许读取工作区。" : "保留工作区已有改动。",
      task.allowedPaths?.length ? `允许修改路径：\n${task.allowedPaths.map((item) => `- ${item}`).join("\n")}` : "",
      task.acceptanceCriteria ? `验收标准：\n${task.acceptanceCriteria}` : "",
      buildGuardrailInstructions(guardrailsConfig),
      `${isResume ? "反馈" : "任务说明"}：\n${brief}`,
    ].filter(Boolean).join("\n\n");
  }

  /** 将 Codex JSONL 转成公开事件；命令、工具输出、参数和推理明细不进入时间轴。 */
  parseEvent(evt) {
    if (evt?.type === "thread.started") return { type: evt.type, threadId: evt.thread_id, summary: "Codex 会话已启动" };
    if (evt?.type === "turn.started") return { type: evt.type, summary: "开始执行当前轮次" };
    if (evt?.type === "turn.completed") return { type: evt.type, usage: normalizeUsage(evt.usage), summary: "当前轮次执行结束" };
    if (evt?.type === "turn.failed" || evt?.type === "error") {
      return { type: evt.type, summary: evt.type === "turn.failed" ? "Codex 轮次失败" : "Codex 报告执行异常" };
    }
    if (!["item.started", "item.updated", "item.completed"].includes(evt?.type)) return null;
    const item = evt.item;
    const completed = evt.type === "item.completed";
    switch (item?.type) {
      case "command_execution":
        if (evt.type === "item.updated") return null;
        return { type: item.type, toolCall: completed, summary: completed
          ? `命令结束${Number.isInteger(item.exit_code) ? `（退出码 ${item.exit_code}）` : ""}` : "执行工作区命令" };
      case "file_change":
        if (!completed) return null;
        return { type: item.type, toolCall: true, files: (item.changes ?? []).map((change) => change.path),
          summary: `记录 ${item.changes?.length ?? 0} 项文件变更` };
      case "agent_message":
        return completed && typeof item.text === "string" ? { type: item.type, text: item.text, summary: "Codex 发来消息" } : null;
      case "collab_tool_call":
      case "custom_tool_call":
      case "mcp_tool_call":
      case "web_search":
        if (evt.type === "item.updated") return null;
        return { type: item.type, toolCall: completed, summary: `${item.type === "collab_tool_call" ? "协作工具" : "工具调用"}${completed ? "结束" : "开始"}` };
      case "reasoning":
        return completed ? { type: item.type, summary: "完成一段分析" } : null;
      default:
        return null;
    }
  }

  /** 运行一次 Codex exec。网关认证通过子进程环境或环回桥传递，避免将凭据写入命令行。 */
  async run(task, brief, isResume, callbacks = {}) {
    const config = callbacks.config ?? {};
    const runtime = await this.detect(config);
    if (!runtime.available) throw new Error("找不到可用的 Codex CLI，请在执行器设置中检查路径");
    if (callbacks.signal?.aborted) return { code: null, signal: "cancelled", turnFailed: false };
    const provider = callbacks.providerConfig ?? {};
    const prompt = this.buildPrompt(task, brief, isResume, config.guardrails);
    const args = ["exec", "--json", "--skip-git-repo-check", `--model=${task.model}`,
      "-c", `sandbox_mode=${tomlString(task.sandbox)}`, "-c", 'approval_policy="never"'];
    if (task.reasoningEffort) args.push("-c", `model_reasoning_effort=${tomlString(task.reasoningEffort)}`);
    const env = { ...process.env, CODEX_HOME: runtime.codexHome };
    let bridge;
    let catalog;
    try {
      // 1. 注入供应商与模型配置，实际用户密钥只交给请求认证。
      if (task.provider === "codex-plus") {
        args.push("-c", 'model_provider="openai"');
      } else {
        const key = provider.apiKey || (task.provider === "magpie" ? "magpie" : "");
        const providerId = task.provider === "magpie" ? "magpie" : "agent_deck_custom";
        const fields = [`name=${tomlString(providerId)}`, 'wire_api="responses"', "requires_openai_auth=false",
          "supports_websockets=false"];
        if (provider.wireApi === "chat_completions") {
          bridge = await startChatBridge({ ...provider, apiKey: key }, task.model);
          fields.push(`base_url=${tomlString(bridge.baseUrl)}`, `experimental_bearer_token=${tomlString(bridge.token)}`);
        } else {
          fields.push(`base_url=${tomlString(gatewayUrl(provider.baseUrl).href.replace(/\/$/, ""))}`);
          if (task.provider === "magpie" && key === "magpie") {
            fields.push('experimental_bearer_token="magpie"');
          } else if (key) {
            env[providerEnv] = key;
            fields.push(`env_key=${tomlString(providerEnv)}`);
            args.push("-c", `shell_environment_policy.exclude=[${tomlString(providerEnv)}]`);
          }
        }
        catalog = writeGatewayCatalog(runtime, task, provider);
        args.push("-c", `model_provider=${tomlString(providerId)}`,
          "-c", `model_providers.${providerId}={${fields.join(",")}}`,
          "-c", `model_catalog_json=${tomlString(catalog.catalogPath)}`);
      }
      if (callbacks.signal?.aborted) return { code: null, signal: "cancelled", turnFailed: false };
      if (isResume) {
        if (!/^[\da-z][\da-z_-]{0,159}$/i.test(task.codexThreadId)) throw new Error("Codex 会话 ID 格式无效");
        args.push("resume", task.codexThreadId);
      }
      args.push("-");
      // 2. 使用 argv 启动原生程序或 Node 入口，提示词写入后立即关闭 stdin。
      const child = spawn(runtime.isJsEntry ? process.execPath : runtime.executablePath,
        runtime.isJsEntry ? [runtime.executablePath, ...args] : args, {
          cwd: task.repoPath, env, windowsHide: true, detached: process.platform !== "win32",
          stdio: ["pipe", "pipe", "pipe"],
        });
      const done = childOutcome(child);
      const cancel = () => stopWorker(child);
      callbacks.signal?.addEventListener("abort", cancel, { once: true });
      child.stdin.on("error", () => {}); // 启动失败时按进程退出状态统一处理 EPIPE。
      child.stderr.resume(); // 原始诊断可能包含请求头或用户内容。
      const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
      let turnFailed = false;
      try {
        if (child.pid) callbacks.onSpawn?.(child.pid);
        child.stdin.end(prompt, "utf8");
        // 3. 只分发归一化事件；轮次异常和退出码共同决定结果。
        for await (const line of lines) {
          let evt;
          try {
            evt = JSON.parse(line);
          } catch {
            continue;
          }
          const event = this.parseEvent(evt);
          if (!event) continue;
          if (event.type === "turn.failed") turnFailed = true;
          callbacks.onEvent?.(event);
        }
        return { ...await done, turnFailed };
      } catch (error) {
        cancel();
        await done;
        throw error;
      } finally {
        callbacks.signal?.removeEventListener("abort", cancel);
        lines.close();
      }
    } finally {
      bridge?.close();
      catalog?.cleanup();
    }
  }
}

/** 校验仓库相对路径并拒绝符号链接，避免读取或回滚到仓库外。 */
export function safeWorkspacePath(root, relative) {
  const normalized = String(relative).replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (!normalized || /[:\x00-\x1f]/.test(normalized) ||
    segments.some((segment) => !segment || segment === "." || segment === ".." || segment.toLowerCase() === ".git" ||
      (process.platform === "win32" && /[. ]$/.test(segment)))) {
    throw new Error("文件路径必须是仓库内的相对路径");
  }
  let target = root;
  for (const segment of segments) {
    target = path.join(target, segment);
    if (fs.lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error("工单路径不允许穿过符号链接");
  }
  return target;
}

/** 计算当前文件内容指纹，供回滚前判断是否被人或后续任务修改。 */
export function workspaceFingerprint(root, relative) {
  const target = safeWorkspacePath(root, relative);
  const stat = fs.statSync(target, { throwIfNoEntry: false });
  if (!stat) return null;
  if (!stat.isFile()) throw new Error("回滚目标必须是普通文件");
  return createHash("sha256").update(fs.readFileSync(target)).digest("hex");
}

/** 读取未提交文件的准确名称，保留含空格、非 ASCII 字符和重命名条目。 */
function dirtyFiles(root) {
  const entries = execFileSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
    cwd: root, encoding: "utf8", windowsHide: true, maxBuffer: 8 * 1024 * 1024,
  }).split("\0");
  const paths = [];
  for (let index = 0; index < entries.length; index++) {
    const status = entries[index].slice(0, 2);
    if (!status) continue;
    paths.push(entries[index].slice(3));
    if (/[RC]/.test(status) && entries[index + 1]) paths.push(entries[++index]);
  }
  return paths;
}

/** 过滤不能经工作区快照机制安全处理的路径。 */
function safePaths(root, paths) {
  return paths.flatMap((item) => {
    try {
      safeWorkspacePath(root, item);
      return [item];
    } catch {
      return [];
    }
  });
}

/** 构造每轮独立基线，并包含既有脏文件，避免把用户原有改动误标为本轮新增。 */
function captureRunBaseline(task, db) {
  const info = captureBaseline(task.repoPath, [], { sandbox: "read-only" });
  if (task.sandbox === "read-only") return info;
  const dirty = info.isGit ? safePaths(task.repoPath, dirtyFiles(task.repoPath)) : [];
  const scope = task.allowedPaths.length ? [...new Set([...task.allowedPaths, ...dirty])] : [];
  return captureBaseline(task.repoPath, scope, {
    sandbox: task.sandbox, snapshotDir: path.join(db.getTaskSnapshotDir(task.id), String(task.currentRound)),
  });
}

/** 校验并规范化用户传入的仓库和路径范围。 */
function taskWorkspace(params) {
  const repoPath = fs.realpathSync(params.repoPath);
  if (!fs.statSync(repoPath).isDirectory()) throw new Error("工作目录必须为目录");
  const allowedPaths = [...new Set((params.allowedPaths ?? []).map((value) => String(value)
    .replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "")))];
  for (const relative of allowedPaths) safeWorkspacePath(repoPath, relative);
  if (params.sandbox && !["read-only", "workspace-write"].includes(params.sandbox)) throw new Error("沙箱模式不受支持");
  if (params.sandbox !== "read-only" && !allowedPaths.length) throw new Error("写任务需要指定允许修改的路径");
  return { repoPath, allowedPaths, sandbox: params.sandbox || "workspace-write" };
}

/** 在跨进程 SQLite 写锁下占用工单轮次或更新审计记录。 */
export function inDeckTransaction(db, action) {
  db.db.exec("BEGIN IMMEDIATE");
  try {
    const value = action();
    db.db.exec("COMMIT");
    return value;
  } catch (error) {
    db.db.exec("ROLLBACK");
    throw error;
  }
}

/** 写任务和文件回滚共用的工作区占用检查。 */
export function assertWorkspaceIdle(db, repoPath) {
  const conflict = db.db.prepare(
    "SELECT id FROM tasks WHERE repo_path = ? AND sandbox != 'read-only' AND status IN ('queued', 'running') LIMIT 1",
  ).get(repoPath);
  if (conflict) throw new Error("该工作区仍有写任务在执行");
}

const preference = { none: "high", minimal: "high", low: "high", medium: "high", high: "xhigh" };

export class DeckRunner {
  constructor({ db, getConfig, getPolicy, adapter = new CodexAdapter() }) {
    this.db = db;
    this.getConfig = getConfig;
    this.getPolicy = getPolicy;
    this.adapter = adapter;
    this.running = new Map();
  }

  /** 创建协同工单，写入首轮输入及路由，然后异步执行 worker。 */
  async dispatchNewTask(params) {
    const workspace = taskWorkspace(params);
    const config = this.getConfig();
    const policy = await this.getPolicy(config);
    const quota = readLatestCodexQuota(config);
    const routing = resolveRoutingDecision(params, { config, policy, quota });
    const secrets = providerSecrets(config);
    const clean = (value) => redactProviderSecrets(value, secrets);
    const task = inDeckTransaction(this.db, () => {
      if (workspace.sandbox !== "read-only") assertWorkspaceIdle(this.db, workspace.repoPath);
      const created = this.db.createTask({ ...params, ...workspace, ...routing, id: createId("task"),
        title: clean(params.title), acceptanceCriteria: clean(params.acceptanceCriteria) });
      this.db.updateTask(created.id, { pid: process.pid });
      this.db.addMessage({ taskId: created.id, round: 1, sender: "orchestrator", kind: "brief", content: clean(params.brief),
        meta: params.antigravityTaskId ? { antigravityTaskId: clean(params.antigravityTaskId) } : {} });
      return this.db.getTask(created.id);
    });
    this.start(task, clean(params.brief), false, config, routing.providerConfig, quota);
    return task;
  }

  /** 在同一线程和模型上返工，超出轮次前暂停并等待 UI 人工确认。 */
  async sendFeedbackAndResume(taskId, feedback, forceHumanOverride = false) {
    const config = this.getConfig();
    const quota = readLatestCodexQuota(config);
    const policy = await this.getPolicy(config);
    const secrets = providerSecrets(config);
    const content = redactProviderSecrets(feedback, secrets);
    const result = inDeckTransaction(this.db, () => {
      const previous = this.db.getTask(taskId);
      if (!previous) throw new Error("工单不存在");
      if (activeStatuses.has(previous.status)) throw new Error("当前轮次仍在执行");
      if (previous.status === "done" || this.db.getTaskBaseline(taskId).closed || !previous.codexThreadId) {
        throw new Error("该工单没有可继续的 Codex 会话");
      }
      if (!forceHumanOverride && previous.currentRound >= previous.maxRounds) {
        if (previous.status !== "need_human") {
          this.db.updateTask(taskId, { status: "need_human" });
          this.db.addEvent(taskId, previous.currentRound, "warning", "已达到预设轮次，需要人工确认后继续");
        }
        return { task: this.db.getTask(taskId) };
      }
      const provider = normalizeProvider(previous.provider) || (previous.profile === "magpie-fast" ? "magpie" : "codex-plus");
      if (!previous.model) throw new Error("历史工单缺少执行模型，无法同模型续跑");
      const desired = preference[previous.reasoningEffort] ?? previous.reasoningEffort;
      const entry = policy.eligibleModels?.find((item) => item.provider === provider && item.model === previous.model);
      const declared = provider === "codex-plus" || provider === "magpie" ? entry?.efforts : null;
      const effort = desired && declared?.length && !declared.includes(desired)
        ? previous.reasoningEffort || declared[0] : desired;
      const routing = resolveRoutingDecision({ ...previous, provider, reasoningEffort: effort }, { config, quota, policy });
      if (previous.sandbox !== "read-only") assertWorkspaceIdle(this.db, previous.repoPath);
      const round = previous.currentRound + 1;
      const task = this.db.updateTask(taskId, {
        ...routing, status: "queued", currentRound: round, pid: process.pid, lastError: "", finishedAt: "",
      });
      this.db.addMessage({ taskId, round, sender: forceHumanOverride ? "human" : "orchestrator", kind: "feedback", content });
      return { task, routing };
    });
    if (result.routing) this.start(result.task, content, true, config, result.routing.providerConfig, quota);
    return result.task;
  }

  /** 发出取消信号，等进程退出并归档本轮变更后再标记 cancelled。 */
  cancelTask(taskId) {
    const task = this.db.getTask(taskId);
    if (!task) throw new Error("工单不存在");
    if (!activeStatuses.has(task.status)) return task;
    const run = this.running.get(taskId);
    if (!run) throw new Error("执行进程属于另一 AgentDeck 实例");
    run.controller.abort();
    return { ...task, cancellationRequested: true };
  }

  /** 等待指定进程注销并完成当前轮次的日志入库。 */
  async waitForTask(taskId) {
    await this.running.get(taskId)?.done;
  }

  /** 注册可取消的本轮运行，异步故障写入工单状态而不污染 stdio 协议。 */
  start(task, brief, isResume, config, providerConfig, quota) {
    const controller = new AbortController();
    const run = { controller };
    this.running.set(task.id, run);
    run.done = this.execute(task, brief, isResume, config, providerConfig, quota, controller.signal)
      .catch((error) => {
        const reason = redactProviderSecrets(error.message || "执行器异常", providerSecrets(config)).slice(0, 400);
        this.db.updateTask(task.id, { status: "failed", pid: null, lastError: reason, finishedAt: nowIso() });
        this.db.addEvent(task.id, task.currentRound, "error", reason);
      }).finally(() => this.running.delete(task.id));
    void run.done.catch(() => process.stderr.write("AgentDeck 无法保存执行结果\n"));
  }

  /** 保存一轮的变更、用量与结论。磁盘收集失败时明确标记失败，保留回滚基线。 */
  async execute(task, brief, isResume, config, providerConfig, quota, signal) {
    const { id, currentRound: round } = task;
    const started = Date.now();
    const secrets = providerSecrets(config);
    const clean = (value) => redactProviderSecrets(value, secrets);
    const hints = new Set();
    const usage = normalizeUsage();
    const baseline = captureRunBaseline(task, this.db);
    const previousBaseline = this.db.getTaskBaseline(id);
    this.db.updateTask(id, { baseline: { ...baseline, afterHashes: previousBaseline.afterHashes }, status: "running" });
    this.db.addEvent(id, round, "running", `开始第 ${round} 轮 · ${clean(task.model)}`);
    let threadId = task.codexThreadId;
    let summary = "";
    let turnsCount = 0;
    let toolCallsCount = 0;
    let outcome;
    let failure = "";
    try {
      outcome = await this.adapter.run(task, brief, isResume, {
        config, providerConfig, signal,
        onSpawn: (pid) => this.db.updateTask(id, { pid }),
        onEvent: (event) => {
          if (event.threadId) {
            threadId = event.threadId;
            this.db.updateTask(id, { codexThreadId: threadId });
          }
          for (const file of event.files ?? []) if (typeof file === "string") {
            hints.add(path.isAbsolute(file) ? path.relative(task.repoPath, file).replaceAll("\\", "/") : file.replaceAll("\\", "/"));
          }
          if (event.toolCall) toolCallsCount++;
          if (event.usage) {
            turnsCount++;
            for (const field of Object.keys(usage)) usage[field] += event.usage[field] ?? 0;
          }
          if (event.text) {
            summary = clean(event.text).slice(0, 48_000);
            this.db.addMessage({ taskId: id, round, sender: "worker", kind: "message", content: summary });
          }
          this.db.addEvent(id, round, event.type, clean(event.summary));
        },
      });
    } catch (error) {
      failure = clean(error.message || "执行器异常");
    }
    if (!failure && !signal.aborted && (outcome?.code !== 0 || outcome?.turnFailed || !turnsCount)) {
      failure = outcome?.processError ? `Codex 启动失败（${outcome.processError}）`
        : outcome?.turnFailed ? "Codex 报告轮次失败"
          : outcome?.code === 0 ? "Codex 退出前未报告轮次完成"
            : `Codex 提前退出（${outcome?.code ?? outcome?.signal ?? "未知状态"}）`;
    }
    let changes = [];
    if (!baseline.readOnly) {
      const dirty = baseline.isGit ? dirtyFiles(task.repoPath) : [];
      changes = collectChangesAfterRun(task.repoPath, { ...baseline, isGit: false }, task.allowedPaths,
        safePaths(task.repoPath, [...dirty, ...hints]), config.guardrails);
      changes = changes.filter((change) => safePaths(task.repoPath, [change.filePath]).length > 0).map((change) => {
        if (change.outOfScope || !task.allowedPaths.length || process.platform === "win32" ||
          task.allowedPaths.some((item) => change.filePath === item || change.filePath.startsWith(`${item}/`))) return change;
        return { ...change, outOfScope: true, warnings: [...change.warnings, `超出允许路径范围：${change.filePath}`] };
      });
    }
    const hashes = Object.fromEntries(changes.map((change) => [change.filePath, workspaceFingerprint(task.repoPath, change.filePath)]));
    const telemetry = readCodexThreadTelemetry(threadId, config, { fresh: !isResume });
    const codexPlus = task.provider === "codex-plus";
    const quotaDelta = (key) => {
      const after = telemetry?.quota?.[key];
      const before = quota?.[key];
      return codexPlus && before?.resetsAt && after?.resetsAt === before.resetsAt
        ? Math.max(0, after.usedPercent - before.usedPercent) : null;
    };
    const status = signal.aborted ? "cancelled" : failure ? "failed" : "reviewing";
    inDeckTransaction(this.db, () => {
      this.db.saveFileChanges(id, round, changes.map((change) => ({
        ...change, diffText: clean(change.diffText), warnings: change.warnings.map(clean),
      })));
      this.db.addUsage({
        taskId: id, round, engine: task.provider, profile: task.profile, model: task.model, reasoningEffort: task.reasoningEffort,
        ...usage, turnsCount, toolCallsCount, durationMs: Date.now() - started,
        primaryQuotaDelta: quotaDelta("primary"), secondaryQuotaDelta: quotaDelta("secondary"),
        primaryQuotaAfter: codexPlus ? telemetry?.primaryAfter ?? null : null,
        secondaryQuotaAfter: codexPlus ? telemetry?.secondaryAfter ?? null : null,
      });
      this.db.updateTask(id, { status, pid: null, lastSummary: summary, lastError: failure.slice(0, 800),
        finishedAt: nowIso(), baseline: { ...baseline, afterHashes: { ...previousBaseline.afterHashes, [round]: hashes } } });
      this.db.addEvent(id, round, status, status === "reviewing" ? "执行结束，等待验收" : failure || "工单已取消");
    });
  }
}
