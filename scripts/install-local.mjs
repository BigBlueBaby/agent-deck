/**
 * 本地开发一键安装与历史数据迁移脚本。
 * 用法：
 *   node scripts/install-local.mjs
 *   node scripts/install-local.mjs --migrate-legacy
 *
 * 功能：
 * 1. 将 AgentDeck 插件文件同步至 ~/.gemini/config/plugins/agent-deck（排除 .git / .data / 截图）；
 * 2. 可选（--migrate-legacy）将旧版 codex-workbench 的 SQLite 历史工单无损复制到 plugin_data/agent-deck/。
 *
 * @author AgentDeck Contributors
 * @since 2026-11-27
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const TARGET_PLUGIN_DIR = path.join(os.homedir(), ".gemini", "config", "plugins", "agent-deck");
const TARGET_DATA_DIR = path.join(os.homedir(), ".gemini", "antigravity", "plugin_data", "agent-deck");
const LEGACY_DATA_DIR = path.join(os.homedir(), ".gemini", "antigravity", "plugin_data", "codex-workbench");

const INCLUDE_ITEMS = [
  "plugin.json",
  "mcp_config.json",
  "package.json",
  "LICENSE",
  "README.md",
  "README.zh-CN.md",
  "assets",
  "rules",
  "skills",
  "src",
  "dist",
  "scripts",
  "node_modules",
];

function copyRecursive(src, dst) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const ent of fs.readdirSync(src)) {
      if (ent === ".git" || ent === ".data" || ent === "test-screenshots") continue;
      copyRecursive(path.join(src, ent), path.join(dst, ent));
    }
  } else {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
}

function main() {
  const migrateLegacy = process.argv.includes("--migrate-legacy");
  fs.mkdirSync(TARGET_PLUGIN_DIR, { recursive: true });

  for (const item of INCLUDE_ITEMS) {
    const src = path.join(ROOT, item);
    if (!fs.existsSync(src)) continue;
    copyRecursive(src, path.join(TARGET_PLUGIN_DIR, item));
  }
  console.log(`[OK] Installed AgentDeck plugin files to ${TARGET_PLUGIN_DIR}`);

  if (migrateLegacy && fs.existsSync(LEGACY_DATA_DIR)) {
    fs.mkdirSync(TARGET_DATA_DIR, { recursive: true });
    const legacyDb = path.join(LEGACY_DATA_DIR, "workbench.sqlite");
    const targetDb = path.join(TARGET_DATA_DIR, "workbench.sqlite");
    if (fs.existsSync(legacyDb) && !fs.existsSync(targetDb)) {
      fs.copyFileSync(legacyDb, targetDb);
      for (const suffix of ["-wal", "-shm"]) {
        if (fs.existsSync(legacyDb + suffix)) {
          fs.copyFileSync(legacyDb + suffix, targetDb + suffix);
        }
      }
      console.log(`[OK] Migrated legacy SQLite history to ${targetDb}`);
    }
    const legacyPolicy = path.join(LEGACY_DATA_DIR, "model-policy.json");
    const targetPolicy = path.join(TARGET_DATA_DIR, "model-policy.json");
    if (fs.existsSync(legacyPolicy) && !fs.existsSync(targetPolicy)) {
      fs.copyFileSync(legacyPolicy, targetPolicy);
      console.log(`[OK] Migrated legacy Parallax policy snapshot to ${targetPolicy}`);
    }
  }
}

main();
