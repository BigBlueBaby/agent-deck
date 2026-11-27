import fs from "node:fs/promises";
import path from "node:path";
import { readEfforts } from "./codex_plus.mjs";

/** 统一识别转发到 Codex Plus 的 Magpie 模型，优先于免费归属标签。 */
export function consumesCodexPlus(id, owner) {
  return owner === "codex" || /^(group|codex)\//.test(id);
}

/** 接受 HTTP(S) 基址，拒绝 URL 内嵌凭据，避免在错误或界面中暴露凭据。 */
export function gatewayUrl(baseUrl, operation = "") {
  const url = new URL(baseUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("网关基址必须为不含凭据、查询参数或片段的 HTTP(S) URL");
  }
  url.pathname = url.pathname.replace(/\/+$/, "") + (operation ? `/${operation}` : "");
  return url;
}

/** 按网关归属整理模型，保留可用于路由和界面展示的公开元数据。 */
function groupModels(data, freeOwners) {
  const rows = Array.isArray(data) ? data : data?.data ?? data?.models ??
    (Array.isArray(data?.groups) ? data.groups.flatMap((group) => (group.models || [])
      .map((model) => ({ owned_by: group.owner, ...model }))) : null);
  if (!Array.isArray(rows)) throw new Error("模型目录格式无效");
  const groups = new Map();
  const seen = new Set();
  for (const row of rows) {
    const id = row?.id ?? row?.slug;
    if (typeof id !== "string" || !id || seen.has(id)) continue;
    seen.add(id);
    const ownedBy = String(row.owned_by ?? row.ownedBy ?? row.provider ?? (id.includes("/") ? id.split("/")[0] : "unknown"));
    const isFreeOwner = ownedBy !== "codex" && freeOwners.has(ownedBy);
    const group = groups.get(ownedBy) ?? { owner: ownedBy, isFreeOwner, models: [] };
    group.models.push({
      id, displayName: row.display_name ?? row.displayName ?? row.name ?? id, ownedBy,
      ctx: row.context_window ?? row.context_length ?? row.ctx ?? null,
      efforts: readEfforts(row.supported_reasoning_levels ?? row.efforts),
      pricing: row.pricing ?? null, consumesCodexPlus: consumesCodexPlus(id, ownedBy),
    });
    groups.set(ownedBy, group);
  }
  return { totalModels: seen.size, groups: [...groups.values()] };
}

/** 查询 Magpie 的完整目录，离线时按优先级读取已有本地目录。 */
export async function discoverMagpieModels(magpieConfig = {}, codexHome) {
  const defaultPath = codexHome ? path.join(codexHome, "magpie-desktop-models.json") : "";
  const catalogPath = magpieConfig.catalogPath ? path.resolve(magpieConfig.catalogPath) : defaultPath;
  const status = { reachable: false, baseUrl: "", totalModels: 0, groups: [], catalogPath };
  try {
    status.baseUrl = gatewayUrl(magpieConfig.baseUrl).href.replace(/\/$/, "");
  } catch {
    // 本地目录仍可展示，非法基址不返回给客户端。
  }
  if (magpieConfig.enabled === false) return status;
  const freeOwners = new Set(magpieConfig.freeOwners ?? []);
  // 1. 优先使用在线目录，拒绝重定向，避免将认证头转发给其他地址。
  try {
    const response = await fetch(gatewayUrl(status.baseUrl, "models"), {
      headers: { Authorization: `Bearer ${magpieConfig.apiKey || "magpie"}` },
      redirect: "error", signal: AbortSignal.timeout(3000),
    });
    if (response.ok) {
      return { ...status, reachable: true, ...groupModels(await response.json(), freeOwners) };
    }
    await response.body?.cancel();
  } catch {
    // 网络或返回格式异常时尝试离线目录。
  }
  // 2. 明确区分目录可读与网关在线。
  for (const source of new Set([catalogPath, defaultPath].filter(Boolean))) {
    try {
      const data = JSON.parse(await fs.readFile(source, "utf8"));
      return { ...status, catalogPath: source, ...groupModels(data, freeOwners) };
    } catch {
      // 目录缺失或损坏时继续检查下一个候选。
    }
  }
  return status;
}
