import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const jsEntry = /\.[cm]?js$/i;
const execOptions = { timeout: 2000, windowsHide: true, maxBuffer: 64 * 1024 };

/** 解析 CLI 和遥测共用的 Codex 数据目录。 */
export function resolveCodexHome(config) {
  return path.resolve(config?.runtimes?.codex?.codexHome || process.env.CODEX_HOME ||
    path.join(os.homedir(), ".codex"));
}

/** 归一化供应商公开的推理档位。 */
export function readEfforts(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((value) => typeof value === "string" ? value : value?.effort)
    .filter((value) => typeof value === "string" && value.length > 0))];
}

/** 读取可见官方模型，只有缓存缺失或损坏时才使用默认模型。 */
export function readCodexPlusModels(codexHome) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(codexHome, "models_cache.json"), "utf8"));
    const models = Array.isArray(data) ? data : data.models;
    if (!Array.isArray(models)) throw new Error("模型缓存格式无效");
    return models.filter((model) => model?.visibility !== "hide" && typeof model?.slug === "string")
      .map((model) => ({
        slug: model.slug,
        ctx: model.context_window ?? model.contextWindow ?? model.ctx ?? null,
        efforts: readEfforts(model.supported_reasoning_levels ?? model.efforts),
        visibility: model.visibility ?? "list",
      }));
  } catch {
    return ["gpt-6.2-sol", "gpt-6.2-astra"].map((slug) => ({
      slug, ctx: null, efforts: ["low", "medium", "high", "xhigh"], visibility: "list",
    }));
  }
}

/** 查找命令的 PATH 入口，不经 shell 解析用户配置。 */
export async function findCliOnPath(command) {
  try {
    const { stdout } = await exec(process.platform === "win32" ? "where.exe" : "which", [command], execOptions);
    return stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/** 解析 Windows npm 启动器对应的 JavaScript 入口。 */
function resolveCodexEntry(candidate) {
  if (!candidate) return null;
  const absolute = path.resolve(candidate);
  const entry = process.platform === "win32" && !jsEntry.test(absolute) &&
    !/\.(exe|com)$/i.test(absolute)
    ? path.join(path.dirname(absolute), "node_modules", "@openai", "codex", "bin", "codex.js")
    : absolute;
  return fs.statSync(entry, { throwIfNoEntry: false })?.isFile() ? entry : null;
}

/** 探测真实 CLI 版本、数据目录、模型缓存；探测失败保留可展示的目录和模型信息。 */
export async function detectCodexRuntime(config) {
  const codexHome = resolveCodexHome(config);
  const runtime = config?.runtimes?.codex;
  const result = {
    available: false, executablePath: "", isJsEntry: false, codexHome, version: "",
    models: readCodexPlusModels(codexHome),
    codexHomeExists: fs.existsSync(codexHome),
    modelsCacheExists: fs.existsSync(path.join(codexHome, "models_cache.json")),
  };
  if (runtime?.enabled === false) return result;

  // 1. 显式配置独立验证，自动探测优先 npm 入口再查 PATH，避免执行 Windows shim。
  const npmEntry = process.platform === "win32" && process.env.APPDATA
    ? path.join(process.env.APPDATA, "npm", "node_modules", "@openai", "codex", "bin", "codex.js") : "";
  const candidates = runtime?.executablePath ? [runtime.executablePath] : [npmEntry, ...await findCliOnPath("codex")];
  const checked = new Set();
  // 2. 用实际版本命令确认可执行性，只返回结构化结果。
  for (const candidate of candidates) {
    try {
      const executablePath = resolveCodexEntry(candidate);
      if (!executablePath || checked.has(executablePath)) continue;
      checked.add(executablePath);
      const isJsEntry = jsEntry.test(executablePath);
      const args = isJsEntry ? [executablePath, "--version"] : ["--version"];
      const { stdout } = await exec(isJsEntry ? process.execPath : executablePath, args, {
        ...execOptions, env: { ...process.env, CODEX_HOME: codexHome },
      });
      return { ...result, available: true, executablePath, isJsEntry, version: stdout.trim().split(/\r?\n/)[0] };
    } catch {
      // PATH 中的残留入口不可执行时继续探测其他候选。
    }
  }
  return result;
}
