import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { hasCommand } from "./platform.ts";
import { homeDir } from "./config.ts";

/** Always excluded: our own folder, and git's (we leave git alone). */
export const ALWAYS_EXCLUDE = [".northern-lights", ".git"];

export interface SnapshotOptions {
  exclude: string[];
}

function excluded(name: string, exclude: Set<string>): boolean {
  return exclude.has(name) || name === ".DS_Store";
}

/** Recursively list files (relative paths) under root, skipping excluded names at any depth. */
export function listFiles(root: string, exclude: string[]): string[] {
  const ex = new Set([...ALWAYS_EXCLUDE, ...exclude]);
  const out: string[] = [];
  const walk = (rel: string) => {
    const abs = path.join(root, rel);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (excluded(e.name, ex)) continue;
      const r = rel ? path.join(rel, e.name) : e.name;
      if (e.isDirectory()) walk(r);
      else if (e.isFile() || e.isSymbolicLink()) out.push(r);
    }
  };
  walk("");
  return out.sort();
}

function cloneFile(src: string, dst: string) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const st = fs.lstatSync(src);
  if (st.isSymbolicLink()) {
    try {
      fs.unlinkSync(dst);
    } catch {}
    fs.symlinkSync(fs.readlinkSync(src), dst);
    return;
  }
  // COPYFILE_FICLONE: copy-on-write clone where supported (APFS), normal copy otherwise.
  fs.copyFileSync(src, dst, fs.constants.COPYFILE_FICLONE);
  fs.chmodSync(dst, st.mode);
}

export function snapshotsRoot(): string {
  return path.join(homeDir(), "snapshots");
}

/** Take a snapshot of `folder` into ~/.northern-lights/snapshots/<projectId>/<name>. Returns its path. */
export function takeSnapshot(folder: string, projectId: string, name: string, opts: SnapshotOptions): string {
  const dest = path.join(snapshotsRoot(), projectId, `${name}-${Date.now()}`);
  fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
  for (const rel of listFiles(folder, opts.exclude)) {
    cloneFile(path.join(folder, rel), path.join(dest, rel));
  }
  return dest;
}

function sameFile(a: string, b: string): boolean {
  let sa: fs.Stats, sb: fs.Stats;
  try {
    sa = fs.lstatSync(a);
    sb = fs.lstatSync(b);
  } catch {
    return false;
  }
  if (sa.isSymbolicLink() || sb.isSymbolicLink()) {
    return sa.isSymbolicLink() && sb.isSymbolicLink() && fs.readlinkSync(a) === fs.readlinkSync(b);
  }
  if (sa.size !== sb.size) return false;
  return fs.readFileSync(a).equals(fs.readFileSync(b));
}

export interface Change {
  file: string;
  kind: "added" | "modified" | "deleted";
}

/** Files that differ between a snapshot and the current folder. */
export function changedFiles(snapshot: string, folder: string, exclude: string[]): Change[] {
  const before = new Set(listFiles(snapshot, exclude));
  const after = new Set(listFiles(folder, exclude));
  const out: Change[] = [];
  for (const f of after) {
    if (!before.has(f)) out.push({ file: f, kind: "added" });
    else if (!sameFile(path.join(snapshot, f), path.join(folder, f))) out.push({ file: f, kind: "modified" });
  }
  for (const f of before) if (!after.has(f)) out.push({ file: f, kind: "deleted" });
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

/** Unified diff of the folder against a snapshot (system `diff` when there is one, else a built-in diff). */
export function diffText(snapshot: string, folder: string, exclude: string[], maxBytes = 400_000): string {
  const changes = changedFiles(snapshot, folder, exclude);
  if (!changes.length) return "(no changes)\n";
  let out = "";
  for (const c of changes) {
    const a = c.kind === "added" ? "/dev/null" : path.join(snapshot, c.file);
    const b = c.kind === "deleted" ? "/dev/null" : path.join(folder, c.file);
    const label = c.file.split(path.sep).join("/");
    if (hasCommand("diff")) {
      const r = spawnSync("diff", ["-u", "--label", `a/${label}`, "--label", `b/${label}`, a, b], {
        encoding: "utf8",
        maxBuffer: 20 * 1024 * 1024,
      });
      out += r.stdout || `Binary or unreadable file ${c.kind}: ${label}\n`;
    } else {
      out += unifiedDiffFiles(c.kind === "added" ? null : a, c.kind === "deleted" ? null : b, label) ?? `Binary or unreadable file ${c.kind}: ${label}\n`;
    }
    if (out.length > maxBytes) {
      out = out.slice(0, maxBytes) + `\n… diff truncated (${changes.length} files changed in total)\n`;
      break;
    }
  }
  return out;
}

/**
 * Make `folder` match `snapshot` exactly (excluded folders are left alone).
 * Takes a safety snapshot first and returns its path, so the restore can itself be undone.
 */
export function restoreSnapshot(
  snapshot: string,
  folder: string,
  projectId: string,
  opts: SnapshotOptions,
): string {
  const safety = takeSnapshot(folder, projectId, "before-restore", opts);
  const want = new Set(listFiles(snapshot, opts.exclude));
  for (const f of listFiles(folder, opts.exclude)) {
    if (!want.has(f)) fs.rmSync(path.join(folder, f), { force: true });
  }
  for (const f of want) {
    const src = path.join(snapshot, f);
    const dst = path.join(folder, f);
    if (!sameFile(src, dst)) {
      try {
        fs.rmSync(dst, { force: true });
      } catch {}
      cloneFile(src, dst);
    }
  }
  removeEmptyDirs(folder, new Set([...ALWAYS_EXCLUDE, ...opts.exclude]), snapshot);
  return safety;
}

function removeEmptyDirs(folder: string, ex: Set<string>, snapshot: string) {
  const walk = (rel: string): boolean => {
    const abs = path.join(folder, rel);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return false;
    }
    let empty = true;
    for (const e of entries) {
      if (ex.has(e.name)) {
        empty = false;
        continue;
      }
      if (e.isDirectory()) {
        const r = rel ? path.join(rel, e.name) : e.name;
        if (!walk(r)) empty = false;
      } else empty = false;
    }
    if (empty && rel && !fs.existsSync(path.join(snapshot, rel))) {
      fs.rmdirSync(abs);
      return true;
    }
    return false;
  };
  walk("");
}

export function deleteSnapshot(p: string | null | undefined) {
  if (!p) return;
  if (!p.startsWith(snapshotsRoot())) return; // never delete outside our folder
  fs.rmSync(p, { recursive: true, force: true });
}

// ── built-in unified diff (Myers), for systems without `diff` ──────────────────────────

function readLines(file: string | null): string[] | null {
  if (!file) return [];
  try {
    const buf = fs.readFileSync(file);
    if (buf.includes(0)) return null; // binary
    const text = buf.toString("utf8");
    if (!text) return [];
    const lines = text.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    return lines.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  } catch {
    return null;
  }
}

type Edit = { op: " " | "-" | "+"; line: string };

/** Shortest edit script between two line arrays (Myers). Falls back to delete-all/add-all for huge diffs. */
export function diffLines(a: string[], b: string[]): Edit[] {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  if (max === 0) return [];
  const replaceAll = (): Edit[] => [...a.map((line) => ({ op: "-" as const, line })), ...b.map((line) => ({ op: "+" as const, line }))];
  if (max > 40000) return replaceAll();
  const off = max;
  let v: Int32Array = new Int32Array(2 * max + 2);
  const trace: Int32Array[] = [];
  let found = false;
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    if (d > 4000) return replaceAll();
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[k - 1 + off] < v[k + 1 + off]) ? v[k + 1 + off] : v[k - 1 + off] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[k + off] = x;
      if (x >= n && y >= m) {
        found = true;
        break;
      }
    }
    if (found) break;
  }
  const out: Edit[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    v = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && v[k - 1 + off] < v[k + 1 + off]) ? k + 1 : k - 1;
    const prevX = v[prevK + off];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      out.push({ op: " ", line: a[x - 1] });
      x--;
      y--;
    }
    if (d > 0) {
      if (x === prevX) out.push({ op: "+", line: b[y - 1] });
      else out.push({ op: "-", line: a[x - 1] });
    }
    x = prevX;
    y = prevY;
  }
  return out.reverse();
}

/** `diff -u` style output for two line arrays, with 3 lines of context. */
export function unifiedDiff(a: string[], b: string[], label: string): string {
  const edits = diffLines(a, b);
  if (!edits.some((e) => e.op !== " ")) return "";
  // Position of each edit in a and b.
  const pos: { ai: number; bi: number }[] = [];
  let ai = 0;
  let bi = 0;
  for (const e of edits) {
    pos.push({ ai, bi });
    if (e.op !== "+") ai++;
    if (e.op !== "-") bi++;
  }
  const C = 3;
  let out = `--- a/${label}\n+++ b/${label}\n`;
  const changed = edits.map((e, i) => (e.op !== " " ? i : -1)).filter((i) => i >= 0);
  let h = 0;
  while (h < changed.length) {
    const first = changed[h];
    let last = first;
    // Changes separated by at most 2*C unchanged lines share a hunk (like GNU diff).
    while (h + 1 < changed.length && changed[h + 1] - last - 1 <= 2 * C) last = changed[++h];
    h++;
    const start = Math.max(0, first - C);
    const end = Math.min(edits.length, last + 1 + C);
    const hunk = edits.slice(start, end);
    const aLen = hunk.filter((e) => e.op !== "+").length;
    const bLen = hunk.filter((e) => e.op !== "-").length;
    const aStart = aLen ? pos[start].ai + 1 : pos[start].ai;
    const bStart = bLen ? pos[start].bi + 1 : pos[start].bi;
    out += `@@ -${aStart},${aLen} +${bStart},${bLen} @@\n`;
    for (const e of hunk) out += `${e.op}${e.line}\n`;
  }
  return out;
}

function unifiedDiffFiles(a: string | null, b: string | null, label: string): string | null {
  const la = readLines(a);
  const lb = readLines(b);
  if (la === null || lb === null) return null;
  return unifiedDiff(la, lb, label);
}
