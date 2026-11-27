/**
 * 可插拔执行安全红线预设库（Orchestration Execution Guardrails）。
 * 设计原则：AgentDeck 只负责多 Agent 协同层面的通用执行安全（路径白名单、防私自提交/破坏性操作、
 * 是否允许 Worker 跑重型构建），绝不干涉具体语言或团队的代码编写规范（由各仓库自己的 AGENTS.md 负责）。
 *
 * @author BigBlueBaby & AgentDeck Contributors
 * @since 2026-11-27
 */

export const GUARDRAIL_PRESETS = {
  generic: {
    id: "generic",
    nameZh: "通用标准安全（默认）",
    nameEn: "Standard Safety (Default)",
    descriptionZh: "适用于任意语言与项目：严守路径白名单、最小 Diff、禁止私自 git commit/push 与危险删除，编码规范遵循仓库自身的 AGENTS.md。",
    descriptionEn: "Language-agnostic orchestration safety: path allowlist, minimal diff, no git commit/push or destructive deletions. Coding conventions stay in your repo's own AGENTS.md.",
    rules: [
      "1. Strictly edit files inside the allowed path scope only; preserve existing uncommitted user changes and avoid unrelated refactoring.",
      "2. NEVER execute git commit, git push, git reset --hard, or destructive file deletions, and never mutate external/production databases.",
      "3. Follow the target repository's own AGENTS.md, lint rules, and existing code style rather than inventing new conventions.",
      "4. Keep diffs minimal, run a lightweight static check (e.g. git diff --check) if appropriate, and return a concise summary of modified files, key changes, and items left for orchestrator verification.",
    ],
  },
  "no-build": {
    id: "no-build",
    nameZh: "仅编辑不构建（IDE 托管编译）",
    nameEn: "Edit-Only (No Heavy Builds or Servers)",
    descriptionZh: "禁止 Worker 自行触发重型构建（Maven/Gradle/Cargo/Webpack）或启动长驻 dev server，由主控端或 IDE 统一串行编译与测试。",
    descriptionEn: "Prevents workers from running heavy builds (Maven/Gradle/Cargo/Webpack) or spawning long-lived dev servers; compilation and testing stay in your IDE or orchestrator.",
    rules: [
      "1. Do NOT run heavy full builds (e.g. mvn/gradle/cargo/webpack/next build) or start long-lived dev servers/background daemons; leave compilation and runtime tests to the orchestrator or IDE.",
      "2. Strictly edit files inside the allowed path scope only; preserve existing uncommitted user changes and follow the repository's own AGENTS.md.",
      "3. NEVER execute git commit, git push, git reset --hard, or destructive file deletions, and never mutate external/production databases.",
      "4. After editing, run only fast lightweight syntax checks if safe, and return a concise summary of modified files, core logic changes, and pending build/test checks.",
    ],
  },
  "strict-review": {
    id: "strict-review",
    nameZh: "严格只读审计",
    nameEn: "Strict Read-Only Audit",
    descriptionZh: "面向独立代码盲审、安全检查与根因定位：禁止修改任何工作区文件，仅输出有精确文件与行号依据的问题清单。",
    descriptionEn: "Designed for independent cross-model reviews, security audits, and root-cause analysis: zero file edits, evidence-backed findings with exact file/line references only.",
    rules: [
      "1. Strictly read-only: NEVER modify, create, or delete any files in the repository.",
      "2. Ground every finding in exact file paths, line numbers, and observed code/log evidence; clearly separate confirmed bugs from risks or assumptions.",
      "3. Prioritize high-impact correctness, security, concurrency, and regression issues over stylistic nitpicks.",
    ],
  },
};

const LEGACY_PRESET_MAP = {
  "java-idea": "no-build",
  "frontend-node": "no-build",
};

/**
 * 归一化红线预设 ID（平滑兼容旧版预设名）。
 *
 * @param {string} [id] 预设 ID
 * @returns {string} 有效预设 ID
 */
export function normalizePresetId(id) {
  if (id && Object.hasOwn(GUARDRAIL_PRESETS, id)) return id;
  if (id && Object.hasOwn(LEGACY_PRESET_MAP, id)) return LEGACY_PRESET_MAP[id];
  return "generic";
}

/**
 * 获取所有预设的简要元数据（供前端卡片展示）。
 *
 * @returns {Array<object>}
 */
export function listGuardrailPresets() {
  return Object.values(GUARDRAIL_PRESETS).map((p) => ({
    id: p.id,
    nameZh: p.nameZh,
    nameEn: p.nameEn,
    descriptionZh: p.descriptionZh,
    descriptionEn: p.descriptionEn,
    ruleCount: p.rules.length,
  }));
}

/**
 * 按当前配置组装下发给 Worker 的最终执行安全红线段落。
 *
 * @param {object} guardrailsConfig config.guardrails 配置块
 * @returns {string}
 */
export function buildGuardrailInstructions(guardrailsConfig = {}) {
  const preset = GUARDRAIL_PRESETS[normalizePresetId(guardrailsConfig.activePreset)] || GUARDRAIL_PRESETS.generic;
  const lines = [
    "[Orchestrated Sub-Task Guardrails]",
    ...preset.rules,
  ];
  if (guardrailsConfig.disableNestedSubagents !== false) {
    lines.push("- Do NOT spawn nested sub-agents (collab_tool_call) or idle wait loops; execute directly in this worker session.");
  }
  const customRules = Array.isArray(guardrailsConfig.customRules)
    ? guardrailsConfig.customRules.map((r) => String(r || "").trim()).filter(Boolean)
    : [];
  if (customRules.length > 0) {
    lines.push("", "[User Custom Guardrails]");
    customRules.forEach((rule, idx) => {
      lines.push(`${idx + 1}. ${rule}`);
    });
  }
  return lines.join("\n");
}
