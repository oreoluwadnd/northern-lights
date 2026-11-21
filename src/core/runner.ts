import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { commandFor, killTree, treeSpawnOptions } from "./platform.ts";

export { killTree };
import type { ChildProcess } from "node:child_process";
import type { AgentProfile } from "./config.ts";
import type { Permissions } from "./model.ts";

import { TOOLS } from "./tools.ts";

export interface LaunchOptions {
  role: "plan" | "work" | "verify";
  cwd: string;
  briefing: string;
  runDir: string;
  key: string;
  serverUrl: string;
  mcpScript: string;
  cliScript: string;
  permissionMode: "upfront" | "full";
  permissions: Permissions;
  taskId: string;
}

export interface LaunchSpec {
  cmd: string;
  args: string[];
  env: Record<string, string>;
  stdin: string;
  cwd: string;
  output: "claude-stream" | "codex-json" | "agy-stream" | "none";
  /** Things this harness can't enforce from the permission list, shown as warnings. */
  warnings: string[];
}

const READ_ONLY_ROLES = new Set(["plan", "verify"]);

/** When the engine runs inside the Mac app, process.execPath is Electron; this makes it behave as plain Node. */
export const NODE_ENV: Record<string, string> = process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {};

/** "agent-browser open" → also "/opt/homebrew/bin/agent-browser open": agents often call tools by full path. */
export function withFullPaths(commands: string[]): string[] {
  const out = new Set(commands);
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const c of commands) {
    const [bin, ...rest] = c.split(" ");
    if (!bin || bin.includes("/")) continue;
    for (const d of dirs) {
      const full = path.join(d, bin);
      try {
        if (fs.statSync(full).isFile()) out.add([full, ...rest].join(" "));
      } catch {}
    }
  }
  return [...out];
}

/** Read-only commands Antigravity agents may always run (they tend to explore with ls/cat; Claude has built-in tools). */
export const AGY_SAFE_COMMANDS = ["ls", "pwd", "cat", "head", "tail", "wc", "grep", "git status", "git diff", "git log", "git show"];

export function buildLaunch(profile: AgentProfile, o: LaunchOptions): LaunchSpec {
  const readOnly = READ_ONLY_ROLES.has(o.role);
  const env: Record<string, string> = {
    NL_URL: o.serverUrl,
    NL_KEY: o.key,
    NL_ROLE: o.role,
    NL_TASK: o.taskId,
    NL_BRIEFING_FILE: path.join(o.runDir, "briefing.md"),
    ...(profile.env ?? {}),
  };
  const warnings: string[] = [];

  if (profile.harness === "claude") {
    const mcpConfig = {
      mcpServers: {
        "northern-lights": {
          command: process.execPath,
          args: [o.mcpScript],
          env: { NL_URL: o.serverUrl, NL_KEY: o.key, ...NODE_ENV },
        },
      },
    };
    const mcpFile = path.join(o.runDir, "mcp.json");
    fs.writeFileSync(mcpFile, JSON.stringify(mcpConfig, null, 2), { mode: 0o600 });
    const args: string[] = [];
    if (o.permissionMode === "full") {
      args.push("--dangerously-skip-permissions");
    } else {
      const allowed = ["Read", "Glob", "Grep", "LS", "TodoWrite", "mcp__northern-lights"];
      if (!readOnly) allowed.push("Edit", "Write", "MultiEdit", "NotebookEdit");
      for (const c of withFullPaths(o.permissions.commands)) allowed.push(`Bash(${c}:*)`);
      for (const d of o.permissions.domains) allowed.push(`WebFetch(domain:${d})`);
      args.push("--allowedTools", ...allowed);
      if (!readOnly) args.push("--permission-mode", "acceptEdits");
      for (const p of o.permissions.paths) args.push("--add-dir", p);
      if (o.permissions.domains.length) {
        warnings.push("Claude Code can't limit network access of shell commands to the allowed domains; only WebFetch is limited.");
      }
    }
    if (readOnly) args.push("--disallowedTools", "Edit", "Write", "MultiEdit", "NotebookEdit");
    args.push(
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--no-session-persistence",
      "--strict-mcp-config",
      "--mcp-config",
      mcpFile,
    );
    if (profile.model) args.push("--model", profile.model);
    return { cmd: "claude", args, env, stdin: o.briefing, cwd: o.cwd, output: "claude-stream", warnings };
  }

  if (profile.harness === "codex") {
    // NOTE: written from Codex CLI docs; not yet tested against a real Codex install.
    const args = ["exec", "--json", "--skip-git-repo-check", "-C", o.cwd];
    if (profile.model) args.push("-m", profile.model);
    if (o.permissionMode === "full") {
      args.push("--dangerously-bypass-approvals-and-sandbox");
    } else {
      args.push("--sandbox", readOnly ? "read-only" : "workspace-write");
      if (o.permissions.domains.length && !readOnly) args.push("-c", "sandbox_workspace_write.network_access=true");
      warnings.push("Codex can't limit shell commands to an allow list; the sandbox limits file writes to the project folder.");
      if (o.permissions.domains.length) warnings.push("Codex network access is all-or-nothing; allowed domains turn it on fully.");
    }
    const tomlStr = (s: string) => JSON.stringify(s);
    args.push(
      "-c",
      `mcp_servers.northern-lights.command=${tomlStr(process.execPath)}`,
      "-c",
      `mcp_servers.northern-lights.args=[${tomlStr(o.mcpScript)}]`,
      "-c",
      `mcp_servers.northern-lights.env={NL_URL=${tomlStr(o.serverUrl)},NL_KEY=${tomlStr(o.key)}${NODE_ENV.ELECTRON_RUN_AS_NODE ? ",ELECTRON_RUN_AS_NODE=\"1\"" : ""}}`,
      "-",
    );
    return { cmd: "codex", args, env, stdin: o.briefing, cwd: o.cwd, output: "codex-json", warnings };
  }

  if (profile.harness === "antigravity") {
    // Antigravity CLI (agy). Its MCP servers are global, so Northern Lights registers one entry once
    // (see ensureAgyMcp); the run's key reaches it through the environment. Per-run permissions go in --settings.
    const args = ["--output-format", "stream-json"];
    if (profile.model) args.push("--model", profile.model);
    for (const p of o.permissions.paths) args.push("--add-dir", p);
    const allow = TOOLS.map((t) => `mcp(northern-lights/${t.name})`);
    if (o.permissionMode === "full") {
      args.push("--dangerously-skip-permissions");
    } else {
      // A denied command ends an agy run in headless mode, so allow harmless read-only ones by default.
      for (const c of withFullPaths([...AGY_SAFE_COMMANDS, ...o.permissions.commands])) allow.push(`command(${c})`);
      // Read-only roles don't get accept-edits: in headless mode, unapproved edits are denied.
      if (!readOnly) args.push("--mode", "accept-edits");
      if (o.permissions.domains.length) warnings.push("Antigravity's web access isn't limited to the allowed domains by Northern Lights.");
    }
    args.push("--settings", JSON.stringify({ permissions: { allow } }));
    args.push(`-p=${o.briefing}`);
    return { cmd: "agy", args, env, stdin: "", cwd: o.cwd, output: "agy-stream", warnings };
  }

  // custom: any program. Briefing on stdin; tools via `northern-lights tool <name> '<json>'`.
  if (!profile.command?.length) throw new Error("custom profile needs a command");
  const [cmd, ...args] = profile.command;
  warnings.push("Custom harnesses get no permission enforcement from Northern Lights.");
  return {
    cmd,
    args,
    env: { ...env, ...NODE_ENV, NL_CLI: `${process.execPath} ${o.cliScript}` },
    stdin: o.briefing,
    cwd: o.cwd,
    output: profile.output ?? "none",
    warnings,
  };
}

/** Token counts by type, for pricing. */
export interface UsageBreakdown {
  input: number;
  cache_write: number;
  cache_read: number;
  output: number;
}

/** Reads token usage from a harness's JSON output, line by line. */
export class UsageTracker {
  format: LaunchSpec["output"];
  usdFinal: number | null = null;
  model: string | null = null;
  private perMessage = new Map<string, UsageBreakdown>();
  private codexTotal: UsageBreakdown = { input: 0, cache_write: 0, cache_read: 0, output: 0 };

  constructor(format: LaunchSpec["output"]) {
    this.format = format;
  }

  breakdown(): UsageBreakdown {
    if (this.format === "codex-json") return { ...this.codexTotal };
    const sum: UsageBreakdown = { input: 0, cache_write: 0, cache_read: 0, output: 0 };
    for (const u of this.perMessage.values()) {
      sum.input += u.input;
      sum.cache_write += u.cache_write;
      sum.cache_read += u.cache_read;
      sum.output += u.output;
    }
    return sum;
  }

  /** Tokens counted against budgets: new input + cache writes + output. Cache reads (re-reading the same context) are excluded. */
  get tokens(): number {
    const b = this.breakdown();
    return b.input + b.cache_write + b.output;
  }

  /** Returns true if usage changed. */
  feed(line: string): boolean {
    if (this.format === "none") return false;
    let d: any;
    try {
      d = JSON.parse(line);
    } catch {
      return false;
    }
    if (this.format === "claude-stream") {
      if (d.type === "assistant" && d.message?.usage) {
        const u = d.message.usage;
        // The same message can appear several times (one event per content block): keep the latest.
        this.perMessage.set(d.message.id ?? String(this.perMessage.size), {
          input: u.input_tokens ?? 0,
          cache_write: u.cache_creation_input_tokens ?? 0,
          cache_read: u.cache_read_input_tokens ?? 0,
          output: u.output_tokens ?? 0,
        });
        if (d.message.model) this.model = d.message.model;
        return true;
      }
      if (d.type === "result" && typeof d.total_cost_usd === "number") {
        this.usdFinal = d.total_cost_usd;
        return true;
      }
      return false;
    }
    if (this.format === "agy-stream") {
      if (d.event === "init" && d.init?.model) {
        this.model = d.init.model;
        return false;
      }
      const step = d.step_update;
      if (step?.usage && step.state === "DONE") {
        const u = step.usage;
        this.perMessage.set(`${step.conversation_id}:${step.step_index}`, {
          input: u.input_tokens ?? 0,
          cache_write: 0,
          cache_read: u.cache_read_tokens ?? 0,
          output: (u.output_tokens ?? 0) + (u.thinking_tokens ?? 0),
        });
        return true;
      }
      return false;
    }
    if (this.format === "codex-json") {
      const u = d.usage ?? d.msg?.usage ?? d.info?.last_token_usage;
      if ((d.type === "turn.completed" || d.type === "token_count") && u) {
        const cached = u.cached_input_tokens ?? 0;
        this.codexTotal.input += Math.max(0, (u.input_tokens ?? 0) - cached);
        this.codexTotal.cache_read += cached;
        this.codexTotal.output += u.output_tokens ?? 0;
        if (d.model) this.model = d.model;
        return true;
      }
    }
    return false;
  }
}

export interface ProcessHandle {
  child: ChildProcess;
  kill(reason: string): void;
  stopReason: string | null;
}

export interface ProcessCallbacks {
  onLine(line: string): void;
  onExit(code: number | null, signal: string | null): void;
}

/** Start the agent process in its own process group so the whole tree can be stopped. */
export function startProcess(spec: LaunchSpec, logFile: string, cb: ProcessCallbacks): ProcessHandle {
  const log = fs.createWriteStream(logFile, { flags: "a" });
  const { file, shell } = commandFor(spec.cmd);
  const child = spawn(file, spec.args, {
    ...treeSpawnOptions(),
    cwd: spec.cwd,
    env: { ...process.env, ...spec.env },
    shell,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const handle: ProcessHandle = {
    child,
    stopReason: null,
    kill(reason: string) {
      if (handle.stopReason) return;
      handle.stopReason = reason;
      killTree(child.pid);
    },
  };
  child.stdin?.on("error", () => {});
  child.stdin?.end(spec.stdin);
  let buf = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    log.write(chunk);
    buf += chunk.toString("utf8");
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim()) cb.onLine(line);
    }
  });
  child.stderr?.on("data", (chunk: Buffer) => log.write(chunk));
  let exited = false;
  const done = (code: number | null, signal: string | null) => {
    if (exited) return;
    exited = true;
    if (buf.trim()) cb.onLine(buf);
    log.end();
    cb.onExit(code, signal);
  };
  child.on("error", (err) => {
    log.write(`\n[northern-lights] failed to start ${spec.cmd}: ${err.message}\n`);
    done(127, null);
  });
  child.on("exit", (code, signal) => done(code, signal));
  return handle;
}

export function isAlive(pid: number | null | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
