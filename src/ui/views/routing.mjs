import { button, disclosure, empty, esc, icon } from "../components/common.mjs";

const modes = ["burst", "balanced", "free_only"];
const slots = ["plusFlagship", "plusPrimary", "plusBoost", "plusEco", "freeFast"];

/** 全局策略页显示配额、调度模式、选模槽位和历史记录。 */
export function routingView(ctx) {
  const { t, busy, snapshot } = ctx;
  const disabled = !snapshot.config;
  return `<section class="global-view">
    <header class="view-header"><h1>${esc(t("routing"))}</h1><div class="header-actions">
      ${button("sync", t("sync"), { symbol: "bolt", kind: "primary", disabled: disabled || busy("config") })}
      ${button("refresh", t("refresh"), { symbol: "refresh", iconOnly: true, disabled: busy("refresh") })}</div></header>
    <div class="view-scroll global-scroll" data-scroll-key="routing">
      <div class="global-grid">
        ${quotaCard(ctx)}
        ${modeCard(ctx)}
        ${matrixCard(ctx)}
        ${ledgerCard(ctx)}
      </div>
    </div>
  </section>`;
}

/** Codex 提供配额窗口（自动读取账号套餐类型，不写死 Plus/Pro），Antigravity 提供本地转录用量窗口。 */
function quotaCard({ t, snapshot, fmt, locale }) {
  const codex = snapshot.quotaOverview?.codex;
  const antigravity = snapshot.quotaOverview?.antigravity;
  const windows = [["quota5", "primary"], ["quota7", "secondary"]];
  const rawPlan = String(codex?.planType || "").trim();
  const codexHeading = rawPlan ? `Codex · ${rawPlan[0].toUpperCase()}${rawPlan.slice(1)}` : "Codex";
  return `<section class="card panel quota-card" data-scroll-anchor="quota">
    <h2>${icon("routing", 17)}${esc(t("quotaMonitor"))}</h2>
    <div class="quota-section"><h3>${esc(codexHeading)}</h3>
      ${windows.map(([label, key]) => {
        const window = [codex?.primary, codex?.secondary].find((row) => row?.windowMinutes === (key === "primary" ? 300 : 10080))
          ?? (codex?.[key] && !codex[key].windowMinutes ? codex[key] : null);
        if (!window) return `<div class="quota-caption"><span>${esc(t(label))}</span><span>${esc(t("quotaUnavailable"))}</span></div>`;
        const value = Math.min(100, Math.max(0, Number(window.usedPercent) || 0));
        return `<div class="quota-meter"><div class="quota-caption"><span>${esc(t(label))}</span><strong>${fmt.percent(window.usedPercent)}</strong></div>
          <progress value="${value}" max="100" aria-label="${esc(codexHeading)} · ${esc(t(label))}"></progress>
          <small data-reset-at="${esc(window.resetsAt)}">${esc(countdown(window.resetsAt, t, locale))}</small></div>`;
      }).join("")}
    </div>
    <div class="quota-section"><h3>Antigravity</h3>
      ${windows.map(([label, key]) => {
        const window = antigravity?.[key];
        return `<div class="quota-caption"><span>${esc(t(label))}</span><span>${window ? esc(t("windowTasks", fmt.number(window.tasks))) : "—"}</span>
          <small>${window ? `${esc(t("input"))} ${fmt.number(window.inputTokens)} · ${esc(t("output"))} ${fmt.number(window.outputTokens)}` : ""}</small></div>`;
      }).join("")}
      <p class="muted">${esc(t("activityUnavailable"))}</p>
    </div></section>`;
}

/** 倒计时兼容历史 Unix 秒、毫秒和 ISO 值，由主入口单独更新文本。 */
export function countdown(resetsAt, t, locale) {
  if (resetsAt == null || resetsAt === "") return "—";
  const numeric = Number(resetsAt);
  const date = Number.isFinite(numeric) ? numeric * (numeric < 1e12 ? 1000 : 1) : Date.parse(resetsAt);
  const mins = Math.ceil((date - Date.now()) / 60_000);
  if (!Number.isFinite(mins)) return "—";
  if (mins <= 0) return t("awaitingReset");
  const format = (value, unit) => new Intl.NumberFormat(locale, { style: "unit", unit, unitDisplay: "short" }).format(value);
  const hours = Math.floor(mins / 60);
  return t("resetsIn", [hours ? format(hours, "hour") : "", mins % 60 ? format(mins % 60, "minute") : ""].filter(Boolean).join(" "));
}

/** 三档模式使用持久配置中的当前值，写入时防重复提交。 */
function modeCard({ t, snapshot, busy }) {
  const current = snapshot.config?.routing?.quotaMode;
  return `<section class="card panel mode-card" data-scroll-anchor="modes"><h2>${icon("bolt", 17)}${esc(t("quotaMode"))}</h2>
    <div class="mode-options">${modes.map((mode) => `<button type="button" data-action="quota-mode" data-id="${mode}"
      aria-pressed="${mode === current}" ${!current || busy("config") ? "disabled" : ""}>
      <span class="mode-indicator"></span><span><strong>${esc(t(mode))}</strong><small>${esc(t(`${mode}Help`))}</small></span>
    </button>`).join("")}</div>
  </section>`;
}

/** 选模槽位严格读取公开投影，缺失的评分与延迟使用空值占位。 */
function matrixCard({ t, fmt, snapshot }) {
  const policy = snapshot.modelPolicy;
  const columns = ["slot", "modelEffort", "score", "weight", "latency", "reason"].map((key) => t(key));
  let hasMetrics = false;
  const rows = slots.map((key) => {
    const slot = policy?.slots?.[key];
    const model = slot ? [slot.model, slot.reasoningEffort].filter(Boolean).join(" × ") : t("noCandidate");
    const score = Number.isFinite(slot?.intelligence) ? (hasMetrics = true, esc(slot.intelligence.toFixed(1))) : "—";
    const cost = slot?.isFreeChannel ? `<span class="badge success-badge">${esc(t("freeChannel"))}</span>`
      : Number.isFinite(slot?.costPerTask) ? (hasMetrics = true, `$${esc(slot.costPerTask.toFixed(2))}`) : "—";
    const latency = Number.isFinite(slot?.latency) ? (hasMetrics = true, `${esc(slot.latency.toFixed(1))}s`) : "—";
    return [`<strong>${esc(t(key))}</strong>`, `<span>${esc(model)}</span>${slot?.provider ? `<small>${esc(slot.provider)}</small>` : ""}`, score, cost, latency, esc(slot?.reason ? t(slot.reason) : "—")];
  });
  const rejected = policy?.rejectedHighlights ?? [];
  const invalid = policy?.invalidOverrides ?? [];
  return `<section class="card panel full" data-scroll-anchor="matrix"><h2>${icon("log", 17)}${esc(t("matrix"))}</h2>
    ${table(columns, rows, "matrix-table")}
    ${hasMetrics ? "" : `<p class="muted">${esc(t("policyStatsMissing"))}</p>`}
    <div class="matrix-footer">
      <p><strong>${esc(t("lastSync"))}</strong> · ${esc(policy?.syncedAt ? fmt.date(policy.syncedAt) : t("noSync"))}</p>
      ${rejected.length ? `<p><strong>${esc(t("rejected"))}</strong> · ${rejected.map((item) => `<code class="text-chip" title="${esc(item.reason)}">${esc([item.model, item.reasoningEffort].filter(Boolean).join(" × "))}</code>`).join(" ")}</p>` : ""}
      ${invalid.length ? `<p class="negative">${esc(t("invalidOverrides"))} · ${invalid.map((key) => esc(t(key))).join(" · ")}</p>` : ""}
      ${policy?.syncError ? `<p class="negative">${esc(policy.syncError)}</p>` : ""}
    </div>
  </section>`;
}

/** 消耗账本保留服务端按模型、强度和供应商的分组，以及最近 20 轮记录。 */
function ledgerCard({ t, fmt, snapshot }) {
  const usage = snapshot.usage;
  const general = usage?.byModelEffort ?? [];
  const recent = (usage?.recent ?? []).slice(0, 20);
  const labels = ["modelEffort", "runs", "input", "output", "cache", "quota5", "quota7"].map((key) => t(key));
  const rows = general.map((row) => [
    `<strong>${esc([row.model, row.reasoningEffort].filter(Boolean).join(" × "))}</strong><small>${esc(row.engine)}</small>`,
    fmt.number(row.runs), fmt.number(row.inputTokens), fmt.number(row.outputTokens),
    fmt.percent(row.inputTokens > 0 ? row.cachedInputTokens / row.inputTokens * 100 : null),
    fmt.percent(row.primaryQuotaDelta), fmt.percent(row.secondaryQuotaDelta),
  ]);
  const recentRows = recent.map((row) => [
    `<strong>${esc(row.taskTitle)}</strong><small>${esc(t("round", row.round))} · ${esc(fmt.date(row.createdAt))}</small>`,
    esc([row.model, row.reasoningEffort].filter(Boolean).join(" × ") || "—"),
    fmt.number(row.inputTokens), fmt.number(row.outputTokens), fmt.percent(row.primaryQuotaDelta), fmt.percent(row.secondaryQuotaDelta),
  ]);
  return `<section class="card panel full" data-scroll-anchor="ledger"><h2>${icon("terminal", 17)}${esc(t("ledger"))}</h2>
    ${general.length ? table(labels, rows, "ledger-table") : empty(t("empty"))}
    ${recent.length ? disclosure("routing:recent", esc(t("recentRuns", recent.length)),
      table(["task", "modelEffort", "input", "output", "quota5", "quota7"].map((key) => t(key)), recentRows, "recent-table"), "recent-runs") : ""}
  </section>`;
}

/** 桌面保留表头，窄屏把每条记录变为带标签的自适应明细。 */
function table(labels, rows, className) {
  return `<table class="responsive-table ${className}"><thead><tr>${labels.map((label) => `<th scope="col">${esc(label)}</th>`).join("")}</tr></thead>
    <tbody>${rows.map((row) => `<tr>${row.map((cell, index) => `<td data-label="${esc(labels[index])}">${cell}</td>`).join("")}</tr>`).join("")}</tbody>
  </table>`;
}
