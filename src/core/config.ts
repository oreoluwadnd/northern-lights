import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Where Northern Lights keeps its own data (database, snapshots, run logs, config). */
export function homeDir(): string {
  return process.env.NL_HOME || path.join(os.homedir(), ".northern-lights");
}

export type Harness = "claude" | "codex" | "antigravity" | "custom";

export interface AgentProfile {
  harness: Harness;
  /** Model name passed to the harness (e.g. "opus", "sonnet"). Empty = harness default. */
  model?: string;
  /** For harness "custom": the command to run. The briefing arrives on stdin. */
  command?: string[];
  /** How to read token usage from the process's stdout. */
  output?: "claude-stream" | "codex-json" | "agy-stream" | "none";
  /** Extra env vars for the process. */
  env?: Record<string, string>;
}

export interface Prices {
  /** Dollars per million tokens. */
  input: number;
  output: number;
  cache_write?: number;
  cache_read?: number;
}

export interface NotifySettings {
  enabled: boolean;
  kinds: Record<string, boolean>;
}

export interface Config {
  port: number;
  /** Max agent processes + check runs at once, across all projects. */
  concurrency: number;
  profiles: Record<string, AgentProfile>;
  /** Default profiles for new missions. */
  defaults: { planner: string; worker: string; verifier: string };
  /** Optional price table, keyed by model name as the harness reports it. */
  prices: Record<string, Prices>;
  notifications: NotifySettings;
  /** Minutes without any output or tool call before a run counts as hung. */
  heartbeat_min: number;
  /** Max minutes for each automated check command. */
  check_timeout_min: number;
}

export const NOTIFY_KINDS = [
  "plan",
  "question",
  "permission",
  "review",
  "your_turn",
  "over_limit",
  "stuck",
  "failed",
  "budget",
  "mission_done",
  "final_review",
] as const;

export function defaultConfig(): Config {
  return {
    port: 7477,
    concurrency: 3,
    profiles: {
      "claude-opus": { harness: "claude", model: "opus", output: "claude-stream" },
      "claude-sonnet": { harness: "claude", model: "sonnet", output: "claude-stream" },
      codex: { harness: "codex", output: "codex-json" },
    },
    defaults: { planner: "claude-opus", worker: "claude-sonnet", verifier: "claude-opus" },
    prices: {},
    notifications: {
      enabled: true,
      kinds: Object.fromEntries(NOTIFY_KINDS.map((k) => [k, true])),
    },
    heartbeat_min: 15,
    check_timeout_min: 10,
  };
}

export function configPath(): string {
  return path.join(homeDir(), "config.json");
}

export function loadConfig(): Config {
  const file = configPath();
  const base = defaultConfig();
  if (!fs.existsSync(file)) {
    fs.mkdirSync(homeDir(), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(base, null, 2) + "\n");
    return base;
  }
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<Config>;
  return {
    ...base,
    ...raw,
    defaults: { ...base.defaults, ...(raw.defaults ?? {}) },
    notifications: {
      ...base.notifications,
      ...(raw.notifications ?? {}),
      kinds: { ...base.notifications.kinds, ...(raw.notifications?.kinds ?? {}) },
    },
    profiles: raw.profiles ?? base.profiles,
    prices: raw.prices ?? {},
  };
}

export const HARNESS_LABEL: Record<string, string> = { claude: "Claude Code", antigravity: "Antigravity", codex: "Codex", custom: "Custom" };
const HARNESS_OUTPUT: Record<string, AgentProfile["output"]> = { claude: "claude-stream", codex: "codex-json", antigravity: "agy-stream" };

/**
 * A profile is either a name from config.json or an ad-hoc "harness:model" pair
 * (e.g. "antigravity:gemini-3.8-flash-high", "claude:opus"), so you can pick any installed agent without editing config.
 */
export function resolveProfile(config: Config, name: string): AgentProfile | null {
  if (config.profiles[name]) return config.profiles[name];
  const m = /^(claude|codex|antigravity)(?::(.+))?$/.exec(name);
  if (!m) return null;
  return { harness: m[1] as Harness, model: m[2] || undefined, output: HARNESS_OUTPUT[m[1]] };
}
