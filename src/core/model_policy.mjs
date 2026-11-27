import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { readCodexPlusModels, resolveCodexHome } from "../providers/codex_plus.mjs";
import { consumesCodexPlus, discoverMagpieModels } from "../providers/magpie_gateway.mjs";
import { testOpenAICompatProvider } from "../providers/openai_compat.mjs";

const POLICY_FILE = "model-policy.json";
const slotNames = ["plusPrimary", "plusBoost", "plusEco", "plusFlagship", "freeFast"];
const effortSuffix = /-(non-reasoning|minimal|none|low|medium|high|xhigh|max|ultra)$/;
const syncing = new Map();
const refreshAttempts = new Map();
const policyFiles = new Map();

/** 从目标属性后提取完整 JSON 对象，正确处理嵌套对象及字符串中的括号。 */
function readCatalogObject(text) {
  const marker = /"initialCatalog"\s*:\s*(?=\{)/g;
  for (const match of text.matchAll(marker)) {
    const start = match.index + match[0].length;
    let depth = 0;
    let quoted = false;
    for (let end = start; end < text.length; end++) {
      const char = text[end];
      if (quoted) {
        if (char === "\\") end++;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === "{") depth++;
      else if (char === "}" && --depth === 0) {
        try {
          const catalog = JSON.parse(text.slice(start, end + 1));
          if (Array.isArray(catalog.models) && catalog.models.length > 0) return catalog;
        } catch {
          // 同一页面可能含多个序列化入口。
        }
        break;
      }
    }
  }
  return null;
}

/** 解码公开 SSR 目录，兼容普通 JSON 与 Next.js Flight 分段序列化。 */
export function parseParallaxCatalogFromHtml(html) {
  const direct = readCatalogObject(html);
  if (direct) return direct;
  const chunks = [];
  for (const match of html.matchAll(/self\.__next_f\.push\(\s*\[1\s*,\s*("(?:[^"\\]|\\.)*")\s*\]\s*\)/g)) {
    try {
      chunks.push(JSON.parse(match[1]));
    } catch {
      // 无法解码的片段不参与目录解析。
    }
  }
  const catalog = readCatalogObject(chunks.join(""));
  if (!catalog) throw new Error("Parallax 页面缺少可解析的 initialCatalog");
  return catalog;
}

/** 读取 Parallax 公开页面，超时或上游格式变更由同步入口记录。 */
export async function fetchParallaxCatalog(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Parallax HTTP ${response.status}`);
  }
  return parseParallaxCatalogFromHtml(await response.text());
}

/** 用可比的能力和成本指标计算 Pareto 前沿及归一化拐点。 */
export function evaluateParetoAndKnee(models) {
  const hasPerTaskCost = models.some((model) => Number.isFinite(model.costPerTask));
  const candidates = models.map((model) => ({
    ...model,
    score: model.intelligence ?? model.coding ?? model.agentic ?? model.score,
    cost: hasPerTaskCost ? model.costPerTask : model.blendedPrice ?? model.cost,
  })).filter((model) => Number.isFinite(model.score) && Number.isFinite(model.cost) && model.cost >= 0)
    .sort((a, b) => a.cost - b.cost || b.score - a.score);
  const pareto = [];
  for (const model of candidates) {
    if (!pareto.length || model.score > pareto.at(-1).score) pareto.push(model);
  }
  const first = pareto[0];
  const last = pareto.at(-1);
  if (pareto.length < 3) return { pareto, knee: first ?? null };
  let knee = first;
  let best = -Infinity;
  for (const model of pareto.slice(1, -1)) {
    const cost = (model.cost - first.cost) / (last.cost - first.cost);
    const score = (model.score - first.score) / (last.score - first.score);
    if (score - cost > best) {
      best = score - cost;
      knee = model;
    }
  }
  return { pareto, knee: best > 0 ? knee : first };
}

/** 解析模型的版本号、通道前缀与推理档位，统一为 Parallax 比对键。 */
function modelKey(name) {
  return String(name ?? "").toLowerCase().split("/").at(-1).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/** 把公开目录的模型变体索引到模型及档位，处理未带档位后缀的 Max 记录。 */
function catalogVariants(catalog) {
  const byModel = new Map();
  for (const row of (Array.isArray(catalog) ? catalog : catalog?.models ?? [])) {
    const slug = modelKey(row.slug ?? row.model ?? row.id);
    if (!slug) continue;
    const suffix = effortSuffix.exec(slug);
    const effort = row.reasoningEffort ?? row.effort ?? suffix?.[1] ??
      /\((minimal|none|low|medium|high|xhigh|max|ultra)\)$/i.exec(row.name ?? "")?.[1]?.toLowerCase() ?? "";
    const base = suffix ? slug.slice(0, suffix.index) : slug;
    const variants = byModel.get(base) ?? new Map();
    variants.set(effort === "non-reasoning" ? "none" : effort, row);
    byModel.set(base, variants);
  }
  return byModel;
}

/** 将可用清单展平并与配置勾选项求交集。免费归属服从 Plus 消耗标记。 */
function eligibleModels(inventory, config) {
  const models = [];
  if (config.providers?.codexPlus?.enabled !== false) {
    for (const row of inventory.codex?.models ?? inventory.codexPlus?.models ?? []) {
      if (row.visibility === "hide") continue;
      models.push({ provider: "codex-plus", model: row.slug, efforts: row.efforts, isFreeChannel: false, consumesCodexPlus: true });
    }
  }
  const magpie = config.providers?.magpie;
  if (magpie?.enabled !== false) {
    const selected = new Set(magpie?.selectedModels ?? []);
    const freeOwners = new Set(magpie?.freeOwners ?? []);
    for (const group of inventory.magpie?.groups ?? []) {
      for (const row of group.models ?? []) {
        if (!selected.has(row.id)) continue;
        const plus = row.consumesCodexPlus === true || consumesCodexPlus(row.id, row.ownedBy ?? group.owner);
        models.push({
          provider: "magpie", model: row.id, efforts: row.efforts, consumesCodexPlus: plus,
          isFreeChannel: !plus && freeOwners.has(row.ownedBy ?? group.owner),
        });
      }
    }
  }
  for (const provider of config.providers?.custom ?? []) {
    if (provider.enabled === false) continue;
    const probe = inventory.custom?.find((item) => item.id === provider.id);
    const available = probe?.reachable ? new Set(probe.discoveredModels ?? []) : null;
    for (const model of provider.models ?? []) {
      if (available && !available.has(model)) continue;
      models.push({
        provider: provider.id, model, efforts: [provider.defaultEffort || "high"],
        isFreeChannel: provider.isFree === true, consumesCodexPlus: false,
      });
    }
  }
  return models;
}

/** 标记自动选型时应排除的档位，供选型说明和 UI 展示。 */
function rejection(candidate) {
  const key = modelKey(candidate.model);
  if (/^gpt-6(?:-[12])?-luna$/.test(key)) return "能力不足，排除在自动槽位之外";
  if (key === "gpt-6-2-sol" && candidate.reasoningEffort === "low") return "保留更有性价比的 Sol 档位";
  if (key === "gpt-6-2-astra" && candidate.reasoningEffort === "medium") return "保留更有性价比的 Astra 档位";
  return "";
}

const profiles = {
  plusPrimary: "plus-high", plusBoost: "plus-high", plusEco: "plus-clean",
  plusFlagship: "plus-flagship", freeFast: "magpie-fast",
};

/** 槽位只保存执行所需的公开参数与 Parallax 公开评分指标，凭据由路由执行时从配置取得。 */
function slot(candidate, name, reason) {
  if (!candidate) return null;
  const { provider, model, reasoningEffort, isFreeChannel, consumesCodexPlus: plus } = candidate;
  const profile = provider === "codex-plus" || provider === "magpie" ? profiles[name] : provider;
  const intelligence = candidate.intelligence ?? candidate.coding ?? candidate.agentic ?? candidate.score;
  const costPerTask = candidate.costPerTask ?? candidate.blendedPrice ?? candidate.cost;
  const latency = candidate.latency;
  return {
    provider, model, reasoningEffort, profile, isFreeChannel, consumesCodexPlus: plus, reason,
    ...(Number.isFinite(intelligence) ? { intelligence: Math.round(intelligence * 10) / 10 } : {}),
    ...(Number.isFinite(costPerTask) ? { costPerTask: Math.round(costPerTask * 100) / 100 } : {}),
    ...(Number.isFinite(latency) ? { latency: Math.round(latency * 10) / 10 } : {}),
  };
}

/** 解析用户锁定的已选模型，允许覆盖自动排除档位，并保留免费槽位边界。 */
function lockedCandidate(override, candidates, name) {
  if (!override) return null;
  let requested = override;
  if (typeof override === "string") {
    const [, model, effort] = /^(.*?)(?:\s+(none|minimal|low|medium|high|xhigh|max|ultra))?$/.exec(override.trim());
    const colon = model.indexOf(":");
    const separator = colon > 0 && candidates.some((candidate) => candidate.provider === model.slice(0, colon)) ? colon : -1;
    requested = {
      provider: separator > 0 ? model.slice(0, separator) : "",
      model: separator > 0 ? model.slice(separator + 1) : model,
      reasoningEffort: effort,
    };
  }
  const effort = requested.reasoningEffort ?? requested.effort;
  const matches = candidates.filter((candidate) => candidate.model === requested.model &&
    (!requested.provider || candidate.provider === requested.provider) &&
    (name === "freeFast" ? candidate.isFreeChannel : true) &&
    (!effort || candidate.reasoningEffort === effort || !candidate.efforts?.length));
  const match = matches.find((candidate) => candidate.reasoningEffort === (effort || "high")) ?? matches[0];
  return match ? slot({ ...match, reasoningEffort: effort || match.reasoningEffort }, name, "用户锁定") : null;
}

/** 从当前可用且获准的模型构建五个槽位，支持官方 Codex、Magpie 与任意自定义网关，并记录排除项与上次差异。 */
export function computeDynamicPolicy(catalog, inventory, config, prevPolicy) {
  const byModel = catalogVariants(catalog);
  const eligible = eligibleModels(inventory, config);
  // 1. 按模型允许的档位生成候选，再用公开目录补齐观测值。
  const candidates = eligible.flatMap((entry) => {
    const variants = byModel.get(modelKey(entry.model));
    const efforts = entry.efforts?.length ? entry.efforts
      : variants?.size ? [...variants.keys()] : [entry.provider === "codex-plus" ? "high" : ""];
    return efforts.map((reasoningEffort) => ({
      ...(variants?.get(reasoningEffort) ?? variants?.get("")), ...entry, reasoningEffort,
    }));
  });
  const rejectedHighlights = candidates.flatMap((candidate) => {
    const reason = rejection(candidate);
    return reason ? [{ provider: candidate.provider, model: candidate.model, reasoningEffort: candidate.reasoningEffort, reason }] : [];
  });
  // 2. 主池纳入全部已启用的非免费通道（官方 Codex 任意订阅/API、付费 Magpie、自定义付费网关）；无付费通道时平滑回退到免费池。
  const paidPool = candidates.filter((candidate) => !candidate.isFreeChannel && !rejection(candidate));
  const free = candidates.filter((candidate) => candidate.isFreeChannel && !rejection(candidate));
  const primaryPool = paidPool.length ? paidPool : free;
  const { pareto, knee } = evaluateParetoAndKnee(primaryPool);
  const fallback = buildFallbackPolicy().slots;
  const defaultFor = (name) => primaryPool.find((candidate) => candidate.model === fallback[name]?.model &&
    candidate.reasoningEffort === fallback[name]?.reasoningEffort);
  const ranked = [...pareto].sort((a, b) => b.score - a.score || a.cost - b.cost);
  const primary = evaluateParetoAndKnee(primaryPool.filter((candidate) => candidate.reasoningEffort === "high")).knee
    ?? knee ?? defaultFor("plusPrimary") ?? primaryPool[0];
  const eco = pareto.find((candidate) => !primary?.score || candidate.score >= primary.score * 0.8)
    ?? pareto[0] ?? defaultFor("plusEco") ?? primary;
  const flagship = ranked[0] ?? defaultFor("plusFlagship") ?? primary;
  const boost = ranked.find((candidate) => candidate.model === primary?.model &&
    candidate.score > (primary.score ?? primary.intelligence ?? primary.coding ?? primary.agentic ?? -Infinity))
    ?? ranked.find((candidate) => candidate.reasoningEffort === "xhigh") ?? defaultFor("plusBoost") ?? flagship;
  free.sort((a, b) => (a.latency ?? Infinity) - (b.latency ?? Infinity) ||
    (b.outputSpeed ?? 0) - (a.outputSpeed ?? 0) ||
    (b.intelligence ?? 0) - (a.intelligence ?? 0));
  const choices = { plusPrimary: primary, plusBoost: boost, plusEco: eco, plusFlagship: flagship, freeFast: free[0] };
  // 3. 应用锁定并和上一次实际槽位比对，原因文本变化不计为模型变更。
  const slots = {};
  const invalidOverrides = [];
  const lastDiff = [];
  for (const name of slotNames) {
    const override = config.routing?.slotOverrides?.[name];
    const locked = lockedCandidate(override, candidates, name);
    if (override && !locked) invalidOverrides.push(name);
    slots[name] = locked ?? slot(choices[name], name, catalog ? "Parallax 动态选型" : "按已知可用模型选择");
    const previous = prevPolicy?.slots?.[name] ?? null;
    const current = slots[name];
    if (previous?.provider !== current?.provider || previous?.model !== current?.model ||
      previous?.reasoningEffort !== current?.reasoningEffort) {
      lastDiff.push({ slot: name, from: previous, to: current });
    }
  }
  return {
    schemaVersion: 2, source: catalog ? "parallax" : "local", slots,
    eligibleModels: eligible, rejectedHighlights, invalidOverrides, lastDiff,
    syncedAt: prevPolicy?.syncedAt ?? null,
  };
}

/** 提供冷启动官方候选。免费槽位等到发现已获准的通道后才可用。 */
export function buildFallbackPolicy() {
  const plus = (model, effort, name) => slot({
    provider: "codex-plus", model, reasoningEffort: effort, isFreeChannel: false, consumesCodexPlus: true,
  }, name, "默认官方模型");
  return {
    schemaVersion: 2, source: "fallback", syncedAt: null, eligibleModels: [], rejectedHighlights: [], lastDiff: [],
    slots: {
      plusPrimary: plus("gpt-6.2-sol", "high", "plusPrimary"),
      plusBoost: plus("gpt-6.2-sol", "xhigh", "plusBoost"),
      plusEco: plus("gpt-6.2-sol", "medium", "plusEco"),
      plusFlagship: plus("gpt-6.2-astra", "xhigh", "plusFlagship"),
      freeFast: null,
    },
  };
}

/** 从本地磁盘读取上次成功保存的策略和 SSR 数据。 */
function readPolicyFile(dataDir) {
  const file = path.join(dataDir, POLICY_FILE);
  try {
    const stat = fs.statSync(file, { throwIfNoEntry: false });
    if (!stat) {
      policyFiles.delete(file);
      return null;
    }
    const previous = policyFiles.get(file);
    if (stat.mtimeMs === previous?.mtimeMs && stat.size === previous.size) return previous.value;
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    const value = saved?.slots ? saved : null;
    policyFiles.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, value });
    return value;
  } catch {
    return null;
  }
}

/** 读取轻量策略投影，不把 SSR 原始目录送入 MCP 帧。 */
export function loadModelPolicy(dataDir) {
  const { catalog, magpieInventory, magpieSource, customInventory, ...policy } = readPolicyFile(dataDir) ?? buildFallbackPolicy();
  return policy;
}

/** 使用当前配置和原有评分快速重新计算，避免路由沿用已取消勾选的通道。 */
export function resolveModelPolicy(dataDir, config, magpie, custom) {
  const saved = readPolicyFile(dataDir);
  const home = resolveCodexHome(config);
  const magpieSource = config.providers?.magpie?.baseUrl;
  const known = saved?.magpieSource === magpieSource ? saved?.magpieInventory : null;
  const savedCustom = saved?.customInventory?.filter((probe) => config.providers?.custom?.some((provider) =>
    provider.id === probe.id && provider.baseUrl === probe.baseUrl));
  const policy = computeDynamicPolicy(saved?.catalog, {
    codex: { models: readCodexPlusModels(home) }, magpie: magpie ?? known, custom: custom ?? savedCustom,
  }, config, saved);
  return { ...policy, lastDiff: policy.lastDiff.length ? policy.lastDiff : saved?.lastDiff ?? [],
    ...(saved?.syncError ? { syncError: saved.syncError } : {}) };
}

/** 并行更新评分和 Magpie 库存，网络失败时保留最近有效目录，原子替换策略文件。 */
export function syncModelPolicy(dataDir, config) {
  const key = path.resolve(dataDir);
  if (syncing.has(key)) return syncing.get(key);
  const pending = (async () => {
    const previous = readPolicyFile(key);
    const home = resolveCodexHome(config);
    const url = config.routing?.parallaxUrl;
    const [catalogResult, detectedMagpie, detectedCustom] = await Promise.allSettled([
      fetchParallaxCatalog(url), discoverMagpieModels(config.providers?.magpie, home),
      Promise.all((config.providers?.custom ?? []).filter((provider) => provider.enabled !== false)
        .map(async (provider) => ({ id: provider.id, baseUrl: provider.baseUrl, ...await testOpenAICompatProvider(provider) }))),
    ]);
    const fresh = catalogResult.status === "fulfilled";
    const catalog = fresh ? catalogResult.value : previous?.catalog;
    const magpieSource = config.providers?.magpie?.baseUrl;
    const detected = detectedMagpie.status === "fulfilled" ? detectedMagpie.value : null;
    const magpieInventory = detected && (detected.reachable || detected.totalModels > 0) ? detected
      : previous?.magpieSource === magpieSource ? previous?.magpieInventory : detected;
    const customInventory = detectedCustom.status === "fulfilled" ? detectedCustom.value : previous?.customInventory;
    const policy = computeDynamicPolicy(catalog, {
      codex: { models: readCodexPlusModels(home) }, magpie: magpieInventory, custom: customInventory,
    }, config, previous);
    if (fresh) policy.syncedAt = new Date().toISOString();
    else policy.syncError = "暂时无法更新 Parallax 目录，已按本地可用信息计算";
    fs.mkdirSync(key, { recursive: true });
    const temporary = path.join(key, `${POLICY_FILE}.${randomUUID()}.tmp`);
    try {
      fs.writeFileSync(temporary, JSON.stringify({ ...policy, catalog, magpieInventory, magpieSource, customInventory }), { mode: 0o600 });
      fs.renameSync(temporary, path.join(key, POLICY_FILE));
    } finally {
      fs.rmSync(temporary, { force: true });
    }
    return policy;
  })().finally(() => syncing.delete(key));
  syncing.set(key, pending);
  return pending;
}

/** 在超过策略时效后发起共享刷新，失败后最多每分钟重试一次。 */
export function triggerBackgroundPolicyRefreshIfStale(dataDir, config) {
  const key = path.resolve(dataDir);
  const now = Date.now();
  const savedAt = Date.parse(loadModelPolicy(key).syncedAt);
  const hours = Number(config.routing?.parallaxSyncTtlHours ?? 72);
  const ttl = Number.isFinite(hours) && hours >= 0 ? hours * 3_600_000 : 72 * 3_600_000;
  if (now - savedAt < ttl || now - (refreshAttempts.get(key) ?? 0) < 60_000) return null;
  refreshAttempts.set(key, now);
  return syncModelPolicy(key, config);
}
