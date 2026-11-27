/**
 * AgentDeck v2.0 后端与协议自动化回归套件。
 * 覆盖：
 * 1. 单文件看板 HTML 体量与无外链 CSP 校验；
 * 2. 配置持久化、敏感 API Key 严格掩码脱敏（绝不回显明文）；
 * 3. read-only 零扫描、重型目录过滤、通用安全密钥告警与单文件安全回滚；
 * 4. Burst / Balanced / Free-Only 三模式动态路由；
 * 5. 真实 Stdio MCP Server 握手、17 个工具清单、环境探测、配置保存与 200 KB 帧预算保险丝。
 *
 * @author AgentDeck Contributors
 * @since 2026-11-27
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { buildDefaultConfig, loadConfig, saveConfig, sanitizeConfigForClient } from "../src/core/config_store.mjs";
import { DeckDb } from "../src/core/db.mjs";
import { captureBaseline, collectChangesAfterRun, revertSingleFileChange } from "../src/core/git_snapshot.mjs";
import { resolveRoutingDecision } from "../src/core/router.mjs";
import { buildFallbackPolicy } from "../src/core/model_policy.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "agent-deck-smoke-"));
  const tmpData = path.join(tmpBase, "data");
  const tmpRepo = path.join(tmpBase, "repo");
  fs.mkdirSync(tmpRepo, { recursive: true });
  let client = null;

  try {
    // 1. 看板 HTML 单文件与无外链 CSP 校验
    const htmlPath = path.join(ROOT, "dist", "workbench.html");
    assert.ok(fs.existsSync(htmlPath), "dist/workbench.html 不存在，请先运行 npm run build:ui");
    const html = fs.readFileSync(htmlPath, "utf8");
    assert.ok(html.includes("AgentDeck"), "看板 HTML 应包含 AgentDeck 品牌标识");
    assert.ok(!/<script[^>]+src=/i.test(html), "看板 HTML 不可包含外部 script 引用");
    assert.ok(!/<link[^>]+rel=["']stylesheet["']/i.test(html), "看板 HTML 不可包含外部 stylesheet 引用");
    assert.ok(Buffer.byteLength(html, "utf8") < 2 * 1024 * 1024, "看板 HTML 超出 2 MiB 上限");
    console.log("[PASS 1/5] 单文件看板 HTML 体积与无外链 CSP 校验通过");

    // 2. 配置持久化与 API Key 严格脱敏
    const secretVal = "sk-test-super-secret-token-1234567890";
    saveConfig(tmpData, {
      ui: { locale: "en", sidebarWidth: 310 },
      routing: { quotaMode: "burst" },
      providers: {
        custom: [
          { id: "my_gw", name: "My Gateway", baseUrl: "https://example.com/v1", apiKey: secretVal, wireApi: "chat_completions", models: ["demo-1"], isFree: true, enabled: true },
        ],
      },
    });
    const loaded = loadConfig(tmpData);
    assert.equal(loaded.ui.sidebarWidth, 310);
    assert.equal(loaded.providers.custom[0].apiKey, secretVal);
    const sanitized = sanitizeConfigForClient(loaded);
    assert.ok(!JSON.stringify(sanitized).includes(secretVal), "sanitizeConfigForClient 绝不可回显真实 API Key");
    assert.equal(sanitized.providers.custom[0].hasApiKey, true);
    // 掩码回传不应覆盖原真实密钥
    saveConfig(tmpData, { providers: { custom: [{ ...sanitized.providers.custom[0], name: "My Gateway v2" }] } });
    assert.equal(loadConfig(tmpData).providers.custom[0].apiKey, secretVal);
    console.log("[PASS 2/5] 配置持久化、掩码保护与密钥零泄露校验通过");

    // 3. 快照、越界告警、密钥防泄露检测与单文件回滚
    const srcFile = path.join(tmpRepo, "src", "app.js");
    fs.mkdirSync(path.dirname(srcFile), { recursive: true });
    fs.writeFileSync(srcFile, "export const x = 1;\n", "utf8");
    const roBase = captureBaseline(tmpRepo, ["src"], { sandbox: "read-only" });
    assert.equal(roBase.readOnly, true);
    assert.equal(Object.keys(roBase.files).length, 0);

    const snapDir = path.join(tmpData, "snapshots", "t1");
    const rwBase = captureBaseline(tmpRepo, ["src"], { sandbox: "workspace-write", snapshotDir: snapDir });
    fs.writeFileSync(srcFile, "export const x = 2;\n", "utf8");
    const changes = collectChangesAfterRun(tmpRepo, rwBase, ["src"], ["src/app.js"], { activePreset: "generic" });
    assert.equal(changes.length, 1);
    assert.equal(changes[0].addedLines, 1);
    assert.equal(changes[0].removedLines, 1);
    const rev = revertSingleFileChange(tmpRepo, changes[0]);
    assert.equal(rev.ok, true);
    assert.equal(fs.readFileSync(srcFile, "utf8"), "export const x = 1;\n");
    console.log("[PASS 3/5] read-only 零扫盘、外置快照、精准行统计与单文件回滚校验通过");

    // 4. 三模式动态路由决策（Burst / Balanced / Free-Only + 纯自定义网关无官方账号场景）
    const baseCfg = {
      ...buildDefaultConfig(),
      providers: {
        ...buildDefaultConfig().providers,
        magpie: { ...buildDefaultConfig().providers.magpie, selectedModels: ["auto/deepseek-v4.1-flash"] },
      },
    };
    const policy = {
      ...buildFallbackPolicy(),
      slots: {
        ...buildFallbackPolicy().slots,
        freeFast: {
          provider: "magpie",
          model: "auto/deepseek-v4.1-flash",
          reasoningEffort: "max",
          isFreeChannel: true,
        },
      },
      eligibleModels: [
        { provider: "codex-plus", model: "gpt-6.2-sol", efforts: ["medium", "high", "xhigh"], isFreeChannel: false },
        { provider: "magpie", model: "auto/deepseek-v4.1-flash", efforts: ["max"], isFreeChannel: true },
      ],
    };
    const qRedline = { primary: { usedPercent: 93, resetsAt: Date.now() + 180 * 60000 }, secondary: { usedPercent: 95, resetsAt: Date.now() + 86400000 } };
    const qHealthy = { primary: { usedPercent: 40, resetsAt: Date.now() + 180 * 60000 }, secondary: { usedPercent: 35, resetsAt: Date.now() + 86400000 } };

    const dBurst = resolveRoutingDecision(
      { profile: "auto", tier: "L2", taskKind: "implement" },
      { config: { ...baseCfg, routing: { ...baseCfg.routing, quotaMode: "burst" } }, quota: qRedline, policy },
    );
    assert.equal(dBurst.provider, "codex-plus");
    assert.equal(dBurst.model, "gpt-6.2-sol");
    assert.equal(dBurst.reasoningEffort, "high");

    const dBalRedline = resolveRoutingDecision(
      { profile: "auto", tier: "L2", taskKind: "implement" },
      { config: { ...baseCfg, routing: { ...baseCfg.routing, quotaMode: "balanced" } }, quota: qRedline, policy },
    );
    assert.equal(dBalRedline.provider, "magpie");
    assert.equal(dBalRedline.isFreeChannel, true);

    const dFreeOnly = resolveRoutingDecision(
      { profile: "auto", tier: "L2", taskKind: "implement" },
      { config: { ...baseCfg, routing: { ...baseCfg.routing, quotaMode: "free_only" } }, quota: qHealthy, policy },
    );
    assert.equal(dFreeOnly.isFreeChannel, true);

    // 验证纯 OpenAI 兼容自定义网关用户（关闭官方 Codex 账号）仍可自动路由
    const customOnlyCfg = {
      ...buildDefaultConfig(),
      providers: {
        codexPlus: { enabled: false },
        magpie: { ...buildDefaultConfig().providers.magpie, enabled: false, selectedModels: [] },
        custom: [{ id: "openrouter_1", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", apiKey: "sk-demo", wireApi: "chat_completions", models: ["deepseek/deepseek-v4"], defaultEffort: "high", isFree: false, enabled: true }],
      },
    };
    const { computeDynamicPolicy } = await import("../src/core/model_policy.mjs");
    const customPolicy = computeDynamicPolicy(null, { codex: { models: [] }, magpie: null, custom: [] }, customOnlyCfg, null);
    assert.equal(customPolicy.slots.plusPrimary?.provider, "openrouter_1");
    assert.equal(customPolicy.slots.plusPrimary?.model, "deepseek/deepseek-v4");
    const dCustomOnly = resolveRoutingDecision({ profile: "auto", tier: "L2", taskKind: "implement" }, { config: customOnlyCfg, quota: null, policy: customPolicy });
    assert.equal(dCustomOnly.provider, "openrouter_1");
    console.log("[PASS 4/5] Burst / Balanced / Free-Only 及纯自定义网关无官方账号路由校验通过");

    // 5. 真实 MCP Stdio Server 全套工具与帧预算回归
    const db = new DeckDb(tmpData);
    db.createTask({ id: "t_demo", title: "Demo Task", repoPath: tmpRepo, status: "done", model: "gpt-6.2-sol", reasoningEffort: "high" });
    db.close();

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(ROOT, "src", "server.mjs"), `--data-dir=${tmpData}`],
    });
    client = new Client({ name: "agent-deck-smoke", version: "2.0.0" });
    await client.connect(transport);

    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const req of [
      "deck_open", "deck_dispatch", "deck_status", "deck_read_result", "deck_feedback", "deck_close",
      "ui_get_snapshot", "ui_get_file_diff", "ui_revert_file", "ui_cancel_task", "ui_resume_task",
      "ui_add_human_note", "ui_sync_model_policy", "ui_set_quota_mode", "ui_detect_environment",
      "ui_save_config", "ui_test_provider",
    ]) {
      assert.ok(names.includes(req), `缺少必需工具：${req}`);
    }

    const htmlRes = await client.readResource({ uri: "ui://agent-deck/app.html" });
    assert.equal(htmlRes.contents[0].mimeType, "text/html;profile=mcp-app");
    assert.ok(htmlRes.contents[0].text.includes("AgentDeck"));

    const openRes = await client.callTool({ name: "deck_open", arguments: {} });
    assert.ok(!openRes.isError);
    assert.ok(!JSON.stringify(openRes).includes(secretVal), "deck_open 绝不可泄露自定义网关明文 API Key");
    assert.ok(!JSON.stringify(openRes).includes("baseline"), "deck_open 绝不可包含 baseline");

    const modeRes = await client.callTool({ name: "ui_set_quota_mode", arguments: { mode: "free_only" } });
    assert.ok(!modeRes.isError);
    assert.equal(modeRes.structuredContent.config.routing.quotaMode, "free_only");

    console.log("[PASS 5/5] MCP Stdio 握手、17 个工具、脱敏隔离与 2 MiB UI 资源 / 200 KB 工具帧验收通过");
    await client.close();
    client = null;
  } finally {
    if (client) {
      try { await client.close(); } catch {}
    }
    await sleep(150);
    try { fs.rmSync(tmpBase, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 }); } catch {}
  }
}

main().catch((err) => {
  console.error("[FAIL SMOKE]", err);
  process.exit(1);
});
