const paths = {
  brand: '<path d="m12 2 9 5v10l-9 5-9-5V7l9-5Z"/><path d="m7 9 5 3 5-3m-5 3v6"/>',
  tasks: '<rect x="4" y="5" width="16" height="15" rx="3"/><path d="M9 5V3h6v2m-7 6h8m-8 4h5"/>',
  routing: '<path d="M4 18h16M6 15v-3m4 3V8m4 7v-5m4 5V5"/>',
  setup: '<path d="M5 7h14M5 12h14M5 17h14"/><circle cx="9" cy="7" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="10" cy="17" r="2"/>',
  refresh: '<path d="M20 10a8 8 0 1 0-2 8m2-13v5h-5"/>',
  search: '<circle cx="10.5" cy="10.5" r="5.5"/><path d="m15 15 4 4"/>',
  sidebar: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M9 5v14"/>',
  log: '<path d="M3 12h4l3-7 4 14 3-7h4"/>',
  terminal: '<path d="m5 7 5 5-5 5m8 0h6"/>',
  diff: '<path d="M7 4h8l4 4v12H7zM10 11h6m-3-3v6m-3 3h6"/>',
  chat: '<path d="M20 11a7 7 0 0 1-7 7H5l1.5-3A7 7 0 1 1 20 11Z"/>',
  arrow: '<path d="m9 6 6 6-6 6"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  external: '<path d="M13 5h6v6m0-6-8 8m6 0v6H5V7h6"/>',
  bolt: '<path d="m13 2-8 12h6l-1 8 9-12h-6z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  send: '<path d="m4 11 16-7-7 16-2-7-7-2Zm7 2 9-9"/>',
  info: '<circle cx="12" cy="12" r="8"/><path d="M12 11v5m0-8v.1"/>',
};

/** 所有服务器文本进入模板前统一转义，避免注入标记或属性。 */
export function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

/** 固定图标使用内联路径，打包时不需要外部字体或图片资源。 */
export function icon(name, size = 18) {
  return `<svg aria-hidden="true" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round">${paths[name] ?? ""}</svg>`;
}

/** 生成由主入口统一处理的按钮，图标按钮同时提供可读名称。 */
export function button(action, label, { id, symbol, kind = "", iconOnly = false, disabled = false, pressed, accessible = label } = {}) {
  return `<button type="button" class="button ${kind} ${iconOnly ? "icon-button" : ""}" data-action="${action}"${id == null ? "" : ` data-id="${esc(id)}"`}${disabled ? " disabled" : ""}${pressed == null ? "" : ` aria-pressed="${pressed}"`} title="${esc(accessible)}" aria-label="${esc(accessible)}">${symbol ? icon(symbol) : ""}${iconOnly ? "" : esc(label)}</button>`;
}

/** 搜索输入通过稳定键恢复光标，供工单、文件和模型筛选共用。 */
export function search(name, value, label) {
  return `<label class="search">${icon("search", 16)}<input type="search" data-search="${name}" data-focus-key="search:${name}" value="${esc(value)}" placeholder="${esc(label)}" aria-label="${esc(label)}"></label>`;
}

/** 展示可本地化的数字、日期和相对时间。 */
export function formats(locale) {
  const numeric = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });
  const relative = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "short" });
  const dates = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });
  const number = (value) => value == null || !Number.isFinite(Number(value)) ? "—" : numeric.format(value);
  return {
    number,
    percent: (value) => value == null ? "—" : `${number(value)}%`,
    date: (value) => value && Number.isFinite(Date.parse(value)) ? dates.format(new Date(value)) : "—",
    relative: (value) => {
      const seconds = (Date.parse(value) - Date.now()) / 1000;
      if (!Number.isFinite(seconds)) return "—";
      const unit = Math.abs(seconds) >= 86400 ? ["day", 86400] : Math.abs(seconds) >= 3600 ? ["hour", 3600] : ["minute", 60];
      return relative.format(Math.round(seconds / unit[1]), unit[0]);
    },
  };
}

/** 显示紧凑空状态。 */
export function empty(title, detail = "") {
  return `<div class="empty"><strong>${esc(title)}</strong>${detail ? `<p>${esc(detail)}</p>` : ""}</div>`;
}

/** 使用原生 disclosure 保存行与卡片的展开状态。 */
export function disclosure(key, summary, body, className = "", open = false) {
  return `<details class="${className}" data-disclosure="${esc(key)}"${open ? " open" : ""}><summary>${summary}</summary>${body}</details>`;
}

/** 同一文件的改动行数采用一致的正负显示。 */
export function lineCounts(added, removed) {
  return `<span class="line-counts"><span class="positive">+${esc(added)}</span><span class="negative">−${esc(removed)}</span></span>`;
}

/** 将可安全展示的字段排成标签和值，支持长路径自动折行。 */
export function facts(rows) {
  return `<dl class="facts">${rows.map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${value}</dd></div>`).join("")}</dl>`;
}
