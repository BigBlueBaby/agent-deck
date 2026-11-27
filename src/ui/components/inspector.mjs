import { disclosure, esc, facts, icon, lineCounts } from "./common.mjs";

/** 对选中工单汇总文件行数，并展示双端已有的遥测值。 */
export function inspector(ctx, compact = false) {
  const { t, snapshot, fmt } = ctx;
  const task = snapshot.selectedTask;
  const metrics = snapshot.selectedTaskMetrics;
  const changes = snapshot.fileChanges ?? [];
  const [added, removed] = changes.reduce(([a, r], row) => [a + row.addedLines, r + row.removedLines], [0, 0]);
  const codex = metrics?.codex ?? ledgerTelemetry(metrics?.usage);
  const model = [task.model, task.reasoningEffort].filter(Boolean).join(" × ");
  const rationale = task.routingReason?.split(" · ").map((part) => t(part)).join(" · ");
  const show = (value) => esc(value || "—");
  const body = `<div class="inspector-body">
    ${facts([
      [t("repository"), show(task.repoPath)], [t("branch"), show(task.branchName)], [t("modelEffort"), show(model)],
      [t("provider"), show(task.provider)], [t("netChanges"), lineCounts(fmt.number(added), fmt.number(removed))],
      [t("routingReason"), show(rationale)],
    ])}
    <div class="inspector-metrics"><h3>${esc(t("telemetry"))}</h3>
      ${side(ctx, "Antigravity", metrics?.antigravity)}
      ${side(ctx, "Codex / Worker", codex)}
    </div></div>`;
  if (compact) {
    const summary = `${icon("info", 16)}<strong>${esc(t("inspector"))}</strong><span class="inspector-short">${show(model)}</span>`;
    return disclosure(`${task.id}:inspector`, summary, body, "card inspector-compact");
  }
  return `<aside class="card inspector-wide"><h2>${icon("info", 17)}${esc(t("inspector"))}</h2>${body}</aside>`;
}

/** 无 Codex 线程遥测时汇总该工单各轮账本，所有轮次都缺失的额度保持空值。 */
function ledgerTelemetry(runs) {
  if (!runs?.length) return null;
  const columns = {
    turns: "turns_count", toolCalls: "tool_calls_count", inputTokens: "input_tokens",
    cachedInputTokens: "cached_input_tokens", outputTokens: "output_tokens",
    primaryDelta: "primary_quota_delta", secondaryDelta: "secondary_quota_delta",
  };
  return Object.fromEntries(Object.entries(columns).map(([key, column]) => {
    const samples = runs.map((run) => run[column]).filter((value) => Number.isFinite(value));
    return [key, samples.length ? samples.reduce((sum, value) => sum + value, 0) : null];
  }));
}

/** 缓存率按缓存输入除以总输入计算；额度增量仅在存在可观察数值时展示。 */
function side({ t, fmt }, name, metric) {
  const entries = metric ? [
    [t("turns"), fmt.number(metric.turns)], [t("toolCalls"), fmt.number(metric.toolCalls)],
    [t("input"), fmt.number(metric.inputTokens)], [t("output"), fmt.number(metric.outputTokens)],
    [t("cache"), fmt.percent(metric.inputTokens > 0 && metric.cachedInputTokens != null ? metric.cachedInputTokens / metric.inputTokens * 100 : null)],
    ...(metric.primaryDelta != null || metric.secondaryDelta != null
      ? [[t("quotaDeltaShort"), `${fmt.percent(metric.primaryDelta)} / ${fmt.percent(metric.secondaryDelta)}`]] : []),
  ] : null;
  const rows = entries ? facts(entries) : `<p class="muted">${esc(t("noTelemetry"))}</p>`;
  return `<section class="metric-side"><h4>${esc(name)}${metric?.model ? `<small>${esc(metric.model)}</small>` : ""}</h4>${rows}</section>`;
}
