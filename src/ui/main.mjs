import { callTool, hostApp, hostTheme, toolData, workspaceFileUrl } from "./api.mjs";
import { translator } from "./i18n.mjs";
import { button, esc, formats, icon } from "./components/common.mjs";
import { tasksView } from "./views/tasks.mjs";
import { countdown, routingView } from "./views/routing.mjs";
import { setupView } from "./views/setup.mjs";

const root = document.querySelector("#root");
const narrowScreen = matchMedia("(max-width: 859.98px)");
const connectionTimeout = 10_000;
const reconnectDelays = [500, 1000, 2000];
const views = { tasks: tasksView, routing: routingView, setup: setupView };
const tabs = new Set(["activity", "changes", "conversation"]);
const modes = new Set(["burst", "balanced", "free_only"]);
const widthLimit = (width) => Math.max(200, Math.min(420, Math.round(Number(width) || 268)));
const ui = {
  view: "tasks", tab: "activity", width: 268, collapsed: false, reasoning: false, quotaDisplay: "remaining",
  search: { tasks: "", files: "", models: "" }, taskFilter: "all", fileFilter: "all",
  requestedTask: undefined, notes: new Map(), diffs: new Map(), cancelling: new Set(),
  forms: new Map(), models: null, provider: null, probes: new Map(), environment: null,
};

let snapshot = { tasks: [] };
let fingerprint;
let app;
let connection = "connecting";
let attempt = 0;
let connectionSequence = 0;
let initialResult = false;
let readVersion = 0;
let pendingWrites = 0;
let writeTail = Promise.resolve();
let refreshFlight;
let pollTimer;
let connectTimer;
let composing = false;
let renderPending = false;
let resetCatalog = false;
let drag;
const locks = new Set();
const scroll = new Map();
const disclosures = new Map();
const locale = () => snapshot.config?.ui?.locale === "en" ? "en" : "zh-CN";
const t = (key, ...args) => translator(locale())(key, ...args);
const busy = (key) => locks.has(key) || key === "config" && locks.has("scan");

const toasts = document.createElement("div");
toasts.className = "toasts";
toasts.setAttribute("aria-live", "polite");
toasts.setAttribute("aria-atomic", "false");
root.after(toasts);

const dialog = document.createElement("dialog");
dialog.className = "confirm-dialog";
dialog.setAttribute("aria-label", "AgentDeck");
root.after(dialog);

/** 用户操作提示独立于主节点，不参与快照重绘。 */
function toast(message, error = false) {
  const node = document.createElement("div");
  node.className = `toast ${error ? "toast-error" : ""}`;
  node.textContent = message;
  toasts.append(node);
  if (toasts.childElementCount > 4) toasts.firstElementChild.remove();
  setTimeout(() => node.remove(), error ? 6500 : 3800);
}

/** MCP 请求错误显示本地化摘要或服务端已脱敏的错误。 */
function errorText(error) {
  const message = error?.message ?? "operationFailed";
  return error?.code === -32001 || /timed out|timeout/i.test(message) ? t("requestTimeout") : t(message);
}

/** 原生 dialog 在沙箱内提供二次确认，不依赖宿主启用浏览器模态框。 */
function confirmAction(message, action) {
  if (dialog.open) return Promise.resolve(false);
  dialog.innerHTML = `<form method="dialog"><h2>${esc(action)}</h2><p>${esc(message)}</p><div class="form-actions">
    <button class="button" value="cancel" autofocus>${esc(t("cancel"))}</button>
    <button class="button danger" value="approve">${esc(action)}</button></div></form>`;
  dialog.returnValue = "cancel";
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "approve"), { once: true });
    dialog.showModal();
  });
}

/** 保存首个可见锚点相对滚动容器的位置，顶部保持零以显示最新动态。 */
function captureScroll() {
  for (const container of root.querySelectorAll("[data-scroll-key]")) {
    const top = container.scrollTop;
    const box = container.getBoundingClientRect();
    const row = top > 0 ? Array.from(container.querySelectorAll("[data-scroll-anchor]")).find((anchor) => {
      const rect = anchor.getBoundingClientRect();
      return rect.height > 0 && rect.bottom > box.top && rect.top < box.bottom;
    }) : null;
    scroll.set(container.dataset.scrollKey, {
      top,
      anchor: row?.dataset?.scrollAnchor,
      offset: row ? row.getBoundingClientRect().top - box.top : 0,
    });
  }
}

/** 先按锚点恢复位置，锚点离开服务器窗口时退回原滚动距离。 */
function restoreScroll() {
  for (const container of root.querySelectorAll("[data-scroll-key]")) {
    const position = scroll.get(container.dataset.scrollKey);
    if (!position) continue;
    container.scrollTop = position.top;
    const anchor = position.anchor
      ? Array.from(container.querySelectorAll("[data-scroll-anchor]")).find((item) => item.dataset.scrollAnchor === position.anchor && item.getBoundingClientRect().height > 0)
      : null;
    if (anchor) container.scrollTop += anchor.getBoundingClientRect().top - container.getBoundingClientRect().top - position.offset;
  }
}

/** 还原表单、导航和文件行上的焦点，以及支持选区的输入光标。 */
function activeFocus() {
  const element = document.activeElement;
  if (!root.contains(element)) return null;
  const attrs = ["data-focus-key", "data-action", "data-id", "data-resizer"].filter((name) => element.hasAttribute(name));
  if (element.matches("summary") && element.parentElement?.dataset?.disclosure) {
    const key = element.parentElement.dataset.disclosure;
    return { find: () => Array.from(root.querySelectorAll("details[data-disclosure]")).find((item) => item.dataset.disclosure === key)?.querySelector("summary") };
  }
  if (!attrs.length) return null;
  const match = attrs.map((attr) => [attr, element.getAttribute(attr)]);
  return {
    start: element.selectionStart, end: element.selectionEnd, direction: element.selectionDirection,
    find: () => Array.from(root.querySelectorAll(`[${attrs[0]}]`)).find((item) => match.every(([attr, value]) => item.getAttribute(attr) === value)),
  };
}

/** 桌面与窄屏拥有同一导航顺序，只有当前视图进入主区域。 */
function navigation(narrow) {
  return `<nav class="${narrow ? "segments" : "rail-nav"}" aria-label="${esc(t("navigation"))}">${Object.keys(views).map((key) => {
    const short = `short${key[0].toUpperCase()}${key.slice(1)}`;
    return `<button type="button" data-action="view" data-id="${key}" aria-current="${key === ui.view}" aria-label="${esc(t(key))}" title="${esc(t(key))}">
      ${icon(key, narrow ? 16 : 20)}${narrow ? `<span>${esc(t(short))}</span>` : ""}</button>`;
  }).join("")}</nav>`;
}

/** 批量替换当前视图，在输入法合成或拖动时延后重绘。 */
function render() {
  if (composing || drag) {
    renderPending = true;
    return;
  }
  renderPending = false;
  captureScroll();
  const focus = activeFocus();
  for (const item of root.querySelectorAll("[data-disclosure]")) disclosures.set(item.dataset.disclosure, item.open);
  if (resetCatalog) {
    for (const key of disclosures.keys()) if (key.startsWith("catalog:")) disclosures.delete(key);
    resetCatalog = false;
  }
  const narrow = narrowScreen.matches;
  const language = button("language", "中 / EN", {
    kind: "ghost language-button", disabled: !snapshot.config || busy("config"), accessible: t("switchLanguage"),
  });
  const brand = `<span class="brand">${icon("brand", 23)}<strong>AgentDeck</strong></span>`;
  const status = connection === "ready" ? "" : `<div class="connection ${connection === "offline" ? "is-offline" : ""}" role="status">
    <span>${esc(t(connection === "offline" ? "offline" : attempt ? "reconnecting" : "connecting", attempt))}</span>
    ${connection === "offline" ? button("reconnect", t("retry"), { symbol: "refresh" }) : ""}</div>`;
  document.documentElement.lang = locale();
  root.innerHTML = `<div class="shell" style="--sidebar-width:${ui.width}px">
    ${narrow ? "" : `<aside class="rail"><span class="rail-brand" title="AgentDeck" aria-label="AgentDeck">${icon("brand", 24)}</span>
      ${navigation(false)}<div class="rail-footer">${language}<small>v2.0</small></div></aside>`}
    <main class="workspace">${narrow ? `<div class="masthead">${brand}${language}</div>${navigation(true)}` : ""}${status}
      ${snapshot.truncated ? `<div class="snapshot-notice">${esc(t("truncated"))}</div>` : ""}
      ${views[ui.view]({ t, snapshot, ui, busy, narrow, locale: locale(), fmt: formats(locale()) })}
    </main></div>`;
  for (const item of root.querySelectorAll("[data-disclosure]")) {
    if (disclosures.has(item.dataset.disclosure)) item.open = disclosures.get(item.dataset.disclosure);
  }
  for (const input of root.querySelectorAll('input[type="password"]')) {
    input.value = ui.forms.get(input.form.dataset.form)?.[input.name] ?? "";
  }
  const next = focus?.find();
  if (next && !next.disabled) {
    next.focus({ preventScroll: true });
    if (typeof focus.start === "number" && next.selectionStart != null) next.setSelectionRange(focus.start, focus.end, focus.direction);
  }
  restoreScroll();
}

/** 剔除采样时钟，保留业务数据、真实用量变化以及返回裁剪状态。 */
function snapshotFingerprint(value) {
  const { generatedAt, ...data } = value;
  return JSON.stringify(data, (key, field) => {
    if (key !== "antigravity" || !field || typeof field !== "object") return field;
    const { sampledAt, ...metric } = field;
    return metric;
  });
}

/** 消费完整快照，首屏通知即时生效，指纹相同则保持 DOM。 */
function acceptSnapshot(value) {
  if (!Array.isArray(value?.tasks) || !value.config || !Object.hasOwn(value, "selectedTask")) return false;
  const { environmentStatus, cancellationRequested, ...incoming } = value;
  const next = snapshotFingerprint(incoming);
  if (next === fingerprint) return true;
  const previousId = snapshot.selectedTaskId;
  fingerprint = next;
  snapshot = incoming;
  ui.width = widthLimit(incoming.config.ui?.sidebarWidth);
  ui.collapsed = incoming.config.ui?.sidebarCollapsed === true;
  ui.quotaDisplay = incoming.config.ui?.quotaDisplayMode === "used" ? "used" : "remaining";
  if (previousId && previousId !== incoming.selectedTaskId) {
    ui.search.files = "";
    ui.fileFilter = "all";
  }
  for (const task of [...incoming.tasks, incoming.selectedTask].filter(Boolean)) {
    if (!["running", "queued"].includes(task.status)) ui.cancelling.delete(task.id);
  }
  render();
  return true;
}

/** 读取当前宿主连接，工具名和参数与服务端 app-only schema 一致。 */
function invoke(name, args, timeout) {
  if (!app || connection !== "ready") throw new Error("offline");
  return callTool(app, name, args, timeout);
}

/** 未手动选中时跟随最近工单；全局写入保留当前业务上下文。 */
function selection() {
  const taskId = ui.requestedTask ?? snapshot.selectedTaskId;
  return taskId ? { taskId } : {};
}

/** 合并同一版本的刷新请求，不接受选中工单或写入前的旧响应；refreshQuota=true 时绕过缓存强制实时查配额。 */
async function refresh({ refreshQuota = false } = {}) {
  if (connection !== "ready" || pendingWrites) return;
  const version = readVersion;
  if (!refreshQuota && refreshFlight?.version === version) return refreshFlight.promise;
  const args = {
    ...(ui.requestedTask ? { taskId: ui.requestedTask } : { followLatest: true }),
    ...(refreshQuota ? { refreshQuota: true } : {}),
  };
  const promise = (async () => {
    const result = await invoke("ui_get_snapshot", args, connectionTimeout);
    if (version === readVersion && !pendingWrites) {
      if (!acceptSnapshot(result)) throw new Error("operationFailed");
    }
  })();
  refreshFlight = { version, promise };
  try {
    await promise;
  } finally {
    if (refreshFlight?.promise === promise) refreshFlight = undefined;
  }
}

/** 页面可见时按运行状态执行单一心跳，失焦交给宿主事件唤醒。 */
function schedulePoll() {
  clearTimeout(pollTimer);
  if (document.hidden || connection !== "ready") return;
  const running = snapshot.selectedTask?.status === "running" || snapshot.tasks.some((task) => task.status === "running");
  const delay = running ? snapshot.config?.ui?.pollRunningMs ?? 3000 : snapshot.config?.ui?.pollIdleMs ?? 15000;
  pollTimer = setTimeout(async () => {
    try {
      await refresh();
    } catch (error) {
      if (connection === "ready" && (!initialResult || isConnectionError(error))) {
        connect();
        return;
      }
      toast(errorText(error), true);
    }
    schedulePoll();
  }, delay);
}

/** MCP 关闭连接或等待超时后重建宿主连接，业务错误仍由界面直接展示。 */
function isConnectionError(error) {
  return error?.code === -32000 || error?.code === -32001;
}

/** 前台切回和宿主上下文变化共享刷新入口，合并并发请求。 */
async function foreground(options) {
  if (document.hidden || connection !== "ready") return;
  try {
    await refresh(options);
  } catch (error) {
    if (connection === "ready" && isConnectionError(error)) connect();
    else toast(errorText(error), true);
  } finally {
    schedulePoll();
  }
}

/** 连接失败按三档退避重新握手，旧连接回调经世代标识失效。 */
function connect() {
  const generation = ++connectionSequence;
  readVersion++;
  clearTimeout(pollTimer);
  clearTimeout(connectTimer);
  const previous = app;
  app = undefined;
  if (previous) void previous.close().catch(() => {});
  connection = "connecting";
  attempt = 0;
  render();
  void open(0);

  async function open(retry) {
    if (generation !== connectionSequence) return;
    attempt = retry;
    let candidate;
    const live = () => generation === connectionSequence && candidate === app;
    candidate = hostApp({
      onInput: (args) => {
        if (live() && !initialResult && typeof args?.taskId === "string") ui.requestedTask = args.taskId;
      },
      onResult: (result) => {
        if (!live()) return;
        try {
          const value = toolData(result);
          if (ui.requestedTask && value?.selectedTaskId !== ui.requestedTask) return;
          if (!pendingWrites && acceptSnapshot(value)) {
            initialResult = true;
            readVersion++;
            schedulePoll();
          }
        } catch (error) {
          toast(errorText(error), true);
        }
      },
      onContext: (context) => {
        if (!live()) return;
        hostTheme(context);
        void foreground();
      },
    });
    app = candidate;
    render();
    try {
      await candidate.connect(undefined, { timeout: connectionTimeout });
      if (!live()) return;
      hostTheme(candidate.getHostContext());
      connection = "ready";
      render();
      // 启动工具通常直接推送首屏，仅在推送尚未到达或重新连接时补拉；业务报错不触发断连重连死循环。
      if (!initialResult || retry || generation > 1) {
        await new Promise((resolve) => setTimeout(resolve, 300));
        if (!live()) return;
        if (!initialResult || retry || generation > 1) {
          try {
            await refresh();
          } catch (refreshError) {
            if (isConnectionError(refreshError)) throw refreshError;
            toast(errorText(refreshError), true);
          }
        }
      }
      schedulePoll();
      candidate.onclose = () => {
        if (live() && connection === "ready") connect();
      };
    } catch {
      if (!live()) return;
      app = undefined;
      void candidate.close().catch(() => {});
      connection = retry < reconnectDelays.length ? "connecting" : "offline";
      if (connection === "connecting") {
        attempt = retry + 1;
        connectTimer = setTimeout(() => void open(retry + 1), reconnectDelays[retry]);
      }
      render();
    }
  }
}

/** 单个操作锁防止重复触发，并把失败留在当前视图。 */
async function perform(key, run, { redraw = true } = {}) {
  if (busy(key)) return;
  locks.add(key);
  if (redraw) render();
  try {
    return await run();
  } catch (error) {
    toast(errorText(error), true);
  } finally {
    locks.delete(key);
    if (redraw) render();
    schedulePoll();
  }
}

/** 串行发送快照型写入，忽略写入期间由轮询返回的旧版本。 */
function write(name, args) {
  const version = ++readVersion;
  pendingWrites++;
  const run = writeTail.then(async () => {
    const result = await invoke(name, args);
    if (version === readVersion || result.selectedTaskId === ui.requestedTask && pendingWrites === 1) acceptSnapshot(result);
    return result;
  }).finally(() => {
    pendingWrites--;
    if (!pendingWrites && version !== readVersion) void foreground();
  });
  writeTail = run.catch(() => {});
  return run;
}

/** 配置只提交当前操作对应的严格补丁。 */
function saveConfig(patch) {
  return write("ui_save_config", { patch, ...selection() });
}

/** Magpie 分页以渠道和模型 ID 去重，游标必须单调前进。 */
async function scanEnvironment() {
  const args = selection();
  const groups = new Map();
  let cursor = 0;
  let environment;
  let policy;
  do {
    const result = await invoke("ui_detect_environment", cursor ? { ...args, cursor } : args);
    const status = result.environmentStatus;
    if (!status?.magpie) throw new Error("operationFailed");
    environment = status;
    policy ??= result.modelPolicy;
    for (const group of status.magpie.groups ?? []) {
      const existing = groups.get(group.owner) ?? { ...group, models: new Map() };
      for (const model of group.models) existing.models.set(model.id, model);
      groups.set(group.owner, existing);
    }
    const next = status.magpie.nextCursor;
    if (next != null && (!Number.isInteger(next) || next <= cursor)) throw new Error("operationFailed");
    cursor = next;
  } while (cursor != null);
  ui.environment = { ...environment, magpie: { ...environment.magpie,
    groups: [...groups.values()].map((group) => ({ ...group, models: [...group.models.values()] })),
  } };
  if (policy) acceptSnapshot({ ...snapshot, modelPolicy: policy });
}

/** 文本配置遵守后端的数组长度及单项长度限制。 */
function lines(value, limit, max) {
  const values = String(value ?? "").split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  if (values.length > limit || values.some((item) => item.length > max)) throw new Error(t("limit", limit, max));
  return values;
}

/** 网关基址匹配服务端 URL 校验，避免 URL 自带凭据或查询参数。 */
function gatewayBase(value) {
  const base = String(value ?? "").trim();
  let url;
  try {
    url = new URL(base);
  } catch {
    throw new Error("invalidUrl");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || base.length > 2048) throw new Error("invalidUrl");
  return base;
}

/** 自定义供应商表单仅发送公开可编辑字段，空密钥由服务端保留原值。 */
function providerInput(form, forTest = false) {
  const baseUrl = gatewayBase(form.elements.baseUrl.value);
  const apiKey = form.elements.apiKey.value;
  const current = ui.provider ? { id: ui.provider } : {};
  if (forTest) return { ...current, baseUrl, ...(apiKey ? { apiKey } : {}) };
  return {
    ...current, baseUrl, ...(apiKey ? { apiKey } : {}),
    name: form.elements.name.value.trim(), wireApi: form.elements.wireApi.value,
    models: lines(form.elements.models.value, 500, 200),
    defaultEffort: form.elements.defaultEffort.value.trim(),
    isFree: form.elements.isFree.checked, enabled: form.elements.enabled.checked,
  };
}

/** 编辑器和列表测试结果分别缓存，已移除或已切换的草稿丢弃旧响应。 */
async function testProvider(provider, key, form) {
  const draft = form ? ui.forms.get("provider") : null;
  const identity = ui.provider;
  await perform(`test:${key}`, async () => {
    const result = await invoke("ui_test_provider", { provider });
    if (form && (identity !== ui.provider || draft !== ui.forms.get("provider"))) return;
    ui.probes.set(key, result);
    if (!result.reachable) toast(result.error || t("testFailed"), true);
  });
}

/** 获取完整 Diff，文件行保留独立加载和重试状态。 */
async function loadDiff(id) {
  if (!id || ui.diffs.get(id)?.loading) return;
  ui.diffs.set(id, { loading: true });
  render();
  try {
    const data = await invoke("ui_get_file_diff", { changeId: id });
    ui.diffs.set(id, { data });
  } catch (error) {
    ui.diffs.set(id, { error: errorText(error) });
  }
  render();
}

/** 手选工单立即固定请求目标，较早的刷新通过版本失效。 */
async function selectTask(id) {
  if (!id || ui.requestedTask === id && snapshot.selectedTaskId === id) return;
  const previous = ui.requestedTask;
  const version = ++readVersion;
  ui.requestedTask = id;
  ui.tab = "activity";
  render();
  try {
    await refresh();
  } catch (error) {
    if (version === readVersion) {
      ui.requestedTask = previous;
      ++readVersion;
      render();
    }
    toast(errorText(error), true);
  }
  schedulePoll();
}

/** 侧栏通过同一个配置入口保存拖动宽度及折叠状态。 */
function saveSidebar(patch) {
  return perform("config", async () => {
    await saveConfig({ ui: patch });
  }, { redraw: false });
}

/** 剪贴板优先使用标准 API，宿主未授权时尝试浏览器复制命令。 */
async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    // 沙箱允许编辑命令时，尝试通过选中文字复制。
  }
  const active = document.activeElement;
  const field = document.createElement("textarea");
  field.className = "clipboard-field";
  field.value = text;
  document.body.append(field);
  field.select();
  try {
    if (!document.execCommand("copy")) throw new Error("clipboardError");
  } finally {
    field.remove();
    active?.focus({ preventScroll: true });
  }
}

/** 将界面点击映射到当前工单操作、全局配置或宿主动作。 */
const actions = {
  view: (id) => {
    if (Object.hasOwn(views, id) && id !== ui.view) {
      ui.view = id;
      render();
      void foreground({ refreshQuota: id === "routing" });
    }
  },
  "quota-display": () => {
    const next = ui.quotaDisplay === "used" ? "remaining" : "used";
    ui.quotaDisplay = next;
    render();
    return perform("quota-display", () => saveConfig({ ui: { quotaDisplayMode: next } }), { redraw: false });
  },
  tab: (id) => {
    if (tabs.has(id) && id !== ui.tab) {
      ui.tab = id;
      render();
    }
  },
  task: selectTask,
  "task-filter": (id) => { ui.taskFilter = id; render(); },
  "file-filter": (id) => { ui.fileFilter = id; render(); },
  sidebar: () => saveSidebar({ sidebarCollapsed: !ui.collapsed }),
  language: () => perform("config", () => saveConfig({ ui: { locale: locale() === "en" ? "zh-CN" : "en" } })),
  refresh: () => perform("refresh", async () => {
    await foreground({ refreshQuota: true });
    toast(t("refreshed"));
  }),
  reconnect: connect,
  stop: (taskId) => perform("task-write", async () => {
    const result = await write("ui_cancel_task", { taskId });
    if (result.cancellationRequested) ui.cancelling.add(taskId);
    toast(t(result.cancellationRequested ? "stopping" : "cancelled"));
  }),
  resume: (taskId) => perform("task-write", async () => {
    ui.cancelling.delete(taskId);
    await write("ui_resume_task", { taskId });
    toast(t("resumed"));
  }),
  notify: () => perform("notify", async () => {
    const task = snapshot.selectedTask;
    if (!app || connection !== "ready") throw new Error("offline");
    const result = await app.sendMessage({ role: "user", content: [{ type: "text", text: t("reviewMessage", task.title, task.id) }] }, { timeout: connectionTimeout });
    if (result?.isError) throw new Error("operationFailed");
    toast(t("notified"));
  }),
  "copy-summary": () => perform("copy", async () => {
    await copyText(snapshot.selectedTask.lastSummary);
    toast(t("copied"));
  }, { redraw: false }),
  "load-diff": loadDiff,
  "open-file": (id) => perform("open-file", async () => {
    const change = snapshot.fileChanges?.find((row) => row.id === id);
    const url = workspaceFileUrl(snapshot.selectedTask?.repoPath, change?.filePath);
    if (!url || !app) throw new Error("fileOpenError");
    const result = await app.openLink({ url }, { timeout: connectionTimeout });
    if (result?.isError) throw new Error("fileOpenError");
  }, { redraw: false }),
  revert: (changeId) => perform("task-write", async () => {
    const change = snapshot.fileChanges?.find((row) => row.id === changeId);
    if (!change || !await confirmAction(t("revertConfirm", change.filePath), t("revert"))) return;
    await write("ui_revert_file", { changeId });
    ui.diffs.delete(changeId);
    toast(t("revertDone"));
  }),
  "quota-mode": (mode) => {
    if (!modes.has(mode) || mode === snapshot.config?.routing?.quotaMode) return;
    return perform("config", async () => {
      await write("ui_set_quota_mode", { mode, ...selection() });
      toast(t("quotaSaved"));
    });
  },
  sync: () => perform("config", async () => {
    const result = await write("ui_sync_model_policy", selection());
    if (result.modelPolicy?.syncError) throw new Error(`${t("syncFailed")} · ${result.modelPolicy.syncError}`);
    toast(t("synced"));
  }),
  scan: () => perform("scan", async () => {
    if (busy("config") && locks.has("config")) return;
    await scanEnvironment();
    toast(t("scanned"));
  }),
  "save-models": () => perform("config", async () => {
    const selected = ui.models;
    if (!selected) return;
    const models = lines([...selected].join("\n"), 500, 200);
    await saveConfig({ providers: { magpie: { selectedModels: models } } });
    if (selected === ui.models) ui.models = null;
    toast(t("saved"));
    if (ui.environment?.magpie) await scanEnvironment();
  }),
  "add-provider": () => openProvider(""),
  "edit-provider": openProvider,
  "close-provider": () => openProvider(null),
  "test-provider": (id) => testProvider(id, id),
  "test-editor": (_, element) => {
    const form = element.closest("form");
    if (form.elements.baseUrl.reportValidity()) return testProvider(providerInput(form, true), "editor", form);
  },
  "use-models": () => {
    const ids = ui.probes.get("editor")?.discoveredModels ?? [];
    const usable = ids.filter((id) => id.length <= 200).slice(0, 500);
    ui.forms.set("provider", { ...ui.forms.get("provider"), models: usable.join("\n") });
    if (usable.length < ids.length) toast(t("limit", 500, 200), true);
    render();
  },
  "delete-provider": (id) => perform("config", async () => {
    const providers = snapshot.config.providers.custom ?? [];
    const provider = providers.find((item) => item.id === id);
    if (!provider || !await confirmAction(t("deleteConfirm", provider.name), t("remove"))) return;
    await saveConfig({ providers: { custom: providers.filter((item) => item.id !== id).map((item) => ({ id: item.id })) } });
    ui.probes.delete(id);
    invalidateEnvironment("custom");
    if (ui.provider === id) openProvider(null);
    toast(t("saved"));
  }),
};

/** 清除受配置变化影响的环境结果，保留其他扫描信息。 */
function invalidateEnvironment(key) {
  if (ui.environment) ui.environment = { ...ui.environment, [key]: undefined };
}

/** 打开供应商编辑器或放弃草稿，清除上一编辑对象的测试结果。 */
function openProvider(id) {
  if (id === "" && (snapshot.config.providers.custom?.length ?? 0) >= 50) {
    toast(t("providersLimit"), true);
    return;
  }
  ui.provider = id;
  ui.forms.delete("provider");
  ui.probes.delete("editor");
  render();
  if (id !== null) root.querySelector('[data-focus-key="provider:name"]')?.focus();
}

/** 按表单读取严格配置补丁；自定义供应商列表仅传其他供应商的 ID。 */
async function submitSettings(key, form) {
  const draft = ui.forms.get(key);
  const fields = form.elements;
  let patch;
  if (key === "runtime") {
    patch = {
      runtimes: { codex: { executablePath: fields.executablePath.value.trim(), codexHome: fields.codexHome.value.trim() } },
      providers: { codexPlus: { enabled: fields.officialAccount.checked } },
    };
  } else if (key === "magpie") {
    const apiKey = fields.apiKey.value;
    patch = { providers: { magpie: { baseUrl: gatewayBase(fields.baseUrl.value), enabled: fields.enabled.checked,
      ...(apiKey ? { apiKey } : {}),
    } } };
  } else if (key === "guardrails") {
    patch = { ui: { locale: fields.locale.value }, guardrails: {
      activePreset: fields.activePreset?.value || snapshot.config.guardrails.activePreset,
      customRules: lines(fields.customRules.value, 40, 2000), disableNestedSubagents: fields.disableNestedSubagents.checked,
    } };
  } else if (key === "provider") {
    const input = providerInput(form);
    const providers = snapshot.config.providers.custom ?? [];
    const custom = providers.map(({ id }) => id === input.id ? input : { id });
    if (!input.id) custom.push(input);
    if (!input.name) throw new Error("providerNameRequired");
    if (custom.length > 50) throw new Error("providersLimit");
    patch = { providers: { custom } };
  } else {
    return;
  }
  await saveConfig(patch);
  if (ui.forms.get(key) === draft) ui.forms.delete(key);
  if (key === "magpie") invalidateEnvironment("magpie");
  if (key === "runtime") invalidateEnvironment("codex");
  if (key === "provider") {
    ui.probes.delete(ui.provider);
    invalidateEnvironment("custom");
    if (!ui.forms.has(key)) openProvider(null);
  }
  toast(t("saved"));
}

/** 事件委托保留视图模块的纯渲染职责。 */
root.addEventListener("click", async (event) => {
  const element = event.target.closest("[data-action]");
  if (!element || element.disabled) return;
  try {
    await actions[element.dataset.action]?.(element.dataset.id, element);
  } catch (error) {
    toast(errorText(error), true);
  }
});

root.addEventListener("input", (event) => {
  const element = event.target;
  const search = element.dataset.search;
  if (search) {
    ui.search[search] = element.value;
    if (search === "models") resetCatalog = true;
    render();
    return;
  }
  const form = element.form;
  const key = form?.dataset.form;
  if (key === "note") ui.notes.set(form.dataset.id, element.value);
  else if (key && element.name && (element.type !== "radio" || element.checked)) {
    ui.forms.set(key, { ...ui.forms.get(key), [element.name]: element.type === "checkbox" ? element.checked : element.value });
    if (key === "provider" && ["baseUrl", "apiKey"].includes(element.name) && ui.probes.delete("editor")) render();
  }
});

root.addEventListener("change", (event) => {
  const element = event.target;
  if (element.matches("[data-task-select]")) void selectTask(element.value);
  if (element.dataset.toggle === "reasoning") {
    ui.reasoning = element.checked;
    render();
  }
  if (element.dataset.model) {
    ui.models = new Set(ui.models ?? snapshot.config.providers.magpie.selectedModels ?? []);
    if (element.checked) ui.models.add(element.dataset.model);
    else ui.models.delete(element.dataset.model);
    render();
  }
});

root.addEventListener("toggle", (event) => {
  const element = event.target;
  if (element.open && element.dataset.change && !ui.diffs.has(element.dataset.change)) void loadDiff(element.dataset.change);
}, true);

root.addEventListener("submit", (event) => {
  const form = event.target;
  const key = form.dataset.form;
  if (!key) return;
  event.preventDefault();
  if (composing) return;
  if (key === "note") {
    const taskId = form.dataset.id;
    const content = form.elements.content.value.trim();
    if (!content) return;
    void perform("task-write", async () => {
      await write("ui_add_human_note", { taskId, content });
      if (ui.notes.get(taskId)?.trim() === content) ui.notes.delete(taskId);
      toast(t("noteSent"));
    });
  } else {
    void perform("config", () => submitSettings(key, form));
  }
});

root.addEventListener("compositionstart", () => { composing = true; });
root.addEventListener("compositionend", () => {
  composing = false;
  queueMicrotask(() => { if (renderPending) render(); });
});
root.addEventListener("focusout", (event) => {
  if (!composing || !root.contains(event.target)) return;
  composing = false;
  if (renderPending) queueMicrotask(render);
});

/** 拖动在 window 上跟踪指针并可选启用指针捕获；松手后乐观更新并保存一次。 */
root.addEventListener("pointerdown", (event) => {
  const handle = event.target.closest('[data-resizer="sidebar"]');
  if (!handle || drag || event.button !== 0 || busy("config") || !snapshot.config) return;
  drag = { handle, pointer: event.pointerId, x: event.clientX, base: ui.width, width: ui.width };
  try { handle.setPointerCapture(event.pointerId); } catch {}
  document.body.classList.add("resizing");
  event.preventDefault();
});

window.addEventListener("pointermove", (event) => {
  if (!drag || event.pointerId !== drag.pointer) return;
  drag.width = widthLimit(drag.base + event.clientX - drag.x);
  drag.handle.closest(".shell")?.style.setProperty("--sidebar-width", `${drag.width}px`);
  drag.handle.setAttribute("aria-valuenow", drag.width);
});

/** 结束拖拽时乐观应用目标宽度，并在后台持久化；失败时由服务端快照还原。 */
function finishDrag(event) {
  if (!drag || event.pointerId !== drag.pointer) return;
  const { width } = drag;
  const committed = event.type === "pointerup";
  drag = undefined;
  document.body.classList.remove("resizing");
  if (committed && width !== ui.width) {
    ui.width = width;
    render();
    void saveSidebar({ sidebarWidth: width }).finally(render);
  } else render();
}

for (const name of ["pointerup", "pointercancel"]) window.addEventListener(name, finishDrag);

root.addEventListener("keydown", (event) => {
  if (!event.target.matches('[data-resizer="sidebar"]') || !snapshot.config || busy("config")) return;
  const delta = { ArrowLeft: -10, ArrowRight: 10, Home: -420, End: 420 }[event.key];
  if (delta === undefined) return;
  event.preventDefault();
  void saveSidebar({ sidebarWidth: widthLimit(ui.width + delta) });
});

narrowScreen.addEventListener("change", render);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) clearTimeout(pollTimer);
  else void foreground();
});
window.addEventListener("focus", () => void foreground());
setInterval(() => {
  if (document.hidden) return;
  for (const node of root.querySelectorAll("[data-reset-at]")) {
    const next = countdown(node.dataset.resetAt, t, locale());
    if (node.textContent !== next) node.textContent = next;
  }
}, 15_000);

connect();
