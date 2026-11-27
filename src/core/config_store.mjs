/**
 * AgentDeck 统一配置持久化中心（Zero-Hardcoding）。
 * 所有本机路径、供应商、自定义 OpenAI-compatible 网关、路由模式、UI 布局与工作区红线预设
 * 均保存在 `${dataDir}/config.json` 中，保证开源仓库零个人环境硬编码。
 *
 * 安全边界：对外暴露给看板/模型的配置对象统一经过 sanitizeConfigForClient() 掩码处理，
 * 绝不回显或向大模型泄露用户填写的自定义 API Key。
 *
 * @author AgentDeck Contributors
 * @since 2026-11-27
 */
import fs from "node:fs";
import path from "node:path";
import { normalizePresetId } from "../guardrails/presets.mjs";

const CONFIG_FILENAME = "config.json";

/**
 * 构建开源默认配置模板（跨平台零硬编码）。
 *
 * @returns {object} 默认配置对象
 */
export function buildDefaultConfig() {
  return {
    schemaVersion: 2,
    ui: {
      locale: "zh-CN", // "zh-CN" | "en"
      sidebarWidth: 268,
      sidebarCollapsed: false,
      pollRunningMs: 3000,
      pollIdleMs: 15000,
    },
    routing: {
      quotaMode: "balanced", // "burst" | "balanced" | "free_only"
      parallaxUrl: process.env.AGENT_DECK_PARALLAX_URL || "https://parallax.zzz.sd/",
      parallaxSyncTtlHours: Number(process.env.AGENT_DECK_PARALLAX_TTL_HOURS || 72),
      activeAdapter: "codex",
      // 用户显式锁定的模型槽位覆盖（留空则完全交由 Parallax 动态选型引擎自动决策）
      slotOverrides: {
        plusFlagship: "",
        plusPrimary: "",
        plusBoost: "",
        plusEco: "",
        freeFast: "",
      },
    },
    runtimes: {
      codex: {
        enabled: true,
        executablePath: "", // 留空自动跨平台探测（PATH / npm global / homebrew）
        codexHome: "",      // 留空自动探测（CODEX_HOME 环境变量 -> ~/.codex）
      },
      claude: {
        enabled: false,
        executablePath: "", // 预留 Phase 2 Claude Code CLI 适配器
      },
    },
    providers: {
      codexPlus: {
        enabled: true,
      },
      magpie: {
        enabled: true,
        baseUrl: process.env.MAGPIE_BASE_URL || "http://127.0.0.1:3425/v1",
        apiKey: "magpie",
        // 用户在「执行器与设置」页面自由勾选纳入自动路由的 Magpie 模型 ID 列表（默认空，由用户按本机发现自由勾选）
        selectedModels: [],
        // 标记为免费/低成本通道的 Magpie owned_by 归属白名单（绝不包含 codex）
        freeOwners: ["workbuddy", "opencode-zen-free", "trae-cn", "workbuddy-ai"],
        catalogPath: "",
      },
      custom: [
        // 示例结构：{ id, name, baseUrl, apiKey, wireApi: "responses"|"chat_completions", models: [], defaultEffort: "high", isFree: false, enabled: true }
      ],
    },
    guardrails: {
      activePreset: "generic", // "generic" | "no-build" | "strict-review"
      customRules: [],         // 用户个人可追加的自定义红线文本条（仅存本机 dataDir）
      disableNestedSubagents: true,
    },
    updatedAt: new Date().toISOString(),
  };
}

/**
 * 深度合并用户配置与默认模板，兼容未来字段升级。
 *
 * @param {object} base 默认配置
 * @param {object} patch 用户配置补丁
 * @returns {object}
 */
function deepMerge(base, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    return patch === undefined ? base : patch;
  }
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === "object" && !Array.isArray(v) && base[k] && typeof base[k] === "object" && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

/**
 * 获取配置文件路径。
 *
 * @param {string} dataDir 插件持久化数据目录
 * @returns {string}
 */
export function getConfigFilePath(dataDir) {
  return path.join(dataDir, CONFIG_FILENAME);
}

/**
 * 读取本地持久化配置；不存在或损坏时安全回退默认配置。
 *
 * @param {string} [dataDir] 数据目录
 * @returns {object}
 */
export function loadConfig(dataDir) {
  const defaults = buildDefaultConfig();
  if (!dataDir) return defaults;
  const filePath = getConfigFilePath(dataDir);
  if (!fs.existsSync(filePath)) return defaults;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const merged = deepMerge(defaults, parsed);
    merged.guardrails.activePreset = normalizePresetId(merged.guardrails?.activePreset);
    return merged;
  } catch {
    return defaults;
  }
}

/**
 * 原子落盘更新配置（保留未修改字段及既有自定义网关 API Key）。
 *
 * @param {string} dataDir 数据目录
 * @param {object} patch 增量配置补丁
 * @returns {object} 保存后的完整配置
 */
export function saveConfig(dataDir, patch = {}) {
  const current = loadConfig(dataDir);
  const next = deepMerge(current, patch);

  // 对 custom 列表特殊处理：若前端回传占位掩码 "••••" 则保留原真实 apiKey，防止误覆盖
  if (Array.isArray(patch?.providers?.custom)) {
    const oldById = new Map((current.providers?.custom || []).map((c) => [c.id, c]));
    next.providers.custom = patch.providers.custom.map((item) => {
      const prev = oldById.get(item.id);
      const rawKey = String(item.apiKey || "");
      const keepPrevKey = prev && (!rawKey || rawKey.includes("••••"));
      return {
        id: String(item.id || `prov_${Date.now().toString(36)}`),
        name: String(item.name || "Custom Provider").trim(),
        baseUrl: String(item.baseUrl || "").trim(),
        apiKey: keepPrevKey ? prev.apiKey : rawKey,
        wireApi: item.wireApi === "chat_completions" ? "chat_completions" : "responses",
        models: Array.isArray(item.models) ? item.models.map((m) => String(m).trim()).filter(Boolean) : [],
        defaultEffort: String(item.defaultEffort || "high").trim(),
        isFree: Boolean(item.isFree),
        enabled: item.enabled !== false,
      };
    });
  }

  // 边界收敛：侧栏宽度限制在 200~420px，配额模式收敛到枚举值
  next.ui.sidebarWidth = Math.max(200, Math.min(420, Number(next.ui.sidebarWidth || 268)));
  next.ui.locale = next.ui.locale === "en" ? "en" : "zh-CN";
  if (!["burst", "balanced", "free_only"].includes(next.routing.quotaMode)) {
    next.routing.quotaMode = "balanced";
  }
  next.guardrails.activePreset = normalizePresetId(next.guardrails?.activePreset);
  next.updatedAt = new Date().toISOString();

  if (dataDir) {
    fs.mkdirSync(dataDir, { recursive: true });
    const filePath = getConfigFilePath(dataDir);
    const tmpPath = `${filePath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(next, null, 2), "utf8");
    fs.renameSync(tmpPath, filePath);
  }
  return next;
}

/**
 * 对密钥执行安全脱敏掩码（仅保留状态，绝不回显真实明文给前端或大模型）。
 *
 * @param {string} key 原始密钥
 * @returns {string}
 */
function maskSecret(key) {
  const s = String(key || "").trim();
  if (!s) return "";
  if (s === "magpie") return "magpie";
  if (s.length <= 6) return "••••";
  return `${s.slice(0, 3)}••••${s.slice(-2)}`;
}

/**
 * 生成可安全返回给前端 UI 的脱敏配置副本。
 *
 * @param {object} config 原始配置对象
 * @returns {object} 脱敏后的公开配置
 */
export function sanitizeConfigForClient(config) {
  const clone = structuredClone(config || buildDefaultConfig());
  if (clone.providers?.magpie?.apiKey) {
    clone.providers.magpie.apiKey = maskSecret(clone.providers.magpie.apiKey);
  }
  if (Array.isArray(clone.providers?.custom)) {
    clone.providers.custom = clone.providers.custom.map((item) => ({
      ...item,
      hasApiKey: Boolean(item.apiKey),
      apiKey: maskSecret(item.apiKey),
    }));
  }
  return clone;
}
