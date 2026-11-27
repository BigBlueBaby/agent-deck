import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveCodexHome } from "../providers/codex_plus.mjs";

const QUOTA_TTL_MS = 15_000;
const ANTIGRAVITY_TTL_MS = 60_000;
const usageKeys = {
  inputTokens: ["input_tokens", "inputTokens", "prompt_tokens", "promptTokenCount", "prompt_token_count"],
  cachedInputTokens: ["cached_input_tokens", "cachedInputTokens", "cache_read_input_tokens", "cachedContentTokenCount", "cached_content_token_count"],
  outputTokens: ["output_tokens", "outputTokens", "completion_tokens", "candidatesTokenCount", "candidates_token_count"],
  reasoningTokens: ["reasoning_output_tokens", "reasoning_tokens", "reasoningTokens", "thoughtsTokenCount", "thoughts_token_count"],
};

const codexFiles = new Map();
const quotaCache = new Map();
const rolloutIndexes = new Map();
const transcriptFiles = new Map();
let taskCache = new Map();
let windowCache;

/** 保留明确记录的数值，缺失配额不能被误判为 0%。 */
function numeric(value) {
  return value != null && value !== "" && Number.isFinite(Number(value)) ? Number(value) : null;
}

/** 统一各日志来源的 token 字段和单位。 */
export function normalizeUsage(raw = {}) {
  return Object.fromEntries(Object.entries(usageKeys).map(([name, keys]) => [
    name, keys.map((key) => numeric(raw?.[key])).find((value) => value != null) ?? 0,
  ]));
}

/** 归一化 Codex 配额窗口，重置时间保留服务端 Unix 秒值。 */
function quotaWindow(window) {
  const usedPercent = numeric(window?.used_percent ?? window?.usedPercent);
  if (usedPercent == null) return null;
  return {
    usedPercent,
    resetsAt: window.resets_at ?? window.resetsAt ?? null,
    windowMinutes: numeric(window.window_minutes ?? window.windowMinutes),
  };
}

/** 按文件修改时间与长度复用解析结果，每次刷新最多读取文件一次。 */
function cachedFile(file, cache, parse, stat = fs.statSync(file, { throwIfNoEntry: false })) {
  if (!stat?.isFile()) {
    cache.delete(file);
    return null;
  }
  const previous = cache.get(file);
  if (previous?.mtimeMs === stat.mtimeMs && previous.size === stat.size) return previous.value;
  const value = parse(fs.readFileSync(file, "utf8"), stat);
  cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, value });
  return value;
}

/** 流式行格式允许末尾正在追加的半行，已完成记录仍可用于统计。 */
function* jsonLines(text) {
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      yield JSON.parse(line);
    } catch {
      // 并发写入时末行可能尚未写完。
    }
  }
}

/** 解析累计 token、轮次、工具次数和同一配额窗口内的变化。 */
function parseRollout(text, stat) {
  const result = { model: "", effort: "", turns: 0, toolCalls: 0, ...normalizeUsage() };
  let firstQuota;
  let lastQuota;
  let officialProvider = true;
  const seenTurns = new Set();
  for (const row of jsonLines(text)) {
    const payload = row?.payload;
    if (!payload) continue;
    if (row.type === "session_meta") {
      officialProvider = !payload.model_provider || payload.model_provider === "openai";
    } else if (row.type === "turn_context") {
      result.model = payload.model || result.model;
      result.effort = payload.effort || payload.reasoning_effort || result.effort;
    } else if (row.type === "response_item" && ["function_call", "custom_tool_call", "local_shell_call",
      "web_search_call", "image_generation_call", "mcp_call"].includes(payload.type)) {
      result.toolCalls += 1;
    } else if (row.type === "event_msg" && ["task_complete", "turn_completed"].includes(payload.type)) {
      if (payload.turn_id && seenTurns.has(payload.turn_id)) continue;
      if (payload.turn_id) seenTurns.add(payload.turn_id);
      result.turns += 1;
    } else if (row.type === "event_msg" && payload.type === "token_count") {
      if (payload.info?.total_token_usage) Object.assign(result, normalizeUsage(payload.info.total_token_usage));
      const limits = payload.rate_limits;
      if (!officialProvider || !limits || (limits.limit_id && limits.limit_id !== "codex")) continue;
      const quota = {
        primary: quotaWindow(limits.primary), secondary: quotaWindow(limits.secondary),
        planType: limits.plan_type ?? null, capturedAt: row.timestamp ?? new Date(stat.mtimeMs).toISOString(),
      };
      if (!quota.primary && !quota.secondary) continue;
      firstQuota ??= quota;
      lastQuota = quota;
    }
  }
  for (const key of ["primary", "secondary"]) {
    const first = firstQuota?.[key];
    const last = lastQuota?.[key];
    result[`${key}After`] = last?.usedPercent ?? null;
    result[`${key}Delta`] = first && last && first.resetsAt === last.resetsAt
      ? Math.max(0, last.usedPercent - first.usedPercent) : null;
  }
  return { ...result, quota: lastQuota ?? null };
}

/** 枚举日志路径，仅遍历真实子目录，避免循环链接和跨目录扫描。 */
function* filesNamed(root, matches) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) yield* filesNamed(file, matches);
    else if (entry.isFile() && matches(entry.name)) yield file;
  }
}

/** 对同一个 Codex Home 复用短期 rollout 路径索引。 */
function rolloutIndex(home, fresh = false) {
  const now = Date.now();
  const cached = rolloutIndexes.get(home);
  if (!fresh && cached && now < cached.expiresAt) return cached;
  const files = ["sessions", "archived_sessions"].flatMap((dir) =>
    [...filesNamed(path.join(home, dir), (name) => /^rollout-.*\.jsonl$/.test(name))]);
  const byId = new Map();
  for (const file of files) {
    const id = /([\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12})\.jsonl$/i.exec(file)?.[1];
    if (id && !byId.has(id)) byId.set(id, file);
  }
  const index = { files, byId, expiresAt: now + QUOTA_TTL_MS };
  rolloutIndexes.set(home, index);
  return index;
}

/** 读取指定线程的累计遥测，不返回日志原文、提示词或工具参数。 */
export function readCodexThreadTelemetry(threadId, config, { fresh = false } = {}) {
  if (!threadId) return null;
  const home = resolveCodexHome(config);
  const index = rolloutIndex(home, fresh);
  const file = index.byId.get(threadId) ?? index.files.find((candidate) =>
    path.basename(candidate).endsWith(`-${threadId}.jsonl`));
  try {
    return file ? cachedFile(file, codexFiles, parseRollout) : null;
  } catch {
    return null;
  }
}

/** 每 15 秒刷新最近 8 个 rollout 的配额，文件内容未变化时复用既有解析结果。 */
export function readLatestCodexQuota(config) {
  const home = resolveCodexHome(config);
  const now = Date.now();
  const cached = quotaCache.get(home);
  if (cached && now < cached.expiresAt) return cached.value;
  const recent = rolloutIndex(home, true).files.flatMap((file) => {
    try {
      const stat = fs.statSync(file);
      return stat.isFile() ? [{ file, stat }] : [];
    } catch {
      return [];
    }
  }).sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs).slice(0, 8);
  let value = null;
  for (const { file, stat } of recent) {
    try {
      const quota = cachedFile(file, codexFiles, parseRollout, stat)?.quota;
      if (quota && (!value || Date.parse(quota.capturedAt) > Date.parse(value.capturedAt))) value = quota;
    } catch {
      // 已移动或不可读的 rollout 不影响其他日志。
    }
  }
  quotaCache.set(home, { value, expiresAt: now + QUOTA_TTL_MS });
  return value;
}

/** 支持运行环境注入的目录，并使用 Antigravity 跨平台默认数据根。 */
function antigravityRoots() {
  const home = process.env.ANTIGRAVITY_HOME || path.join(os.homedir(), ".gemini", "antigravity");
  return process.env.ANTIGRAVITY_TRANSCRIPTS_DIR ? [path.resolve(process.env.ANTIGRAVITY_TRANSCRIPTS_DIR)]
    : ["brain", "conversations", "tasks", "transcripts"].map((dir) => path.join(home, dir));
}

/** 提取单条 Antigravity 记录的用量元数据，不读取消息内容用于返回。 */
function parseTranscript(text, stat) {
  const result = { model: "", turns: 0, toolCalls: 0, ...normalizeUsage(), updatedAt: new Date(stat.mtimeMs).toISOString() };
  const samples = [];
  for (const row of jsonLines(text)) {
    const payload = row?.payload ?? row?.data ?? row;
    if (!payload) continue;
    const type = payload.type ?? row.type ?? row.event;
    const usage = payload.usage ?? payload.usageMetadata ?? payload.message?.usage ?? payload.response?.usage;
    result.model = payload.model ?? payload.message?.model ?? payload.response?.model ?? result.model;
    if (["assistant", "turn.completed", "turn_complete"].includes(type) || payload.message?.role === "assistant") result.turns++;
    if (["tool_call", "tool_use", "function_call"].includes(type)) result.toolCalls++;
    if (!usage) continue;
    const normalized = normalizeUsage(usage);
    for (const key of Object.keys(usageKeys)) result[key] += normalized[key];
    const rawTime = row.timestamp ?? payload.timestamp;
    const timestamp = typeof rawTime === "number" ? rawTime * (rawTime < 1e12 ? 1000 : 1) : Date.parse(rawTime);
    samples.push({ timestamp: Number.isFinite(timestamp) ? timestamp : stat.mtimeMs, ...normalized });
  }
  return { summary: result, samples };
}

/** 每分钟更新 transcript 元数据，按文件版本共享任务与窗口的解析结果。 */
function antigravityTranscripts() {
  return [...new Set(antigravityRoots().flatMap((root) => [...filesNamed(root, (name) => name === "transcript.jsonl")]))];
}

/** 按任务 ID 查找 transcript，60 秒内缓存命中及缺失结果。 */
export function readAntigravityTaskTelemetry(taskId) {
  if (typeof taskId !== "string" || !taskId || /[\\/]/.test(taskId) || [".", ".."].includes(taskId)) return null;
  const now = Date.now();
  const roots = antigravityRoots();
  const key = JSON.stringify([roots, taskId]);
  const cached = taskCache.get(key);
  if (cached && now < cached.expiresAt) return cached.value;
  const file = roots.map((root) => path.join(root, taskId, "transcript.jsonl")).find((candidate) => fs.existsSync(candidate))
    ?? antigravityTranscripts().find((candidate) => path.dirname(candidate).split(path.sep).includes(taskId));
  let value = null;
  try {
    if (file) value = cachedFile(file, transcriptFiles, parseTranscript)?.summary ?? null;
  } catch {
    // 任务日志可能在扫描后归档。
  }
  if (taskCache.size >= 512) taskCache = new Map();
  taskCache.set(key, { value, expiresAt: now + ANTIGRAVITY_TTL_MS });
  return value;
}

/** 统计过去 5 小时和 7 天的本地 transcript 用量，按记录时间归入窗口。 */
export function readAntigravityWindowStats() {
  const now = Date.now();
  const rootKey = JSON.stringify(antigravityRoots());
  if (windowCache?.rootKey === rootKey && now < windowCache.expiresAt) return windowCache.value;
  const windows = [
    { windowMinutes: 5 * 60, tasks: 0, ...normalizeUsage() },
    { windowMinutes: 7 * 24 * 60, tasks: 0, ...normalizeUsage() },
  ];
  const files = antigravityTranscripts();
  for (const file of files) {
    try {
      const transcript = cachedFile(file, transcriptFiles, parseTranscript);
      if (!transcript) continue;
      for (const window of windows) {
        const start = now - window.windowMinutes * 60_000;
        let counted = false;
        for (const sample of transcript.samples) {
          if (sample.timestamp < start || sample.timestamp > now) continue;
          counted = true;
          for (const key of Object.keys(usageKeys)) window[key] += sample[key];
        }
        if (counted) window.tasks++;
      }
    } catch {
      // 忽略扫描后被归档的文件。
    }
  }
  const value = { primary: windows[0], secondary: windows[1], transcriptCount: files.length };
  windowCache = { rootKey, expiresAt: now + ANTIGRAVITY_TTL_MS, value };
  return value;
}
