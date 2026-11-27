import { button, disclosure, empty, esc, facts, icon, search } from "../components/common.mjs";

/** 全局设置使用独立表单，界面草稿在快照刷新或切换视图时保留。 */
export function setupView(ctx) {
  const { t, snapshot, busy } = ctx;
  const config = snapshot.config;
  return `<section class="global-view">
    <header class="view-header"><h1>${esc(t("setup"))}</h1><div class="header-actions">
      ${button("scan", t(busy("scan") ? "scanning" : "scan"), { symbol: "bolt", kind: "primary", disabled: !config || busy("scan") || busy("config") })}
    </div></header>
    <div class="view-scroll global-scroll" data-scroll-key="setup">
      ${config ? `<div class="global-grid setup-grid">${runtimes(ctx)}${magpie(ctx)}${customProviders(ctx)}${guardrails(ctx)}</div>`
        : `<section class="card">${empty(t("loading"))}</section>`}
    </div>
  </section>`;
}

/** 表单控件使用同一草稿键和可访问标签，密码框仅显示是否已有保存值。 */
function field(ctx, form, name, label, fallback, options = {}) {
  const { type = "text", max, required, placeholder, choices, rows } = options;
  const value = ctx.ui.forms.get(form)?.[name] ?? fallback ?? "";
  const attrs = `name="${name}" data-focus-key="${form}:${name}"${max ? ` maxlength="${max}"` : ""}${required ? " required" : ""}${placeholder ? ` placeholder="${esc(placeholder)}"` : ""}`;
  if (type === "checkbox") {
    return `<label class="switch-label"><input ${attrs} type="checkbox" ${value ? "checked" : ""}><span>${esc(label)}</span></label>`;
  }
  const input = choices ? `<select ${attrs}>${choices.map(([option, title]) => `<option value="${esc(option)}" ${option === value ? "selected" : ""}>${esc(title)}</option>`).join("")}</select>`
    : rows ? `<textarea ${attrs} rows="${rows}">${esc(value)}</textarea>`
    : type === "password" ? `<input ${attrs} type="password" autocomplete="new-password">`
    : `<input ${attrs} type="${type}" value="${esc(value)}">`;
  return `<label class="field"><span>${esc(label)}</span>${input}</label>`;
}

/** 保存按钮在同一配置写入期间禁用，服务端仍负责严格字段校验。 */
function saveButton({ t, busy }, label = "save") {
  return `<button type="submit" class="button primary" ${busy("config") || busy("scan") ? "disabled" : ""}>${esc(t(label))}</button>`;
}

/** 运行时检测的路径与用户可保存的覆盖值分别展示。 */
function runtimes(ctx) {
  const { t, snapshot, ui } = ctx;
  const config = snapshot.config.runtimes?.codex ?? {};
  const codex = ui.environment?.codex;
  const claude = ui.environment?.claude;
  const code = (value) => esc(value || "—");
  const status = (result) => `<span class="badge ${result?.available ? "success-badge" : ""}">${esc(t(result ? result.available ? "available" : "unavailable" : "unscanned"))}</span>`;
  return `<section class="card panel runtimes-card" data-scroll-anchor="runtimes"><h2>${icon("terminal", 17)}${esc(t("runtimes"))}</h2>
    <div class="runtime-heading"><h3>Codex CLI</h3>${status(codex)}</div>
    ${codex ? facts([[t("version"), code(codex.version)], [t("exePath"), code(codex.executablePath)], ["CODEX_HOME", code(codex.codexHome)]]) : ""}
    <form class="settings-form" data-form="runtime">
      ${field(ctx, "runtime", "executablePath", t("exePath"), config.executablePath, { max: 4096, placeholder: t("autoPath") })}
      ${field(ctx, "runtime", "codexHome", "CODEX_HOME", config.codexHome, { max: 4096, placeholder: t("autoPath") })}
      <div class="form-actions split">${field(ctx, "runtime", "officialAccount", t("officialAccount"), snapshot.config.providers?.codexPlus?.enabled !== false, { type: "checkbox" })}${saveButton(ctx)}</div>
    </form>
    <div class="runtime-heading claude"><h3>Claude Code CLI</h3>${status(claude)}</div>
    <p class="muted">${esc(t("phase2"))}</p>
    ${claude?.executablePath ? facts([[t("exePath"), code(claude.executablePath)]]) : ""}
  </section>`;
}

/** Magpie 网关设置和目录勾选分开保存，防止配置草稿被勾选操作提交。 */
function magpie(ctx) {
  const { t, snapshot, ui, busy } = ctx;
  const cfg = snapshot.config.providers?.magpie ?? {};
  const magpie = ui.environment?.magpie;
  const selected = ui.models ?? new Set(cfg.selectedModels ?? []);
  const total = magpie?.totalModels ?? 0;
  const status = cfg.enabled === false ? "disabled" : magpie ? magpie.reachable ? "online" : total ? "cachedCatalog" : "unavailable" : "unscanned";
  return `<section class="card panel magpie-card" data-scroll-anchor="magpie"><h2>${icon("routing", 17)}${esc(t("magpie"))}
    <span class="badge ${status === "online" ? "success-badge" : ""}">${esc(t(status))}</span></h2>
    <form class="settings-form" data-form="magpie">
      ${field(ctx, "magpie", "baseUrl", t("baseUrl"), cfg.baseUrl, { type: "url", max: 2048, required: true })}
      ${field(ctx, "magpie", "apiKey", t("apiKey"), "", { type: "password", max: 4096, placeholder: cfg.apiKey ? t("keepKey") : "" })}
      <div class="form-actions split">${field(ctx, "magpie", "enabled", t("enable"), cfg.enabled !== false, { type: "checkbox" })}${saveButton(ctx)}</div>
    </form>
    <div class="catalog">
      <div class="catalog-heading"><span>${magpie ? esc(t("modelCount", total)) : esc(t("scanNeeded"))}</span><strong>${esc(t("selectedCount", selected.size))}</strong></div>
      ${magpie || selected.size ? search("models", ui.search.models, t("searchModels")) : ""}
      ${modelGroups(ctx, magpie, selected)}
      <div class="form-actions">${button("save-models", t("saveSelection"), { kind: "primary", disabled: !ui.models || busy("config") || busy("scan") })}</div>
    </div>
  </section>`;
}

/** 保留离线或已消失模型的勾选，便于用户显式取消；搜索覆盖渠道和模型名。 */
function modelGroups({ t, ui, fmt }, magpie, selected) {
  const groups = magpie?.groups ?? [];
  const known = new Set(groups.flatMap((group) => group.models.map((model) => model.id)));
  const missing = [...selected].filter((id) => !known.has(id));
  const source = missing.length ? [...groups, { owner: t("missingCatalog"), key: "missing", models: missing.map((id) => ({ id })) }] : groups;
  const q = ui.search.models.trim().toLowerCase();
  const rendered = source.flatMap((group) => {
    const matches = group.models.filter((model) => [group.owner, model.id, model.displayName].some((value) => String(value ?? "").toLowerCase().includes(q)));
    if (!matches.length) return [];
    const checked = group.models.filter((model) => selected.has(model.id)).length;
    const header = `<span class="group-title"><strong>${esc(group.owner)}</strong>${group.isFreeOwner ? `<span class="badge success-badge">${esc(t("freeChannel"))}</span>` : ""}</span>
      <small class="count">${checked}/${group.models.length}</small>`;
    const body = matches.map((model) => {
      const title = model.displayName || model.id;
      const details = [title === model.id ? "" : model.id, model.ctx == null ? "" : `${t("context")} ${fmt.number(model.ctx)}`, model.efforts?.join(" / ")].filter(Boolean);
      return `<label class="model-line"><input type="checkbox" data-model="${esc(model.id)}" data-focus-key="model:${esc(model.id)}" ${selected.has(model.id) ? "checked" : ""} ${model.id.length > 200 ? "disabled" : ""}>
        <span><strong>${esc(title)}</strong>${details.length ? `<small>${esc(details.join(" · "))}</small>` : ""}</span>
        ${model.consumesCodexPlus ? `<small class="badge state-reviewing">${esc(t("paidChannel"))}</small>` : ""}
      </label>`;
    }).join("");
    return [disclosure(`catalog:${group.key ?? group.owner}`, header, `<div class="model-list">${body}</div>`, "model-group", Boolean(q))];
  });
  return `<div class="model-groups">${rendered.join("") || (q ? empty(t("emptyFilter")) : "")}</div>`;
}

/** 自定义网关可独立测试，编辑草稿的 Key 不从脱敏配置回填。 */
function customProviders(ctx) {
  const { t, ui, snapshot, busy } = ctx;
  const providers = snapshot.config.providers?.custom ?? [];
  const rows = providers.map((provider) => {
    const result = ui.probes.get(provider.id) ?? ui.environment?.custom?.find((row) => row.id === provider.id);
    return `<section class="provider-row"><div class="provider-meta"><h3>${esc(provider.name)}</h3>
      ${provider.isFree ? `<span class="badge success-badge">${esc(t("freeChannel"))}</span>` : ""}
      ${provider.enabled === false ? `<span class="badge">${esc(t("disabled"))}</span>` : ""}
      <small>${esc(provider.baseUrl)} · ${esc(provider.wireApi)}</small>
      ${probeResult(ctx, result)}</div>
      <div class="form-actions">
        ${button("test-provider", t("test"), { id: provider.id, disabled: busy(`test:${provider.id}`) || busy("config") })}
        ${button("edit-provider", t("edit"), { id: provider.id, disabled: busy("config") })}
        ${button("delete-provider", t("remove"), { id: provider.id, kind: "danger", disabled: busy("config") || busy("scan") })}
      </div></section>`;
  }).join("");
  return `<section class="card panel full" data-scroll-anchor="providers"><div class="panel-heading">
    <h2>${icon("setup", 17)}${esc(t("customGateways"))}</h2>
    ${button("add-provider", t("addProvider"), { symbol: "plus", disabled: busy("config") })}
    </div>
    ${ui.provider == null ? "" : providerEditor(ctx, providers.find((provider) => provider.id === ui.provider))}
    ${rows || (ui.provider == null ? empty(t("empty")) : "")}
  </section>`;
}

/** 编辑页测试使用当前表单数据，读到的模型可显式填入模型清单。 */
function providerEditor(ctx, provider) {
  const { t, ui, busy } = ctx;
  const result = ui.probes.get("editor");
  const key = "provider";
  return `<form class="provider-editor settings-form" data-form="provider">
    <h3>${esc(t(provider ? "editProvider" : "addProvider"))}</h3>
    <div class="form-grid">
      ${field(ctx, key, "name", t("providerName"), provider?.name, { max: 200, required: true })}
      ${field(ctx, key, "baseUrl", t("baseUrl"), provider?.baseUrl, { type: "url", max: 2048, required: true })}
      ${field(ctx, key, "apiKey", t("apiKey"), "", { type: "password", max: 4096, placeholder: provider?.hasApiKey ? t("keepKey") : "" })}
      ${field(ctx, key, "wireApi", t("protocol"), provider?.wireApi ?? "responses", { choices: [["responses", "Responses"], ["chat_completions", "Chat Completions"]] })}
      ${field(ctx, key, "defaultEffort", t("defaultEffort"), provider?.defaultEffort || "high", { max: 20 })}
      ${field(ctx, key, "models", t("modelIds"), provider?.models?.join("\n"), { rows: 2 })}
      ${field(ctx, key, "isFree", t("freeChannel"), provider?.isFree ?? false, { type: "checkbox" })}
      ${field(ctx, key, "enabled", t("enable"), provider?.enabled !== false, { type: "checkbox" })}
    </div>
    ${probeResult(ctx, result)}
    <div class="form-actions">
      ${result?.reachable && result.discoveredModels?.length ? button("use-models", t("useDiscovered")) : ""}
      ${button("test-editor", t("test"), { disabled: busy("test:editor") || busy("config") })}
      ${button("close-provider", t("cancel"), { disabled: busy("config") })}
      ${saveButton(ctx)}
    </div>
  </form>`;
}

/** 连接结果显示延迟、模型总数与服务端失败原因。 */
function probeResult({ t, fmt }, result) {
  if (!result) return "";
  const label = result.reachable ? `${t("online")} · ${fmt.number(result.latencyMs)} ms · ${t("modelCount", fmt.number(result.modelCount))}`
    : result.error || t("testFailed");
  return `<small class="probe-result ${result.reachable ? "positive" : "negative"}">${esc(label)}</small>`;
}

/** 红线规则按行编辑，预设名称与说明使用服务端提供的双语字段。 */
function guardrails(ctx) {
  const { t, ui, locale, snapshot } = ctx;
  const cfg = snapshot.config.guardrails ?? {};
  const current = ui.forms.get("guardrails")?.activePreset ?? cfg.activePreset;
  const key = locale === "en" ? "En" : "Zh";
  return `<section class="card panel full" data-scroll-anchor="guardrails"><h2>${icon("info", 17)}${esc(t("guardrails"))}</h2>
    <form class="settings-form" data-form="guardrails">
      <div class="presets">${(snapshot.guardrailPresets ?? []).map((preset) => `<label class="preset">
        <input type="radio" name="activePreset" data-focus-key="preset:${esc(preset.id)}" value="${esc(preset.id)}" ${current === preset.id ? "checked" : ""}>
        <span><strong>${esc(preset[`name${key}`])}</strong><small>${esc(preset[`description${key}`])}</small></span></label>`).join("")}</div>
      <div class="form-grid">
        ${field(ctx, "guardrails", "customRules", t("customRules"), cfg.customRules?.join("\n"), { rows: 4 })}
        <div class="settings-form">
          ${field(ctx, "guardrails", "locale", t("language"), locale, { choices: [["zh-CN", "简体中文"], ["en", "English"]] })}
          ${field(ctx, "guardrails", "disableNestedSubagents", t("noNested"), cfg.disableNestedSubagents !== false, { type: "checkbox" })}
        </div>
      </div>
      <div class="form-actions">${saveButton(ctx)}</div>
    </form>
  </section>`;
}
