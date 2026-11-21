#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { homeDir, loadConfig } from "./core/config.ts";

const HELP = `Northern Lights — AI agents work your missions, one task at a time per project.

Server
  serve [--port N]                     Start the server (keep it running)
  open                                 Open the app's screens in your browser
  status                               Projects, what's running, spend
  watch                                Live event stream
  inbox                                Everything waiting on you

Projects & missions
  project add <folder> [--name N]      Add a project folder
  project list
  mission new <project> <title> [--goal TEXT] [--review every|auto] [--access upfront|full]
              [--unit usd|tokens] [--task-budget N] [--mission-budget N] [--time-limit MIN]
              [--planner P] [--worker P] [--verifier P]
  mission list [project]
  mission show <M>                     TODO and task list
  mission set <M> [--review every|auto] [--access upfront|full]
              [--task-budget N] [--mission-budget N] [--time-limit MIN]
  mission cancel <M>

Plans
  plan <M>                             Show the plan waiting for approval
  plan edit <M>                        Edit it in $EDITOR (JSON)
  approve <M>                          Approve the plan (or split / fix tasks)
  reject <M> <feedback>                Send it back to the planner

Tasks (ids like M1:T2.1, or just T2.1 if unique)
  task <T>                             Show the task file
  review <T>                           Task file + diff
  accept <T>                           Accept a reviewed task
  accept <M> [--keep-overview]         Final approval of a mission
  send-back <T> <feedback>             Back to an agent with your feedback
  discard <T> [--cancel]               Restore the folder to before the task
  undo-discard <T>                     Undo the last discard
  retry <T> [note]                     Retry a stuck / failed / over-limit task
  cancel <T>                           Skip a task
  answer <T> <text>                    Answer an agent's question
  permit <T> once|mission|deny         Decide a permission request
  done <T> [note]                      Mark a task for you as done
  raise <T|M> <amount>                 Add budget to a task or mission

Control
  stop [project]                       Stop every running agent (missions pause)
  resume [project|M]                   Resume paused missions
  profiles                             Agent profiles
  pull-key <profile>                   Key for an agent you run yourself (pull mode)
  log <T>                              Agent output of the task's last run

Agents
  tool <name> '<json>'                 Call an agent tool (uses NL_KEY)
`;

function serverUrl(): string {
  if (process.env.NL_URL) return process.env.NL_URL;
  const f = path.join(homeDir(), "server.json");
  if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, "utf8")).url;
  return `http://127.0.0.1:${loadConfig().port}`;
}

function token(): string {
  const f = path.join(homeDir(), "admin-token");
  return fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim() : "";
}

async function api(method: string, p: string, body?: unknown, auth = token()): Promise<any> {
  let res: Response;
  try {
    res = await fetch(serverUrl() + p, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${auth}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    die(`Server isn't running at ${serverUrl()}. Start it with: northern-lights serve`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) die(data.error ?? `HTTP ${res.status}`);
  return data;
}

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

/** Split argv into positionals and --flags. */
function parse(argv: string[]) {
  const pos: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[k] = next;
        i++;
      } else flags[k] = true;
    } else pos.push(a);
  }
  return { pos, flags };
}

const enc = encodeURIComponent;
const isMission = (s: string) => /^M\d+$/i.test(s);

function money(unit: string, v: number) {
  return unit === "usd" ? `$${v.toFixed(2)}` : `${Math.round(v).toLocaleString()} tok`;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, flags } = parse(rest);
  switch (cmd) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return;

    case "serve": {
      const { startServer } = await import("./server.ts");
      const s = await startServer({ port: flags.port ? Number(flags.port) : undefined });
      console.log(`Northern Lights running at ${s.url}  (Ctrl-C to stop)`);
      console.log(`Open the screens: northern-lights open`);
      s.engine.events.on("event", (e) => {
        if (e.type === "changed") return;
        console.log(`${e.ts.slice(11, 19)} ${e.type}${e.mission ? ` ${e.mission}` : ""}${e.task ? ` ${e.task}` : ""}${e.message ? ` — ${e.message}` : ""}`);
      });
      const bye = async () => {
        console.log("\nStopping agents and shutting down…");
        await s.close();
        process.exit(0);
      };
      process.on("SIGINT", bye);
      process.on("SIGTERM", bye);
      s.engine.events.once("shutdown-request", bye);
      return;
    }

    case "open": {
      await api("GET", "/api/status");
      const url = `${serverUrl()}/login?k=${token()}`;
      const r = spawnSync(process.platform === "darwin" ? "open" : "xdg-open", [url], { stdio: "ignore" });
      if (r.status !== 0) console.log(`Open this in your browser: ${url}`);
      return;
    }

    case "status": {
      const s = await api("GET", "/api/status");
      if (!s.projects.length) return console.log("No projects yet. Add one: northern-lights project add <folder>");
      for (const p of s.projects) {
        console.log(`\n${p.id}  ${p.path}`);
        console.log(`  ${p.busy ? `busy: ${p.busy.task} "${p.busy.title}" (${p.busy.status.replace(/_/g, " ")})` : "free"}`);
        for (const m of p.missions) {
          const spent = m.budget.unit === "usd" ? m.spend.usd : m.spend.tokens;
          console.log(`  ${m.id} ${m.title} — ${m.status.replace(/_/g, " ")}${m.paused ? " (paused)" : ""} · ${money(m.budget.unit, spent)} of ${money(m.budget.unit, m.budget.mission)}`);
        }
      }
      console.log(`\nRunning: ${s.runs.length}/${s.concurrency}`);
      for (const r of s.runs) console.log(`  run ${r.id}: ${r.task} ${r.role} by ${r.profile} since ${r.started.slice(11, 19)} · ${Math.round(r.tokens)} tok · $${r.usd.toFixed(2)}`);
      return;
    }

    case "watch": {
      const res = await fetch(serverUrl() + "/events", { headers: { authorization: `Bearer ${token()}` } }).catch(() =>
        die("Server isn't running."),
      );
      const dec = new TextDecoder();
      let buf = "";
      for await (const chunk of res.body as any) {
        buf += dec.decode(chunk, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const line = block.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          const e = JSON.parse(line.slice(6));
          if (e.type === "changed" && !flags.all) continue;
          console.log(`${e.ts.slice(11, 19)} ${e.type}${e.mission ? ` ${e.mission}` : ""}${e.task ? ` ${e.task}` : ""}${e.message ? ` — ${e.message}` : ""}`);
        }
      }
      return;
    }

    case "inbox": {
      const items = await api("GET", "/api/inbox");
      if (!items.length) return console.log("Nothing waiting on you.");
      for (const it of items) {
        console.log(`• [${it.kind}] ${it.task ?? it.mission} — ${it.title}${it.detail ? `\n    ${it.detail}` : ""}`);
      }
      return;
    }

    case "project": {
      const sub = pos[0];
      if (sub === "add") {
        if (!pos[1]) die("Usage: project add <folder> [--name N]");
        const p = await api("POST", "/api/projects", { path: path.resolve(pos[1]), name: flags.name });
        console.log(`Added ${p.id} → ${p.path}\nSettings: ${path.join(p.path, ".northern-lights", "project.yaml")} (check commands, snapshot excludes)`);
        return;
      }
      if (sub === "list" || !sub) {
        for (const p of await api("GET", "/api/projects")) console.log(`${p.id}  ${p.path}`);
        return;
      }
      die("Usage: project add|list");
    }

    case "mission": {
      const sub = pos[0];
      if (sub === "new") {
        const [, project, ...titleParts] = pos;
        const title = titleParts.join(" ");
        if (!project || !title) die("Usage: mission new <project> <title> [--goal TEXT] …");
        const m = await api("POST", "/api/missions", {
          project,
          title,
          goal: typeof flags.goal === "string" ? flags.goal : title,
          review_mode: flags.review,
          permission_mode: flags.access,
          budget_unit: flags.unit,
          budget_task: flags["task-budget"] ? Number(flags["task-budget"]) : undefined,
          budget_mission: flags["mission-budget"] ? Number(flags["mission-budget"]) : undefined,
          time_limit_min: flags["time-limit"] ? Number(flags["time-limit"]) : undefined,
          planner: flags.planner,
          worker: flags.worker,
          verifier: flags.verifier,
        });
        console.log(`Created ${m.id} "${m.title}" in ${m.project_id}. The planner starts when the project is free.`);
        return;
      }
      if (sub === "list" || !sub) {
        const q = pos[1] ? `?project=${enc(pos[1])}` : "";
        for (const m of await api("GET", `/api/missions${q}`)) {
          console.log(`${m.id}  ${m.project_id}  ${m.status.replace(/_/g, " ")}${m.paused ? " (paused)" : ""}  ${m.title}`);
        }
        return;
      }
      if (sub === "show") {
        const v = await api("GET", `/api/missions/${enc(pos[1])}`);
        console.log(v.todo || `${v.mission.id} ${v.mission.title}: ${v.mission.status}`);
        const s = v.spend;
        console.log(`Spend: ${Math.round(s.tokens).toLocaleString()} tokens · $${s.usd.toFixed(2)}`);
        return;
      }
      if (sub === "set") {
        if (!pos[1]) die("Usage: mission set <M> [--review every|auto] [--access upfront|full] [--task-budget N] [--mission-budget N] [--time-limit MIN]");
        const body: Record<string, unknown> = {
          review_mode: flags.review,
          permission_mode: flags.access,
          budget_task: flags["task-budget"],
          budget_mission: flags["mission-budget"],
          time_limit_min: flags["time-limit"],
        };
        for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];
        if (!Object.keys(body).length) die("Nothing to change. Pass e.g. --review auto");
        const r = await api("PATCH", `/api/missions/${enc(pos[1])}`, body);
        const m = r.mission;
        console.log(`${m.id}: review ${m.review_mode === "auto" ? "auto-accept" : "every task"} · access ${m.permission_mode} · ${money(m.budget_unit, m.budget_task)}/task · ${money(m.budget_unit, m.budget_mission)}/mission · ${m.time_limit_min} min/run`);
        if (r.accepted?.length) console.log(`Auto-accepted: ${r.accepted.join(", ")}`);
        return;
      }
      if (sub === "cancel") {
        await api("POST", `/api/missions/${enc(pos[1])}/cancel`, {});
        console.log(`Cancelled ${pos[1]}. Its changes stay in the folder.`);
        return;
      }
      die("Usage: mission new|list|show|set|cancel");
    }

    case "plan": {
      if (pos[0] === "edit") {
        const id = pos[1];
        const v = await api("GET", `/api/missions/${enc(id)}/plan`);
        if (!v.plan) die(`${id} has no plan waiting for approval.`);
        const file = path.join(os.tmpdir(), `northern-lights-${id}-plan.json`);
        fs.writeFileSync(file, JSON.stringify({ tasks: v.plan.tasks, permissions: v.plan.permissions, overview: v.plan.overview }, null, 2));
        const editor = process.env.EDITOR || "vi";
        spawnSync(editor, [file], { stdio: "inherit" });
        let edited;
        try {
          edited = JSON.parse(fs.readFileSync(file, "utf8"));
        } catch (e) {
          die(`Not valid JSON: ${(e as Error).message}. Your edit is still in ${file}`);
        }
        await api("PUT", `/api/missions/${enc(id)}/plan`, edited);
        fs.rmSync(file);
        console.log("Plan updated. Approve it with: northern-lights approve " + id);
        return;
      }
      const id = pos[0];
      if (!id) die("Usage: plan <M>");
      const v = await api("GET", `/api/missions/${enc(id)}/plan`);
      if (!v.plan) return console.log(`${id} has no plan waiting (status: ${v.mission.status}).`);
      const kind = v.plan.source === "split" ? `Split of ${v.plan.split_of}` : v.plan.source === "fix" ? "Fix tasks from the final check" : "Plan";
      console.log(`${kind} for ${v.mission.id} "${v.mission.title}"${v.plan.reason ? `\nReason: ${v.plan.reason}` : ""}\n`);
      console.log(v.tree);
      const perm = v.plan.permissions;
      if (perm && v.mission.permission_mode === "upfront") {
        console.log(`\nPermissions requested (approve up front):`);
        console.log(`  commands: ${perm.commands?.join(", ") || "(none)"}`);
        console.log(`  domains:  ${perm.domains?.join(", ") || "(none)"}`);
        console.log(`  paths:    ${perm.paths?.join(", ") || "(none)"}`);
      }
      if (v.plan.overview) console.log(`\nProposed PROJECT.md:\n${"-".repeat(40)}\n${v.plan.overview}\n${"-".repeat(40)}`);
      console.log(`\nApprove: northern-lights approve ${id}   Edit: northern-lights plan edit ${id}   Reject: northern-lights reject ${id} "<feedback>"`);
      return;
    }

    case "approve":
      await api("POST", `/api/missions/${enc(pos[0])}/approve`, {});
      console.log(`Approved. Work starts on ${pos[0]}.`);
      return;
    case "reject":
      if (!pos[1]) die("Usage: reject <M> <feedback>");
      await api("POST", `/api/missions/${enc(pos[0])}/reject`, { feedback: pos.slice(1).join(" ") });
      console.log("Sent back to the planner.");
      return;

    case "task":
    case "review": {
      const v = await api("GET", `/api/tasks/${enc(pos[0])}${cmd === "review" ? "?diff=1" : ""}`);
      console.log(v.file);
      for (const q of v.questions) {
        if (q.kind === "question") console.log(`QUESTION: ${q.body.question}${q.body.choices?.length ? ` [${q.body.choices.join(" / ")}]` : ""}`);
        else console.log(`PERMISSION REQUEST: ${q.body.kind} "${q.body.value}" — ${q.body.reason}`);
      }
      console.log(`Spend: ${Math.round(v.spend.tokens).toLocaleString()} tokens · $${v.spend.usd.toFixed(2)}`);
      if (cmd === "review") {
        console.log(`\n${"=".repeat(20)} diff ${"=".repeat(20)}\n${v.diff}`);
        if (v.task.status === "in_review") {
          console.log(`Accept: northern-lights accept ${v.task.id}   Send back: northern-lights send-back ${v.task.id} "<feedback>"   Discard: northern-lights discard ${v.task.id}`);
        }
      }
      return;
    }

    case "accept": {
      const id = pos[0];
      if (!id) die("Usage: accept <T|M>");
      if (isMission(id)) {
        const r = await api("POST", `/api/missions/${enc(id)}/accept`, { overview: flags["keep-overview"] ? false : undefined });
        console.log(`${id} is done.${r.mission_start_snapshot ? `\nSnapshot from before the mission (to roll it all back): ${r.mission_start_snapshot}` : ""}`);
      } else {
        await api("POST", `/api/tasks/${enc(id)}/accept`, {});
        console.log(`Accepted ${id}.`);
      }
      return;
    }
    case "send-back":
      if (!pos[1]) die("Usage: send-back <T> <feedback>");
      await api("POST", `/api/tasks/${enc(pos[0])}/send-back`, { feedback: pos.slice(1).join(" ") });
      console.log("Sent back.");
      return;
    case "discard": {
      const r = await api("POST", `/api/tasks/${enc(pos[0])}/discard`, { cancel: !!flags.cancel });
      console.log(`Folder restored to before ${pos[0]}.${r.safety ? ` Undo with: northern-lights undo-discard ${pos[0]}` : ""}`);
      return;
    }
    case "undo-discard":
      await api("POST", `/api/tasks/${enc(pos[0])}/undo-discard`, {});
      console.log("Discard undone.");
      return;
    case "retry":
      await api("POST", `/api/tasks/${enc(pos[0])}/retry`, { note: pos.slice(1).join(" ") || undefined });
      console.log("Retrying.");
      return;
    case "cancel":
      await api("POST", `/api/tasks/${enc(pos[0])}/cancel`, {});
      console.log("Cancelled.");
      return;
    case "answer":
      if (!pos[1]) die("Usage: answer <T> <text>");
      await api("POST", `/api/tasks/${enc(pos[0])}/answer`, { text: pos.slice(1).join(" ") });
      console.log("Answered. A fresh agent will continue.");
      return;
    case "permit":
      if (!["once", "mission", "deny"].includes(pos[1])) die("Usage: permit <T> once|mission|deny");
      await api("POST", `/api/tasks/${enc(pos[0])}/permit`, { decision: pos[1] });
      console.log("Done. A fresh agent will continue.");
      return;
    case "done":
      await api("POST", `/api/tasks/${enc(pos[0])}/done`, { note: pos.slice(1).join(" ") || undefined });
      console.log("Marked done.");
      return;
    case "raise": {
      if (!pos[1]) die("Usage: raise <T|M> <amount>");
      const target = isMission(pos[0]) ? `/api/missions/${enc(pos[0])}/raise` : `/api/tasks/${enc(pos[0])}/raise`;
      await api("POST", target, { amount: Number(pos[1]) });
      console.log("Budget raised.");
      return;
    }

    case "stop": {
      const r = await api("POST", "/api/stop", { project: pos[0] });
      console.log(`Stopped ${r.stopped} run(s). Missions are paused; resume with: northern-lights resume${pos[0] ? ` ${pos[0]}` : ""}`);
      return;
    }
    case "resume": {
      const r = await api("POST", "/api/resume", { target: pos[0] });
      console.log(r.resumed.length ? `Resumed ${r.resumed.join(", ")}.` : "Nothing resumed.");
      for (const s of r.skipped) console.log(`Skipped: ${s}`);
      return;
    }
    case "profiles": {
      const r = await api("GET", "/api/profiles");
      for (const [name, p] of Object.entries<any>(r.profiles)) {
        const roles = Object.entries(r.defaults).filter(([, v]) => v === name).map(([k]) => k);
        console.log(`${name}: ${p.harness}${p.model ? ` · ${p.model}` : ""}${roles.length ? `  (default ${roles.join(", ")})` : ""}${p.harness === "codex" ? "  [untested]" : ""}`);
      }
      console.log(`\nEdit profiles in ${path.join(homeDir(), "config.json")}, then restart the server.`);
      return;
    }
    case "pull-key": {
      const r = await api("POST", "/api/pull-keys", { profile: pos[0] });
      console.log(`Pull-mode key for ${pos[0]}:\n  NL_KEY=${r.key}\nGive your agent the northern-lights MCP server with env NL_URL=${serverUrl()} and this NL_KEY,\nthen tell it to call next_task for your project.`);
      return;
    }
    case "log": {
      const v = await api("GET", `/api/tasks/${enc(pos[0])}`);
      const last = v.runs[v.runs.length - 1];
      if (!last?.log_path) return console.log("No runs yet.");
      console.log(`Run ${last.id} (${last.role}, ${last.profile}, ${last.status}${last.stop_reason ? `: ${last.stop_reason}` : ""}) — ${last.log_path}\n`);
      console.log(fs.existsSync(last.log_path) ? fs.readFileSync(last.log_path, "utf8").slice(-8000) : "(log missing)");
      return;
    }

    case "tool": {
      const key = process.env.NL_KEY;
      if (!key) die("NL_KEY isn't set. Agents get it from Northern Lights when their run starts.");
      let args = {};
      if (pos[1]) {
        try {
          args = JSON.parse(pos[1]);
        } catch {
          die("Arguments must be JSON, e.g. '{\"text\":\"hi\"}'");
        }
      }
      const r = await api("POST", `/api/tool/${pos[0]}`, args, key);
      console.log(r.text);
      if (r.error) process.exit(2);
      return;
    }

    default:
      die(`Unknown command "${cmd}". Run: northern-lights help`);
  }
}

main();
