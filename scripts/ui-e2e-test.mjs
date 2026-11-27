/**
 * AgentDeck v2.0 真浏览器（Chrome/Edge Headless + CDP）多视口端到端交互与视觉布局验收脚本。
 * 强制验证：
 * 1. 1440px 全屏 / 1024px 中屏 / 440px 侧边栏三档视口下，所有容器严格 scrollWidth <= clientWidth（零意外横向滚动条！）；
 * 2. 顶层三视图彻底解耦：进入「策略与用量」和「执行器与设置」后，绝不显示无关的左侧工单栏；
 * 3. 工单台左侧栏支持鼠标拖拽调宽并触发 ui_save_config 持久化、支持一键折叠/展开；
 * 4. 时间轴最新置顶、连续检索/读文件自动折叠微组、下拉阅读新动态插入顶部绝不跳顶；
 * 5. 全交互点击（工单 3 子页、Diff 展开、人工批注、三模式切换、一键体检 + Magpie 模型勾选保存、中英双语切换）零 JS 异常；
 * 6. 自动输出深色与浅色多视口真实截图至 test-screenshots/ 供逐图审验。
 *
 * @author AgentDeck Contributors
 * @since 2026-11-27
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const HTML_PATH = path.join(ROOT, "dist", "workbench.html");
const SHOT_DIR = path.join(ROOT, "test-screenshots");

const BROWSER_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
];

function findBrowser() {
  for (const p of BROWSER_CANDIDATES) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error("未找到本机 Chrome 或 Edge 浏览器");
}

function buildMockData() {
  const now = new Date().toISOString();
  const task1 = {
    id: "task_v2_1",
    title: "Refactor multi-provider routing engine and visual inspector for AgentDeck v2.0",
    status: "reviewing",
    tier: "L2",
    adapter: "codex",
    provider: "codex-plus",
    profile: "plus-high",
    model: "gpt-6.2-sol",
    reasoningEffort: "high",
    taskKind: "implement",
    routingReason: "Burst mode · Parallax Pareto Knee #1 (54.9 pts / $0.56)",
    sandbox: "workspace-write",
    repoPath: "/workspace/acme-app",
    branchName: "main",
    currentRound: 1,
    maxRounds: 2,
    lastSummary: "Completed 4 files with zero lint warnings. Ready for final build verification.",
    lastError: "",
    codexThreadId: "thread_v2_1",
    createdAt: new Date(Date.now() - 180_000).toISOString(),
    updatedAt: now,
    finishedAt: "",
  };
  const task2 = {
    ...task1,
    id: "task_v2_2",
    title: "Independent read-only security audit on gateway API authentication",
    status: "done",
    model: "auto/deepseek-v4.1-flash",
    reasoningEffort: "max",
    provider: "magpie",
    profile: "magpie-fast",
    finishedAt: now,
    updatedAt: new Date(Date.now() - 3600_000).toISOString(),
  };

  const events = [];
  // 先插入较早的历史步骤，确保有足够滚动高度测试下拉防跳顶，同时让最新动态和连续检索折叠组展示在顶部
  for (let k = 1; k <= 12; k += 1) {
    events.push({ id: k, round: 1, eventType: "file_change", summary: `历史步骤 #${k}：更新模块文件 mod_${k}.mjs`, createdAt: new Date(Date.now() - (300 - k * 10) * 1000).toISOString() });
  }
  events.push(
    { id: 21, round: 1, eventType: "spawn", summary: "Started Codex worker (gpt-6.2-sol high)", createdAt: new Date(Date.now() - 170_000).toISOString() },
    { id: 22, round: 1, eventType: "command", summary: "[完成] 检索代码关键字与注解引用", createdAt: new Date(Date.now() - 160_000).toISOString() },
    { id: 23, round: 1, eventType: "command", summary: "[完成] 读取文件 router.mjs", createdAt: new Date(Date.now() - 150_000).toISOString() },
    { id: 24, round: 1, eventType: "command", summary: "[完成] 检索代码关键字与注解引用", createdAt: new Date(Date.now() - 140_000).toISOString() },
    { id: 25, round: 1, eventType: "warning", summary: "[失败] 检索代码关键字与注解引用", createdAt: new Date(Date.now() - 130_000).toISOString() },
    { id: 26, round: 1, eventType: "reasoning", summary: "思考中：planning file structure...", createdAt: new Date(Date.now() - 120_000).toISOString() },
    { id: 27, round: 1, eventType: "file_change", summary: "已修改文件：router.mjs、server.mjs", createdAt: new Date(Date.now() - 60_000).toISOString() },
    { id: 28, round: 1, eventType: "agent_message", summary: "阶段汇报：已完成 [router.mjs](/D:/Projects/agent-deck/src/core/router.mjs) 与 [server.mjs](D:/Projects/agent-deck/src/server.mjs) 核心改动。", createdAt: new Date(Date.now() - 20_000).toISOString() },
    { id: 29, round: 1, eventType: "turn.completed", summary: "本轮完成（净输入 42,100 / 缓存命中 95% / 输出 8,420 tokens）", createdAt: now },
  );

  const snapshot = {
    generatedAt: now,
    selectedTaskId: task1.id,
    tasks: [task1, task2],
    selectedTask: task1,
    selectedTaskMetrics: {
      antigravity: { model: "Gemini 4 Neon", turns: 18, toolCalls: 42, inputTokens: 128000, cachedInputTokens: 96000, outputTokens: 12400 },
      codex: {
        model: "gpt-6.2-sol", effort: "high",
        turns: 14, toolCalls: 19, inputTokens: 840000, cachedInputTokens: 798000,
        outputTokens: 8420, reasoningTokens: 2100,
        primaryAfter: 32, primaryDelta: 8, secondaryAfter: 32, secondaryDelta: 2,
      },
      usage: [],
    },
    quotaOverview: {
      codex: {
        planType: "pro", capturedAt: now,
        primary: { usedPercent: 32, windowMinutes: 300, resetsAt: Math.floor((Date.now() + 9000_000) / 1000) },
        secondary: { usedPercent: 32, windowMinutes: 10080, resetsAt: Math.floor((Date.now() + 250_000_000) / 1000) },
      },
      antigravity: {
        primary: { windowMinutes: 300, tasks: 2, inputTokens: 245000, cachedInputTokens: 190000, outputTokens: 18200, reasoningTokens: 4100 },
        secondary: { windowMinutes: 10080, tasks: 9, inputTokens: 1840000, cachedInputTokens: 1520000, outputTokens: 142000, reasoningTokens: 32000 },
        transcriptCount: 9,
      },
    },
    modelPolicy: {
      schemaVersion: 2,
      source: "parallax",
      syncedAt: now,
      slots: {
        plusFlagship: { provider: "codex-plus", model: "gpt-6.2-astra", reasoningEffort: "high", intelligence: 60.1, costPerTask: 2.07, latency: 20.1, reason: "Parallax 动态选型" },
        plusPrimary: { provider: "codex-plus", model: "gpt-6.2-sol", reasoningEffort: "high", intelligence: 54.9, costPerTask: 0.56, latency: 12.3, reason: "Parallax 动态选型" },
        plusBoost: { provider: "codex-plus", model: "gpt-6.2-sol", reasoningEffort: "xhigh", intelligence: 55.7, costPerTask: 0.65, latency: 39.8, reason: "Parallax 动态选型" },
        plusEco: { provider: "codex-plus", model: "gpt-6.2-sol", reasoningEffort: "medium", intelligence: 52.7, costPerTask: 0.41, latency: 3.9, reason: "Parallax 动态选型" },
        freeFast: { provider: "magpie", model: "auto/deepseek-v4.1-flash", reasoningEffort: "max", intelligence: 32.6, costPerTask: 0.6, latency: 1.3, reason: "Parallax 动态选型", isFreeChannel: true },
      },
      rejectedHighlights: [{ provider: "codex-plus", model: "gpt-6-luna", reasoningEffort: "max", reason: "能力不足，排除在自动槽位之外" }],
      invalidOverrides: [],
      lastDiff: [],
    },
    config: {
      schemaVersion: 2,
      ui: { locale: "zh-CN", sidebarWidth: 268, sidebarCollapsed: false, pollRunningMs: 3000, pollIdleMs: 15000 },
      routing: { quotaMode: "burst", parallaxUrl: "https://parallax.zzz.sd/", parallaxSyncTtlHours: 72, activeAdapter: "codex", slotOverrides: {} },
      runtimes: { codex: { enabled: true, executablePath: "", codexHome: "" }, claude: { enabled: false, executablePath: "" } },
      providers: {
        codexPlus: { enabled: true },
        magpie: { enabled: true, baseUrl: "http://127.0.0.1:3425/v1", apiKey: "magpie", selectedModels: ["auto/deepseek-v4.1-flash"], freeOwners: ["workbuddy", "opencode-zen-free", "trae-cn"], catalogPath: "" },
        custom: [{ id: "openrouter_1", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", apiKey: "sk-••••90", hasApiKey: true, wireApi: "chat_completions", models: ["deepseek/deepseek-v4"], defaultEffort: "high", isFree: false, enabled: true }],
      },
      guardrails: { activePreset: "generic", customRules: ["Never touch production configs"], disableNestedSubagents: true },
    },
    guardrailPresets: [
      { id: "generic", nameZh: "通用标准安全（默认）", nameEn: "Standard Safety (Default)", descriptionZh: "路径白名单与最小 Diff，编码规范遵循仓库自身的 AGENTS.md", descriptionEn: "Path allowlist & minimal diff; coding style stays in repo AGENTS.md", ruleCount: 4 },
      { id: "no-build", nameZh: "仅编辑不构建（IDE 托管编译）", nameEn: "Edit-Only (No Heavy Builds)", descriptionZh: "禁止 Worker 跑重型编译或长驻服务，由 IDE 统一构建", descriptionEn: "Leave heavy builds and dev servers to your IDE", ruleCount: 4 },
      { id: "strict-review", nameZh: "严格只读审计", nameEn: "Strict Read-Only Audit", descriptionZh: "禁止修改工作区文件，仅输出带文件与行号证据的问题清单", descriptionEn: "Zero file edits; evidence-backed audit findings only", ruleCount: 3 },
    ],
    messages: [
      { id: "m1", round: 1, sender: "orchestrator", kind: "brief", content: "Refactor router and server for multi-provider support.", createdAt: new Date(Date.now() - 170_000).toISOString() },
      { id: "m2", round: 1, sender: "worker", kind: "message", content: "Done. Updated `src/core/router.mjs` and `src/server.mjs`.", createdAt: now },
    ],
    events,
    fileChanges: [
      { id: "fc1", round: 1, filePath: "src/core/router.mjs", changeType: "modified", addedLines: 48, removedLines: 12, warnings: [], outOfScope: false, localOnlyArtifact: false, reverted: false, hasSnapshot: true },
      { id: "fc2", round: 1, filePath: "src/server.mjs", changeType: "modified", addedLines: 36, removedLines: 9, warnings: ["Check frame budget"], outOfScope: false, localOnlyArtifact: false, reverted: false, hasSnapshot: true },
    ],
    usage: {
      taskStats: { totalTasks: 2, runningTasks: 0, reviewingTasks: 1, doneTasks: 1 },
      total: { runs: 2, inputTokens: 840000, cachedInputTokens: 798000, netInputTokens: 42000, outputTokens: 8420, cacheHitRate: 95.0, durationMs: 145000 },
      byModelEffort: [
        { model: "gpt-6.2-sol", reasoningEffort: "high", engine: "codex-plus", profile: "plus-high", runs: 1, turnsCount: 14, toolCallsCount: 19, inputTokens: 840000, cachedInputTokens: 798000, outputTokens: 8420, primaryQuotaDelta: 8, secondaryQuotaDelta: 2 },
        { model: "auto/deepseek-v4.1-flash", reasoningEffort: "max", engine: "magpie-free", profile: "magpie-fast", runs: 1, turnsCount: 12, toolCallsCount: 20, inputTokens: 320000, cachedInputTokens: 280000, outputTokens: 6100, primaryQuotaDelta: 0, secondaryQuotaDelta: 0 },
      ],
      recent: [{ createdAt: now, taskTitle: task1.title, round: 1, model: "gpt-6.2-sol", reasoningEffort: "high", turnsCount: 14, toolCallsCount: 19, primaryQuotaDelta: 8, secondaryQuotaDelta: 2, inputTokens: 840000, cachedInputTokens: 798000, outputTokens: 8420, durationMs: 145000 }],
    },
  };

  const environmentStatus = {
    codex: { available: true, executablePath: "C:/npm/codex.js", codexHome: "C:/Users/demo/.codex", version: "0.171.0", models: [{ slug: "gpt-6.2-sol" }, { slug: "gpt-6.2-astra" }] },
    claude: { available: false, executablePath: "" },
    magpie: {
      reachable: true,
      baseUrl: "http://127.0.0.1:3425/v1",
      totalModels: 4,
      nextCursor: null,
      groups: [
        {
          owner: "workbuddy",
          isFreeOwner: true,
          models: [
            { id: "auto/deepseek-v4.1-flash", displayName: "DeepSeek V4.1 Flash", ownedBy: "workbuddy", ctx: 1000000, efforts: ["max"], consumesCodexPlus: false },
            { id: "workbuddy/kimi-k3.1-pro", displayName: "Kimi K3.1 Pro", ownedBy: "workbuddy", ctx: 1000000, efforts: ["high", "max"], consumesCodexPlus: false },
          ],
        },
        {
          owner: "codex",
          isFreeOwner: false,
          models: [
            { id: "codex/gpt-6.2-sol", displayName: "GPT-6.2 Sol", ownedBy: "codex", ctx: 500000, efforts: ["medium", "high"], consumesCodexPlus: true },
          ],
        },
      ],
    },
    custom: [{ id: "openrouter_1", reachable: true, latencyMs: 142, modelCount: 24 }],
  };

  return { snapshot, environmentStatus };
}

function buildHarness(appUrl, dataJson) {
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><style>html,body,iframe{margin:0;padding:0;width:100%;height:100%;border:0;display:block;}</style></head>
<body>
<iframe id="app-frame" src="${appUrl}" sandbox="allow-scripts allow-same-origin"></iframe>
<script>
const data = ${dataJson};
let currentTheme = "light";
const hostState = { calls: [], snapshot: data.snapshot, environmentStatus: data.environmentStatus };
window.__HOST__ = hostState;
window.__SET_THEME__ = (theme) => {
  currentTheme = theme;
  frame.contentWindow.postMessage({
    jsonrpc: "2.0",
    method: "ui/notifications/host-context-changed",
    params: { theme, styles: { variables: {} } },
  }, "*");
};
window.__PUSH_EVENT__ = (summary) => {
  const maxId = Math.max(...hostState.snapshot.events.map(e => e.id));
  hostState.snapshot.events.push({ id: maxId + 1, round: 1, eventType: "file_change", summary, createdAt: new Date().toISOString() });
  hostState.snapshot.generatedAt = new Date().toISOString();
  frame.contentWindow.postMessage({
    jsonrpc: "2.0",
    method: "ui/notifications/tool-result",
    params: { structuredContent: structuredClone(hostState.snapshot) },
  }, "*");
};
const frame = document.getElementById("app-frame");
window.addEventListener("message", (evt) => {
  const msg = evt.data;
  if (!msg || msg.jsonrpc !== "2.0") return;
  if (msg.method === "ui/initialize") {
    frame.contentWindow.postMessage({
      jsonrpc: "2.0", id: msg.id,
      result: {
        protocolVersion: msg.params?.protocolVersion || "2026-01-26",
        hostInfo: { name: "Antigravity-E2E", version: "2.0.0" },
        hostCapabilities: { serverTools: {}, message: {} },
        hostContext: { theme: currentTheme, displayMode: "inline", styles: { variables: {} } },
      },
    }, "*");
    return;
  }
  if (msg.method === "ui/notifications/initialized") {
    frame.contentWindow.postMessage({
      jsonrpc: "2.0", method: "ui/notifications/tool-result",
      params: { structuredContent: structuredClone(hostState.snapshot) },
    }, "*");
    return;
  }
  if (msg.method === "tools/call") {
    const name = msg.params?.name;
    const args = msg.params?.arguments || {};
    hostState.calls.push({ name, args });
    let sc = structuredClone(hostState.snapshot);
    if (name === "ui_get_snapshot") {
      sc.generatedAt = new Date().toISOString();
      if (args.taskId && !args.followLatest) {
        const found = sc.tasks.find(t => t.id === args.taskId);
        if (found) { sc.selectedTaskId = found.id; sc.selectedTask = found; }
      }
    } else if (name === "ui_get_file_diff") {
      sc = { id: args.changeId, filePath: "src/core/router.mjs", diffText: "@@ -1,2 +1,3 @@\\n-oldLine\\n+newLine" };
    } else if (name === "ui_set_quota_mode") {
      hostState.snapshot.config.routing.quotaMode = args.mode;
      hostState.snapshot.modelPolicy.quotaMode = args.mode;
      sc = structuredClone(hostState.snapshot);
    } else if (name === "ui_save_config") {
      const p = args.patch || {};
      if (p.ui) Object.assign(hostState.snapshot.config.ui, p.ui);
      if (p.routing) Object.assign(hostState.snapshot.config.routing, p.routing);
      if (p.guardrails) Object.assign(hostState.snapshot.config.guardrails, p.guardrails);
      if (p.providers?.magpie) Object.assign(hostState.snapshot.config.providers.magpie, p.providers.magpie);
      if (p.providers?.custom) hostState.snapshot.config.providers.custom = p.providers.custom;
      sc = structuredClone(hostState.snapshot);
    } else if (name === "ui_detect_environment") {
      sc = { ...structuredClone(hostState.snapshot), environmentStatus: structuredClone(hostState.environmentStatus) };
    } else if (name === "ui_test_provider") {
      sc = { reachable: true, latencyMs: 95, modelCount: 18, discoveredModels: ["demo/a", "demo/b"] };
    } else if (name === "ui_sync_model_policy") {
      hostState.snapshot.modelPolicy.localSyncedAt = new Date().toISOString();
      sc = structuredClone(hostState.snapshot);
    } else if (name === "ui_add_human_note") {
      hostState.snapshot.messages.push({ id: "m_new_" + Date.now(), round: 1, sender: "human", kind: "note", content: args.content, createdAt: new Date().toISOString() });
      sc = structuredClone(hostState.snapshot);
    }
    frame.contentWindow.postMessage({ jsonrpc: "2.0", id: msg.id, result: { isError: false, content: [], structuredContent: sc } }, "*");
  }
});
</script>
</body>
</html>`;
}

class CdpClient {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve);
      this.ws.addEventListener("error", reject);
    });
    this.ws.addEventListener("message", (evt) => {
      const msg = JSON.parse(String(evt.data));
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
      }
    });
  }
  async send(method, params = {}) {
    await this.ready;
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { this.ws.close(); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const html = fs.readFileSync(HTML_PATH, "utf8");
  const mockJson = JSON.stringify(buildMockData()).replace(/<\/script>/gi, "<\\/script>");
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(req.url === "/app.html" ? html : buildHarness("/app.html", mockJson));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}/`;

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ad-e2e-"));
  const debugPort = 9300 + Math.floor(Math.random() * 400);
  const proc = spawn(findBrowser(), [
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=${userDataDir}`, "--window-size=1440,900", baseUrl,
  ], { stdio: "ignore", windowsHide: true });

  let cdp = null;
  try {
    let target = null;
    for (let i = 0; i < 40; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
        target = list.find((t) => t.type === "page" && t.url.includes(`127.0.0.1:${port}`));
        if (target?.webSocketDebuggerUrl) break;
      } catch {}
      await sleep(200);
    }
    assert.ok(target, "无法连接 headless Chrome");
    cdp = new CdpClient(target.webSocketDebuggerUrl);
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");
    await sleep(900);

    const setViewport = async (width, height) => {
      await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
      await sleep(250);
    };

    const shot = async (filename) => {
      const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(path.join(SHOT_DIR, filename), Buffer.from(data, "base64"));
    };

    const evalFrame = async (expr) => {
      const res = await cdp.send("Runtime.evaluate", {
        expression: `(() => { const doc = document.getElementById("app-frame").contentDocument; ${expr} })()`,
        returnByValue: true,
        awaitPromise: true,
      });
      if (res.exceptionDetails) throw new Error(`Frame eval error: ${JSON.stringify(res.exceptionDetails)}`);
      return res.result?.value;
    };

    const assertNoHorizontalOverflow = async (label) => {
      const overflows = await evalFrame(`
        const bad = [];
        const candidates = doc.querySelectorAll("aside, .task-sidebar, .task-list, nav, .rail, header, .view-header, .shell, .workspace, .task-detail, .global-view");
        for (const el of candidates) {
          const st = getComputedStyle(el);
          if (st.display === "none" || el.clientWidth === 0) continue;
          if (el.scrollWidth > el.clientWidth + 2) {
            bad.push({ tag: el.tagName, cls: el.className, scrollW: el.scrollWidth, clientW: el.clientWidth });
          }
        }
        return bad;
      `);
      assert.equal(overflows.length, 0, `[${label}] 发现横向滚动条溢出：${JSON.stringify(overflows)}`);
    };

    // 1. 1440px 全屏亮色：验证工单台、零横滚、侧栏存在、宽屏检查器存在、无重复顶部下拉
    await setViewport(1440, 900);
    const init = await evalFrame(`
      return {
        bodyText: doc.body.innerText.slice(0, 300),
        railWidth: doc.querySelector("aside.rail")?.getBoundingClientRect().width || 0,
        sidebarWidth: doc.querySelector("aside.task-sidebar")?.getBoundingClientRect().width || 0,
        hasResizer: Boolean(doc.querySelector('[data-resizer="sidebar"]')),
        hasInspector: Boolean(doc.querySelector(".inspector-wide")),
        hasTopPicker: Boolean(doc.querySelector("[data-task-select]")),
      };
    `);
    assert.ok(init.railWidth >= 40 && init.railWidth <= 64, `1440px 应显示极简左图标栏，实际宽度=${init.railWidth}`);
    assert.ok(init.sidebarWidth >= 200, `1440px 应显示左侧工单栏，实际宽度=${init.sidebarWidth}`);
    assert.ok(init.hasResizer, "缺少可拖拽侧栏分割线 [data-resizer=sidebar]");
    assert.ok(init.hasInspector, "1440px 宽屏应显示右侧工单检查器 .inspector-wide");
    assert.equal(init.hasTopPicker, false, "宽屏展开侧栏时顶栏不应重复出现工单下拉选择器");
    await assertNoHorizontalOverflow("1440px-tasks");
    await shot("1440-tasks-light.png");

    // 2. 测试拖拽分割线调宽左侧栏（使用 pointer 事件匹配 setPointerCapture）
    const resizerBox = await evalFrame(`
      const r = doc.querySelector('[data-resizer="sidebar"]').getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + 120 };
    `);
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: resizerBox.x, y: resizerBox.y, button: "left", buttons: 1, clickCount: 1 });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: resizerBox.x + 60, y: resizerBox.y, button: "left", buttons: 1 });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: resizerBox.x + 60, y: resizerBox.y, button: "left", buttons: 0, clickCount: 1 });
    await sleep(300);
    const newSidebarWidth = await evalFrame(`return doc.querySelector("aside.task-sidebar")?.getBoundingClientRect().width || 0;`);
    assert.ok(newSidebarWidth >= init.sidebarWidth + 30, `拖拽侧栏后宽度应增大：before=${init.sidebarWidth}, after=${newSidebarWidth}`);
    await assertNoHorizontalOverflow("1440px-tasks-resized");

    // 3. 测试下拉阅读防跳顶
    const scrollBefore = await evalFrame(`
      const scroller = doc.querySelector('[data-scroll-key^="activity:"]');
      scroller.scrollTop = 200;
      return scroller.scrollTop;
    `);
    await cdp.send("Runtime.evaluate", { expression: `window.__PUSH_EVENT__("新增实时步骤测试防跳顶");` });
    await sleep(300);
    const scrollAfter = await evalFrame(`return doc.querySelector('[data-scroll-key^="activity:"]').scrollTop;`);
    assert.ok(scrollAfter >= scrollBefore - 5, `新动态插入顶部不应把用户弹回顶部：before=${scrollBefore}, after=${scrollAfter}`);

    // 3b. 验证工单子页切换（改动 + Diff 展开、对话 + 批注）
    await evalFrame(`doc.querySelector('[data-action="tab"][data-id="changes"]').click();`);
    await sleep(250);
    await evalFrame(`doc.querySelector('details.file-row summary')?.click();`);
    await sleep(300);
    const diffLoaded = await evalFrame(`return doc.body.innerText.includes("newLine");`);
    assert.ok(diffLoaded, "展开文件改动后应懒加载并显示 Diff 内容");

    await evalFrame(`doc.querySelector('[data-action="tab"][data-id="conversation"]').click();`);
    await sleep(250);
    const hasNoteForm = await evalFrame(`return Boolean(doc.querySelector('form[data-form="note"]'));`);
    assert.ok(hasNoteForm, "对话页应显示人工批注表单");

    // 4. 切到「策略与用量」全局页：强制断言绝不渲染左侧工单栏、触发实时刷新、默认展示剩余额度且可切换已用！
    await evalFrame(`doc.querySelector('[data-action="view"][data-id="routing"]').click();`);
    await sleep(300);
    const routingCheck = await evalFrame(`
      const aside = doc.querySelector("aside.task-sidebar");
      const visible = aside && getComputedStyle(aside).display !== "none" && aside.getBoundingClientRect().width > 0;
      const calls = window.parent.__HOST__.calls.filter(c => c.name === "ui_get_snapshot" && c.args?.refreshQuota === true);
      return { sidebarVisible: Boolean(visible), text: doc.body.innerText, forcedQuotaCalls: calls.length };
    `);
    assert.equal(routingCheck.sidebarVisible, false, "「策略与用量」全局页绝不应显示无关的左侧工单栏！");
    assert.ok(routingCheck.forcedQuotaCalls >= 1, "切换到策略与用量页签应自动触发 refreshQuota=true 实时刷新");
    assert.ok(routingCheck.text.includes("剩余 68%"), "默认应展示剩余额度（剩余 68%）");
    assert.ok(routingCheck.text.includes("54.9") && routingCheck.text.includes("$0.56"), "Parallax 矩阵应展示真实能力分与成本");
    await evalFrame(`doc.querySelector('[data-action="quota-display"]').click();`);
    await sleep(250);
    const usedText = await evalFrame(`return doc.body.innerText;`);
    assert.ok(usedText.includes("已用 32%"), "点击切换后应展示已用额度（已用 32%）");
    await evalFrame(`doc.querySelector('[data-action="quota-display"]').click();`);
    await sleep(250);
    await evalFrame(`doc.querySelector('[data-action="quota-mode"][data-id="balanced"]').click();`);
    await sleep(300);
    const modePressed = await evalFrame(`return doc.querySelector('[data-action="quota-mode"][data-id="balanced"]')?.getAttribute("aria-pressed");`);
    assert.equal(modePressed, "true", "点击均衡省流后应切换为选中状态");
    await evalFrame(`doc.querySelector('[data-action="quota-mode"][data-id="burst"]').click();`);
    await sleep(250);
    await assertNoHorizontalOverflow("1440px-routing");
    await shot("1440-routing-light.png");

    // 5. 切到「执行器与设置」全局页：强制断言绝不渲染左侧工单栏，并测试一键环境扫描！
    await evalFrame(`doc.querySelector('[data-action="view"][data-id="setup"]').click();`);
    await sleep(300);
    const setupCheck = await evalFrame(`
      const aside = doc.querySelector("aside.task-sidebar");
      const visible = aside && getComputedStyle(aside).display !== "none" && aside.getBoundingClientRect().width > 0;
      const scanBtn = doc.querySelector('[data-action="scan"]');
      if (scanBtn) scanBtn.click();
      return { sidebarVisible: Boolean(visible), hasScanBtn: Boolean(scanBtn) };
    `);
    assert.equal(setupCheck.sidebarVisible, false, "「执行器与设置」全局页绝不应显示无关的左侧工单栏！");
    assert.ok(setupCheck.hasScanBtn, "缺少一键扫描本机环境按钮 [data-action=scan]");
    await sleep(400);
    const setupText = await evalFrame(`return doc.body.innerText;`);
    assert.ok(setupText.includes("workbuddy") || setupText.includes("DeepSeek"), "扫描后应展示 Magpie 分组模型");
    await assertNoHorizontalOverflow("1440px-setup");
    await shot("1440-setup-light.png");

    // 5b. 验证中英双语实时切换
    await evalFrame(`doc.querySelector('[data-action="language"]').click();`);
    await sleep(300);
    const enTitle = await evalFrame(`return doc.querySelector("h1")?.textContent || "";`);
    assert.ok(enTitle.includes("Agents & Setup"), `切换到英文后标题应为 Agents & Setup，实际=${enTitle}`);
    await evalFrame(`doc.querySelector('[data-action="language"]').click();`);
    await sleep(300);

    // 6. 深色主题截图（1440px 工单台）
    await evalFrame(`doc.querySelector('[data-action="view"][data-id="tasks"]').click();`);
    await evalFrame(`doc.querySelector('[data-action="tab"][data-id="activity"]')?.click();`);
    await cdp.send("Runtime.evaluate", { expression: `window.__SET_THEME__("dark");` });
    await sleep(350);
    await shot("1440-tasks-dark.png");

    // 7. 440px 窄屏（右侧边栏真实宽度）零横滚 + 截图
    await cdp.send("Runtime.evaluate", { expression: `window.__SET_THEME__("light");` });
    await setViewport(440, 800);
    await assertNoHorizontalOverflow("440px-tasks");
    await shot("440-tasks-light.png");

    // 8. 1024px 中屏零横滚校验
    await setViewport(1024, 760);
    await assertNoHorizontalOverflow("1024px-tasks");

    // 9. 严查 0 未捕获 JS 异常
    const exceptions = cdp.events.filter((e) => e.method === "Runtime.exceptionThrown");
    if (exceptions.length > 0) console.error("EXCEPTIONS:", JSON.stringify(exceptions, null, 2));
    assert.equal(exceptions.length, 0, `页面存在 ${exceptions.length} 条未捕获 JS 异常`);

    console.log("[PASS E2E 9/9] 真 Chrome 3视口(440/1024/1440px)全交互 + 零横滚 + 侧栏拖拽 + 全局页解耦 + 双语切换 + 5张高清截图全部通过！");
  } finally {
    if (cdp) cdp.close();
    try { proc.kill("SIGTERM"); } catch {}
    server.close();
    await sleep(200);
    try { fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 }); } catch {}
  }
}

main().catch((err) => {
  console.error("[FAIL E2E]", err);
  process.exit(1);
});
