import fs from "node:fs/promises";
import path from "node:path";
import { detectCodexRuntime, findCliOnPath, resolveCodexHome } from "./codex_plus.mjs";
import { discoverMagpieModels, gatewayUrl } from "./magpie_gateway.mjs";

/** 只读探测模型列表。错误仅含状态或固定说明，避免回显网关响应和认证信息。 */
export async function testOpenAICompatProvider(provider) {
  const start = performance.now();
  const finish = (models, error) => ({
    reachable: !error, latencyMs: Math.round(performance.now() - start),
    modelCount: models.length, discoveredModels: models, ...(error ? { error } : {}),
  });
  const key = provider?.apiKey || "";
  let url;
  try {
    url = gatewayUrl(provider?.baseUrl, "models");
  } catch {
    return finish([], "网关基址无效");
  }
  try {
    const response = await fetch(url, {
      headers: key ? { Authorization: `Bearer ${key}` } : {},
      redirect: "error", signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return finish([], `模型列表请求失败 (HTTP ${response.status})`);
    }
    const data = await response.json();
    if (!Array.isArray(data?.data)) return finish([], "网关模型列表格式无效");
    const models = data.data.map((item) => item?.id)
      .filter((id) => typeof id === "string" && id && (!key || !id.includes(key)));
    return finish([...new Set(models)]);
  } catch (error) {
    return finish([], error?.name === "TimeoutError" ? "模型列表请求超时" : "无法读取网关模型列表");
  }
}

/** 并行扫描本机执行器与启用的供应商，结果仅包含公开环境信息。 */
export async function detectAllProviders(config) {
  const claudePath = config.runtimes?.claude?.executablePath;
  const claude = claudePath
    ? fs.stat(claudePath).then((stat) => stat.isFile() ? [path.resolve(claudePath)] : [], () => [])
    : findCliOnPath("claude");
  const [codex, magpie, custom, claudeEntries] = await Promise.all([
    detectCodexRuntime(config),
    discoverMagpieModels(config.providers?.magpie, resolveCodexHome(config)),
    Promise.all((config.providers?.custom ?? []).filter((provider) => provider.enabled !== false)
      .map(async (provider) => ({
        id: provider.id, name: provider.name, isFree: provider.isFree === true,
        ...await testOpenAICompatProvider(provider),
      }))),
    claude,
  ]);
  return { codex, magpie, custom, claude: { available: claudeEntries.length > 0, executablePath: claudeEntries[0] || "" } };
}
