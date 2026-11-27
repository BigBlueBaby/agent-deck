---
name: agent-orchestration
description: Orchestrate multi-agent implementation, independent cross-model reviews, debugging, and batch tasks through AgentDeck (Codex CLI, Magpie, and OpenAI-compatible providers) with dynamic Parallax routing, Diff guardrails, and single-file rollback.
---

# AgentDeck Multi-Agent Orchestration Workflow

## 1. Core Principle: Plan & Verify in Antigravity, Execute in AgentDeck
- **Antigravity (Orchestrator & Reviewer)** owns discovery, minimal context slicing, build/test verification, and final acceptance.
- **AgentDeck Workers (Codex CLI / Magpie / Custom Providers)** run asynchronously inside a scoped path allowlist with zero heavy MCP bloat, streaming structured progress and Diffs to the AgentDeck side pane.

## 2. Pre-Dispatch Context Slicing Checklist
Before calling `deck_dispatch`:
1. Confirm `repoPath` and set a tight `allowedPaths` allowlist to prevent out-of-scope edits.
2. Put verified facts (exact file paths, symbols, constraints, error logs) directly in `brief` so the worker does not waste turns redoing discovery.
3. Provide concrete `acceptanceCriteria` that you can verify after the worker finishes.
4. Keep `profile="auto"` and choose the right `taskKind` (`implement` | `review` | `debug` | `mechanical`) so the Parallax dynamic policy and user's active quota mode (`burst` / `balanced` / `free_only`) pick the optimal model automatically.

## 3. Parallel Execution & Review Loop
1. **Work in parallel**: While the worker executes asynchronously, prepare verification scripts, check related specs, or draft release notes instead of idling.
2. **Inspect via `deck_read_result`**: When status reaches `reviewing`, review the worker's summary, compliance/out-of-scope warnings, and Diff (use `filePaths` filter for large tasks).
3. **Iterate safely**: If fixes are needed, call `deck_feedback` to resume the same worker thread (with automatic reasoning-effort escalation). Respect `maxRounds` (default 2) so runaway loops pause for human confirmation (`need_human`).
4. **Close cleanly**: After build/test verification passes, call `deck_close` (`done` or `cancelled`) to clean up temporary rollback snapshots and record the acceptance summary.

## 4. Non-Blocking Resilience
If `deck_dispatch` or `deck_status` fails due to a transient MCP issue, retry status once; if still unavailable, proceed directly in Antigravity or via a built-in subagent without blocking the user's primary task.
