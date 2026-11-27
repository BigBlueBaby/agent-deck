import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import {
  DeckRunner, assertWorkspaceIdle, inDeckTransaction, providerSecrets, redactProviderSecrets, safeWorkspacePath, workspaceFingerprint,
} from "./adapters/codex_adapter.mjs";
import { loadConfig, saveConfig, sanitizeConfigForClient } from "./core/config_store.mjs";
import { DeckDb, nowIso } from "./core/db.mjs";
import { revertSingleFileChange } from "./core/git_snapshot.mjs";
import { resolveModelPolicy, syncModelPolicy, triggerBackgroundPolicyRefreshIfStale } from "./core/model_policy.mjs";
import { getLatestCodexQuota, readAntigravityTaskTelemetry, readAntigravityWindowStats, readCodexThreadTelemetry } from "./core/telemetry.mjs";
import { listGuardrailPresets } from "./guardrails/presets.mjs";
import { resolveCodexHome } from "./providers/codex_plus.mjs";
import { detectAllProviders, testOpenAICompatProvider } from "./providers/openai_compat.mjs";
import { discoverMagpieModels } from "./providers/magpie_gateway.mjs";

export const APP_URI = "ui://agent-deck/app.html";
const FRAME_BYTES = 200_000;
const HTML_RESOURCE_MAX_BYTES = 2 * 1024 * 1024; // 官方 MCP App 资源上限为 10 MiB，这里设为 2 MiB 安全预算
const APP_ROOT = fileURLToPath(new URL("../", import.meta.url));
const entrypoints = [{ type: "aux_pane", title: "AgentDeck" }, { type: "global", title: "AgentDeck" }];
const mode = z.enum(["burst", "balanced", "free_only"]);
const id = z.string().min(1).max(160);
const taskSelection = { taskId: id.optional(), followLatest: z.boolean().optional(), refreshQuota: z.boolean().optional() };
const providerInput = z.object({
  id: id.optional(), name: z.string().max(200).optional(), baseUrl: z.string().max(2048).optional(),
  apiKey: z.string().max(4096).optional(), wireApi: z.enum(["responses", "chat_completions"]).optional(),
  models: z.array(z.string().min(1).max(200)).max(500).optional(), defaultEffort: z.string().max(20).optional(),
  isFree: z.boolean().optional(), enabled: z.boolean().optional(), hasApiKey: z.boolean().optional(),
}).strict();
const slotOverride = z.union([z.string().max(350), z.object({
  provider: id.optional(), model: id, reasoningEffort: z.string().max(20).optional(), effort: z.string().max(20).optional(),
}).strict()]);
const runtimePatch = z.object({
  enabled: z.boolean().optional(), executablePath: z.string().max(4096).optional(), codexHome: z.string().max(4096).optional(),
}).strict();
const configPatch = z.object({
  ui: z.object({
    locale: z.enum(["zh-CN", "en"]).optional(), sidebarWidth: z.number().finite().optional(),
    sidebarCollapsed: z.boolean().optional(), quotaDisplayMode: z.enum(["remaining", "used"]).optional(),
    pollRunningMs: z.number().int().positive().optional(), pollIdleMs: z.number().int().positive().optional(),
  }).strict().optional(),
  routing: z.object({
    quotaMode: mode.optional(), parallaxUrl: z.string().url().max(2048).optional(),
    parallaxSyncTtlHours: z.number().finite().nonnegative().optional(),
    slotOverrides: z.object({
      plusPrimary: slotOverride.optional(), plusBoost: slotOverride.optional(), plusEco: slotOverride.optional(),
      plusFlagship: slotOverride.optional(), freeFast: slotOverride.optional(),
    }).strict().optional(),
  }).strict().optional(),
  runtimes: z.object({ codex: runtimePatch.optional(), claude: runtimePatch.optional() }).strict().optional(),
  providers: z.object({
    codexPlus: z.object({ enabled: z.boolean().optional() }).strict().optional(),
    magpie: z.object({
      enabled: z.boolean().optional(), baseUrl: z.string().max(2048).optional(), apiKey: z.string().max(4096).optional(),
      selectedModels: z.array(z.string().min(1).max(200)).max(500).optional(),
      freeOwners: z.array(z.string().min(1).max(200)).max(100).optional(), catalogPath: z.string().max(4096).optional(),
    }).strict().optional(),
    custom: z.array(providerInput).max(50).optional(),
  }).strict().optional(),
  guardrails: z.object({
    activePreset: z.enum(["generic", "no-build", "strict-review"]).optional(),
    customRules: z.array(z.string().max(2000)).max(40).optional(), disableNestedSubagents: z.boolean().optional(),
  }).strict().optional(),
}).strict();

/** 成帧前递归删除私有字段并遮盖携带真实凭据的字符串，包括字典键。 */
function publicData(value, secrets) {
  if (typeof value === "string") return redactProviderSecrets(value, secrets);
  if (Array.isArray(value)) return value.map((item) => publicData(item, secrets));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => {
    if (/^(?:baseline_?json|baseline|providerConfig|pre_?content_?b64|pre_?snapshot_?file)$/i.test(key)) return [];
    const name = redactProviderSecrets(key, secrets);
    if (/^api_?key$/i.test(key)) return [[name, item ? "••••" : ""]];
    return [[name, publicData(item, secrets)]];
  }));
}

const FRAME_TOOL_ERROR = {
  isError: true, content: [{ type: "text", text: "返回超过 200 KB，请缩小查询范围。" }],
};

/** 按实际 UTF-8 JSON 字节数保护 MCP 帧，固定超限响应也受同一预算约束。 */
export function enforceFrameBudget(result, overflow = FRAME_TOOL_ERROR) {
  const fits = (value) => Buffer.byteLength(JSON.stringify({ jsonrpc: "2.0", id: Number.MAX_SAFE_INTEGER, result: value })) < FRAME_BYTES;
  return fits(result) ? result : fits(overflow) ? overflow : FRAME_TOOL_ERROR;
}

/** 为模型提供文本、为 UI 提供结构化对象；opensApp 入口同时提供简短文本与完整首屏快照。 */
function makeToolResult(value, appOnly, isError = false, opensApp = false) {
  if (isError) {
    return { isError: true, content: [{ type: "text", text: value.error || "AgentDeck 操作失败" }], ...(appOnly || opensApp ? { structuredContent: value } : {}) };
  }
  if (appOnly) {
    return { content: [], structuredContent: value };
  }
  if (opensApp) {
    const taskCount = Array.isArray(value?.tasks) ? value.tasks.length : 0;
    const running = Array.isArray(value?.tasks) ? value.tasks.filter((t) => t.status === "running").length : 0;
    const summary = value?.selectedTask
      ? `已打开 AgentDeck 看板（共 ${taskCount} 条工单，运行中 ${running} 条；当前：${value.selectedTask.title} [${value.selectedTask.status}]）。`
      : "已打开 AgentDeck 看板（暂无历史工单，可在「执行器与设置」一键体检本机环境）。";
    return { content: [{ type: "text", text: summary }], structuredContent: value };
  }
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

/** 长文本和列表按显示场景逐级缩小，优先保留当前任务与最新记录。 */
function fitToolResult(value, appOnly, isError = false, opensApp = false) {
  const overflow = makeToolResult({ error: "返回超过 200 KB，请缩小查询范围。", truncated: true }, appOnly, true, opensApp);
  const render = () => enforceFrameBudget(makeToolResult(value, appOnly, isError, opensApp), overflow);
  let frame = render();
  if (frame !== overflow || isError) return frame;
  value.truncated = true;
  if (typeof value.diffText === "string") value.diffText = value.diffText.slice(0, 35_000);
  for (const change of value.fileChanges ?? []) {
    if (typeof change.diffText === "string") change.diffText = change.diffText.slice(0, 1800);
  }
  value.messages = value.messages?.slice(-20).map((message) => ({ ...message, content: message.content?.slice(0, 900) }));
  if (value.tasks) value.tasks = value.tasks.slice(0, 12);
  if (value.usage?.byModelEffort) value.usage.byModelEffort = value.usage.byModelEffort.slice(0, 30);
  if (value.modelPolicy?.eligibleModels) value.modelPolicy.eligibleModels = value.modelPolicy.eligibleModels.slice(0, 40);
  frame = render();
  if (frame !== overflow) return frame;
  if (value.fileChanges) value.fileChanges = value.fileChanges.slice(0, 20);
  if (value.environmentStatus) {
    value.tasks = [];
    value.messages = [];
    value.events = [];
    value.fileChanges = [];
    delete value.config;
    delete value.usage;
    delete value.modelPolicy;
  }
  return render();
}

/** 公开工单列表只保存短摘要，完整结果由详情工具按任务查询。 */
function taskCard(task) {
  return { ...task, lastSummary: task.lastSummary.slice(0, 400), acceptanceCriteria: task.acceptanceCriteria.slice(0, 400) };
}

/** 排除原始 diff 和回滚存档，详情由独立工具按文件读取。 */
function fileDiff(change) {
  return {
    id: change.id, taskId: change.taskId, round: change.round, filePath: change.filePath,
    diffText: change.diffText, addedLines: change.addedLines, removedLines: change.removedLines,
    changeType: change.changeType, warnings: change.warnings, outOfScope: change.outOfScope, reverted: change.reverted,
  };
}

/** 大模型目录按组分页，保留总数与续页游标供 UI 分批读取。 */
function pageEnvironment(status, cursor = 0) {
  const models = status.magpie.groups.flatMap((group) => group.models.map((model) => ({ group, model })));
  const groups = new Map();
  let bytes = 0;
  let next = cursor;
  for (const { group, model } of models.slice(cursor)) {
    const modelBytes = Buffer.byteLength(JSON.stringify(model)) + Buffer.byteLength(group.owner) + 96;
    if (bytes + modelBytes > 105_000 && next > cursor) break;
    const entry = groups.get(group.owner) ?? { owner: group.owner, isFreeOwner: group.isFreeOwner, models: [] };
    entry.models.push(model);
    groups.set(group.owner, entry);
    bytes += modelBytes;
    next++;
  }
  return { ...status, magpie: { ...status.magpie, groups: [...groups.values()], nextCursor: next < models.length ? next : null } };
}

/** 读取构建产物；前端构建完成后会自动读取现有文件，无需改动插件注册。 */
function readAppHtml() {
  const placeholder = '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>AgentDeck</title><body><main><h1>AgentDeck</h1><p>界面构建产物尚未安装，请运行 npm run build:ui。</p></main></body></html>';
  const candidate = path.join(APP_ROOT, "dist", "workbench.html");
  const stat = fs.statSync(candidate, { throwIfNoEntry: false });
  if (!stat?.isFile()) return placeholder;
  if (stat.size >= HTML_RESOURCE_MAX_BYTES) return '<!doctype html><meta charset="utf-8"><title>AgentDeck</title><p>界面资源超过 2 MiB 安全上限。</p>';
  return fs.readFileSync(candidate, "utf8");
}

/** 创建可通过 stdio 或外部 Transport 连接的 AgentDeck MCP 服务。 */
export function createDeckServer({ dataDir }) {
  const db = new DeckDb(dataDir);
  const getConfig = () => loadConfig(dataDir) ?? loadConfig();
  let discovery;
  // 1. 路由采用当前勾选配置，探测结果按网关配置和短时有效期复用。
  const discoveredMagpie = (config, force = false) => {
    const magpie = config.providers?.magpie;
    const key = JSON.stringify([magpie, resolveCodexHome(config)]);
    if (!force && discovery?.key === key && Date.now() < discovery.expiresAt) return discovery.promise;
    const promise = discoverMagpieModels(magpie, resolveCodexHome(config));
    discovery = { key, expiresAt: Date.now() + 30_000, promise };
    return promise;
  };
  let environment;
  const environmentKey = (config) => JSON.stringify([config.runtimes, config.providers]);
  const cachedEnvironment = (config) => environment?.key === environmentKey(config) && Date.now() < environment.expiresAt
    ? environment.promise : null;
  const getPolicy = async (config) => {
    const magpie = config.providers?.magpie;
    const status = await cachedEnvironment(config);
    const latest = status?.magpie ?? (magpie?.enabled && magpie.selectedModels?.length ? await discoveredMagpie(config) : null);
    return resolveModelPolicy(dataDir, config, latest && (latest.reachable || latest.totalModels) ? latest : undefined, status?.custom);
  };
  const runner = new DeckRunner({ db, getConfig, getPolicy });
  const server = new McpServer({ name: "agent-deck", version: "2.0.0" });
  const appMeta = { resourceUri: APP_URI, visibility: ["app"] };
  const knownSecrets = new Set();

  /** 给所有工具接入同一脱敏、错误和帧体积处理。 */
  function register(name, description, inputSchema, handler, { appOnly = false, opensApp = false, readOnly = false } = {}) {
    const tool = { title: opensApp ? "AgentDeck" : undefined, description, inputSchema, annotations: { readOnlyHint: readOnly },
      _meta: appOnly ? { ui: appMeta } : opensApp ? { ui: { resourceUri: APP_URI },
        "com.google.antigravity/ui": { entrypoints } } : undefined };
    const callback = async (input) => {
      const submitted = typeof input?.provider === "object" ? input.provider.apiKey : undefined;
      const patchKeys = providerSecrets(input?.patch ?? {});
      const current = getConfig();
      for (const key of [...providerSecrets(current), ...patchKeys, submitted]) {
        if (typeof key === "string" && key && !key.includes("••••")) knownSecrets.add(key);
      }
      const secrets = [...knownSecrets].sort((a, b) => b.length - a.length);
      try {
        return fitToolResult(publicData(await handler(input ?? {}), secrets), appOnly, false, opensApp);
      } catch (error) {
        return fitToolResult({ error: redactProviderSecrets(error.message || "AgentDeck 操作失败", secrets).slice(0, 1200) }, appOnly, true, opensApp);
      }
    };
    if (appOnly || opensApp) registerAppTool(server, name, tool, callback);
    else server.registerTool(name, tool, callback);
  }

  /** 获取指定工单，缺失时返回明确的可读错误。 */
  function requireTask(taskId) {
    const task = db.getTask(taskId);
    if (!task) throw new Error("工单不存在");
    return task;
  }

  /** 构建看板数据，followLatest 优先聚焦运行中 → 待验收 → 最新工单；refreshQuota=true 强制执行实时配额查询。 */
  async function snapshot({ taskId, followLatest, refreshQuota } = {}) {
    const config = getConfig();
    const tasks = db.listTasks(30);
    const autoPick =
      tasks.find((t) => t.status === "running") ||
      tasks.find((t) => t.status === "reviewing") ||
      tasks[0] ||
      null;
    const selected = followLatest ? autoPick : taskId ? requireTask(taskId) : autoPick;
    const [status, liveCodexQuota] = await Promise.all([
      cachedEnvironment(config),
      getLatestCodexQuota(config, { forceLive: Boolean(refreshQuota) }),
    ]);
    const policy = resolveModelPolicy(dataDir, config, status?.magpie, status?.custom);
    const messages = selected ? db.listMessages(selected.id) : [];
    const antigravityTaskId = messages.find((message) => message.kind === "brief")?.meta?.antigravityTaskId;
    return {
      generatedAt: nowIso(),
      selectedTaskId: selected?.id ?? "",
      tasks: tasks.map(taskCard), selectedTask: selected ?? null,
      selectedTaskMetrics: selected ? {
        codex: readCodexThreadTelemetry(selected.codexThreadId, config),
        antigravity: readAntigravityTaskTelemetry(antigravityTaskId || selected.id),
        usage: db.listUsageByTask(selected.id),
      } : null,
      quotaOverview: { codex: liveCodexQuota, antigravity: readAntigravityWindowStats() },
      modelPolicy: policy, config: sanitizeConfigForClient(config), guardrailPresets: listGuardrailPresets(),
      messages,
      events: selected ? db.listRecentEvents(selected.id, 60) : [],
      fileChanges: selected ? db.listFileChanges(selected.id) : [],
      usage: db.getUsageSummary(),
    };
  }

  /** 返回显式请求的文件记录，回滚存档只供服务器内部消费。 */
  function requireChange(changeId) {
    const change = db.getFileChangeById(changeId);
    if (!change) throw new Error("文件变更不存在");
    return change;
  }

  // 2. 模型协同入口只提供工单操作，界面管理入口使用 app 可见性。
  register("deck_open", "打开 AgentDeck 看板", { taskId: taskSelection.taskId }, ({ taskId }) => snapshot({ taskId, followLatest: !taskId }), { opensApp: true, readOnly: true });
  register("deck_dispatch", "派发协同工单，异步交给 Codex 执行器", {
    title: z.string().min(1).max(300), repoPath: z.string().min(1).max(4096), brief: z.string().min(1).max(90_000),
    acceptanceCriteria: z.string().max(12_000).optional(), allowedPaths: z.array(z.string().min(1).max(4096)).max(200).optional(),
    sandbox: z.enum(["read-only", "workspace-write"]).optional(), tier: z.enum(["L1", "L2", "L3"]).optional(),
    taskKind: z.enum(["implement", "review", "debug", "mechanical"]).optional(),
    provider: id.optional(), profile: id.optional(), model: z.string().min(1).max(300).optional(),
    reasoningEffort: z.string().min(1).max(20).optional(), maxRounds: z.number().int().min(1).max(20).optional(),
    antigravityTaskId: id.optional(),
  }, async (input) => {
    const task = await runner.dispatchNewTask(input);
    return { taskId: task.id, task };
  });
  register("deck_status", "查询工单执行状态和最近事件", { taskId: taskSelection.taskId }, ({ taskId }) => {
    if (!taskId) return { tasks: db.listTasks(15).map(taskCard) };
    return { taskId, task: requireTask(taskId), events: db.listRecentEvents(taskId, 15) };
  }, { readOnly: true });
  register("deck_read_result", "查看工单结果、变更与验收线索", {
    taskId: id, filePaths: z.array(z.string().min(1).max(4096)).max(40).optional(),
  }, ({ taskId, filePaths }) => {
    const task = requireTask(taskId);
    const requested = new Set(filePaths?.map((item) => item.replaceAll("\\", "/")));
    const changes = db.listFileChanges(taskId, task.currentRound);
    const fileChanges = requested.size ? changes.filter((change) => requested.has(change.filePath))
      .map((change) => fileDiff(requireChange(change.id))) : changes;
    return { taskId, task, summary: task.lastSummary, fileChanges, usage: db.listUsageByTask(taskId) };
  }, { readOnly: true });
  register("deck_feedback", "提交返工反馈并续跑同一会话，达到轮次上限时等待人工确认", {
    taskId: id, feedback: z.string().min(1).max(30_000),
  }, async ({ taskId, feedback }) => ({ taskId, task: await runner.sendFeedbackAndResume(taskId, feedback) }));
  register("deck_close", "关闭工单并记录验收结论", {
    taskId: id, status: z.enum(["done", "cancelled"]).default("done"), summary: z.string().max(12_000).optional(),
  }, async ({ taskId, status, summary }) => {
    const existing = requireTask(taskId);
    if (["queued", "running"].includes(existing.status)) {
      if (status !== "cancelled") throw new Error("请等待当前轮次结束");
      runner.cancelTask(taskId);
      await runner.waitForTask(taskId);
    }
    const task = inDeckTransaction(db, () => {
      const previous = requireTask(taskId);
      if (["queued", "running"].includes(previous.status)) throw new Error("请等待当前轮次结束");
      if (previous.status === "done" && status !== "done") throw new Error("工单已验收关闭");
      const note = summary == null ? previous.lastSummary : redactProviderSecrets(summary, providerSecrets(getConfig()));
      db.addEvent(taskId, previous.currentRound, status, status === "done" ? "工单已验收关闭" : "工单已取消关闭");
      return db.updateTask(taskId, {
        status, lastSummary: note, pid: null, finishedAt: nowIso(), baseline: { ...db.getTaskBaseline(taskId), closed: true },
      });
    });
    db.cleanupTaskSnapshotDir(taskId);
    return { taskId, task };
  });

  const app = { appOnly: true };
  const appRead = { appOnly: true, readOnly: true };
  register("ui_get_snapshot", "获取看板状态", taskSelection, snapshot, appRead);
  register("ui_get_file_diff", "查看指定文件的变更", { changeId: id }, ({ changeId }) => fileDiff(requireChange(changeId)), appRead);
  register("ui_revert_file", "回滚指定文件的变更", { changeId: id }, async ({ changeId }) => {
    const taskId = inDeckTransaction(db, () => {
      const change = requireChange(changeId);
      const task = requireTask(change.taskId);
      if (change.reverted) return task.id;
      assertWorkspaceIdle(db, task.repoPath);
      const baseline = db.getTaskBaseline(task.id);
      if (task.status === "done" || baseline.closed) throw new Error("工单已关闭，回滚存档已清理");
      const after = baseline.afterHashes?.[change.round];
      if (!after || !Object.hasOwn(after, change.filePath) ||
        workspaceFingerprint(task.repoPath, change.filePath) !== after[change.filePath]) {
        throw new Error("无法确认文件仍是本轮输出，已保留当前文件");
      }
      if (change.preSnapshotFile) {
        const root = db.getTaskSnapshotDir(task.id);
        const relative = path.relative(root, change.preSnapshotFile);
        safeWorkspacePath(root, relative);
      }
      const result = revertSingleFileChange(task.repoPath, change);
      if (!result.ok) throw new Error(result.message);
      db.markFileChangeReverted(changeId);
      db.addEvent(task.id, change.round, "file_reverted", `已回滚文件 ${change.filePath}`);
      return task.id;
    });
    return snapshot({ taskId });
  }, app);
  register("ui_cancel_task", "停止执行任务", { taskId: id }, async ({ taskId }) => {
    const task = runner.cancelTask(taskId);
    return { ...await snapshot({ taskId }), cancellationRequested: task.cancellationRequested ?? false };
  }, app);
  register("ui_resume_task", "人工确认后继续执行", { taskId: id, instruction: z.string().max(30_000).optional() },
    async ({ taskId, instruction }) => {
      await runner.sendFeedbackAndResume(taskId, instruction?.trim() || "请继续执行尚未完成的验收事项。", true);
      return snapshot({ taskId });
    }, app);
  register("ui_add_human_note", "添加人工备注", { taskId: id, content: z.string().min(1).max(30_000) },
    async ({ taskId, content }) => {
      const task = requireTask(taskId);
      db.addMessage({ taskId, round: task.currentRound, sender: "human", kind: "note",
        content: redactProviderSecrets(content, providerSecrets(getConfig())) });
      return snapshot({ taskId });
    }, app);
  register("ui_sync_model_policy", "同步 Parallax 模型策略", { taskId: taskSelection.taskId }, async ({ taskId }) => {
    await syncModelPolicy(dataDir, getConfig());
    return snapshot({ taskId });
  }, app);
  register("ui_set_quota_mode", "保存配额调度模式", { mode, taskId: taskSelection.taskId }, ({ mode: quotaMode, taskId }) => {
    saveConfig(dataDir, { routing: { quotaMode } });
    return snapshot({ taskId });
  }, app);
  register("ui_detect_environment", "探测本机执行器与模型供应商", {
    taskId: taskSelection.taskId, cursor: z.number().int().nonnegative().optional(),
  }, async ({ taskId, cursor = 0 }) => {
    const config = getConfig();
    const key = environmentKey(config);
    if (!cursor || environment?.key !== key || Date.now() >= environment.expiresAt) {
      environment = { key, expiresAt: Date.now() + 60_000, promise: detectAllProviders(config) };
    }
    const status = await environment.promise;
    const modelPolicy = resolveModelPolicy(dataDir, config, status.magpie, status.custom);
    return { ...await snapshot({ taskId }), modelPolicy, environmentStatus: pageEnvironment(status, cursor) };
  }, appRead);
  register("ui_save_config", "保存 AgentDeck 设置", { patch: configPatch, taskId: taskSelection.taskId },
    ({ patch, taskId }) => {
      const updates = patch.providers;
      if (updates?.magpie?.apiKey?.includes("••••")) delete updates.magpie.apiKey;
      if (updates?.custom) {
        const previous = new Map(getConfig().providers.custom.map((item) => [item.id, item]));
        const reservedIds = new Set(["auto", "plus", "codex", "codexPlus", "codex-plus", "openai", "magpie",
          "plus-high", "plus-clean", "plus-flagship", "magpie-fast"]);
        const seen = new Set();
        updates.custom = updates.custom.map((item) => {
          const providerId = item.id ?? `prov_${randomUUID()}`;
          if (reservedIds.has(providerId) || seen.has(providerId)) throw new Error("自定义供应商 ID 重复或为系统保留名称");
          seen.add(providerId);
          return { ...previous.get(providerId), ...item, id: providerId };
        });
      }
      saveConfig(dataDir, patch);
      return snapshot({ taskId });
    }, app);
  register("ui_test_provider", "检查单个网关的模型列表和响应时间", { provider: z.union([id, providerInput]) },
    ({ provider }) => {
      const input = typeof provider === "string" ? { id: provider } : provider;
      const saved = getConfig().providers.custom.find((item) => item.id === input.id);
      const baseUrl = input.baseUrl ?? saved?.baseUrl;
      const submittedKey = input.apiKey;
      const apiKey = submittedKey && !submittedKey.includes("••••") ? submittedKey
        : baseUrl === saved?.baseUrl ? saved?.apiKey : "";
      return testOpenAICompatProvider({ baseUrl, apiKey });
    }, appRead);

  // 3. 注册 UI 资源和延迟维护，MCP 握手无需等待历史日志或网络（UI HTML 允许 2 MiB，工具调用严格限制 200 KB）。
  registerAppResource(server, "AgentDeck", APP_URI, {
    description: "AgentDeck 协同看板",
    mimeType: RESOURCE_MIME_TYPE,
    _meta: { ui: { prefersBorder: false } },
  }, () => {
    const text = readAppHtml();
    return { contents: [{ uri: APP_URI, mimeType: RESOURCE_MIME_TYPE, text, _meta: { ui: { prefersBorder: false } } }] };
  });

  const refresh = () => {
    void triggerBackgroundPolicyRefreshIfStale(dataDir, getConfig())?.catch(() => {
      process.stderr.write("AgentDeck 后台模型策略同步失败\n");
    });
  };
  const startup = setTimeout(() => {
    try {
      inDeckTransaction(db, () => db.recoverStaleRunningTasks());
      const config = getConfig();
      db.backfillHistoricalTelemetry((threadId) => readCodexThreadTelemetry(threadId, config));
    } catch {
      process.stderr.write("AgentDeck 历史遥测回填失败\n");
    }
    refresh();
  }, 2000);
  startup.unref();
  setInterval(refresh, 60_000).unref();
  return { server, db, runner };
}

/** 从插件启动参数或环境计算数据目录，并连接 stdio。 */
async function main() {
  const args = process.argv.slice(2);
  const flag = args.indexOf("--data-dir");
  const dataDir = args.find((arg) => arg.startsWith("--data-dir="))?.slice("--data-dir=".length)
    || (flag >= 0 ? args[flag + 1] : "") || process.env.PLUGIN_DATA || path.join(APP_ROOT, ".data");
  const { server } = createDeckServer({ dataDir: path.resolve(dataDir) });
  const transport = new StdioServerTransport();
  const send = transport.send.bind(transport);
  // 保护实际 stdio 帧：工具 JSON 严控 200 KB，ui:// HTML 资源放宽至 2 MiB
  transport.send = (message) => {
    const isUiHtml = message?.result?.contents?.[0]?.mimeType === RESOURCE_MIME_TYPE;
    const limit = isUiHtml ? HTML_RESOURCE_MAX_BYTES : FRAME_BYTES;
    const fits = (value) => Buffer.byteLength(JSON.stringify(value)) < limit;
    if (fits(message)) return send(message);
    const error = { jsonrpc: "2.0", id: message.id ?? null,
      error: { code: -32603, message: "返回超过帧体积安全预算，请缩小查询范围。" } };
    return send(fits(error) ? error : { ...error, id: null });
  };
  await server.connect(transport);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(() => {
    process.stderr.write("AgentDeck MCP 服务启动失败\n");
    process.exitCode = 1;
  });
}
