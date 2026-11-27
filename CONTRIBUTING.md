# Contributing to AgentDeck

Thank you for your interest in contributing to **AgentDeck**! We welcome pull requests for new agent adapters, provider discovery modules, guardrail presets, UI improvements, and translations.

## Project Architecture

```text
src/
├── core/         # Config store, SQLite ledger, git snapshot/rollback, Parallax policy, router
├── adapters/     # Pluggable worker runtimes (extend BaseAdapter)
├── providers/    # Runtime & gateway auto-discovery (Codex CLI, Magpie, OpenAI-compatible)
├── guardrails/   # Pluggable language-agnostic execution safety presets
└── ui/           # Modular zero-dependency MCP App frontend (bundled via esbuild)
```

## Adding a New Agent Adapter (e.g., Claude Code / OpenCode / Aider)

1. Create `src/adapters/<your_agent>_adapter.mjs` extending `BaseAdapter` (`src/adapters/base_adapter.mjs`).
2. Implement the standard lifecycle hooks:
   - `detect(config)`: Discover CLI executable and capabilities cross-platform.
   - `buildArgs(task, decision, isResume)`: Construct non-interactive streaming CLI arguments.
   - `parseEvent(rawLine)`: Normalize vendor JSONL/stdout into AgentDeck events (`command`, `file_change`, `agent_message`, `turn.completed`, `reasoning`, `warning`, `error`).
3. Register the adapter in `src/core/router.mjs` and add a detection entry in `src/providers/openai_compat.mjs`.
4. Add unit coverage in `scripts/smoke-test.mjs`.

## Local Validation Checklist

Before opening a PR, please run all checks locally:

```bash
npm run build:ui
npm run test:smoke
npm run test:ui
npm run validate
```

Please keep PRs focused, preserve zero external runtime dependencies in `src/ui/`, and never commit personal paths, API keys, or local `.sqlite` files.
