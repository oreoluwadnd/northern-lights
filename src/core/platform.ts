/**
 * The few things that differ between macOS, Linux and Windows: finding programs, running shell
 * commands, starting and stopping process trees.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { SpawnOptions } from "node:child_process";

export const IS_WIN = process.platform === "win32";

const resolved = new Map<string, string | null>();

/** Full path of a program on PATH, or null. On Windows this finds .exe/.cmd/.bat via PATHEXT. */
export function which(bin: string): string | null {
  if (resolved.has(bin)) return resolved.get(bin)!;
  let found: string | null = null;
  if (path.isAbsolute(bin)) found = fs.existsSync(bin) ? bin : null;
  else {
    const exts = IS_WIN ? ["", ...(process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)] : [""];
    outer: for (const dir of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
      for (const ext of exts) {
        const f = path.join(dir, bin + ext.toLowerCase());
        const F = path.join(dir, bin + ext);
        for (const c of [f, F]) {
          try {
            if (fs.statSync(c).isFile()) {
              found = c;
              break outer;
            }
          } catch {}
        }
      }
    }
  }
  resolved.set(bin, found);
  return found;
}

export const hasCommand = (bin: string) => which(bin) !== null;

/** How to start `cmd`: on Windows, .cmd/.bat shims need a shell; everything else runs directly. */
export function commandFor(cmd: string): { file: string; shell: boolean } {
  if (!IS_WIN) return { file: cmd, shell: false };
  const full = which(cmd) ?? cmd;
  return { file: full, shell: /\.(cmd|bat)$/i.test(full) };
}

/** Options for a child we may need to stop as a whole tree (agents, checks). */
export function treeSpawnOptions(extra: SpawnOptions = {}): SpawnOptions {
  return { ...extra, detached: !IS_WIN, windowsHide: true };
}

/** Stop a process and everything it started. */
export function killTree(pid: number | undefined | null) {
  if (!pid) return;
  if (IS_WIN) {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
  setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {}
  }, 3000).unref();
}
