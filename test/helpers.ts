import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultConfig } from "../src/core/config.ts";
import type { Config } from "../src/core/config.ts";
import { openDb } from "../src/core/db.ts";
import type { Running } from "../src/server.ts";
import { adminToken, startServer } from "../src/server.ts";
import { killTree } from "../src/core/platform.ts";

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-agent.ts");

export interface Env {
  home: string;
  proj: string;
  s: Running;
  api: (method: string, p: string, body?: unknown) => Promise<any>;
  close: () => Promise<void>;
  restart: (opts?: { crash?: boolean }) => Promise<void>;
}

export function fakeConfig(plan: unknown, extraEnv: Record<string, string> = {}): Config {
  const env = { FAKE_PLAN: JSON.stringify(plan), ...extraEnv };
  return {
    ...defaultConfig(),
    concurrency: 3,
    heartbeat_min: 15,
    profiles: {
      fake: { harness: "custom", command: [process.execPath, FAKE], output: "claude-stream", env },
      fake2: { harness: "custom", command: [process.execPath, FAKE], output: "claude-stream", env },
    },
    defaults: { planner: "fake", worker: "fake", verifier: "fake2" },
  };
}

export async function setup(plan: unknown, opts: { extraEnv?: Record<string, string> } = {}): Promise<Env> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nl-home-"));
  process.env.NL_HOME = home;
  process.env.NL_NO_NOTIFY = "1";
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "nl-proj-"));
  fs.writeFileSync(path.join(proj, "README.md"), "# toy\n");
  fs.mkdirSync(path.join(proj, "node_modules", "dep"), { recursive: true });
  fs.writeFileSync(path.join(proj, "node_modules", "dep", "index.js"), "module.exports = 1\n");
  const config = fakeConfig(plan, opts.extraEnv);
  const dbFile = path.join(home, "db.sqlite");
  const env: Env = {
    home,
    proj,
    s: await startServer({ port: 0, config, db: openDb(dbFile), tickMs: 100, notify: false }),
    api: async () => undefined,
    close: async () => {
      await env.s.close();
    },
    restart: async (o = {}) => {
      if (o.crash) {
        // Simulate a crash: kill agents, close the socket, no clean-shutdown marker.
        for (const r of env.s.engine.status().runs) {
          const row = env.s.engine.db.prepare("select pid from runs where id = ?").get(r.id) as { pid: number };
          killTree(row.pid);
        }
        (env.s.engine as any).timers.forEach((t: NodeJS.Timeout) => clearInterval(t));
        for (const live of (env.s.engine as any).live.values()) live.handle?.child.removeAllListeners();
        (env.s.engine as any).live.clear();
        env.s.server.closeAllConnections?.();
        await new Promise<void>((r) => env.s.server.close(() => r()));
        env.s.engine.db.close();
      } else {
        await env.s.close();
        env.s.engine.db.close();
      }
      env.s = await startServer({ port: 0, config, db: openDb(dbFile), tickMs: 100, notify: false });
    },
  };
  env.api = async (method: string, p: string, body?: unknown) => {
    const res = await fetch(env.s.url + p, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${adminToken()}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`${method} ${p}: ${data.error}`);
    return data;
  };
  return env;
}

export async function waitFor<T>(what: string, fn: () => Promise<T | undefined | false | null> | T | undefined | false | null, timeoutMs = 20000): Promise<T> {
  const start = Date.now();
  let last: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      const v = await fn();
      if (v) return v as T;
      last = v;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for: ${what} (last: ${last instanceof Error ? last.message : JSON.stringify(last)})`);
}

export async function taskStatus(env: Env, id: string): Promise<string> {
  return (await env.api("GET", `/api/tasks/${encodeURIComponent(id)}`)).task.status;
}

export async function waitTask(env: Env, id: string, status: string, timeoutMs = 20000) {
  return waitFor(`${id} → ${status}`, async () => (await taskStatus(env, id)) === status, timeoutMs);
}

export async function waitMission(env: Env, id: string, status: string, timeoutMs = 20000) {
  return waitFor(`${id} → ${status}`, async () => (await env.api("GET", `/api/missions/${id}`)).mission.status === status, timeoutMs);
}

export function writeChecks(proj: string, checks: string[]) {
  const f = path.join(proj, ".northern-lights", "project.yaml");
  const body = fs.readFileSync(f, "utf8").replace(/^checks:[\s\S]*?\n\n/m, `checks:\n${checks.map((c) => `  - ${c}`).join("\n")}\n\n`);
  fs.writeFileSync(f, body);
}

/** A check command that works in sh and cmd alike: exits 0 if the file exists. */
export function fileCheck(file: string): string {
  return `node -e "process.exit(require('fs').existsSync('${file}') ? 0 : 1)"`;
}
