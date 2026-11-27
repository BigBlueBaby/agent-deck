/**
 * AgentDeck 本地 SQLite 持久化底座（Node 24 原生 node:sqlite，WAL 模式）。
 * 100% 向下兼容旧版 workbench.sqlite 数据结构，支持无缝平滑迁移历史工单与用量记录。
 * 核心安全约束：
 * 1. 所有对外 task 投影严禁包含 baseline_json，彻底杜绝 MCP 帧膨胀；
 * 2. recoverStaleRunningTasks 通过 PID 存活探测防误杀跨进程活跃任务；
 * 3. 支持多 Adapter / 多 Provider 维度的用量聚合统计。
 *
 * @author AgentDeck Contributors
 * @since 2026-11-27
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const PUBLIC_TASK_COLUMNS = `
  id, title, repo_path, branch_name, tier, adapter, provider, profile, model, reasoning_effort,
  task_kind, routing_reason, sandbox, status, current_round, max_rounds, pid, codex_thread_id,
  allowed_paths_json, acceptance_criteria, last_summary, last_error,
  created_at, updated_at, finished_at
`;

export function createId(prefix) {
  const ts = Date.now().toString(36);
  const rand = crypto.randomBytes(4).toString("hex");
  return `${prefix}_${ts}_${rand}`;
}

export function nowIso() {
  return new Date().toISOString();
}

export function isPidAlive(pid) {
  const num = Number(pid);
  if (!Number.isInteger(num) || num <= 0) return false;
  try {
    process.kill(num, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

function safeJsonParse(raw, fallback) {
  if (!raw || typeof raw !== "string") return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function mapTaskRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    repoPath: row.repo_path,
    branchName: row.branch_name || "",
    tier: row.tier || "L2",
    adapter: row.adapter || "codex",
    provider: row.provider || "",
    profile: row.profile || "plus-high",
    model: row.model || "",
    reasoningEffort: row.reasoning_effort || "",
    taskKind: row.task_kind || "implement",
    routingReason: row.routing_reason || "",
    sandbox: row.sandbox || "workspace-write",
    status: row.status,
    currentRound: row.current_round,
    maxRounds: row.max_rounds,
    pid: row.pid || null,
    codexThreadId: row.codex_thread_id || "",
    allowedPaths: safeJsonParse(row.allowed_paths_json, []),
    acceptanceCriteria: row.acceptance_criteria || "",
    lastSummary: row.last_summary || "",
    lastError: row.last_error || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at || "",
  };
}

export class DeckDb {
  /**
   * @param {string} dataDir 插件持久化数据目录
   */
  constructor(dataDir) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.dataDir = dataDir;
    this.snapshotsRoot = path.join(dataDir, "snapshots");
    this.dbPath = path.join(dataDir, "workbench.sqlite");
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.#initSchema();
  }

  #initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        repo_path TEXT NOT NULL,
        branch_name TEXT DEFAULT '',
        tier TEXT DEFAULT 'L2',
        adapter TEXT DEFAULT 'codex',
        provider TEXT DEFAULT '',
        profile TEXT DEFAULT 'plus-high',
        model TEXT DEFAULT '',
        reasoning_effort TEXT DEFAULT '',
        task_kind TEXT DEFAULT 'implement',
        routing_reason TEXT DEFAULT '',
        sandbox TEXT DEFAULT 'workspace-write',
        status TEXT NOT NULL DEFAULT 'queued',
        current_round INTEGER NOT NULL DEFAULT 1,
        max_rounds INTEGER NOT NULL DEFAULT 2,
        pid INTEGER,
        codex_thread_id TEXT DEFAULT '',
        allowed_paths_json TEXT DEFAULT '[]',
        acceptance_criteria TEXT DEFAULT '',
        baseline_json TEXT DEFAULT '{}',
        last_summary TEXT DEFAULT '',
        last_error TEXT DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        finished_at TEXT DEFAULT ''
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        round INTEGER NOT NULL DEFAULT 1,
        sender TEXT NOT NULL,
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        meta_json TEXT DEFAULT '{}',
        created_at TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS task_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        round INTEGER NOT NULL DEFAULT 1,
        event_type TEXT NOT NULL,
        summary TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS file_changes (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        round INTEGER NOT NULL DEFAULT 1,
        file_path TEXT NOT NULL,
        change_type TEXT NOT NULL,
        added_lines INTEGER DEFAULT 0,
        removed_lines INTEGER DEFAULT 0,
        diff_text TEXT DEFAULT '',
        pre_exists INTEGER NOT NULL DEFAULT 0,
        pre_content_b64 TEXT,
        pre_snapshot_file TEXT DEFAULT '',
        out_of_scope INTEGER NOT NULL DEFAULT 0,
        local_only_artifact INTEGER NOT NULL DEFAULT 0,
        warnings_json TEXT DEFAULT '[]',
        reverted INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS usage_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        round INTEGER NOT NULL DEFAULT 1,
        engine TEXT NOT NULL DEFAULT 'codex-plus',
        profile TEXT NOT NULL DEFAULT 'plus-high',
        model TEXT DEFAULT '',
        reasoning_effort TEXT DEFAULT '',
        turns_count INTEGER DEFAULT 0,
        tool_calls_count INTEGER DEFAULT 0,
        input_tokens INTEGER DEFAULT 0,
        cached_input_tokens INTEGER DEFAULT 0,
        output_tokens INTEGER DEFAULT 0,
        reasoning_tokens INTEGER DEFAULT 0,
        primary_quota_delta REAL,
        secondary_quota_delta REAL,
        primary_quota_after REAL,
        secondary_quota_after REAL,
        duration_ms INTEGER DEFAULT 0,
        created_at TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_updated ON tasks(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_messages_task ON messages(task_id, created_at ASC);
      CREATE INDEX IF NOT EXISTS idx_events_task ON task_events(task_id, id DESC);
      CREATE INDEX IF NOT EXISTS idx_changes_task ON file_changes(task_id, round DESC);
      CREATE INDEX IF NOT EXISTS idx_usage_created ON usage_ledger(created_at DESC);
    `);

    // 幂等列迁移：无缝兼容旧版 workbench.sqlite
    const taskCols = this.db.prepare("PRAGMA table_info(tasks)").all().map((c) => c.name);
    const taskMigrations = [
      ["adapter", "TEXT DEFAULT 'codex'"],
      ["provider", "TEXT DEFAULT ''"],
      ["reasoning_effort", "TEXT DEFAULT ''"],
      ["task_kind", "TEXT DEFAULT 'implement'"],
      ["routing_reason", "TEXT DEFAULT ''"],
    ];
    for (const [col, def] of taskMigrations) {
      if (!taskCols.includes(col)) {
        this.db.exec(`ALTER TABLE tasks ADD COLUMN ${col} ${def};`);
      }
    }

    const changeCols = this.db.prepare("PRAGMA table_info(file_changes)").all().map((c) => c.name);
    const changeMigrations = [
      ["pre_content_b64", "TEXT"],
      ["pre_snapshot_file", "TEXT DEFAULT ''"],
      ["added_lines", "INTEGER DEFAULT 0"],
      ["removed_lines", "INTEGER DEFAULT 0"],
    ];
    for (const [col, def] of changeMigrations) {
      if (!changeCols.includes(col)) {
        this.db.exec(`ALTER TABLE file_changes ADD COLUMN ${col} ${def};`);
      }
    }
    if (changeCols.includes("pre_content_base64") && !changeCols.includes("pre_content_b64")) {
      this.db.exec("UPDATE file_changes SET pre_content_b64 = pre_content_base64 WHERE pre_content_b64 IS NULL AND pre_content_base64 IS NOT NULL;");
    }

    const usageCols = this.db.prepare("PRAGMA table_info(usage_ledger)").all().map((c) => c.name);
    const usageMigrations = [
      ["reasoning_effort", "TEXT DEFAULT ''"],
      ["turns_count", "INTEGER DEFAULT 0"],
      ["tool_calls_count", "INTEGER DEFAULT 0"],
      ["primary_quota_delta", "REAL"],
      ["secondary_quota_delta", "REAL"],
      ["primary_quota_after", "REAL"],
      ["secondary_quota_after", "REAL"],
    ];
    for (const [col, def] of usageMigrations) {
      if (!usageCols.includes(col)) {
        this.db.exec(`ALTER TABLE usage_ledger ADD COLUMN ${col} ${def};`);
      }
    }
  }

  getTaskSnapshotDir(taskId) {
    return path.join(this.snapshotsRoot, taskId);
  }

  cleanupTaskSnapshotDir(taskId) {
    const dir = this.getTaskSnapshotDir(taskId);
    if (fs.existsSync(dir)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // 忽略清理异常
      }
    }
  }

  recoverStaleRunningTasks() {
    const rows = this.db
      .prepare("SELECT id, pid, current_round, codex_thread_id FROM tasks WHERE status IN ('running', 'queued')")
      .all();
    const ts = nowIso();
    for (const row of rows) {
      if (row.pid && isPidAlive(row.pid)) continue;
      const canResumeHint = row.codex_thread_id
        ? "Worker process exited after host restart; thread ID preserved for one-click resume."
        : "Worker process exited after host restart; please re-dispatch.";
      this.db
        .prepare("UPDATE tasks SET status = 'failed', pid = NULL, last_error = ?, updated_at = ? WHERE id = ?")
        .run(canResumeHint, ts, row.id);
      this.addEvent(row.id, row.current_round || 1, "warning", canResumeHint);
    }
  }

  createTask(input) {
    const id = input.id || createId("task");
    const ts = nowIso();
    this.db.prepare(`
      INSERT INTO tasks (
        id, title, repo_path, branch_name, tier, adapter, provider, profile, model, reasoning_effort,
        task_kind, routing_reason, sandbox, status, current_round, max_rounds, allowed_paths_json,
        acceptance_criteria, baseline_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.title,
      input.repoPath,
      input.branchName || "",
      input.tier || "L2",
      input.adapter || "codex",
      input.provider || "",
      input.profile || "plus-high",
      input.model || "",
      input.reasoningEffort || "",
      input.taskKind || "implement",
      input.routingReason || "",
      input.sandbox || "workspace-write",
      input.status || "queued",
      Number(input.maxRounds || 2),
      JSON.stringify(input.allowedPaths || []),
      input.acceptanceCriteria || "",
      JSON.stringify(input.baseline || {}),
      ts,
      ts,
    );
    return this.getTask(id);
  }

  updateTask(taskId, patch) {
    const columnMap = {
      status: "status",
      currentRound: "current_round",
      maxRounds: "max_rounds",
      pid: "pid",
      codexThreadId: "codex_thread_id",
      adapter: "adapter",
      provider: "provider",
      profile: "profile",
      model: "model",
      reasoningEffort: "reasoning_effort",
      taskKind: "task_kind",
      routingReason: "routing_reason",
      lastSummary: "last_summary",
      lastError: "last_error",
      finishedAt: "finished_at",
    };
    const sets = [];
    const vals = [];
    for (const [key, col] of Object.entries(columnMap)) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) {
        sets.push(`${col} = ?`);
        vals.push(patch[key]);
      }
    }
    if (Object.prototype.hasOwnProperty.call(patch, "baseline")) {
      sets.push("baseline_json = ?");
      vals.push(JSON.stringify(patch.baseline || {}));
    }
    sets.push("updated_at = ?");
    vals.push(nowIso());
    vals.push(taskId);
    this.db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
    return this.getTask(taskId);
  }

  getTask(taskId) {
    const row = this.db.prepare(`SELECT ${PUBLIC_TASK_COLUMNS} FROM tasks WHERE id = ?`).get(taskId);
    return mapTaskRow(row);
  }

  getTaskBaseline(taskId) {
    const row = this.db.prepare("SELECT baseline_json FROM tasks WHERE id = ?").get(taskId);
    return safeJsonParse(row?.baseline_json, {});
  }

  listTasks(limit = 30) {
    const rows = this.db
      .prepare(`SELECT ${PUBLIC_TASK_COLUMNS} FROM tasks ORDER BY updated_at DESC LIMIT ?`)
      .all(Number(limit));
    return rows.map(mapTaskRow);
  }

  addMessage(msg) {
    const id = createId("msg");
    const ts = nowIso();
    this.db.prepare(`
      INSERT INTO messages (id, task_id, round, sender, kind, content, meta_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, msg.taskId, Number(msg.round || 1), msg.sender, msg.kind, msg.content, JSON.stringify(msg.meta || {}), ts);
    this.db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(ts, msg.taskId);
    return { id, ...msg, createdAt: ts };
  }

  listMessages(taskId) {
    const rows = this.db
      .prepare("SELECT * FROM messages WHERE task_id = ? ORDER BY created_at ASC, rowid ASC")
      .all(taskId);
    return rows.map((row) => ({
      id: row.id,
      taskId: row.task_id,
      round: row.round,
      sender: row.sender,
      kind: row.kind,
      content: row.content,
      meta: safeJsonParse(row.meta_json, {}),
      createdAt: row.created_at,
    }));
  }

  addEvent(taskId, round, eventType, summary) {
    const clipped = String(summary || "").slice(0, 400);
    this.db.prepare(`
      INSERT INTO task_events (task_id, round, event_type, summary, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(taskId, Number(round || 1), eventType, clipped, nowIso());
  }

  listRecentEvents(taskId, limit = 50) {
    const rows = this.db
      .prepare("SELECT id, task_id, round, event_type, summary, created_at FROM task_events WHERE task_id = ? ORDER BY id DESC LIMIT ?")
      .all(taskId, Number(limit));
    return rows.reverse().map((row) => ({
      id: row.id,
      taskId: row.task_id,
      round: row.round,
      eventType: row.event_type,
      summary: row.summary,
      createdAt: row.created_at,
    }));
  }

  saveFileChanges(taskId, round, changes) {
    this.db.prepare("DELETE FROM file_changes WHERE task_id = ? AND round = ?").run(taskId, Number(round));
    const stmt = this.db.prepare(`
      INSERT INTO file_changes (
        id, task_id, round, file_path, change_type, added_lines, removed_lines, diff_text,
        pre_exists, pre_content_b64, pre_snapshot_file, out_of_scope, local_only_artifact,
        warnings_json, reverted, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
    `);
    const ts = nowIso();
    for (const c of changes) {
      stmt.run(
        createId("chg"),
        taskId,
        Number(round),
        c.filePath,
        c.changeType,
        Number(c.addedLines || 0),
        Number(c.removedLines || 0),
        c.diffText || "",
        c.preExists ? 1 : 0,
        c.preContentB64 ?? null,
        c.preSnapshotFile || "",
        c.outOfScope ? 1 : 0,
        c.localOnlyArtifact ? 1 : 0,
        JSON.stringify(c.warnings || []),
        ts,
      );
    }
  }

  listFileChanges(taskId, round = null) {
    const rows =
      round === null
        ? this.db
            .prepare(`
              SELECT id, task_id, round, file_path, change_type, added_lines, removed_lines,
                     pre_exists, pre_content_b64 IS NOT NULL AS has_b64, pre_snapshot_file,
                     out_of_scope, local_only_artifact, warnings_json, reverted, created_at
              FROM file_changes WHERE task_id = ? ORDER BY round DESC, file_path ASC
            `)
            .all(taskId)
        : this.db
            .prepare(`
              SELECT id, task_id, round, file_path, change_type, added_lines, removed_lines,
                     pre_exists, pre_content_b64 IS NOT NULL AS has_b64, pre_snapshot_file,
                     out_of_scope, local_only_artifact, warnings_json, reverted, created_at
              FROM file_changes WHERE task_id = ? AND round = ? ORDER BY file_path ASC
            `)
            .all(taskId, Number(round));

    return rows.map((row) => ({
      id: row.id,
      taskId: row.task_id,
      round: row.round,
      filePath: row.file_path,
      changeType: row.change_type,
      addedLines: Number(row.added_lines || 0),
      removedLines: Number(row.removed_lines || 0),
      preExists: Boolean(row.pre_exists),
      hasSnapshot: Boolean(row.has_b64 || row.pre_snapshot_file || !row.pre_exists),
      outOfScope: Boolean(row.out_of_scope),
      localOnlyArtifact: Boolean(row.local_only_artifact),
      warnings: safeJsonParse(row.warnings_json, []),
      reverted: Boolean(row.reverted),
      createdAt: row.created_at,
    }));
  }

  getFileChangeById(changeId) {
    const row = this.db.prepare("SELECT * FROM file_changes WHERE id = ?").get(changeId);
    if (!row) return null;
    return {
      id: row.id,
      taskId: row.task_id,
      round: row.round,
      filePath: row.file_path,
      changeType: row.change_type,
      addedLines: Number(row.added_lines || 0),
      removedLines: Number(row.removed_lines || 0),
      diffText: row.diff_text || "",
      preExists: Boolean(row.pre_exists),
      preContentB64: row.pre_content_b64,
      preSnapshotFile: row.pre_snapshot_file || "",
      outOfScope: Boolean(row.out_of_scope),
      localOnlyArtifact: Boolean(row.local_only_artifact),
      warnings: safeJsonParse(row.warnings_json, []),
      reverted: Boolean(row.reverted),
      createdAt: row.created_at,
    };
  }

  markFileChangeReverted(changeId) {
    this.db.prepare("UPDATE file_changes SET reverted = 1 WHERE id = ?").run(changeId);
  }

  addUsage(u) {
    this.db.prepare(`
      INSERT INTO usage_ledger (
        task_id, round, engine, profile, model, reasoning_effort, turns_count, tool_calls_count,
        input_tokens, cached_input_tokens, output_tokens, reasoning_tokens,
        primary_quota_delta, secondary_quota_delta, primary_quota_after, secondary_quota_after,
        duration_ms, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      u.taskId,
      Number(u.round || 1),
      u.engine || "codex-plus",
      u.profile || "plus-high",
      u.model || "",
      u.reasoningEffort || "",
      Number(u.turnsCount || 0),
      Number(u.toolCallsCount || 0),
      Number(u.inputTokens || 0),
      Number(u.cachedInputTokens || 0),
      Number(u.outputTokens || 0),
      Number(u.reasoningTokens || 0),
      u.primaryQuotaDelta ?? null,
      u.secondaryQuotaDelta ?? null,
      u.primaryQuotaAfter ?? null,
      u.secondaryQuotaAfter ?? null,
      Number(u.durationMs || 0),
      nowIso(),
    );
  }

  listUsageByTask(taskId) {
    return this.db.prepare("SELECT * FROM usage_ledger WHERE task_id = ? ORDER BY id ASC").all(taskId);
  }

  backfillHistoricalTelemetry(readCodexThreadTelemetry) {
    const tasks = this.db
      .prepare("SELECT id, codex_thread_id, profile, model, reasoning_effort FROM tasks WHERE codex_thread_id != ''")
      .all();
    for (const t of tasks) {
      const tel = readCodexThreadTelemetry(t.codex_thread_id);
      if (!tel) continue;
      if (tel.model && (!t.model || t.model !== tel.model || !t.reasoning_effort)) {
        this.db
          .prepare("UPDATE tasks SET model = ?, reasoning_effort = ? WHERE id = ?")
          .run(tel.model, tel.effort || t.reasoning_effort || "", t.id);
      }
      const rows = this.db.prepare("SELECT id, model, reasoning_effort, turns_count, primary_quota_delta FROM usage_ledger WHERE task_id = ?").all(t.id);
      if (rows.length > 0) {
        const last = rows[rows.length - 1];
        if (!last.model || !last.reasoning_effort || !last.turns_count || last.primary_quota_delta == null) {
          this.db.prepare(`
            UPDATE usage_ledger
            SET model = CASE WHEN model = '' OR model IS NULL THEN ? ELSE model END,
                reasoning_effort = CASE WHEN reasoning_effort = '' OR reasoning_effort IS NULL THEN ? ELSE reasoning_effort END,
                turns_count = CASE WHEN turns_count = 0 OR turns_count IS NULL THEN ? ELSE turns_count END,
                tool_calls_count = CASE WHEN tool_calls_count = 0 OR tool_calls_count IS NULL THEN ? ELSE tool_calls_count END,
                primary_quota_delta = COALESCE(primary_quota_delta, ?),
                secondary_quota_delta = COALESCE(secondary_quota_delta, ?),
                primary_quota_after = COALESCE(primary_quota_after, ?),
                secondary_quota_after = COALESCE(secondary_quota_after, ?)
            WHERE id = ?
          `).run(
            tel.model || "",
            tel.effort || "",
            tel.turns || 0,
            tel.toolCalls || 0,
            tel.primaryDelta ?? null,
            tel.secondaryDelta ?? null,
            tel.primaryAfter ?? null,
            tel.secondaryAfter ?? null,
            last.id,
          );
        }
      }
    }
  }

  getUsageSummary() {
    const totalRow = this.db.prepare(`
      SELECT COUNT(*) AS runs,
             COALESCE(SUM(turns_count), 0) AS turns,
             COALESCE(SUM(tool_calls_count), 0) AS tool_calls,
             COALESCE(SUM(input_tokens), 0) AS input_tokens,
             COALESCE(SUM(cached_input_tokens), 0) AS cached_input_tokens,
             COALESCE(SUM(output_tokens), 0) AS output_tokens,
             COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
             COALESCE(SUM(duration_ms), 0) AS duration_ms
      FROM usage_ledger
    `).get();

    const taskStatsRow = this.db.prepare(`
      SELECT COUNT(*) AS total_tasks,
             SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running_tasks,
             SUM(CASE WHEN status = 'reviewing' THEN 1 ELSE 0 END) AS reviewing_tasks,
             SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done_tasks,
             SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_tasks
      FROM tasks
    `).get();

    const byModelEffort = this.db.prepare(`
      SELECT COALESCE(NULLIF(model, ''), 'unknown') AS model,
             COALESCE(NULLIF(reasoning_effort, ''), 'default') AS reasoning_effort,
             engine,
             profile,
             COUNT(*) AS runs,
             COALESCE(SUM(turns_count), 0) AS turns_count,
             COALESCE(SUM(tool_calls_count), 0) AS tool_calls_count,
             COALESCE(SUM(input_tokens), 0) AS input_tokens,
             COALESCE(SUM(cached_input_tokens), 0) AS cached_input_tokens,
             COALESCE(SUM(output_tokens), 0) AS output_tokens,
             COALESCE(SUM(primary_quota_delta), 0) AS primary_quota_delta,
             COALESCE(SUM(secondary_quota_delta), 0) AS secondary_quota_delta,
             COALESCE(SUM(duration_ms), 0) AS duration_ms
      FROM usage_ledger
      GROUP BY model, reasoning_effort, engine, profile
      ORDER BY runs DESC, input_tokens DESC
    `).all();

    const recent = this.db.prepare(`
      SELECT u.*, t.title AS task_title
      FROM usage_ledger u
      LEFT JOIN tasks t ON t.id = u.task_id
      ORDER BY u.id DESC
      LIMIT 20
    `).all();

    const totalInput = Number(totalRow?.input_tokens || 0);
    const totalCached = Number(totalRow?.cached_input_tokens || 0);

    return {
      taskStats: {
        totalTasks: Number(taskStatsRow?.total_tasks || 0),
        runningTasks: Number(taskStatsRow?.running_tasks || 0),
        reviewingTasks: Number(taskStatsRow?.reviewing_tasks || 0),
        doneTasks: Number(taskStatsRow?.done_tasks || 0),
        failedTasks: Number(taskStatsRow?.failed_tasks || 0),
      },
      total: {
        runs: Number(totalRow?.runs || 0),
        turns: Number(totalRow?.turns || 0),
        toolCalls: Number(totalRow?.tool_calls || 0),
        inputTokens: totalInput,
        cachedInputTokens: totalCached,
        netInputTokens: Math.max(0, totalInput - totalCached),
        outputTokens: Number(totalRow?.output_tokens || 0),
        reasoningTokens: Number(totalRow?.reasoning_tokens || 0),
        cacheHitRate: totalInput > 0 ? Math.round((totalCached / totalInput) * 1000) / 10 : 0,
        durationMs: Number(totalRow?.duration_ms || 0),
      },
      byModelEffort: byModelEffort.map((r) => ({
        model: r.model,
        reasoningEffort: r.reasoning_effort,
        engine: r.engine,
        profile: r.profile,
        runs: Number(r.runs || 0),
        turnsCount: Number(r.turns_count || 0),
        toolCallsCount: Number(r.tool_calls_count || 0),
        inputTokens: Number(r.input_tokens || 0),
        cachedInputTokens: Number(r.cached_input_tokens || 0),
        outputTokens: Number(r.output_tokens || 0),
        primaryQuotaDelta: Number(r.primary_quota_delta || 0),
        secondaryQuotaDelta: Number(r.secondary_quota_delta || 0),
        durationMs: Number(r.duration_ms || 0),
      })),
      recent: recent.map((r) => ({
        id: r.id,
        taskId: r.task_id,
        taskTitle: r.task_title || r.task_id,
        round: r.round,
        engine: r.engine,
        profile: r.profile,
        model: r.model || "",
        reasoningEffort: r.reasoning_effort || "",
        turnsCount: Number(r.turns_count || 0),
        toolCallsCount: Number(r.tool_calls_count || 0),
        inputTokens: Number(r.input_tokens || 0),
        cachedInputTokens: Number(r.cached_input_tokens || 0),
        outputTokens: Number(r.output_tokens || 0),
        primaryQuotaDelta: r.primary_quota_delta ?? null,
        secondaryQuotaDelta: r.secondary_quota_delta ?? null,
        durationMs: Number(r.duration_ms || 0),
        createdAt: r.created_at,
      })),
    };
  }

  close() {
    this.db.close();
  }
}
