import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveCodexHome } from "../providers/codex_plus.mjs";

const QUOTA_TTL_MS = 3_000;
const LIVE_QUOTA_TTL_MS = 60_000;
const LIVE_QUOTA_TIMEOUT_MS = 4_000;
const DEFAULT_CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const ANTIGRAVITY_TTL_MS = 60_000;
const MAX_FULL_ROLLOUT_BYTES = 32 * 1024 * 1024;
const TAIL_SLICE_SIZES = [256 * 1024, 2 * 1024 * 1024, 8 * 1024 * 1024];
const usageKeys = {
  inputTokens: ["input_tokens", "inputTokens", "prompt_tokens", "promptTokenCount", "prompt_token_count"],
  cachedInputTokens: ["cached_input_tokens", "cachedInputTokens", "cache_read_input_tokens", "cachedContentTokenCount", "cached_content_token_count"],
  outputTokens: ["output_tokens", "outputTokens", "completion_tokens", "candidatesTokenCount", "candidates_token_count"],
  reasoningTokens: ["reasoning_output_tokens", "reasoning_tokens", "reasoningTokens", "thoughtsTokenCount", "thoughts_token_count"],
};

const codexFiles = new Map();
const quotaTailFiles = new Map();
const quotaCache = new Map();
const liveQuotaCache = new Map();
const liveQuotaInFlight = new Map();
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

/** 归一化 Codex 配额窗口，兼容 rollout（resets_at/window_minutes）与实时接口（reset_at/limit_window_seconds）。 */
function quotaWindow(window, now = Date.now()) {
  const usedPercent = numeric(window?.used_percent ?? window?.usedPercent);
  if (usedPercent == null) return null;
  const resetsAt = window.resets_at ?? window.resetsAt ?? window.reset_at ?? window.resetAt ?? null;
  const raw = numeric(resetsAt);
  const resetMs = raw != null ? raw * (raw < 1e12 ? 1000 : 1) : Date.parse(resetsAt);
  const expired = Number.isFinite(resetMs) && now >= resetMs;
  const windowSecs = numeric(window.limit_window_seconds ?? window.limitWindowSeconds);
  const windowMinutes = numeric(window.window_minutes ?? window.windowMinutes)
    ?? (windowSecs != null ? Math.round(windowSecs / 60) : null);
  return {
    usedPercent,
    resetsAt,
    windowMinutes,
    expired,
  };
}

/** 提取单条 token_count 事件中的有效 Codex 配额（同时兼容官方直连与 Magpie/代理透传的官方配额）。 */
function extractQuotaFromEvent(row, stat) {
  const payload = row?.payload;
  if (row?.type !== "event_msg" || payload?.type !== "token_count") return null;
  const limits = payload.rate_limits;
  if (!limits) return null;
  if (limits.limit_id && !/^codex\b/i.test(String(limits.limit_id))) return null;
  const primary = quotaWindow(limits.primary);
  const secondary = quotaWindow(limits.secondary);
  if (!primary && !secondary) return null;
  return {
    primary,
    secondary,
    planType: limits.plan_type ?? null,
    capturedAt: row.timestamp ?? new Date(stat.mtimeMs).toISOString(),
  };
}

/** 仅读取文件尾部切片（支持 >1 GB 超大 rollout 日志，毫秒级且绝不触发 ERR_STRING_TOO_LONG）。 */
function readTailUtf8(file, size, maxBytes) {
  const len = Math.min(size, maxBytes);
  const start = Math.max(0, size - len);
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(len);
    const bytesRead = fs.readSync(fd, buf, 0, len, start);
    return buf.subarray(0, bytesRead).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

/** 从 rollout 尾部逐级扩大切片提取最新一条有效 Codex 配额，按 mtimeMs+size 缓存。 */
function readRolloutQuotaTail(file, stat) {
  const previous = quotaTailFiles.get(file);
  if (previous?.mtimeMs === stat.mtimeMs && previous.size === stat.size) return previous.value;
  let value = null;
  for (const sliceBytes of TAIL_SLICE_SIZES) {
    const text = readTailUtf8(file, stat.size, sliceBytes);
    const lines = text.split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i];
      if (!line || !line.includes("rate_limits")) continue;
      try {
        const quota = extractQuotaFromEvent(JSON.parse(line), stat);
        if (quota) {
          value = quota;
          break;
        }
      } catch {
        // 切片起点截断的半行或并发写入半行安全跳过
      }
    }
    if (value || stat.size <= sliceBytes) break;
  }
  quotaTailFiles.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, value });
  return value;
}

/** 按文件修改时间与长度复用解析结果，超大文件回退尾部读取避免 ERR_STRING_TOO_LONG。 */
function cachedFile(file, cache, parse, stat = fs.statSync(file, { throwIfNoEntry: false })) {
  if (!stat?.isFile()) {
    cache.delete(file);
    return null;
  }
  const previous = cache.get(file);
  if (previous?.mtimeMs === stat.mtimeMs && previous.size === stat.size) return previous.value;
  const text = stat.size > MAX_FULL_ROLLOUT_BYTES
    ? readTailUtf8(file, stat.size, TAIL_SLICE_SIZES.at(-1))
    : fs.readFileSync(file, "utf8");
  const value = parse(text, stat);
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
  const seenTurns = new Set();
  for (const row of jsonLines(text)) {
    const payload = row?.payload;
    if (!payload) continue;
    if (row.type === "turn_context") {
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
      const quota = extractQuotaFromEvent(row, stat);
      if (!quota) continue;
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

/** 刷新最近 24 个 rollout 的尾部配额（按 mtimeMs+size 缓存，支持 >1 GB 大日志与代理透传，实时重算过期状态）。 */
export function readLatestCodexQuota(config, { force = false } = {}) {
  const home = resolveCodexHome(config);
  const now = Date.now();
  const cached = quotaCache.get(home);
  if (!force && cached && now < cached.expiresAt) {
    return refreshQuotaExpiry(cached.value, now);
  }
  const recent = rolloutIndex(home, true).files.flatMap((file) => {
    try {
      const stat = fs.statSync(file);
      return stat.isFile() ? [{ file, stat }] : [];
    } catch {
      return [];
    }
  }).sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs).slice(0, 24);
  let value = null;
  for (const { file, stat } of recent) {
    try {
      const quota = readRolloutQuotaTail(file, stat);
      if (quota && (!value || Date.parse(quota.capturedAt) > Date.parse(value.capturedAt))) value = quota;
    } catch {
      // 已移动或不可读的 rollout 不影响其他日志。
    }
  }
  quotaCache.set(home, { value, expiresAt: now + QUOTA_TTL_MS });
  return refreshQuotaExpiry(value ? { ...value, source: "rollout" } : null, now);
}

/** 仅在内存中读取本地 auth.json 的官方登录令牌用于只读查询，绝不打印、缓存或回传任何凭据。 */
function readCodexAuthTokens(home) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(home, "auth.json"), "utf8"));
    const accessToken = typeof raw?.tokens?.access_token === "string" ? raw.tokens.access_token.trim() : "";
    const accountId = typeof raw?.tokens?.account_id === "string" ? raw.tokens.account_id.trim() : "";
    return accessToken ? { accessToken, accountId } : null;
  } catch {
    return null;
  }
}

/** 通过官方只读配额接口实时拉取最新 5h/7d 配额（默认 60 秒自动缓存，forceLive=true 立即重查，并发请求自动合并）。 */
export async function fetchLiveCodexQuota(config, { forceLive = false, usageUrl = process.env.AGENT_DECK_CODEX_USAGE_URL || DEFAULT_CODEX_USAGE_URL } = {}) {
  if (config?.providers?.codexPlus?.enabled === false) return null;
  const home = resolveCodexHome(config);
  const key = `${home}|${usageUrl}`;
  const now = Date.now();
  const cached = liveQuotaCache.get(key);
  if (!forceLive && cached && now < cached.expiresAt) {
    return refreshQuotaExpiry(cached.value, now);
  }
  if (!forceLive && liveQuotaInFlight.has(key)) {
    return liveQuotaInFlight.get(key);
  }
  const auth = readCodexAuthTokens(home);
  if (!auth) return null;

  const promise = (async () => {
    try {
      const headers = {
        Authorization: `Bearer ${auth.accessToken}`,
        Accept: "application/json",
        "User-Agent": "codex_cli_rs/0.172.0",
      };
      if (auth.accountId) headers["ChatGPT-Account-Id"] = auth.accountId;
      const res = await fetch(usageUrl, { headers, signal: AbortSignal.timeout(LIVE_QUOTA_TIMEOUT_MS) });
      if (!res.ok) {
        await res.body?.cancel?.();
        return null;
      }
      const data = await res.json();
      const rl = data?.rate_limit;
      const capturedAt = new Date().toISOString();
      const primary = quotaWindow(rl?.primary_window ?? rl?.primary, Date.now());
      const secondary = quotaWindow(rl?.secondary_window ?? rl?.secondary, Date.now());
      if (!primary && !secondary) return null;
      const value = {
        primary,
        secondary,
        planType: data?.plan_type ?? null,
        capturedAt,
        source: "live",
      };
      liveQuotaCache.set(key, { value, expiresAt: Date.now() + LIVE_QUOTA_TTL_MS });
      return value;
    } catch {
      return null;
    } finally {
      if (liveQuotaInFlight.get(key) === promise) liveQuotaInFlight.delete(key);
    }
  })();

  liveQuotaInFlight.set(key, promise);
  return promise;
}

/** 优先实时查询 Codex 官方配额（60s 自动更新 / 点击刷新强制重查），离线或无官方登录时无缝回退本地 rollout 尾部采集。 */
export async function getLatestCodexQuota(config, { forceLive = false, usageUrl } = {}) {
  const live = await fetchLiveCodexQuota(config, { forceLive, ...(usageUrl ? { usageUrl } : {}) });
  if (live) return live;
  return readLatestCodexQuota(config, { force: forceLive });
}

/** 每次返回配额前按当前时刻重新评估窗口是否已重置，避免缓存期内停留在旧的未过期状态。 */
function refreshQuotaExpiry(quota, now) {
  if (!quota) return null;
  const check = (win) => {
    if (!win) return null;
    const raw = numeric(win.resetsAt);
    const resetMs = raw != null ? raw * (raw < 1e12 ? 1000 : 1) : Date.parse(win.resetsAt);
    const expired = Number.isFinite(resetMs) && now >= resetMs;
    return { ...win, expired };
  };
  return { ...quota, primary: check(quota.primary), secondary: check(quota.secondary) };
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
