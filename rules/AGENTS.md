# AgentDeck Multi-Agent Routing Rule

AgentDeck enables Antigravity to act as the lead architect & reviewer while delegating heavy multi-file implementation, independent cross-model reviews, deep debugging, or batch mechanical tasks to external worker runtimes (Codex CLI, Magpie gateway models, or any configured OpenAI-compatible provider) with SQLite audit logs, visual Diff review, single-file rollback, and Parallax dynamic model routing.

> **Plugin-Scoped Global Rule**: This rule loads automatically whenever the `AgentDeck` plugin is enabled and turns off cleanly when disabled — no manual edits to `~/.gemini/config/rules/` required. If a user prefers **manual/on-demand invocation only**, respect their preference and only call `deck_dispatch` when they explicitly mention AgentDeck.

## 1. When to Dispatch via `deck_dispatch` (`profile="auto"`)
After completing upfront discovery (reading key files, confirming requirements, and narrowing the minimal file scope), proactively call `deck_dispatch` with `profile="auto"` and an accurate `taskKind`, then:
1. **Auto-open the live workbench**: Immediately call `deck_open(taskId)` right after `deck_dispatch` succeeds so the user can watch real-time progress, Diffs, and rollback controls in the AgentDeck pane without manually opening it.
2. **Work in parallel**: Continue non-conflicting prep work (verification scripts, specs, follow-up checks) while the worker runs asynchronously.

Recommended auto-dispatch triggers:
- **Multi-file or complex implementation (`taskKind="implement"`)**: Changes spanning **≥ 3 source files** or complex single-file logic/refactoring (> 40 lines).
- **Independent review & pre-release audit (`taskKind="review"`, `sandbox="read-only"`)**: Cross-model Diff review, security/permission audit, or migration verification before merging/deploying.
- **Deep debugging & root-cause analysis (`taskKind="debug"`, `sandbox="read-only"`)**: Complex stack traces, concurrency bugs, or slow query/job profiling.
- **Batch mechanical work (`taskKind="mechanical"`)**: Bulk documentation/comments, codebase inventory, or standalone utility scripts.

## 2. When Antigravity Handles Directly (No Dispatch Needed)
- Direct IDE/MCP actions owned by Antigravity (database queries, IDE builds/debugging, browser inspection, external docs/design tools).
- Small edits touching 1–2 files (< 30 lines) where dispatch overhead outweighs direct execution.
- Pure Q&A, explanations, or planning discussions with no code edits/reviews.

## 3. Transparent 1-Line Collaboration Footer
At the end of any **coding, review, debugging, or multi-file task reply**, append a single concise status line (matching the user's language) so the user always knows whether AgentDeck was triggered and why:
- English example: `> **AgentDeck**: Dispatched (`taskKind=implement` · `gpt-6.2-sol high` · `task_xxx`) — live progress opened in AgentDeck.` or `> **AgentDeck**: Direct (handled by Antigravity) — 1–2 file small edit (< 30 lines).`
- Chinese example: `> **协同状态**：已触发（`taskKind=implement` · `gpt-6.2-sol high` · `task_xxx`）｜已自动打开 AgentDeck 实时进度看板。` 或 `> **协同状态**：未触发（主控端直接完成）｜原因：1–2 文件小改动，直接处理更高效。`

## 4. Non-Blocking Fallback
If AgentDeck MCP is unavailable or fails after one status re-check, fall back immediately to Antigravity or a built-in subagent so user work is never blocked. See the `agent-orchestration` skill for detailed dispatch, parallel prep, and acceptance procedures.
