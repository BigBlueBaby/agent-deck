# AgentDeck Multi-Agent Routing Rule

AgentDeck enables Antigravity to act as the lead architect & reviewer while delegating heavy multi-file implementation, independent code reviews, deep debugging, or batch mechanical tasks to external worker runtimes (such as Codex CLI, Magpie gateway models, or configured OpenAI-compatible providers) with SQLite audit logs, visual Diff review, single-file rollback, and dynamic Parallax model routing.

## 1. When to Dispatch via `deck_dispatch` (`profile="auto"`)
After completing upfront discovery (reading key files, confirming requirements, and narrowing the minimal file scope), proactively call `deck_dispatch` with `profile="auto"` and an accurate `taskKind`, then continue non-conflicting prep work in parallel while the worker runs:
- **Multi-file or complex implementation (`taskKind="implement"`)**: Changes spanning **≥ 3 source files** or complex single-file logic/refactoring (> 40 lines).
- **Independent review & pre-release audit (`taskKind="review"`, `sandbox="read-only"`)**: Cross-model Diff review, security/permission audit, or migration script verification before merging/deploying.
- **Deep debugging & root-cause analysis (`taskKind="debug"`, `sandbox="read-only"`)**: Complex stack traces, concurrency bugs, or slow query/job profiling.
- **Batch mechanical work (`taskKind="mechanical"`)**: Bulk documentation/comments, codebase inventory, or standalone utility scripts.

## 2. When Antigravity Handles Directly (No Dispatch Needed)
- Direct IDE/MCP actions owned by Antigravity (database queries, IDE builds/debugging, browser inspection, external docs/design tools).
- Small edits touching 1–2 files (< 30 lines) where dispatch overhead outweighs direct execution.

## 3. Non-Blocking Fallback
If AgentDeck MCP is unavailable or fails after one status re-check, fall back immediately to Antigravity or a built-in subagent so user work is never blocked. See the `agent-orchestration` skill for detailed dispatch, parallel prep, and acceptance procedures.
