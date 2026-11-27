import { buildFallbackPolicy } from "./model_policy.mjs";
import { consumesCodexPlus, gatewayUrl } from "../providers/magpie_gateway.mjs";

const profileSlots = {
  "plus-high": "plusPrimary", "plus-clean": "plusEco", "plus-flagship": "plusFlagship", "magpie-fast": "freeFast",
};
const knownEfforts = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);

/** 将历史 provider 别名转换为稳定 ID。 */
export function normalizeProvider(provider) {
  if (["plus", "codexPlus", "codex", "openai"].includes(provider)) return "codex-plus";
  return provider === "auto" ? "" : provider || "";
}

/** 兼容 Unix 秒、毫秒和 ISO 时间；已重置的观测值不参与降档。 */
function windowState(window, now) {
  const raw = window?.resetsAt ?? window?.resets_at;
  const reset = raw == null ? NaN : Number.isFinite(Number(raw))
    ? Number(raw) * (Number(raw) < 1e12 ? 1000 : 1) : Date.parse(raw);
  const minutes = Number.isFinite(reset) ? (reset - now) / 60_000 : Infinity;
  const used = window?.usedPercent ?? window?.used_percent;
  return { minutes, used: minutes <= 0 || used == null || !Number.isFinite(Number(used)) ? null : Number(used) };
}

/** 先处理免费约束，再根据任务和两个配额窗口确定自动槽位。 */
function autoSlot(mode, tier, taskKind, quota, now) {
  if (mode === "free_only") return ["freeFast", "仅免费模式"];
  const primary = windowState(quota?.primary, now);
  const weekly = windowState(quota?.secondary, now);
  const abundance = primary.minutes <= 90 && primary.used != null && primary.used < 65 &&
    weekly.used != null && weekly.used < 70;
  if (mode === "burst") {
    if (taskKind === "mechanical") return ["plusEco", "性能模式的机械任务"];
    if (tier === "L3" && abundance) return ["plusFlagship", "性能模式，临近重置且配额充裕"];
    return ["plusPrimary", "性能模式"];
  }
  if (taskKind === "mechanical" || primary.used >= 90 || weekly.used >= 92) {
    return ["freeFast", taskKind === "mechanical" ? "机械任务优先免费" : "配额接近上限"];
  }
  if (primary.used >= 80 || weekly.used >= 85 ||
    (taskKind === "implement" && (primary.used >= 65 || weekly.used >= 70))) {
    return ["plusEco", "配额达到均衡降档阈值"];
  }
  if (abundance) return [tier === "L3" ? "plusFlagship" : "plusBoost", "临近重置且配额充裕"];
  return ["plusPrimary", "均衡模式默认选型"];
}

/** 从配置检索指定通道并校验显式模型选择。 */
function resolveProvider(config, policy, provider, model, candidate) {
  const providers = config.providers ?? {};
  const eligible = policy.eligibleModels ?? [];
  const matching = eligible.find((entry) => entry.provider === provider && entry.model === model);
  if (provider === "codex-plus") {
    if (providers.codexPlus?.enabled === false) throw new Error("Codex 官方通道已停用");
    if (eligible.some((entry) => entry.provider === provider) && !matching) throw new Error("模型不在可用 Codex 清单中");
    return { providerConfig: providers.codexPlus ?? {}, isFreeChannel: false, efforts: matching?.efforts };
  }
  if (provider === "magpie") {
    const providerConfig = providers.magpie;
    if (!providerConfig || providerConfig.enabled === false) throw new Error("Magpie 已停用");
    if (!providerConfig.selectedModels?.includes(model)) throw new Error("请先在设置中勾选该 Magpie 模型");
    gatewayUrl(providerConfig.baseUrl);
    return {
      providerConfig,
      isFreeChannel: !consumesCodexPlus(model) && (matching?.isFreeChannel ??
        (candidate?.provider === provider && candidate.model === model && candidate.isFreeChannel === true)),
      efforts: matching?.efforts,
    };
  }
  const providerConfig = providers.custom?.find((entry) => entry.id === provider && entry.enabled !== false);
  if (!providerConfig) throw new Error("指定的自定义供应商未启用");
  gatewayUrl(providerConfig.baseUrl);
  if (providerConfig.models?.length && !providerConfig.models.includes(model)) throw new Error("模型未配置在此自定义网关下");
  return { providerConfig, isFreeChannel: providerConfig.isFree === true };
}

/** 解析模式、覆盖和槽位，始终在返回前验证免费约束及当前供应商配置。 */
export function resolveRoutingDecision(params, { config, quota, policy = buildFallbackPolicy() }) {
  const mode = config.routing?.quotaMode ?? "balanced";
  const requestedProfile = params.profile || "auto";
  const taskKind = params.taskKind || "implement";
  const slots = policy.slots ?? policy;
  // 1. 计算自动槽位，显式 provider、profile 或 model 优先参与候选定位。
  const [automatic, why] = autoSlot(mode, params.tier, taskKind, quota, Date.now());
  const slotName = Object.hasOwn(profileSlots, requestedProfile) ? profileSlots[requestedProfile] : automatic;
  const requestedProvider = normalizeProvider(params.provider) ||
    (requestedProfile !== "auto" && !Object.hasOwn(profileSlots, requestedProfile) ? normalizeProvider(requestedProfile) : "");
  const explicitModel = params.model && params.model !== "auto" ? params.model : "";
  const custom = config.providers?.custom?.find((item) => item.id === requestedProvider && item.enabled !== false);
  const identityMatch = explicitModel ? policy.eligibleModels?.find((item) => item.model === explicitModel &&
    (!requestedProvider || item.provider === requestedProvider)) : null;
  const magpieSelected = config.providers?.magpie?.selectedModels ?? [];
  const inferred = requestedProvider || identityMatch?.provider ||
    (explicitModel && magpieSelected.includes(explicitModel) ? "magpie" : "");
  let candidate = slots[slotName];
  if (inferred && candidate?.provider !== inferred) {
    candidate = Object.values(slots).find((entry) => entry?.provider === inferred) ?? null;
  }
  const provider = inferred || candidate?.provider || (explicitModel && mode !== "free_only" ? "codex-plus" : "");
  const model = explicitModel || candidate?.model || custom?.models?.[0] ||
    (provider === "magpie" ? magpieSelected[0] : "");
  if (!provider || !model) {
    throw new Error(slotName === "freeFast" ? "找不到已选且确认免费的模型，请先配置免费通道" : "找不到可用的路由模型");
  }
  // 2. 对照当前配置重新校验，确保已撤销勾选和停用通道不会沿用旧策略。
  const { providerConfig, isFreeChannel, efforts } = resolveProvider(config, policy, provider, model, candidate);
  if (mode === "free_only" && !isFreeChannel) throw new Error("仅免费模式禁止使用可能消耗付费额度的模型");
  const explicitEffort = params.reasoningEffort === "auto" ? null : params.reasoningEffort;
  const defaultEffort = (candidate?.model === model ? candidate.reasoningEffort : null) ??
    providerConfig.defaultEffort ?? (efforts?.includes("high") ? "high" : efforts?.[0]) ??
    (provider === "codex-plus" ? "high" : "");
  let reasoningEffort = explicitEffort ?? defaultEffort;
  if (reasoningEffort && !knownEfforts.has(reasoningEffort)) throw new Error("推理档位不受支持");
  if (reasoningEffort && efforts?.length && !efforts.includes(reasoningEffort)) {
    if (explicitEffort) throw new Error("所选模型不支持指定推理档位");
    reasoningEffort = efforts.includes("high") ? "high" : efforts[0];
  }
  // 3. 只向执行器交付 providerConfig，外部状态使用其余公开字段。
  const explicit = requestedProfile !== "auto" || requestedProvider || explicitModel || explicitEffort;
  const defaultProfile = provider === "codex-plus" ? "plus-high" : provider === "magpie" ? "magpie-fast" : provider;
  return {
    adapter: "codex", provider, providerConfig,
    profile: requestedProfile !== "auto" ? requestedProfile : candidate?.profile || defaultProfile,
    model, reasoningEffort, taskKind, isFreeChannel,
    routingReason: explicit ? "使用显式路由参数" : `${why} · ${slotName}`,
  };
}
