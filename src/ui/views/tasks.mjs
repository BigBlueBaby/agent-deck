import { button, disclosure, empty, esc, icon, lineCounts, search } from "../components/common.mjs";
import { inlineMarkdown, markdown } from "../components/markdown.mjs";
import { inspector } from "../components/inspector.mjs";

const statuses = ["queued", "running", "reviewing", "need_human", "failed", "done", "cancelled"];
const tabs = [["activity", "log"], ["changes", "diff"], ["conversation", "chat"]];
const activeStatuses = new Set(["queued", "running", "need_human"]);

/** 规范状态样式类，未知状态仍以文本显示。 */
function badge(t, status) {
  return `<span class="badge state-${statuses.includes(status) ? status : "neutral"}"><i></i>${esc(t(status || "empty"))}</span>`;
}

/** 工单台唯一渲染工单侧栏。窄屏和折叠状态使用顶部选择器。 */
export function tasksView(ctx) {
  const { t, snapshot, ui, busy, narrow } = ctx;
  const task = snapshot.selectedTask;
  const hasSidebar = !narrow && !ui.collapsed;
  const picker = hasSidebar ? "" : `<div class="task-picker">
    ${narrow ? "" : button("sidebar", t("expand"), { symbol: "sidebar", iconOnly: true })}
    <select data-task-select data-focus-key="task-select" aria-label="${esc(t("selectTask"))}" ${snapshot.tasks?.length || task ? "" : "disabled"}>
      ${options(snapshot, t)}
    </select></div>`;
  const content = task ? `${taskHeader(ctx, picker)}
    ${tabBar(ctx)}
    ${ui.tab === "changes" ? changesView(ctx) : ui.tab === "conversation" ? conversationView(ctx) : activityView(ctx)}`
    : `<div class="view-header"><h1>${esc(t("tasks"))}</h1>${picker}${button("refresh", t("refresh"), { symbol: "refresh", iconOnly: true, disabled: busy("refresh") })}</div>
      <div class="view-scroll"><div class="card">${empty(t("emptyTasks"), t("noTaskDetail"))}</div></div>`;
  return `<div class="tasks-layout ${hasSidebar ? "has-sidebar" : ""}">
    ${hasSidebar ? sidebar(ctx) : ""}<section class="task-detail">${content}</section>
  </div>`;
}

/** 保留当前工单选项，包括服务端列表裁剪后仍可见的选中详情。 */
function options(snapshot, t) {
  const tasks = [...(snapshot.tasks ?? [])];
  if (snapshot.selectedTask && !tasks.some(({ id }) => id === snapshot.selectedTaskId)) tasks.unshift(snapshot.selectedTask);
  const all = [`<option value="">${esc(t("selectTask"))}</option>`];
  return all.concat(tasks.map((task) => `<option value="${esc(task.id)}" ${task.id === snapshot.selectedTaskId ? "selected" : ""}>${esc(task.title)}</option>`)).join("");
}

/** 工单列表按标题、模型或仓库检索，每行只使用两行高度。 */
function sidebar({ t, snapshot, ui, fmt }) {
  const query = ui.search.tasks.toLowerCase().trim();
  const tasks = snapshot.tasks ?? [];
  const filtered = tasks.filter((task) => {
    const matches = !query || [task.title, task.model, task.repoPath].some((value) => String(value ?? "").toLowerCase().includes(query));
    return matches && (ui.taskFilter === "all" || (ui.taskFilter === "active" ? activeStatuses.has(task.status) : task.status === "reviewing"));
  });
  return `<aside class="task-sidebar">
    <div class="sidebar-head"><div><h2>${esc(t("tasks"))}</h2><span class="count">${tasks.length}</span></div>
      ${button("sidebar", t("collapse"), { symbol: "sidebar", iconOnly: true, kind: "ghost" })}</div>
    <div class="sidebar-tools">${search("tasks", ui.search.tasks, t("searchTasks"))}
      <div class="pills">${["all", "active", "reviewing"].map((value) => button("task-filter", t(value), { id: value, kind: "pill", pressed: ui.taskFilter === value })).join("")}</div>
    </div>
    <div class="task-list" data-scroll-key="task-list">
      ${filtered.length ? filtered.map((task) => {
        const model = task.model?.split("/").at(-1) || "—";
        return `<button type="button" class="task-row state-${statuses.includes(task.status) ? task.status : "neutral"}" data-action="task" data-id="${esc(task.id)}" data-scroll-anchor="${esc(task.id)}" aria-current="${task.id === (ui.requestedTask ?? snapshot.selectedTaskId)}">
          <span class="task-row-title"><i title="${esc(t(task.status))}"></i><span>${esc(task.title)}</span></span>
          <span class="task-row-meta"><span title="${esc(task.model)}">${esc(model)}</span><time title="${esc(fmt.date(task.updatedAt))}">${esc(fmt.relative(task.updatedAt))}</time></span>
        </button>`;
      }).join("") : empty(t(tasks.length ? "emptyFilter" : "emptyTasks"))}
    </div>
    <div class="resizer" data-resizer="sidebar" role="separator" tabindex="0" aria-orientation="vertical" aria-label="${esc(t("resize"))}" aria-valuemin="200" aria-valuemax="420" aria-valuenow="${ui.width}"></div>
  </aside>`;
}

/** 顶栏根据工单状态给出最多两个主操作。 */
function taskHeader({ snapshot, t, ui, busy }, picker) {
  const task = snapshot.selectedTask;
  const id = task.id;
  const stopped = ui.cancelling.has(id);
  const actions = [];
  if (["running", "queued"].includes(task.status)) actions.push(button("stop", t(stopped ? "stopping" : "stop"), { id, kind: "danger", disabled: stopped || busy("task-write") }));
  if (task.status === "reviewing") {
    actions.push(button("tab", t("changesAction"), { id: "changes", symbol: "diff" }));
    actions.push(button("notify", t("notify"), { id, kind: "primary", disabled: busy("notify") }));
  }
  if (["failed", "need_human"].includes(task.status)) actions.push(button("resume", t("resume"), { id, kind: "primary", disabled: busy("task-write") }));
  if (task.status === "done" && task.lastSummary) actions.push(button("copy-summary", t("copySummary"), { id }));
  return `<header class="view-header task-header">
    ${picker}<div class="header-heading"><div class="task-kicker"><span>${esc(t("tasks"))}</span>${badge(t, task.status)}</div><h1 title="${esc(task.title)}">${esc(task.title)}</h1></div>
    <div class="header-actions">${actions.join("")}${button("refresh", t("refresh"), { symbol: "refresh", iconOnly: true, disabled: busy("refresh") })}</div>
  </header>`;
}

/** 二级导航仅展示当前工单的数据和计数。 */
function tabBar({ t, snapshot, ui }) {
  const flagged = snapshot.fileChanges?.some(isFlagged);
  return `<nav class="task-tabs" aria-label="${esc(t("tasks"))}">
    ${tabs.map(([key, glyph]) => {
      const count = key === "changes" ? snapshot.fileChanges?.length ?? 0 : key === "conversation" ? snapshot.messages?.length ?? 0 : null;
      return `<button type="button" data-action="tab" data-id="${key}" aria-current="${ui.tab === key}">${icon(glyph, 16)}${esc(t(key))}
        ${count == null ? "" : `<span class="count">${count}</span>`}${key === "changes" && flagged ? `<i class="warning-dot" aria-label="${esc(t("flagged"))}"></i>` : ""}</button>`;
    }).join("")}
  </nav>`;
}

/** 用服务端状态映射四步进度；失败、取消和待确认保留当前阶段。 */
function progress(t, status) {
  const stage = status === "queued" ? 0 : status === "reviewing" ? 2 : status === "done" ? 3 : 1;
  return `<ol class="progress" aria-label="${esc(t("progress"))}">${["dispatch", "execution", "review", "close"].map((step, index) =>
    `<li class="${index < stage || status === "done" ? "passed" : ""}" ${index === stage ? 'aria-current="step"' : ""}><i>${index < stage || status === "done" ? icon("check", 11) : ""}</i><span>${esc(t(step))}</span></li>`).join("")}</ol>`;
}

/** 只按公开事件文本识别读或检索；无正文的 Codex 命令另作普通命令组。 */
function commandKind(event) {
  if (event.eventType === "web_search") return "read";
  if (!["command", "command_execution"].includes(event.eventType)) return null;
  const summary = String(event.summary ?? "");
  if (/(?:^|[\s;|&"'\\/])(?:rg(?:\.exe)?|grep|findstr|find(?:-item)?|read_file|search_files|get-content|get-childitem|select-string|cat|sed|head|tail|ls|type)(?=\s|$|["'])|检索|读取|搜索/i.test(summary)) return "read";
  return /^(?:执行工作区命令|命令结束)/.test(summary) ? "command" : null;
}

/** 删除紧邻同轮完成事件的开始记录，保留仍在执行或无法配对的事件。 */
function compactEvents(events, showReasoning) {
  const sorted = [...events].sort((a, b) => b.id - a.id);
  const rows = sorted.filter((event, index) => {
    if (event.eventType === "reasoning" && !showReasoning) return false;
    const newer = sorted[index - 1];
    const adjacentEnd = newer?.eventType === event.eventType && newer?.round === event.round;
    return !(adjacentEnd && (
      (event.summary === "执行工作区命令" && newer.summary?.startsWith("命令结束")) ||
      (event.eventType === "web_search" && event.summary === "工具调用开始" && newer.summary === "工具调用结束")
    ));
  });
  const groups = [];
  for (const event of rows) {
    const key = commandKind(event);
    const current = groups.at(-1);
    if (key && key === current?.key && event.round === current.round) current.events.push(event);
    else groups.push({ key, round: event.round, events: [event] });
  }
  return groups;
}

/** 按明确的退出码计算命令结果，未报告的状态保留为未知。 */
function eventOutcome(summary = "") {
  const exit = /(?:退出码|exit(?:ed with)?(?: code)?)\s*[:：]?\s*(-?\d+)/i.exec(summary);
  if (exit) return Number(exit[1]) === 0 ? "success" : "failures";
  if (/失败|\bfailed\b/i.test(summary)) return "failures";
  if (/成功|完成|\bsucceeded\b/i.test(summary)) return "success";
  return "unknownResults";
}

/** 动态行由最新到最旧排列，聚合行保留可展开的原始事件。 */
function eventRows(ctx) {
  const { t, ui, snapshot, fmt } = ctx;
  const rows = compactEvents(snapshot.events ?? [], ui.reasoning);
  const eventRow = (event) => {
    const type = event.eventType;
    const label = ["command", "command_execution"].includes(type) ? "command"
      : type.startsWith("thread.") ? "session" : type.startsWith("turn.") ? "execution" : type.endsWith("_tool_call") ? "tool" : type;
    return `<div class="event-row" data-scroll-anchor="event:${esc(event.id)}"><span class="event-glyph">${icon(label === "command" ? "terminal" : label === "file_change" ? "diff" : "log", 15)}</span>
      <div><span class="event-label">${esc(t(label))}</span><div class="event-text">${inlineMarkdown(event.summary)}</div></div>
      <time title="${esc(fmt.date(event.createdAt))}">${esc(fmt.relative(event.createdAt))}</time>
    </div>`;
  };
  return rows.map(({ key, events }) => {
    if (events.length === 1) return eventRow(events[0]);
    const outcomes = { success: 0, failures: 0, unknownResults: 0 };
    for (const event of events) outcomes[eventOutcome(event.summary)]++;
    const anchor = `group:${events.at(-1).id}`;
    const summary = `<div class="event-group-label" data-scroll-anchor="${esc(anchor)}"><strong>${esc(t(key === "read" ? "groupedReads" : "groupedCommands", events.length))}</strong>
      <span>${Object.entries(outcomes).filter(([, count]) => count).map(([kind, count]) => esc(t(kind, count))).join(" · ")}</span></div>`;
    return disclosure(`${snapshot.selectedTaskId}:${anchor}`, summary, `<div class="event-group-items">${events.map(eventRow).join("")}</div>`, "event-group");
  }).join("");
}

/** 动态页在宽屏提供独立检查器，中窄屏使用可折叠摘要。 */
function activityView(ctx) {
  const { t, snapshot, ui } = ctx;
  const task = snapshot.selectedTask;
  const summary = String(task.lastError || task.lastSummary || "").trim();
  const summaryLine = summary.split(/\r?\n/).find((line) => line.trim() && !/^\s*```/.test(line))?.replace(/^\s*(?:#{1,6}\s+|[-*]\s+)/, "");
  const feed = eventRows(ctx);
  return `<div class="view-scroll activity-scroll" data-scroll-key="activity:${esc(task.id)}">
    ${inspector(ctx, true)}
    <div class="activity-grid">
      <div class="activity-main">
        <section class="card outcome" data-scroll-anchor="outcome"><div class="outcome-label"><h2>${esc(t("conclusion"))}</h2><span>${esc(t("rounds", task.currentRound, task.maxRounds))}</span></div>
          <p>${inlineMarkdown(summaryLine || t("noSummary"))}</p>${progress(t, task.status)}
        </section>
        <section class="card events"><div class="section-heading"><h2>${esc(t("activity"))}</h2>
          <label class="switch-label"><input type="checkbox" data-toggle="reasoning" ${ui.reasoning ? "checked" : ""}>${esc(t("showReasoning"))}</label></div>
          ${feed || empty(t("empty"))}
        </section>
      </div>
      ${inspector(ctx)}
    </div>
  </div>`;
}

/** 判断文件筛选是否包含范围、策略或回滚告警。 */
function isFlagged(change) {
  return Boolean(change.outOfScope || change.warnings?.length);
}

/** 文件列表只渲染有计数的筛选项，并按工单保存滚动锚点。 */
function changesView(ctx) {
  const { t, snapshot, ui } = ctx;
  const all = snapshot.fileChanges ?? [];
  const filters = [["all", () => true], ["added", (c) => c.changeType === "added"], ["modified", (c) => c.changeType === "modified"],
    ["deleted", (c) => c.changeType === "deleted"], ["flagged", isFlagged]];
  const counts = filters.map(([key, test]) => [key, all.filter(test).length]);
  const active = counts.some(([key, count]) => key === ui.fileFilter && count > 0) ? ui.fileFilter : "all";
  const query = ui.search.files.trim().toLowerCase();
  const matches = all.filter(filters.find(([key]) => key === active)[1]).filter((change) => change.filePath.toLowerCase().includes(query));
  return `<div class="view-scroll" data-scroll-key="changes:${esc(snapshot.selectedTaskId)}">
    <section class="card files">
      <div class="section-heading">${search("files", ui.search.files, t("searchFiles"))}
        <div class="pills">${counts.filter(([, count]) => count > 0).map(([key, count]) => button("file-filter", `${t(key)} ${count}`, { id: key, kind: "pill", pressed: active === key })).join("")}</div>
      </div>
      ${matches.length ? matches.map((change) => fileRow(ctx, change)).join("") : empty(t(all.length ? "emptyFilter" : "empty"))}
    </section>
  </div>`;
}

/** 文件 Diff 在首次展开时读取；回滚按钮受工单状态和可用快照约束。 */
function fileRow({ t, snapshot, ui, busy }, change) {
  const { id } = change;
  const entry = ui.diffs.get(id);
  const warnings = [...(change.warnings ?? [])];
  if (change.outOfScope) warnings.unshift(t("outOfScope"));
  if (change.localOnlyArtifact) warnings.push(t("localOnly"));
  const status = snapshot.selectedTask.status;
  const allowRevert = change.hasSnapshot && !change.reverted && !["running", "queued", "done"].includes(status);
  const summary = `${icon("diff", 16)}<span class="file-name" title="${esc(change.filePath)}"><strong>${esc(change.filePath)}</strong>
    <small>${esc(t(change.changeType))} · ${esc(t("round", change.round))}${change.reverted ? ` · ${esc(t("reverted"))}` : ""}</small></span>
    ${warnings.length ? `<i class="warning-dot" aria-label="${esc(t("flagged"))}"></i>` : ""}${lineCounts(change.addedLines, change.removedLines)}`;
  const diff = entry?.data?.diffText;
  const result = entry?.error ? `<div class="file-error">${esc(entry.error)} ${button("load-diff", t("refresh"), { id, symbol: "refresh" })}</div>`
    : entry?.data ? diff ? renderDiff(id, diff) : empty(t("noDiff")) : empty(t("loading"));
  return `<div><details class="file-row" data-disclosure="file:${esc(id)}" data-change="${esc(id)}"><summary data-scroll-anchor="file:${esc(id)}">${summary}</summary>
    <div class="file-detail">
      ${warnings.length ? `<ul class="file-warnings">${warnings.map((warning) => `<li>${esc(warning)}</li>`).join("")}</ul>` : ""}
      <div class="file-actions">${change.changeType === "deleted" || change.reverted && !change.preExists ? "" : button("open-file", t("openFile"), { id, symbol: "external" })}
        ${allowRevert ? button("revert", t("revert"), { id, kind: "danger", disabled: busy("task-write") }) : ""}</div>
      ${result}
    </div>
  </details></div>`;
}

/** 仅按统一 diff 行前缀着色，所有内容保持纯文本并可换行。 */
function renderDiff(id, diff) {
  return `<pre class="diff" data-scroll-key="diff:${esc(id)}">${diff.split(/\r?\n/).map((line) => {
    const kind = /^[+-]{3}|^diff |^index /.test(line) ? "meta" : line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : line.startsWith("@@") ? "hunk" : "";
    return `<span class="diff-line ${kind}">${esc(line) || " "}</span>`;
  }).join("")}</pre>`;
}

/** 对话支持安全 Markdown、长文折叠与按工单隔离的固定批注框。 */
function conversationView({ t, snapshot, ui, fmt, busy }) {
  const id = snapshot.selectedTaskId;
  const rows = (snapshot.messages ?? []).map((message) => {
    const content = String(message.content ?? "");
    const sender = ["orchestrator", "worker", "human"].includes(message.sender) ? message.sender : "other";
    const long = content.length > 600;
    // 预览按渲染后的块高度截断，以免从中间切断 Markdown 链接并露出路径。
    const body = long ? `<div class="message-preview markdown" aria-hidden="true">${markdown(content)}</div>${disclosure(`message:${message.id}`, esc(t("readMore")), `<div class="markdown message-full">${markdown(content)}</div>`, "message-more")}`
      : `<div class="markdown">${markdown(content)}</div>`;
    return `<article class="bubble from-${sender}" data-scroll-anchor="message:${esc(message.id)}">
      <header><strong>${esc(t(message.sender))}</strong><span>${esc(t(message.kind))} · ${esc(t("round", message.round))}</span><time>${esc(fmt.date(message.createdAt))}</time></header>${body}</article>`;
  }).join("");
  return `<div class="conversation">
    <div class="view-scroll message-list" data-scroll-key="chat:${esc(id)}">${rows || `<div class="card">${empty(t("empty"))}</div>`}</div>
    <form class="note-form" data-form="note" data-id="${esc(id)}"><textarea name="content" data-focus-key="note:${esc(id)}" aria-label="${esc(t("notePlaceholder"))}" placeholder="${esc(t("notePlaceholder"))}" required maxlength="30000" rows="2">${esc(ui.notes.get(id))}</textarea>
      <button type="submit" class="button primary" ${busy("task-write") ? "disabled" : ""}>${icon("send", 16)}${esc(t("sendNote"))}</button>
    </form>
  </div>`;
}
