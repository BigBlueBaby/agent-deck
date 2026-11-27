/**
 * 轻量工作区基线快照、精确 Diff 捕获、单文件安全回滚与通用安全初检引擎。
 * 特性：
 * 1. read-only 盲审模式零文件扫描（毫秒级派单）；
 * 2. workspace-write 模式跳过重型产物目录，快照外置落盘不撑大 SQLite；
 * 3. 通用安全初检：仅检查路径越界与硬编码密钥防泄露，不干涉任何语言或团队的业务编码规范。
 *
 * @author BigBlueBaby & AgentDeck Contributors
 * @since 2026-11-27
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

const MAX_SNAPSHOT_BYTES = 1024 * 1024;
const MAX_DIFF_CHARS = 80 * 1024;

const IGNORED_DIR_PREFIXES = [
  ".git/",
  ".codex/",
  ".agents/",
  ".idea/",
  ".vscode/",
  "node_modules/",
  "target/",
  "build/",
  "dist/",
  ".next/",
  "out/",
  "logs/",
  "tmp/",
];

const IGNORED_BINARY_EXTS = new Set([
  ".jar", ".war", ".zip", ".gz", ".tar", ".7z", ".rar",
  ".exe", ".dll", ".so", ".dylib", ".class",
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".sqlite", ".db", ".bin", ".woff", ".woff2", ".ttf",
]);

function normalizeRelPath(p) {
  return String(p || "").replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
}

function shouldSkipPath(relPath) {
  const norm = normalizeRelPath(relPath).toLowerCase();
  if (!norm) return true;
  for (const prefix of IGNORED_DIR_PREFIXES) {
    if (norm === prefix.slice(0, -1) || norm.startsWith(prefix)) return true;
  }
  const ext = path.extname(norm);
  return Boolean(ext && IGNORED_BINARY_EXTS.has(ext));
}

function runGit(repoPath, args) {
  const res = spawnSync("git", args, {
    cwd: repoPath,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  return { ok: res.status === 0, stdout: res.stdout || "", stderr: res.stderr || "" };
}

function hashFile(absPath) {
  const buf = fs.readFileSync(absPath);
  return {
    size: buf.length,
    sha256: crypto.createHash("sha256").update(buf).digest("hex"),
    buf,
  };
}

function isPathAllowed(relPath, allowedPaths) {
  if (!Array.isArray(allowedPaths) || allowedPaths.length === 0) return true;
  const norm = normalizeRelPath(relPath).toLowerCase();
  return allowedPaths.some((rule) => {
    const r = normalizeRelPath(rule).toLowerCase();
    if (!r) return false;
    return norm === r || norm.startsWith(`${r}/`);
  });
}

function writeExternalSnapshot(snapshotDir, relPath, buf) {
  if (!snapshotDir || !buf || buf.length > MAX_SNAPSHOT_BYTES) return "";
  fs.mkdirSync(snapshotDir, { recursive: true });
  const hashName = crypto.createHash("sha1").update(relPath).digest("hex");
  const outPath = path.join(snapshotDir, `${hashName}.snap`);
  fs.writeFileSync(outPath, buf);
  return outPath;
}

function listFilesByScope(repoPath, allowedPaths, limit = 150) {
  const out = [];
  const walk = (absDir, relPrefix) => {
    if (out.length >= limit) return;
    let entries = [];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (out.length >= limit) break;
      const rel = relPrefix ? `${relPrefix}/${ent.name}` : ent.name;
      if (shouldSkipPath(rel)) continue;
      const abs = path.join(absDir, ent.name);
      if (ent.isDirectory()) walk(abs, rel);
      else if (ent.isFile()) out.push(normalizeRelPath(rel));
    }
  };

  if (Array.isArray(allowedPaths) && allowedPaths.length > 0) {
    for (const item of allowedPaths) {
      const rel = normalizeRelPath(item);
      if (!rel || shouldSkipPath(rel)) continue;
      const abs = path.join(repoPath, rel);
      if (!fs.existsSync(abs)) continue;
      const st = fs.statSync(abs);
      if (st.isFile()) out.push(rel);
      else if (st.isDirectory()) walk(abs, rel);
    }
  } else {
    walk(repoPath, "");
  }
  return [...new Set(out)];
}

export function captureBaseline(repoPath, allowedPaths = [], options = {}) {
  const sandbox = options.sandbox || "workspace-write";
  const snapshotDir = options.snapshotDir || "";
  const isGit = runGit(repoPath, ["rev-parse", "--is-inside-work-tree"]).ok;
  const branchName = isGit ? runGit(repoPath, ["branch", "--show-current"]).stdout.trim() : "";

  if (sandbox === "read-only") {
    return { isGit, branchName, readOnly: true, snapshotDir: "", files: {} };
  }

  const candidateSet = new Set();
  if (isGit) {
    const statusRes = runGit(repoPath, ["status", "--porcelain"]);
    if (statusRes.ok) {
      for (const rawLine of statusRes.stdout.split(/\r?\n/)) {
        if (!rawLine || rawLine.length < 4) continue;
        let rel = rawLine.slice(3).trim();
        if (rel.includes(" -> ")) rel = rel.split(" -> ").pop().trim();
        rel = normalizeRelPath(rel.replace(/^"|"$/g, ""));
        if (rel && !shouldSkipPath(rel) && isPathAllowed(rel, allowedPaths)) {
          candidateSet.add(rel);
        }
      }
    }
  }
  for (const rel of listFilesByScope(repoPath, allowedPaths, 120)) {
    candidateSet.add(rel);
  }

  const files = {};
  for (const rel of candidateSet) {
    const abs = path.join(repoPath, rel);
    if (!fs.existsSync(abs)) {
      files[rel] = { exists: false, sha256: "", size: 0, snapshotFile: "" };
      continue;
    }
    try {
      const st = fs.statSync(abs);
      if (!st.isFile()) continue;
      const { size, sha256, buf } = hashFile(abs);
      const snapshotFile = writeExternalSnapshot(snapshotDir, rel, buf);
      files[rel] = { exists: true, sha256, size, snapshotFile };
    } catch {
      // 忽略临时锁文件
    }
  }

  return { isGit, branchName, readOnly: false, snapshotDir, files };
}

function buildUnifiedDiff(repoPath, relPath, oldBuf, newAbsPath) {
  const tmpDir = fs.mkdtempSync(path.join(path.dirname(repoPath), ".ad-diff-"));
  const oldPath = path.join(tmpDir, "before.txt");
  try {
    fs.writeFileSync(oldPath, oldBuf || Buffer.alloc(0));
    const targetPath = fs.existsSync(newAbsPath) ? newAbsPath : path.join(tmpDir, "empty.txt");
    if (!fs.existsSync(targetPath)) fs.writeFileSync(targetPath, "");
    const res = spawnSync("git", ["diff", "--no-index", "--unified=3", "--", oldPath, targetPath], {
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
    const text = (res.stdout || "")
      .replaceAll(oldPath.replace(/\\/g, "/"), `a/${relPath}`)
      .replaceAll(targetPath.replace(/\\/g, "/"), `b/${relPath}`);
    return text.length > MAX_DIFF_CHARS ? `${text.slice(0, MAX_DIFF_CHARS)}\n... [diff truncated]` : text;
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

function countDiffLines(diffText) {
  let added = 0;
  let removed = 0;
  for (const line of String(diffText || "").split(/\r?\n/)) {
    if (line.startsWith("+") && !line.startsWith("+++")) added += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) removed += 1;
  }
  return { addedLines: added, removedLines: removed };
}

function inspectWarnings(relPath, diffText, outOfScope) {
  const warnings = [];
  if (outOfScope) {
    warnings.push(`Out of allowed path scope: ${relPath}`);
  }
  const addedLines = String(diffText || "")
    .split(/\r?\n/)
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"));

  // 通用安全检查：防硬编码常见密钥或私钥模式
  const addedText = addedLines.join("\n");
  if (/(?:sk-[A-Za-z0-9]{24,}|AIza[0-9A-Za-z\-_]{35}|ghp_[A-Za-z0-9]{36}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/.test(addedText)) {
    warnings.push("Possible hardcoded API key or private key detected in added lines.");
  }

  return warnings;
}

export function collectChangesAfterRun(repoPath, baseline, allowedPaths = [], hintedFiles = [], guardrailsConfig = {}) {
  if (baseline?.readOnly) return [];
  const baseFiles = baseline?.files || {};
  const candidates = new Set(Object.keys(baseFiles));

  if (baseline?.isGit) {
    const statusRes = runGit(repoPath, ["status", "--porcelain"]);
    if (statusRes.ok) {
      for (const rawLine of statusRes.stdout.split(/\r?\n/)) {
        if (!rawLine || rawLine.length < 4) continue;
        let rel = rawLine.slice(3).trim();
        if (rel.includes(" -> ")) rel = rel.split(" -> ").pop().trim();
        rel = normalizeRelPath(rel.replace(/^"|"$/g, ""));
        if (rel && !shouldSkipPath(rel)) candidates.add(rel);
      }
    }
  }

  for (const h of hintedFiles || []) {
    const rel = path.isAbsolute(h) ? normalizeRelPath(path.relative(repoPath, h)) : normalizeRelPath(h);
    if (rel && !rel.startsWith("..") && !shouldSkipPath(rel)) candidates.add(rel);
  }
  for (const rel of listFilesByScope(repoPath, allowedPaths, 120)) {
    candidates.add(rel);
  }

  const results = [];
  for (const rel of [...candidates].sort()) {
    const abs = path.join(repoPath, rel);
    const prev = baseFiles[rel] || { exists: false, sha256: "", size: 0, snapshotFile: "" };
    const nowExists = fs.existsSync(abs) && fs.statSync(abs).isFile();

    if (!prev.exists && !nowExists) continue;
    let nowHash = "";
    if (nowExists) {
      try {
        nowHash = hashFile(abs).sha256;
      } catch {
        continue;
      }
    }
    if (prev.exists && nowExists && prev.sha256 === nowHash) continue;

    let changeType = "modified";
    if (!prev.exists && nowExists) changeType = "added";
    else if (prev.exists && !nowExists) changeType = "deleted";

    const oldBuf =
      prev.exists && prev.snapshotFile && fs.existsSync(prev.snapshotFile)
        ? fs.readFileSync(prev.snapshotFile)
        : Buffer.alloc(0);
    const diffText = buildUnifiedDiff(repoPath, rel, oldBuf, abs);
    const { addedLines, removedLines } = countDiffLines(diffText);
    const outOfScope = !isPathAllowed(rel, allowedPaths);
    const localOnlyArtifact = false;
    const warnings = inspectWarnings(rel, diffText, outOfScope);

    results.push({
      filePath: rel,
      changeType,
      addedLines,
      removedLines,
      diffText,
      preExists: prev.exists,
      preContentB64: null,
      preSnapshotFile: prev.snapshotFile || "",
      outOfScope,
      localOnlyArtifact,
      warnings,
    });
  }
  return results;
}

export function revertSingleFileChange(repoPath, changeRecord) {
  const absPath = path.resolve(repoPath, changeRecord.filePath);
  const rootResolved = path.resolve(repoPath);
  if (!absPath.startsWith(rootResolved)) {
    return { ok: false, message: `Refused to revert path outside repository: ${changeRecord.filePath}` };
  }

  if (!changeRecord.preExists) {
    if (fs.existsSync(absPath)) fs.unlinkSync(absPath);
    return { ok: true, message: `Removed newly added file: ${changeRecord.filePath}` };
  }

  if (changeRecord.preSnapshotFile && fs.existsSync(changeRecord.preSnapshotFile)) {
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.copyFileSync(changeRecord.preSnapshotFile, absPath);
    return { ok: true, message: `Restored file from snapshot: ${changeRecord.filePath}` };
  }

  if (changeRecord.preContentB64 != null) {
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, Buffer.from(changeRecord.preContentB64, "base64"));
    return { ok: true, message: `Restored file from inline snapshot: ${changeRecord.filePath}` };
  }

  return { ok: false, message: `No pre-run snapshot available for: ${changeRecord.filePath}` };
}
