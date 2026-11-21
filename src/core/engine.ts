import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Config } from "./config.ts";
import { HARNESS_LABEL, homeDir, resolveProfile } from "./config.ts";
import type { DB } from "./db.ts";
import { nextCounter, now, tx } from "./db.ts";
import type {
  Mission,
  PendingPlan,
  Permissions,
  PlanTaskInput,
  Project,
  Run,
  Screenshot,
  Task,
  TaskStatus,
} from "./model.ts";
import {
  addLog,
  BUSY_STATUSES,
  emptyPermissions,
  getLog,
  getMission,
  getProject,
  getRun,
  getTask,
  listMissions,
  listProjects,
  listTasks,
  missionSpend,
  openQuestions,
  runByKey,
  runningRuns,
  taskSpend,
  updateMission,
  updateRun,
  updateTask,
} from "./model.ts";
import { addProject, appendDecision, missionDir, readOverview, readSettings, writeOverview } from "./project.ts";
import { renderTaskFile, writeMissionFiles } from "./files.ts";
import { applyPlan, leafIdsUnder, renderPlanTree, validatePlan } from "./plan.ts";
import { planBriefing, verifyBriefing, workBriefing } from "./briefing.ts";
import type { ProcessHandle } from "./runner.ts";
import { buildLaunch, isAlive, killTree, NODE_ENV, startProcess, UsageTracker } from "./runner.ts";
import {
  changedFiles,
  deleteSnapshot,
  diffText,
  restoreSnapshot,
  takeSnapshot,
} from "./snapshots.ts";
import { ENDING_TOOLS, TOOLS } from "./tools.ts";
import { commandFor, hasCommand, IS_WIN, shellCommand, treeSpawnOptions } from "./platform.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const MCP_SCRIPT = path.resolve(HERE, "../mcp.ts");
export const CLI_SCRIPT = path.resolve(HERE, "../cli.ts");

export class UserError extends Error {}

export interface NewMission {
  project: string;
  title: string;
  goal: string;
  review_mode?: "every" | "auto";
  permission_mode?: "upfront" | "full";
  budget_unit?: "tokens" | "usd";
  budget_task?: number;
  budget_mission?: number;
  time_limit_min?: number;
  planner?: string;
  worker?: string;
  verifier?: string;
}

export interface EngineEvent {
  type: string;
  mission?: string;
  task?: string;
  project?: string;
  message?: string;
  muted?: boolean;
  ts: string;
}

interface LiveRun {
  handle: ProcessHandle | null;
  tracker: UsageTracker | null;
  lastActivityWrite: number;
}

const HARNESS_BIN: Record<string, string> = { claude: "claude", codex: "codex", antigravity: "agy" };

const DONE_LIKE: TaskStatus[] = ["done", "cancelled"];

export class Engine {
  db: DB;
  config: Config;
  url: string;
  events = new EventEmitter();
  private live = new Map<number, LiveRun>();
  private checking = new Map<string, Set<number>>(); // task id → check process pids
  private pullRuns = new Map<string, number>(); // pull key → current run id
  private ticking = false;
  private timers: NodeJS.Timeout[] = [];
  private fileTimers = new Map<string, NodeJS.Timeout>();
  notifyEnabled: boolean;

  constructor(db: DB, config: Config, opts: { url: string; notify?: boolean }) {
    this.db = db;
    this.config = config;
    this.url = opts.url;
    this.notifyEnabled = opts.notify ?? config.notifications.enabled;
    this.events.setMaxListeners(100);
  }

  // ───────────────────────────── lifecycle ─────────────────────────────

  start(tickMs = 1000) {
    this.recover();
    this.timers.push(setInterval(() => this.tick(), tickMs));
    this.timers.push(setInterval(() => this.watchdog(), 15_000));
    this.tick();
  }

  shutdown() {
    for (const t of this.timers) clearInterval(t);
    this.stopAll(undefined, "server shutting down", false);
    fs.writeFileSync(path.join(homeDir(), "clean-shutdown"), now());
  }

  /** After a crash or restart: orphaned tasks back to Ready, missions paused. */
  recover() {
    const marker = path.join(homeDir(), "clean-shutdown");
    const clean = fs.existsSync(marker);
    if (clean) fs.rmSync(marker);
    const orphans = runningRuns(this.db);
    for (const r of orphans) {
      if (isAlive(r.pid)) killTree(r.pid);
      updateRun(this.db, r.id, { status: "orphaned", ended_at: now(), stop_reason: "server restarted" });
      const t = getTask(this.db, r.task_id);
      if (!t) continue;
      if (t.status === "in_progress") {
        updateTask(this.db, t.id, { status: "ready" });
        addLog(this.db, t.id, "northern-lights", "Server restarted while this task was running; back to Ready. Its changes are still in the folder.");
      }
    }
    const active = listMissions(this.db).filter((m) => !["done", "cancelled"].includes(m.status));
    if (orphans.length || (!clean && active.some((m) => m.status === "running" || m.status === "planning"))) {
      for (const m of active) if (!m.paused) updateMission(this.db, m.id, { paused: 1 });
      if (active.length) {
        this.notify("stuck", "Northern Lights restarted", `${active.length} mission(s) paused. Run: northern-lights resume`);
        this.emit({ type: "recovered", message: `${orphans.length} orphaned run(s); missions paused` });
      }
    }
    for (const m of active) this.writeFiles(m.id);
  }

  emit(e: Omit<EngineEvent, "ts">) {
    this.events.emit("event", { ...e, ts: now() });
  }

  notify(kind: string, title: string, body: string) {
    this.emit({ type: "notify", message: `${title}: ${body}`, muted: this.config.notifications.kinds[kind] === false });
    if (!this.notifyEnabled || process.env.NL_NO_NOTIFY) return;
    if (this.config.notifications.kinds[kind] === false) return;
    if (process.platform !== "darwin") return;
    const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const child = spawn(
      "osascript",
      ["-e", `display notification "${esc(body)}" with title "Northern Lights" subtitle "${esc(title)}"`],
      { stdio: "ignore", detached: true },
    );
    child.on("error", () => {});
    child.unref();
  }

  writeFiles(missionId: string) {
    const existing = this.fileTimers.get(missionId);
    if (existing) clearTimeout(existing);
    this.fileTimers.set(
      missionId,
      setTimeout(() => {
        this.fileTimers.delete(missionId);
        const m = getMission(this.db, missionId);
        if (m) {
          try {
            writeMissionFiles(this.db, m);
          } catch (e) {
            this.emit({ type: "error", mission: missionId, message: `writing files: ${(e as Error).message}` });
          }
        }
      }, 200),
    );
  }

  /** Write files now (used by tests and the CLI). */
  flushFiles() {
    for (const [id, t] of this.fileTimers) {
      clearTimeout(t);
      const m = getMission(this.db, id);
      if (m) writeMissionFiles(this.db, m);
    }
    this.fileTimers.clear();
  }

  private changed(m: Mission | string, extra: Partial<EngineEvent> = {}) {
    const id = typeof m === "string" ? m : m.id;
    this.writeFiles(id);
    this.emit({ type: "changed", mission: id, ...extra });
  }

  // ───────────────────────────── projects & missions ─────────────────────────────

  addProject(folder: string, name?: string): Project {
    const p = addProject(this.db, folder, name);
    this.emit({ type: "project_added", project: p.id });
    return p;
  }

  createMission(input: NewMission): Mission {
    const p = getProject(this.db, input.project);
    if (!p) throw new UserError(`No project "${input.project}". Add it with: northern-lights project add <folder>`);
    if (!input.title?.trim()) throw new UserError("A mission needs a title.");
    const d = this.config.defaults;
    const profiles = {
      planner: input.planner ?? d.planner,
      worker: input.worker ?? d.worker,
      verifier: input.verifier ?? d.verifier,
    };
    for (const [role, prof] of Object.entries(profiles)) {
      if (!resolveProfile(this.config, prof)) throw new UserError(`Unknown ${role} agent "${prof}". Use a profile name or harness:model, e.g. antigravity:gemini-3.8-flash-high`);
    }
    const unit = input.budget_unit ?? "usd";
    const id = `M${nextCounter(this.db, "mission")}`;
    const queue = (this.db.prepare("select coalesce(max(queue_pos),0) q from missions where project_id = ?").get(p.id) as { q: number }).q + 1;
    const ts = now();
    this.db
      .prepare(
        `insert into missions (id, project_id, title, goal, status, review_mode, permission_mode, permissions,
         budget_unit, budget_task, budget_mission, time_limit_min, planner_profile, worker_profile, verifier_profile,
         queue_pos, created_at, updated_at) values (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        p.id,
        input.title.trim(),
        (input.goal || input.title).trim(),
        input.review_mode ?? "every",
        input.permission_mode ?? "upfront",
        JSON.stringify(emptyPermissions()),
        unit,
        input.budget_task ?? (unit === "usd" ? 5 : 2_000_000),
        input.budget_mission ?? (unit === "usd" ? 50 : 20_000_000),
        input.time_limit_min ?? 30,
        profiles.planner,
        profiles.worker,
        profiles.verifier,
        queue,
        ts,
        ts,
      );
    const m = getMission(this.db, id)!;
    this.changed(m, { type: "mission_created", project: p.id });
    setImmediate(() => this.tick());
    return m;
  }

  /** The mission currently allowed to work in a project (one at a time, by queue order). */
  activeMission(projectId: string): Mission | undefined {
    return listMissions(this.db, projectId).find((m) => !["done", "cancelled"].includes(m.status));
  }

  /** The task holding the project's folder, if any. */
  busyTask(projectId: string): Task | undefined {
    const ph = BUSY_STATUSES.map(() => "?").join(",");
    const row = this.db
      .prepare(
        `select t.id from tasks t join missions m on m.id = t.mission_id
         where m.project_id = ? and t.is_parent = 0 and t.status in (${ph})
         and m.status not in ('done','cancelled') order by t.order_idx limit 1`,
      )
      .get(projectId, ...BUSY_STATUSES) as { id: string } | undefined;
    return row ? getTask(this.db, row.id) : undefined;
  }

  private activeJobs(): number {
    return this.live.size + this.checking.size;
  }

  private taskActive(taskId: string): boolean {
    if (this.checking.has(taskId)) return true;
    for (const id of this.live.keys()) {
      const r = getRun(this.db, id);
      if (r?.task_id === taskId) return true;
    }
    return false;
  }

  // ───────────────────────────── scheduler ─────────────────────────────

  tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const p of listProjects(this.db)) this.tickProject(p);
    } catch (e) {
      this.emit({ type: "error", message: `scheduler: ${(e as Error).stack}` });
    } finally {
      this.ticking = false;
    }
  }

  private tickProject(p: Project): void {
    const m = this.activeMission(p.id);
    if (!m) return;
    if (m.status === "running") this.refresh(m);
    const busy = this.busyTask(p.id);
    if (m.paused) return;
    if (busy) {
      // A verification step with nothing running (after its worker exited, a restart, or a verifier with no verdict).
      if (busy.status === "verifying" && !this.taskActive(busy.id) && this.activeJobs() < this.config.concurrency) {
        void this.runVerification(busy.id);
      }
      return;
    }
    if (this.activeJobs() >= this.config.concurrency) return;

    if (m.status === "queued") {
      this.newPlanTask(m);
      updateMission(this.db, m.id, { status: "planning" });
      this.changed(m.id);
      return this.tickProject(p);
    }
    if (m.status === "planning") {
      const planTask = listTasks(this.db, m.id).find((t) => t.kind === "plan" && t.status === "ready");
      if (planTask) this.launch(planTask, "plan", m.planner_profile);
      return;
    }
    if (m.status !== "running") return;

    const tasks = listTasks(this.db, m.id);
    const next = tasks.find((t) => t.status === "ready" && !t.is_parent && (t.kind === "work" || t.kind === "mission_verify"));
    if (next) {
      if (next.kind === "mission_verify") {
        updateTask(this.db, next.id, { status: "verifying", attempt: next.attempt + 1 });
        this.changed(m);
        void this.runVerification(next.id);
      } else {
        this.launch(next, "work", m.worker_profile);
      }
      return;
    }
    const leaves = tasks.filter((t) => !t.is_parent && (t.kind === "work" || t.kind === "human"));
    const allDone = leaves.length > 0 && leaves.every((t) => DONE_LIKE.includes(t.status));
    const finalOpen = tasks.some((t) => t.kind === "mission_verify" && !DONE_LIKE.includes(t.status));
    if (allDone && !finalOpen) {
      const n = tasks.filter((t) => t.kind === "mission_verify").length + 1;
      const local = n === 1 ? "FINAL" : `FINAL${n}`;
      this.insertTask(m, {
        local_id: local,
        kind: "mission_verify",
        title: "Final mission check",
        goal: m.goal,
        status: "ready",
        order_idx: tasks.reduce((mx, t) => Math.max(mx, t.order_idx), 0) + 1,
      });
      this.changed(m);
      return this.tickProject(p);
    }
  }

  private insertTask(
    m: Mission,
    t: { local_id: string; kind: Task["kind"]; title: string; goal: string; status: TaskStatus; order_idx: number },
  ) {
    const ts = now();
    this.db
      .prepare(
        `insert into tasks (id, mission_id, local_id, kind, title, goal, order_idx, status, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(`${m.id}:${t.local_id}`, m.id, t.local_id, t.kind, t.title, t.goal, t.order_idx, t.status, ts, ts);
  }

  private newPlanTask(m: Mission) {
    const n = listTasks(this.db, m.id).filter((t) => t.kind === "plan").length + 1;
    this.insertTask(m, {
      local_id: `P${n}`,
      kind: "plan",
      title: n === 1 ? "Plan the mission" : `Re-plan (attempt ${n})`,
      goal: m.goal,
      status: "ready",
      order_idx: 0,
    });
  }

  /** Move pending tasks whose dependencies are done to Ready / Your turn; finish parents. */
  refresh(m: Mission) {
    let changed = false;
    for (let pass = 0; pass < 4; pass++) {
      const tasks = listTasks(this.db, m.id);
      const byId = new Map(tasks.map((t) => [t.local_id, t]));
      const depsDone = (t: Task) =>
        t.depends.every((d) => leafIdsUnder(tasks, d).every((id) => DONE_LIKE.includes(byId.get(id)?.status ?? "done")));
      let any = false;
      for (const t of tasks) {
        if (t.is_parent) {
          const kids = tasks.filter((c) => c.parent_local === t.local_id);
          const want: TaskStatus = kids.length && kids.every((c) => DONE_LIKE.includes(c.status)) ? "done" : "pending";
          if (t.status !== want && t.status !== "cancelled") {
            updateTask(this.db, t.id, { status: want });
            any = true;
          }
          continue;
        }
        if (t.status !== "pending") continue;
        const parentDepsDone = (() => {
          let parent = t.parent_local ? byId.get(t.parent_local) : undefined;
          while (parent) {
            if (!depsDone(parent)) return false;
            parent = parent.parent_local ? byId.get(parent.parent_local) : undefined;
          }
          return true;
        })();
        if (depsDone(t) && parentDepsDone) {
          if (t.kind === "human") {
            updateTask(this.db, t.id, { status: "your_turn" });
            this.notify("your_turn", `Your turn: ${t.local_id}`, t.title);
          } else {
            updateTask(this.db, t.id, { status: "ready" });
          }
          any = true;
        }
      }
      if (!any) break;
      changed = true;
    }
    if (changed) this.changed(m);
  }

  // ───────────────────────────── running agents ─────────────────────────────

  private agentBrowser: boolean | null = null;
  hasAgentBrowser(): boolean {
    if (this.agentBrowser === null) this.agentBrowser = hasCommand("agent-browser");
    return this.agentBrowser;
  }

  /** Verifiers may always drive a browser to test UI changes. */
  private runPermissions(role: string, m: Mission, t: Task, p: Project): Permissions {
    const perms = this.effectivePermissions(m, t, p);
    if (role === "verify" && this.hasAgentBrowser() && !perms.commands.includes("agent-browser")) {
      return { ...perms, commands: [...perms.commands, "agent-browser"] };
    }
    return perms;
  }

  /** Copy the screenshots a verifier attached (or, if it named none, every image it saved) to permanent storage. */
  private collectScreenshots(run: Run, t: Task, given: unknown): Screenshot[] {
    const shotsDir = path.join(homeDir(), "runs", String(run.id), "shots");
    const isImg = (f: string) => /\.(png|jpe?g|webp|gif)$/i.test(f);
    let items: { path: string; caption: string }[] = [];
    if (Array.isArray(given)) {
      for (const g of given.slice(0, 12)) {
        const p = typeof g === "string" ? g : typeof g?.path === "string" ? g.path : "";
        const caption = typeof g?.caption === "string" ? g.caption.trim().slice(0, 300) : "";
        if (p) items.push({ path: path.isAbsolute(p) ? p : path.join(shotsDir, p), caption });
      }
    } else if (fs.existsSync(shotsDir)) {
      items = fs.readdirSync(shotsDir).filter(isImg).sort().slice(0, 12).map((f) => ({ path: path.join(shotsDir, f), caption: "" }));
    }
    const dest = path.join(homeDir(), "shots", t.id.replace(/[^A-Za-z0-9._-]/g, "_"));
    const out: Screenshot[] = [];
    items.forEach((it, i) => {
      try {
        if (!isImg(it.path) || !fs.statSync(it.path).isFile() || fs.statSync(it.path).size > 15 * 1024 * 1024) return;
        fs.mkdirSync(dest, { recursive: true });
        const file = `${run.id}-${i + 1}${path.extname(it.path).toLowerCase()}`;
        fs.copyFileSync(it.path, path.join(dest, file));
        out.push({ file, caption: it.caption || path.basename(it.path).replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ") });
      } catch {}
    });
    return out;
  }

  /** Path of a stored screenshot, or null if the name isn't one of ours. */
  screenshotPath(taskId: string, file: string): string | null {
    if (!/^\d+-\d+\.(png|jpe?g|webp|gif)$/i.test(file)) return null;
    const f = path.join(homeDir(), "shots", taskId.replace(/[^A-Za-z0-9._-]/g, "_"), file);
    return fs.existsSync(f) ? f : null;
  }

  private effectivePermissions(m: Mission, t: Task, p: Project): Permissions {
    const extra = t.extra_permissions;
    const checks = readSettings(p).checks;
    const uniq = (xs: string[]) => [...new Set(xs)];
    return {
      commands: uniq([...m.permissions.commands, ...(extra.commands ?? []), ...checks]),
      domains: uniq([...m.permissions.domains, ...(extra.domains ?? [])]),
      paths: uniq([...m.permissions.paths, ...(extra.paths ?? [])]),
    };
  }

  private budgetLimit(m: Mission, t: Task): number {
    return m.budget_task + t.extra_budget;
  }

  private spentIn(unit: Mission["budget_unit"], s: { tokens: number; usd: number }): number {
    return unit === "usd" ? s.usd : s.tokens;
  }

  private fmtAmount(m: Mission, v: number): string {
    return m.budget_unit === "usd" ? `$${v.toFixed(2)}` : `${Math.round(v).toLocaleString()} tokens`;
  }

  /** Start an agent process for a task. */
  launch(task: Task, role: "plan" | "work" | "verify", profileName: string, diff = ""): number | null {
    const m = getMission(this.db, task.mission_id)!;
    const p = getProject(this.db, m.project_id)!;
    const profile = resolveProfile(this.config, profileName);
    if (!profile) {
      updateTask(this.db, task.id, { status: "failed", feedback: `Unknown agent profile "${profileName}".` });
      this.notify("failed", `${task.local_id} can't start`, `Unknown profile ${profileName}`);
      this.changed(m);
      return null;
    }
    if (profile.harness === "antigravity") {
      const err = this.ensureAgyMcp();
      if (err) {
        updateTask(this.db, task.id, { status: "failed", feedback: err });
        addLog(this.db, task.id, "northern-lights", err);
        this.notify("failed", `${task.local_id} can't start`, err);
        this.changed(m);
        return null;
      }
    }
    // Budgets: refuse to start over the limit.
    const tSpent = this.spentIn(m.budget_unit, taskSpend(this.db, task.id));
    if (role !== "plan" && tSpent >= this.budgetLimit(m, task)) {
      updateTask(this.db, task.id, { status: "over_limit" });
      addLog(this.db, task.id, "northern-lights", `Over its budget (${this.fmtAmount(m, tSpent)}); not started.`);
      this.notify("over_limit", `${task.local_id} over limit`, task.title);
      this.changed(m);
      return null;
    }
    const mSpent = this.spentIn(m.budget_unit, missionSpend(this.db, m.id));
    if (mSpent >= m.budget_mission) {
      updateMission(this.db, m.id, { paused: 1 });
      this.notify("budget", `${m.id} paused: budget used up`, `${this.fmtAmount(m, mSpent)} of ${this.fmtAmount(m, m.budget_mission)}`);
      this.changed(m);
      return null;
    }

    if (role === "work") {
      let base = task.base_snapshot;
      if (!base) {
        base = takeSnapshot(p.path, p.id, task.local_id.replace(/[^A-Za-z0-9.]/g, "_"), {
          exclude: readSettings(p).snapshot_exclude,
        });
      }
      updateTask(this.db, task.id, { status: "in_progress", attempt: task.attempt + 1, base_snapshot: base });
    } else if (role === "plan") {
      updateTask(this.db, task.id, { status: "in_progress", attempt: task.attempt + 1 });
    } else {
      updateTask(this.db, task.id, { verify_tries: task.verify_tries + 1 });
    }
    const fresh = getTask(this.db, task.id)!;
    const key = crypto.randomBytes(24).toString("hex");
    const ts = now();
    const info = this.db
      .prepare(
        `insert into runs (task_id, role, profile, key, status, started_at, last_activity) values (?, ?, ?, ?, 'running', ?, ?)`,
      )
      .run(task.id, role, profileName, key, ts, ts);
    const runId = Number(info.lastInsertRowid);
    const runDir = path.join(homeDir(), "runs", String(runId));
    fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
    const viaCli = profile.harness === "custom";
    const shotsDir = path.join(runDir, "shots");
    const browser = role === "verify" && this.hasAgentBrowser() ? shotsDir : null;
    if (role === "verify") fs.mkdirSync(shotsDir, { recursive: true });
    const briefing =
      role === "plan"
        ? planBriefing(this.db, p, m, fresh, viaCli)
        : role === "verify"
          ? verifyBriefing(this.db, p, m, fresh, diff, viaCli, browser)
          : workBriefing(this.db, p, m, fresh, viaCli);
    fs.writeFileSync(path.join(runDir, "briefing.md"), briefing);
    const logPath = path.join(runDir, "output.log");
    let spec;
    try {
      spec = buildLaunch(profile, {
        role,
        cwd: p.path,
        briefing,
        runDir,
        key,
        serverUrl: this.url,
        mcpScript: MCP_SCRIPT,
        cliScript: CLI_SCRIPT,
        permissionMode: m.permission_mode,
        permissions: this.runPermissions(role, m, fresh, p),
        taskId: task.id,
      });
      // Every agent gets its own browser session (never yours); verifiers also get a folder for screenshots.
      spec.env = { ...spec.env, AGENT_BROWSER_SESSION: `nl-run-${runId}` };
      if (role === "verify") spec.env = { ...spec.env, NL_SHOTS_DIR: shotsDir, AGENT_BROWSER_SCREENSHOT_DIR: shotsDir };
    } catch (e) {
      updateRun(this.db, runId, { status: "exited", ended_at: now(), stop_reason: "launch error" });
      updateTask(this.db, task.id, { status: "failed", feedback: `Couldn't start the agent: ${(e as Error).message}` });
      addLog(this.db, task.id, "northern-lights", `Couldn't start the agent: ${(e as Error).message}`);
      this.notify("failed", `${task.local_id} couldn't start`, (e as Error).message);
      this.changed(m);
      return null;
    }
    const tracker = new UsageTracker(spec.output);
    const live: LiveRun = { handle: null, tracker, lastActivityWrite: 0 };
    this.live.set(runId, live);
    live.handle = startProcess(spec, logPath, {
      onLine: (line) => this.onRunLine(runId, line),
      onExit: (code, signal) => this.onRunExit(runId, code, signal),
    });
    updateRun(this.db, runId, { pid: live.handle.child.pid ?? null, log_path: logPath });
    const attempt = role === "verify" ? `verify try ${fresh.verify_tries}` : `attempt ${fresh.attempt}`;
    addLog(this.db, task.id, "northern-lights", `${profileName} started (${role}, ${attempt})`);
    for (const w of spec.warnings) addLog(this.db, task.id, "northern-lights", `⚠ ${w}`);
    this.changed(m, { type: "run_started", task: task.id, message: `${profileName} ${role}` });
    return runId;
  }

  private touch(runId: number) {
    const live = this.live.get(runId);
    if (!live) return;
    const t = Date.now();
    if (t - live.lastActivityWrite > 5000) {
      live.lastActivityWrite = t;
      updateRun(this.db, runId, { last_activity: now() });
    }
  }

  /** Live dollar estimate: exact from the price table if set, else a per-token rate learned from earlier runs of the model. */
  private estimateUsd(tr: UsageTracker): number | null {
    if (!tr.model) return null;
    const price = this.config.prices[tr.model];
    const b = tr.breakdown();
    if (price) {
      return (
        (b.input * price.input +
          b.output * price.output +
          b.cache_write * (price.cache_write ?? price.input * 1.25) +
          b.cache_read * (price.cache_read ?? price.input * 0.1)) /
        1_000_000
      );
    }
    const row = this.db
      .prepare("select sum(usd) usd, sum(tokens) tokens from runs where model = ? and usd_final = 1 and tokens > 0")
      .get(tr.model) as { usd: number | null; tokens: number | null };
    if (row.usd && row.tokens) return (row.usd / row.tokens) * tr.tokens;
    return null;
  }

  private onRunLine(runId: number, line: string) {
    this.touch(runId);
    const live = this.live.get(runId);
    if (!live?.tracker || !live.tracker.feed(line)) return;
    const tr = live.tracker;
    const usd = tr.usdFinal ?? this.estimateUsd(tr) ?? 0;
    updateRun(this.db, runId, {
      tokens: tr.tokens,
      usd,
      usd_final: tr.usdFinal !== null ? 1 : 0,
      model: tr.model,
    });
    this.checkBudgets(runId);
  }

  private checkBudgets(runId: number) {
    const run = getRun(this.db, runId)!;
    const t = getTask(this.db, run.task_id)!;
    const m = getMission(this.db, t.mission_id)!;
    const tSpent = this.spentIn(m.budget_unit, taskSpend(this.db, t.id));
    const limit = this.budgetLimit(m, t);
    const mSpent = this.spentIn(m.budget_unit, missionSpend(this.db, m.id));
    const warned = { ...m.warned };
    let warnedChanged = false;
    if (tSpent >= limit && run.role !== "plan") {
      this.live.get(runId)?.handle?.kill("budget");
    } else if (tSpent >= 0.8 * limit && !warned[`task:${t.id}:${limit}`] && run.role !== "plan") {
      warned[`task:${t.id}:${limit}`] = true;
      warnedChanged = true;
      this.notify("budget", `${t.local_id} at 80% of its budget`, `${this.fmtAmount(m, tSpent)} of ${this.fmtAmount(m, limit)}`);
    }
    if (mSpent >= m.budget_mission && !m.paused) {
      updateMission(this.db, m.id, { paused: 1 });
      this.notify("budget", `${m.id} paused: budget used up`, `${this.fmtAmount(m, mSpent)} of ${this.fmtAmount(m, m.budget_mission)}`);
      this.changed(m);
    } else if (mSpent >= 0.8 * m.budget_mission && !warned[`mission:${m.budget_mission}`]) {
      warned[`mission:${m.budget_mission}`] = true;
      warnedChanged = true;
      this.notify("budget", `${m.id} at 80% of its budget`, `${this.fmtAmount(m, mSpent)} of ${this.fmtAmount(m, m.budget_mission)}`);
    }
    if (warnedChanged) updateMission(this.db, m.id, { warned });
  }

  private onRunExit(runId: number, code: number | null, signal: string | null) {
    const live = this.live.get(runId);
    this.live.delete(runId);
    // Stop anything the agent left running (dev servers, watchers) and close its browser session.
    killTree(live?.handle?.child.pid);
    if (this.hasAgentBrowser()) {
      const ab = commandFor("agent-browser");
      const c = spawn(ab.file, ["--session", `nl-run-${runId}`, "close"], { stdio: "ignore", detached: !IS_WIN, windowsHide: true, shell: ab.shell });
      c.on("error", () => {});
      c.unref();
    }
    const stop = live?.handle?.stopReason ?? null;
    const tr = live?.tracker;
    if (tr && tr.usdFinal !== null) updateRun(this.db, runId, { usd: tr.usdFinal, usd_final: 1 });
    updateRun(this.db, runId, {
      status: stop && stop !== "ended" ? "killed" : "exited",
      ended_at: now(),
      stop_reason: stop ?? (code === 0 ? null : `exit ${code ?? signal}`),
    });
    this.finishRun(runId, stop, code, signal);
  }

  /** Decide what happens to the task after its run ends. */
  private finishRun(runId: number, stop: string | null, code: number | null, signal: string | null) {
    const run = getRun(this.db, runId)!;
    const t = getTask(this.db, run.task_id)!;
    const m = getMission(this.db, t.mission_id)!;
    const p = getProject(this.db, m.project_id)!;
    const tail = run.log_path ? tailOf(run.log_path, 1500) : "";
    const actor = "northern-lights";

    if (run.role === "plan" || run.role === "work") {
      if (t.status === "in_progress") {
        if (stop === "budget" || stop === "time") {
          updateTask(this.db, t.id, { status: "over_limit" });
          addLog(this.db, t.id, actor, stop === "time" ? `Stopped: hit the ${m.time_limit_min}-minute time limit.` : "Stopped: hit its budget.");
          this.notify("over_limit", `${t.local_id} over limit`, t.title);
        } else if (stop === "stopped") {
          updateTask(this.db, t.id, { status: "ready" });
          addLog(this.db, t.id, actor, "Stopped by you; back to Ready.");
        } else {
          const failures = t.failures + 1;
          const why = stop === "hung" ? `no activity for ${this.config.heartbeat_min} minutes` : `exited (${code ?? signal}) without submitting`;
          const feedback = `The previous run ${why}. Last output:\n${tail}`;
          const status: TaskStatus = failures >= 3 ? "stuck" : "ready";
          updateTask(this.db, t.id, { status, failures, feedback });
          addLog(this.db, t.id, actor, `Run ${why}.${status === "stuck" ? " Stuck after 3 failed attempts." : ""}`);
          if (status === "stuck") this.notify("stuck", `${t.local_id} stuck`, t.title);
        }
      }
    } else if (run.role === "verify") {
      // Tamper check: the verifier must not change files.
      if (t.submit_snapshot && fs.existsSync(t.submit_snapshot)) {
        const settings = readSettings(p);
        const changes = changedFiles(t.submit_snapshot, p.path, settings.snapshot_exclude);
        if (changes.length) {
          restoreSnapshot(t.submit_snapshot, p.path, p.id, { exclude: settings.snapshot_exclude });
          updateTask(this.db, t.id, { pending_verdict: null });
          addLog(this.db, t.id, actor, `Verifier changed ${changes.length} file(s) (${changes.map((c) => c.file).slice(0, 5).join(", ")}); changes undone and its verdict thrown out.`);
        }
      }
      const fresh = getTask(this.db, t.id)!;
      if (stop === "budget" || stop === "time") {
        updateTask(this.db, t.id, { status: "over_limit" });
        addLog(this.db, t.id, actor, "Verifier stopped: over limit.");
        this.notify("over_limit", `${t.local_id} over limit (verifying)`, t.title);
      } else if (stop === "stopped") {
        addLog(this.db, t.id, actor, "Verifier stopped by you; verification restarts when you resume.");
      } else if (fresh.pending_verdict) {
        this.applyVerdict(fresh);
      } else if (fresh.status === "verifying") {
        if (fresh.verify_tries >= 3) {
          updateTask(this.db, t.id, { status: "stuck", feedback: "The verifier finished 3 times without giving a verdict." });
          this.notify("stuck", `${t.local_id} stuck`, "Verifier gave no verdict");
        } else {
          addLog(this.db, t.id, actor, "Verifier ended without a verdict; trying again.");
        }
      }
    }
    if (run.role !== "verify" && t.status === "verifying") {
      // Worker submitted: tick() starts checks now that the process has exited.
    }
    this.changed(m, { type: "run_ended", task: t.id, message: stop ?? `exit ${code}` });
    setImmediate(() => this.tick());
  }

  /** Every 15 s: stop runs that hit the time limit or went silent. */
  watchdog() {
    for (const [runId, live] of this.live) {
      const run = getRun(this.db, runId);
      if (!run) continue;
      const t = getTask(this.db, run.task_id)!;
      const m = getMission(this.db, t.mission_id)!;
      const age = (Date.now() - Date.parse(run.started_at)) / 60000;
      const idle = (Date.now() - Date.parse(run.last_activity)) / 60000;
      if (age > m.time_limit_min) live.handle ? live.handle.kill("time") : this.endPullRun(runId, "time");
      else if (idle > this.config.heartbeat_min) live.handle ? live.handle.kill("hung") : this.endPullRun(runId, "hung");
    }
  }

  // ───────────────────────────── verification ─────────────────────────────

  private async runChecks(p: Project, taskId: string): Promise<{ command: string; ok: boolean; output: string }[]> {
    const checks = readSettings(p).checks;
    const out: { command: string; ok: boolean; output: string }[] = [];
    const pids = new Set<number>();
    this.checking.set(taskId, pids);
    try {
      for (const command of checks) {
        const r = await new Promise<{ ok: boolean; output: string }>((resolve) => {
          const sh = shellCommand(command);
          const child = spawn(sh.file, sh.args, { ...treeSpawnOptions(), cwd: p.path, env: { ...process.env, CI: "1" } });
          if (child.pid) pids.add(child.pid);
          let buf = "";
          const add = (c: Buffer) => {
            buf += c.toString("utf8");
            if (buf.length > 200_000) buf = buf.slice(-100_000);
          };
          child.stdout?.on("data", add);
          child.stderr?.on("data", add);
          const timer = setTimeout(() => {
            buf += `\n[timed out after ${this.config.check_timeout_min} min]`;
            killTree(child.pid);
          }, this.config.check_timeout_min * 60000);
          child.on("error", (e) => {
            clearTimeout(timer);
            resolve({ ok: false, output: e.message });
          });
          child.on("exit", (code) => {
            clearTimeout(timer);
            if (child.pid) pids.delete(child.pid);
            resolve({ ok: code === 0, output: buf.slice(-6000) });
          });
        });
        out.push({ command, ...r });
        if (!r.ok) break;
      }
    } finally {
      this.checking.delete(taskId);
    }
    return out;
  }

  /** Checks, then the verifier agent. Runs when a task is Verifying and nothing is running for it. */
  async runVerification(taskId: string) {
    let t = getTask(this.db, taskId)!;
    const m = getMission(this.db, t.mission_id)!;
    const p = getProject(this.db, m.project_id)!;
    const settings = readSettings(p);
    this.checking.set(taskId, new Set());
    addLog(this.db, t.id, "northern-lights", settings.checks.length ? `Running checks: ${settings.checks.join(" · ")}` : "No checks configured.");
    this.changed(m);
    const checks = await this.runChecks(p, taskId);
    t = getTask(this.db, taskId)!;
    if (t.status !== "verifying") return; // stopped or changed meanwhile
    const verification = { ...t.verification, checks };
    if (t.kind === "work" && t.base_snapshot) {
      const changes = changedFiles(t.base_snapshot, p.path, settings.snapshot_exclude);
      const changedSet = new Set(changes.map((c) => c.file));
      const listed = new Set((t.result?.files ?? []).map((f) => path.normalize(f).replace(/^\.\//, "")));
      verification.files_changed = [...changedSet];
      verification.files_mismatch = {
        unlisted: [...changedSet].filter((f) => !listed.has(f)),
        listed_but_unchanged: [...listed].filter((f) => !changedSet.has(f)),
      };
    }
    updateTask(this.db, t.id, { verification });
    const failed = checks.find((c) => !c.ok);
    if (failed && t.kind === "work") {
      const failures = t.failures + 1;
      const status: TaskStatus = failures >= 3 ? "stuck" : "ready";
      updateTask(this.db, t.id, {
        status,
        failures,
        feedback: `Automated check failed: \`${failed.command}\`\n${failed.output}`,
      });
      addLog(this.db, t.id, "northern-lights", `Check failed: ${failed.command}.${status === "stuck" ? " Stuck after 3 failures." : " Back to the agent."}`);
      if (status === "stuck") this.notify("stuck", `${t.local_id} stuck`, `Check failed 3 times: ${failed.command}`);
      this.changed(m);
      setImmediate(() => this.tick());
      return;
    }
    addLog(this.db, t.id, "northern-lights", checks.length ? "Checks passed." : "No checks; going to the verifier.");
    // Snapshot at submit so we can detect (and undo) any change the verifier makes.
    deleteSnapshot(t.submit_snapshot);
    const submitSnap = takeSnapshot(p.path, p.id, `${t.local_id}-submit`, { exclude: settings.snapshot_exclude });
    updateTask(this.db, t.id, { submit_snapshot: submitSnap });
    const diff = t.base_snapshot ? diffText(t.base_snapshot, p.path, settings.snapshot_exclude) : "";
    let profile = m.verifier_profile;
    if (t.kind === "work") {
      const lastWorker = this.db
        .prepare("select profile from runs where task_id = ? and role = 'work' order by id desc limit 1")
        .get(t.id) as { profile: string } | undefined;
      if (lastWorker?.profile === profile) {
        // A second opinion from a different model, but never from a different harness than you chose.
        const harness = resolveProfile(this.config, profile)?.harness;
        const alt = Object.keys(this.config.profiles).find(
          (k) => k !== profile && this.config.profiles[k].harness === harness && k !== m.worker_profile && this.profileUsable(k),
        );
        if (alt) profile = alt;
      }
    }
    this.launch(getTask(this.db, t.id)!, "verify", profile, diff);
  }

  private profileUsable(name: string): boolean {
    const prof = resolveProfile(this.config, name);
    if (!prof) return false;
    const bin = prof.harness === "custom" ? prof.command?.[0] : HARNESS_BIN[prof.harness];
    if (!bin) return false;
    return hasCommand(bin);
  }

  /**
   * Antigravity reads MCP servers from one global file, so register Northern Lights there once.
   * The entry is harmless in normal agy sessions: without a run key it offers no tools.
   */
  private ensureAgyMcp(): string | null {
    const file = path.join(process.env.HOME ?? "", ".gemini", "config", "mcp_config.json");
    try {
      const cur = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")).mcpServers?.["northern-lights"] : null;
      const envOk = !NODE_ENV.ELECTRON_RUN_AS_NODE || cur?.env?.ELECTRON_RUN_AS_NODE === "1";
      if (cur && cur.command === process.execPath && cur.args?.[0] === MCP_SCRIPT && !cur.disabled && envOk) return null;
    } catch {}
    const envArgs = NODE_ENV.ELECTRON_RUN_AS_NODE ? ["--env", "ELECTRON_RUN_AS_NODE=1"] : [];
    const agy = commandFor("agy");
    const r = spawnSync(agy.file, ["mcp", "add", ...envArgs, "northern-lights", process.execPath, MCP_SCRIPT], { encoding: "utf8", timeout: 30_000, shell: agy.shell, windowsHide: true });
    if (r.status !== 0) return `Couldn't register Northern Lights with Antigravity (agy mcp add): ${(r.stderr || r.stdout || r.error?.message || "").trim()}`;
    return null;
  }

  private harnessCache: { at: number; data: unknown } | null = null;

  /** Which agent CLIs are installed and which models they offer (for the app's pickers). */
  harnesses() {
    if (this.harnessCache && Date.now() - this.harnessCache.at < 10 * 60_000) return this.harnessCache.data;
    const has = hasCommand;
    const out: Record<string, { label: string; installed: boolean; models: { id: string; label: string }[]; unit: "usd" | "tokens" }> = {};
    out.claude = {
      label: HARNESS_LABEL.claude,
      installed: has("claude"),
      unit: "usd",
      models: [
        { id: "opus", label: "Opus" },
        { id: "sonnet", label: "Sonnet" },
        { id: "haiku", label: "Haiku" },
      ],
    };
    const agy = has("agy");
    let agyModels: { id: string; label: string }[] = [];
    if (agy) {
      const agy = commandFor("agy");
      const r = spawnSync(agy.file, ["models"], { encoding: "utf8", timeout: 20_000, shell: agy.shell, windowsHide: true });
      for (const line of (r.stdout || "").split("\n")) {
        const m = /^(\S+)\t(.+)$/.exec(line.trim());
        if (m) agyModels.push({ id: m[1], label: m[2].trim() });
      }
    }
    out.antigravity = { label: HARNESS_LABEL.antigravity, installed: agy, unit: "tokens", models: agyModels };
    out.codex = { label: HARNESS_LABEL.codex, installed: has("codex"), unit: "usd", models: [] };
    const data = { harnesses: out, profiles: this.config.profiles, defaults: this.config.defaults };
    this.harnessCache = { at: Date.now(), data };
    return data;
  }

  /**
   * Turn a rough idea into a mission title, a testable goal and "done when" checks.
   * Runs the chosen harness read-only in the project folder (it may read code, never change it).
   */
  async sharpen(input: { project?: string; idea?: string; harness?: string; model?: string }) {
    const p = getProject(this.db, String(input.project ?? ""));
    if (!p) throw new UserError("Pick a project first.");
    const idea = String(input.idea ?? "").trim();
    if (idea.length < 3) throw new UserError("Write a rough idea first, even one sentence.");
    const harness = input.harness === "antigravity" ? "antigravity" : input.harness === "claude" || !input.harness ? "claude" : null;
    if (!harness) throw new UserError("Sharpen works with Claude Code or Antigravity.");
    const prompt = `You help a developer write a mission for AI coding agents that will work in this project folder.
Look at the project briefly (README, package/config files, the main entry points) to understand what it is. Do not change any files and do not run commands.

The developer's rough idea:
"""
${idea.slice(0, 4000)}
"""

Reply with ONLY a JSON object, no prose and no code fence:
{"title": "short imperative title, under 60 characters",
 "goal": "1-3 sentences describing the end state in terms a user would notice, specific to this project",
 "done_when": ["3 to 6 concrete, testable checks: a command and its expected result, a behaviour you can see, a file that must exist"],
 "questions": ["at most 2 short questions, only if something important is genuinely ambiguous; otherwise []"]}
Stay within what the developer asked for. Don't add features they didn't mention. Mention real file names, commands and URLs from this project where you can.`;
    let cmd: string;
    let args: string[];
    let stdin = "";
    if (harness === "claude") {
      cmd = "claude";
      args = ["-p", "--output-format", "json", "--model", input.model || "sonnet", "--no-session-persistence", "--strict-mcp-config",
        "--allowedTools", "Read", "Glob", "Grep", "LS", "--disallowedTools", "Edit", "Write", "MultiEdit", "NotebookEdit", "Bash", "WebFetch", "WebSearch"];
      stdin = prompt;
    } else {
      cmd = "agy";
      args = ["--output-format", "json", "--model", input.model || "gemini-3.8-flash-high", `-p=${prompt}`];
    }
    const { stdout, stderr, code } = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve) => {
      const c = commandFor(cmd);
      const child = spawn(c.file, args, { cwd: p.path, env: process.env, stdio: ["pipe", "pipe", "pipe"], shell: c.shell, windowsHide: true });
      let out = "";
      let err = "";
      const timer = setTimeout(() => child.kill("SIGTERM"), 150_000);
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("error", (e) => {
        clearTimeout(timer);
        resolve({ stdout: "", stderr: e.message, code: -1 });
      });
      child.on("close", (c) => {
        clearTimeout(timer);
        resolve({ stdout: out, stderr: err, code: c });
      });
      child.stdin.on("error", () => {});
      child.stdin.end(stdin);
    });
    let meta: any = null;
    for (const line of [stdout.trim(), ...stdout.trim().split("\n").reverse()]) {
      try {
        meta = JSON.parse(line);
        break;
      } catch {}
    }
    const text: string = typeof meta?.result === "string" ? meta.result : typeof meta?.response === "string" ? meta.response : meta?.result?.response ?? stdout;
    const a = text.indexOf("{");
    const b = text.lastIndexOf("}");
    let draft: any = null;
    try {
      draft = a >= 0 && b > a ? JSON.parse(text.slice(a, b + 1)) : null;
    } catch {}
    if (!draft || typeof draft.goal !== "string") {
      throw new UserError(`The agent didn't return a usable draft${code ? ` (exit ${code})` : ""}. ${(stderr || text).trim().slice(0, 300)}`);
    }
    const u = meta?.usage ?? meta?.result?.usage ?? {};
    const tokens = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.thinking_tokens ?? 0);
    const list = (v: unknown) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()).map((x: string) => x.trim()) : []);
    return {
      title: String(draft.title ?? "").trim().slice(0, 80),
      goal: String(draft.goal).trim(),
      done_when: list(draft.done_when).slice(0, 8),
      questions: list(draft.questions).slice(0, 3),
      tokens,
      usd: typeof meta?.total_cost_usd === "number" ? meta.total_cost_usd : 0,
      agent: `${harness}:${input.model || (harness === "claude" ? "sonnet" : "gemini-3.8-flash-high")}`,
    };
  }

  /** Token and dollar totals: today, last 7 days, all time, by day, by model and by mission. */
  usage() {
    const day = (d: Date) => d.toISOString().slice(0, 10);
    const now = new Date();
    const rows = this.db
      .prepare(
        `select r.started_at, r.model, r.profile, r.tokens, r.usd, t.mission_id from runs r join tasks t on t.id = r.task_id`,
      )
      .all() as { started_at: string; model: string | null; profile: string; tokens: number; usd: number; mission_id: string }[];
    const zero = () => ({ tokens: 0, usd: 0, runs: 0 });
    const add = (a: { tokens: number; usd: number; runs: number }, r: { tokens: number; usd: number }) => {
      a.tokens += r.tokens;
      a.usd += r.usd;
      a.runs++;
    };
    const today = zero();
    const week = zero();
    const all = zero();
    const byDay = new Map<string, ReturnType<typeof zero>>();
    for (let i = 13; i >= 0; i--) byDay.set(day(new Date(now.getTime() - i * 86_400_000)), zero());
    const byModel = new Map<string, ReturnType<typeof zero> & { harness: string }>();
    const byMission = new Map<string, ReturnType<typeof zero>>();
    const todayKey = day(now);
    const weekAgo = now.getTime() - 7 * 86_400_000;
    for (const r of rows) {
      add(all, r);
      const d = r.started_at.slice(0, 10);
      if (d === todayKey) add(today, r);
      if (new Date(r.started_at).getTime() >= weekAgo) add(week, r);
      if (byDay.has(d)) add(byDay.get(d)!, r);
      const prof = resolveProfile(this.config, r.profile);
      const key = r.model || prof?.model || r.profile;
      if (!byModel.has(key)) byModel.set(key, { ...zero(), harness: HARNESS_LABEL[prof?.harness ?? "custom"] ?? "Custom" });
      add(byModel.get(key)!, r);
      if (!byMission.has(r.mission_id)) byMission.set(r.mission_id, zero());
      add(byMission.get(r.mission_id)!, r);
    }
    const missions = listMissions(this.db);
    return {
      today,
      week,
      all,
      by_day: [...byDay].map(([d, v]) => ({ day: d, ...v })),
      by_model: [...byModel].map(([model, v]) => ({ model, ...v })).sort((a, b) => b.tokens - a.tokens),
      by_mission: [...byMission]
        .map(([id, v]) => {
          const m = missions.find((x) => x.id === id);
          return { id, title: m?.title ?? id, project: m?.project_id ?? "", ...v };
        })
        .sort((a, b) => b.tokens - a.tokens),
    };
  }

  private applyVerdict(t: Task) {
    const v = t.pending_verdict!;
    const m = getMission(this.db, t.mission_id)!;
    const verdicts = [...(t.verification.verdicts ?? []), { attempt: t.attempt, profile: v.profile, pass: v.pass, criteria: v.criteria, feedback: v.feedback, screenshots: v.screenshots }];
    updateTask(this.db, t.id, { pending_verdict: null, verification: { ...t.verification, verdicts } });
    deleteSnapshot(t.submit_snapshot);
    updateTask(this.db, t.id, { submit_snapshot: null });
    const actor = "northern-lights";
    if (t.kind === "mission_verify") {
      if (v.overview_updates) updateMission(this.db, m.id, { overview_proposal: v.overview_updates });
      if (v.pass) {
        updateTask(this.db, t.id, { status: "done" });
        updateMission(this.db, m.id, { status: "final_review" });
        addLog(this.db, t.id, actor, "Final check passed. Waiting for your approval.");
        this.notify("final_review", `${m.id} ready for your final approval`, m.title);
      } else if (v.fix_tasks?.length) {
        const problems = validatePlan(v.fix_tasks, new Set(listTasks(this.db, m.id).map((x) => x.local_id)));
        updateTask(this.db, t.id, { status: "cancelled" });
        if (problems.length) {
          updateMission(this.db, m.id, { status: "final_review" });
          addLog(this.db, t.id, actor, `Final check failed and its fix tasks were invalid (${problems.join("; ")}).`);
          this.notify("final_review", `${m.id} final check failed`, "Fix tasks were invalid; see the mission");
        } else {
          updateMission(this.db, m.id, { status: "awaiting_approval", pending_plan: { source: "fix", tasks: v.fix_tasks, reason: v.feedback } });
          addLog(this.db, t.id, actor, `Final check failed; ${v.fix_tasks.length} fix task(s) proposed for your approval.`);
          this.notify("plan", `${m.id}: fix tasks to approve`, v.feedback ?? m.title);
        }
      } else {
        updateTask(this.db, t.id, { status: "stuck", feedback: v.feedback ?? "Final check failed." });
        this.notify("stuck", `${m.id} final check failed`, v.feedback ?? m.title);
      }
      this.changed(m);
      return;
    }
    if (v.pass) {
      if (m.review_mode === "every") {
        updateTask(this.db, t.id, { status: "in_review" });
        addLog(this.db, t.id, actor, "Verified. Waiting for your review.");
        this.notify("review", `Review ${t.id}`, t.title);
      } else {
        addLog(this.db, t.id, actor, "Verified; auto-accepted.");
        this.acceptTask(t.id, "auto-accept");
      }
    } else {
      const failures = t.failures + 1;
      const failedCriteria = v.criteria.filter((c) => !c.met).map((c) => `- ${c.criterion}: ${c.evidence}`).join("\n");
      const feedback = `The verifier failed your work.\n${v.feedback ?? ""}\n${failedCriteria}`.trim();
      const status: TaskStatus = failures >= 3 ? "stuck" : "ready";
      updateTask(this.db, t.id, { status, failures, feedback });
      addLog(this.db, t.id, actor, `Verification failed.${status === "stuck" ? " Stuck after 3 failures." : " Back to the agent."}`);
      if (status === "stuck") this.notify("stuck", `${t.local_id} stuck`, t.title);
    }
    this.changed(m);
  }

  // ───────────────────────────── your actions ─────────────────────────────

  private mustTask(id: string, mission?: string): Task {
    let t = getTask(this.db, id);
    if (!t && mission) t = getTask(this.db, `${mission}:${id}`);
    if (!t) {
      // Accept a bare local id if it's unique across active missions.
      const rows = this.db.prepare("select id from tasks where local_id = ? collate nocase").all(id) as { id: string }[];
      if (rows.length === 1) t = getTask(this.db, rows[0].id);
      else if (rows.length > 1) throw new UserError(`"${id}" exists in several missions; use e.g. ${rows[0].id}`);
    }
    if (!t) throw new UserError(`No task "${id}".`);
    return t;
  }

  private mustMission(id: string): Mission {
    const m = getMission(this.db, id);
    if (!m) throw new UserError(`No mission "${id}".`);
    return m;
  }

  private expect(t: Task, statuses: TaskStatus[], action: string) {
    if (!statuses.includes(t.status)) {
      throw new UserError(`Can't ${action} ${t.id}: it is ${t.status.replace(/_/g, " ")} (needs ${statuses.join(" / ")}).`);
    }
  }

  planView(missionId: string) {
    const m = this.mustMission(missionId);
    const p = getProject(this.db, m.project_id)!;
    return {
      mission: m,
      plan: m.pending_plan,
      tree: m.pending_plan ? renderPlanTree(m.pending_plan.tasks) : null,
      overview_exists: !!readOverview(p),
    };
  }

  approvePlan(missionId: string) {
    const m = this.mustMission(missionId);
    if (m.status !== "awaiting_approval" || !m.pending_plan) throw new UserError(`${m.id} has no plan waiting for approval.`);
    const plan = m.pending_plan;
    const problems = validatePlan(plan.tasks, new Set(listTasks(this.db, m.id).map((t) => t.local_id)));
    if (problems.length) throw new UserError(`The plan has problems:\n- ${problems.join("\n- ")}`);
    const p = getProject(this.db, m.project_id)!;
    tx(this.db, () => {
      applyPlan(this.db, m, plan);
      const perms = plan.permissions;
      if (perms) {
        const merged: Permissions = {
          commands: [...new Set([...m.permissions.commands, ...(perms.commands ?? [])])],
          domains: [...new Set([...m.permissions.domains, ...(perms.domains ?? [])])],
          paths: [...new Set([...m.permissions.paths, ...(perms.paths ?? [])])],
        };
        updateMission(this.db, m.id, { permissions: merged });
      }
      updateMission(this.db, m.id, { pending_plan: null, plan_feedback: null, status: "running" });
    });
    if (plan.overview) writeOverview(p, plan.overview);
    if (plan.source === "split" && plan.split_of) {
      addLog(this.db, `${m.id}:${plan.split_of}`, "you", "Split approved; this task is now a parent.");
    }
    this.refresh(getMission(this.db, m.id)!);
    this.changed(m.id, { type: "plan_approved" });
    setImmediate(() => this.tick());
  }

  rejectPlan(missionId: string, feedback: string) {
    const m = this.mustMission(missionId);
    if (m.status !== "awaiting_approval" || !m.pending_plan) throw new UserError(`${m.id} has no plan waiting for approval.`);
    const src = m.pending_plan.source;
    if (src === "plan") {
      updateMission(this.db, m.id, { pending_plan: null, plan_feedback: feedback, status: "planning" });
      this.newPlanTask(getMission(this.db, m.id)!);
    } else if (src === "split") {
      const t = getTask(this.db, `${m.id}:${m.pending_plan.split_of}`)!;
      updateTask(this.db, t.id, { status: "ready", feedback: `Your split was rejected: ${feedback}\nDo the task as one.` });
      updateMission(this.db, m.id, { pending_plan: null, status: "running" });
    } else {
      updateMission(this.db, m.id, { pending_plan: null, status: "final_review" });
    }
    this.changed(m.id, { type: "plan_rejected" });
    setImmediate(() => this.tick());
  }

  editPlan(missionId: string, plan: { tasks: PlanTaskInput[]; permissions?: Permissions; overview?: string }) {
    const m = this.mustMission(missionId);
    if (!m.pending_plan) throw new UserError(`${m.id} has no plan waiting for approval.`);
    const problems = validatePlan(plan.tasks, new Set(listTasks(this.db, m.id).map((t) => t.local_id)));
    if (problems.length) throw new UserError(`The edited plan has problems:\n- ${problems.join("\n- ")}`);
    const next: PendingPlan = { ...m.pending_plan, tasks: plan.tasks };
    if (plan.permissions) next.permissions = plan.permissions;
    if (plan.overview !== undefined) next.overview = plan.overview;
    updateMission(this.db, m.id, { pending_plan: next });
    this.changed(m.id);
  }

  acceptTask(taskId: string, by = "you") {
    const t = this.mustTask(taskId);
    if (by === "you") this.expect(t, ["in_review"], "accept");
    const m = getMission(this.db, t.mission_id)!;
    const p = getProject(this.db, m.project_id)!;
    // Keep the diff as it was when accepted; later tasks change the folder.
    if (t.base_snapshot && fs.existsSync(t.base_snapshot)) {
      try {
        fs.mkdirSync(path.join(homeDir(), "diffs"), { recursive: true });
        fs.writeFileSync(this.diffFile(t.id), diffText(t.base_snapshot, p.path, readSettings(p).snapshot_exclude));
      } catch {}
    }
    updateTask(this.db, t.id, { status: "done", feedback: null });
    addLog(this.db, t.id, by, "Accepted.");
    const dec = t.result?.decisions?.trim();
    if (dec && !/^(none|n\/a|-)$/i.test(dec)) appendDecision(p, dec, `${t.local_id} ${t.title}`);
    this.refresh(getMission(this.db, m.id)!);
    this.changed(m, { type: "task_accepted", task: t.id });
    setImmediate(() => this.tick());
  }

  sendBack(taskId: string, feedback: string) {
    const t = this.mustTask(taskId);
    this.expect(t, ["in_review", "stuck", "failed", "over_limit"], "send back");
    updateTask(this.db, t.id, { status: "ready", failures: 0, feedback: `Feedback from the human:\n${feedback}` });
    addLog(this.db, t.id, "you", `Sent back: ${feedback}`);
    this.changed(t.mission_id);
    setImmediate(() => this.tick());
  }

  discard(taskId: string, cancel = false) {
    const t = this.mustTask(taskId);
    this.expect(t, ["in_review", "stuck", "failed", "over_limit", "waiting", "ready", "needs_split"], "discard");
    if (this.taskActive(t.id)) throw new UserError(`${t.id} is running; stop it first.`);
    const m = getMission(this.db, t.mission_id)!;
    const p = getProject(this.db, m.project_id)!;
    let safety = "";
    if (t.base_snapshot && fs.existsSync(t.base_snapshot)) {
      safety = restoreSnapshot(t.base_snapshot, p.path, p.id, { exclude: readSettings(p).snapshot_exclude });
    }
    this.db.prepare("update questions set answer = '(discarded)', answered_at = ? where task_id = ? and answer is null").run(now(), t.id);
    updateTask(this.db, t.id, {
      status: cancel ? "cancelled" : "ready",
      failures: 0,
      feedback: null,
      result: null,
      verification: {},
      extra_permissions: {},
    });
    addLog(this.db, t.id, "you", `Discarded: folder restored to before this task${safety ? ` (undo with: northern-lights undo-discard ${t.id})` : ""}.${cancel ? " Task cancelled." : " Task will start over."}`);
    if (safety) this.db.prepare("insert into worklog(task_id, ts, actor, text) values (?, ?, 'snapshot', ?)").run(t.id, now(), safety);
    if (m.pending_plan?.source === "split" && m.pending_plan.split_of === t.local_id) {
      updateMission(this.db, m.id, { pending_plan: null, status: "running" });
    }
    this.refresh(getMission(this.db, m.id)!);
    this.changed(m);
    setImmediate(() => this.tick());
    return { safety };
  }

  /** Put the folder back the way it was right before the last discard of this task. */
  undoDiscard(taskId: string) {
    const t = this.mustTask(taskId);
    const row = this.db
      .prepare("select text from worklog where task_id = ? and actor = 'snapshot' order by id desc limit 1")
      .get(t.id) as { text: string } | undefined;
    if (!row || !fs.existsSync(row.text)) throw new UserError(`No discard to undo for ${t.id}.`);
    const m = getMission(this.db, t.mission_id)!;
    const p = getProject(this.db, m.project_id)!;
    if (this.busyTask(p.id) && this.busyTask(p.id)!.id !== t.id) throw new UserError(`${p.id} is busy; finish or stop the current task first.`);
    restoreSnapshot(row.text, p.path, p.id, { exclude: readSettings(p).snapshot_exclude });
    addLog(this.db, t.id, "you", "Undid the discard: folder restored to how it was before it.");
    this.changed(m);
  }

  retry(taskId: string, note?: string) {
    const t = this.mustTask(taskId);
    this.expect(t, ["stuck", "failed", "over_limit"], "retry");
    const feedback = [t.feedback, note ? `Guidance from the human: ${note}` : ""].filter(Boolean).join("\n\n");
    updateTask(this.db, t.id, {
      status: t.kind === "mission_verify" ? "verifying" : "ready",
      failures: 0,
      verify_tries: 0,
      feedback,
    });
    addLog(this.db, t.id, "you", `Retry${note ? `: ${note}` : ""}`);
    if (t.kind === "plan") updateMission(this.db, t.mission_id, { status: "planning" });
    this.changed(t.mission_id);
    setImmediate(() => this.tick());
  }

  cancelTask(taskId: string) {
    const t = this.mustTask(taskId);
    if (this.taskActive(t.id)) throw new UserError(`${t.id} is running; stop it first.`);
    if (t.status === "done") throw new UserError(`${t.id} is already done.`);
    updateTask(this.db, t.id, { status: "cancelled" });
    addLog(this.db, t.id, "you", "Cancelled. Its changes (if any) stay in the folder; tasks that depend on it go ahead.");
    this.refresh(getMission(this.db, t.mission_id)!);
    this.changed(t.mission_id);
    setImmediate(() => this.tick());
  }

  raiseLimit(taskId: string, amount: number) {
    const t = this.mustTask(taskId);
    if (!(amount > 0)) throw new UserError("Give a positive amount to add to the task's budget.");
    updateTask(this.db, t.id, { extra_budget: t.extra_budget + amount });
    const m = getMission(this.db, t.mission_id)!;
    addLog(this.db, t.id, "you", `Raised the task budget by ${this.fmtAmount(m, amount)}.`);
    if (t.status === "over_limit") {
      const wasVerifying = this.db.prepare("select role from runs where task_id = ? order by id desc limit 1").get(t.id) as { role: string } | undefined;
      updateTask(this.db, t.id, { status: wasVerifying?.role === "verify" ? "verifying" : "ready", failures: 0 });
    }
    this.changed(m);
    setImmediate(() => this.tick());
  }

  raiseMissionBudget(missionId: string, amount: number) {
    const m = this.mustMission(missionId);
    if (!(amount > 0)) throw new UserError("Give a positive amount.");
    updateMission(this.db, m.id, { budget_mission: m.budget_mission + amount });
    this.changed(m.id);
  }

  answer(taskId: string, text: string) {
    const t = this.mustTask(taskId);
    const q = openQuestions(this.db, t.id).find((x) => x.kind === "question");
    if (!q) throw new UserError(`${t.id} has no open question.`);
    const body = JSON.parse(q.body) as { question: string };
    this.db.prepare("update questions set answer = ?, answered_at = ? where id = ?").run(text, now(), q.id);
    updateTask(this.db, t.id, {
      status: "ready",
      feedback: [t.feedback, `You asked: ${body.question}\nThe human answered: ${text}`].filter(Boolean).join("\n\n"),
    });
    addLog(this.db, t.id, "you", `Answered: ${text}`);
    if (t.kind === "plan") updateMission(this.db, t.mission_id, { status: "planning" });
    this.changed(t.mission_id);
    setImmediate(() => this.tick());
  }

  permit(taskId: string, decision: "once" | "mission" | "deny") {
    const t = this.mustTask(taskId);
    const q = openQuestions(this.db, t.id).find((x) => x.kind === "permission");
    if (!q) throw new UserError(`${t.id} has no open permission request.`);
    const req = JSON.parse(q.body) as { kind: "command" | "domain" | "path"; value: string; reason: string };
    const field = req.kind === "command" ? "commands" : req.kind === "domain" ? "domains" : "paths";
    const m = getMission(this.db, t.mission_id)!;
    if (decision === "once") {
      const extra = { ...t.extra_permissions };
      extra[field] = [...(extra[field] ?? []), req.value];
      updateTask(this.db, t.id, { extra_permissions: extra });
    } else if (decision === "mission") {
      const perms = { ...m.permissions, [field]: [...new Set([...m.permissions[field], req.value])] };
      updateMission(this.db, m.id, { permissions: perms });
    }
    this.db.prepare("update questions set answer = ?, answered_at = ? where id = ?").run(decision, now(), q.id);
    const fb =
      decision === "deny"
        ? `Your request for ${req.kind} "${req.value}" was denied. Find another way, or call fail if you can't.`
        : `You now have ${req.kind} "${req.value}".`;
    updateTask(this.db, t.id, { status: "ready", feedback: [t.feedback, fb].filter(Boolean).join("\n\n") });
    addLog(this.db, t.id, "you", `Permission ${req.kind} "${req.value}": ${decision === "deny" ? "denied" : decision === "once" ? "allowed once" : "allowed for this mission"}.`);
    if (t.kind === "plan") updateMission(this.db, t.mission_id, { status: "planning" });
    this.changed(m);
    setImmediate(() => this.tick());
  }

  markDone(taskId: string, note?: string) {
    const t = this.mustTask(taskId);
    if (t.kind !== "human") throw new UserError(`${t.id} isn't a task for you.`);
    this.expect(t, ["your_turn", "pending"], "mark done");
    updateTask(this.db, t.id, {
      status: "done",
      result: { summary: note?.trim() || "Done.", files: [], interfaces: "none" },
    });
    addLog(this.db, t.id, "you", `Done${note ? `: ${note}` : ""}.`);
    this.refresh(getMission(this.db, t.mission_id)!);
    this.changed(t.mission_id);
    setImmediate(() => this.tick());
  }

  acceptMission(missionId: string, opts: { overview?: boolean } = {}) {
    const m = this.mustMission(missionId);
    if (m.status !== "final_review") throw new UserError(`${m.id} isn't waiting for final approval (it's ${m.status}).`);
    const p = getProject(this.db, m.project_id)!;
    if (m.overview_proposal && opts.overview !== false) writeOverview(p, m.overview_proposal);
    updateMission(this.db, m.id, { status: "done", overview_proposal: null });
    // Keep only the snapshot from before the mission's first task.
    const tasks = listTasks(this.db, m.id).filter((t) => t.base_snapshot).sort((a, b) => a.order_idx - b.order_idx);
    const first = this.db
      .prepare("select t.base_snapshot s from tasks t join runs r on r.task_id = t.id where t.mission_id = ? and t.base_snapshot is not null order by r.id limit 1")
      .get(m.id) as { s: string } | undefined;
    for (const t of tasks) if (t.base_snapshot !== first?.s) deleteSnapshot(t.base_snapshot);
    this.notify("mission_done", `${m.id} done`, m.title);
    this.changed(m, { type: "mission_done" });
    setImmediate(() => this.tick());
    return { mission_start_snapshot: first?.s ?? null };
  }

  /** Change how a running mission behaves. Switching to auto-accept also accepts tasks already waiting in review. */
  missionSettings(
    missionId: string,
    s: {
      review_mode?: string;
      permission_mode?: string;
      budget_task?: unknown;
      budget_mission?: unknown;
      time_limit_min?: unknown;
      budget_unit?: string;
      planner?: unknown;
      worker?: unknown;
      verifier?: unknown;
    },
  ) {
    const m = this.mustMission(missionId);
    const patch: Partial<Mission> = {};
    if (s.review_mode !== undefined) {
      if (s.review_mode !== "every" && s.review_mode !== "auto") throw new UserError('review must be "every" or "auto".');
      patch.review_mode = s.review_mode;
    }
    if (s.permission_mode !== undefined) {
      if (s.permission_mode !== "upfront" && s.permission_mode !== "full") throw new UserError('access must be "upfront" or "full".');
      patch.permission_mode = s.permission_mode;
    }
    const pos = (v: unknown, what: string) => {
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) throw new UserError(`${what} must be a positive number.`);
      return n;
    };
    if (s.budget_task !== undefined) patch.budget_task = pos(s.budget_task, "Task budget");
    if (s.budget_mission !== undefined) patch.budget_mission = pos(s.budget_mission, "Mission budget");
    if (s.time_limit_min !== undefined) patch.time_limit_min = Math.round(pos(s.time_limit_min, "Time limit"));
    for (const role of ["planner", "worker", "verifier"] as const) {
      const v = s[role];
      if (v === undefined) continue;
      if (typeof v !== "string" || !resolveProfile(this.config, v)) throw new UserError(`Unknown ${role} agent "${String(v)}".`);
      patch[`${role}_profile`] = v;
    }
    if (s.budget_unit !== undefined) {
      if (s.budget_unit !== "usd" && s.budget_unit !== "tokens") throw new UserError('Budget unit must be "usd" or "tokens".');
      patch.budget_unit = s.budget_unit;
    }
    updateMission(this.db, m.id, patch);
    const accepted: string[] = [];
    if (patch.review_mode === "auto") {
      for (const t of listTasks(this.db, m.id)) {
        if (t.status === "in_review" && t.kind === "work") {
          this.acceptTask(t.id, "auto-accept");
          accepted.push(t.id);
        }
      }
    }
    if (m.paused && patch.budget_mission && patch.budget_mission > this.spentIn(m.budget_unit, missionSpend(this.db, m.id))) {
      updateMission(this.db, m.id, { paused: 0 });
    }
    this.changed(m.id);
    setImmediate(() => this.tick());
    return { mission: getMission(this.db, m.id), accepted };
  }

  cancelMission(missionId: string) {
    const m = this.mustMission(missionId);
    for (const r of runningRuns(this.db)) {
      const t = getTask(this.db, r.task_id);
      if (t?.mission_id === m.id) this.live.get(r.id)?.handle?.kill("stopped");
    }
    updateMission(this.db, m.id, { status: "cancelled" });
    this.changed(m, { type: "mission_cancelled" });
    setImmediate(() => this.tick());
  }

  /** Stop running agents and checks. `pauseAll` pauses every open mission; otherwise only the ones that were interrupted. */
  stopAll(projectId?: string, why = "stopped by you", pauseAll = true) {
    let n = 0;
    const interrupted = new Set<string>();
    for (const r of runningRuns(this.db)) {
      const t = getTask(this.db, r.task_id);
      const m = t && getMission(this.db, t.mission_id);
      if (!m || (projectId && m.project_id !== projectId)) continue;
      interrupted.add(m.id);
      const live = this.live.get(r.id);
      if (live?.handle) live.handle.kill("stopped");
      else this.endPullRun(r.id, "stopped");
      n++;
    }
    for (const [taskId, pids] of this.checking) {
      const t = getTask(this.db, taskId);
      const m = t && getMission(this.db, t.mission_id);
      if (projectId && m?.project_id !== projectId) continue;
      if (m) interrupted.add(m.id);
      for (const pid of pids) killTree(pid);
    }
    for (const m of listMissions(this.db)) {
      if (["done", "cancelled"].includes(m.status)) continue;
      if (projectId && m.project_id !== projectId) continue;
      if (!pauseAll && !interrupted.has(m.id)) continue;
      if (!m.paused) {
        updateMission(this.db, m.id, { paused: 1 });
        this.changed(m);
      }
    }
    this.emit({ type: "stopped", project: projectId, message: `${n} run(s) stopped (${why})` });
    return n;
  }

  resume(target?: string) {
    const missions = listMissions(this.db).filter((m) => !["done", "cancelled"].includes(m.status));
    const pick = target
      ? missions.filter((m) => m.id.toLowerCase() === target.toLowerCase() || m.project_id === target || getProject(this.db, target)?.id === m.project_id)
      : missions;
    if (target && !pick.length) throw new UserError(`Nothing to resume for "${target}".`);
    const resumed: string[] = [];
    const skipped: string[] = [];
    for (const m of pick) {
      const spent = this.spentIn(m.budget_unit, missionSpend(this.db, m.id));
      if (spent >= m.budget_mission) {
        skipped.push(`${m.id} has used its budget (${this.fmtAmount(m, spent)}); raise it first: northern-lights raise ${m.id} <amount>`);
        continue;
      }
      updateMission(this.db, m.id, { paused: 0 });
      resumed.push(m.id);
      this.changed(m);
    }
    setImmediate(() => this.tick());
    return { resumed, skipped };
  }

  // ───────────────────────────── views ─────────────────────────────

  inbox() {
    const items: { kind: string; project: string; mission: string; task?: string; title: string; detail?: string; since: string }[] = [];
    for (const m of listMissions(this.db)) {
      if (["done", "cancelled"].includes(m.status)) continue;
      if (m.status === "awaiting_approval" && m.pending_plan) {
        const kind = m.pending_plan.source === "plan" ? "plan to approve" : m.pending_plan.source === "split" ? "split to approve" : "fix tasks to approve";
        items.push({ kind, project: m.project_id, mission: m.id, title: m.title, detail: m.pending_plan.reason, since: m.updated_at });
      }
      if (m.status === "final_review") items.push({ kind: "final approval", project: m.project_id, mission: m.id, title: m.title, since: m.updated_at });
      if (m.paused) {
        const spent = this.spentIn(m.budget_unit, missionSpend(this.db, m.id));
        const why = spent >= m.budget_mission ? `budget used up (${this.fmtAmount(m, spent)})` : "paused";
        items.push({ kind: "paused", project: m.project_id, mission: m.id, title: m.title, detail: why, since: m.updated_at });
      }
      for (const t of listTasks(this.db, m.id)) {
        const q = openQuestions(this.db, t.id)[0];
        const base = { project: m.project_id, mission: m.id, task: t.id, title: t.title, since: t.updated_at };
        if (t.status === "your_turn") items.push({ ...base, kind: "task for you", detail: t.criteria.join("; ") });
        else if (t.status === "waiting" && q) {
          const b = JSON.parse(q.body);
          items.push({ ...base, kind: q.kind === "permission" ? "permission request" : "question", detail: q.kind === "permission" ? `${b.kind} "${b.value}" — ${b.reason}` : `${b.question}${b.choices?.length ? ` [${b.choices.join(" / ")}]` : ""}` });
        } else if (t.status === "in_review") items.push({ ...base, kind: "review" });
        else if (t.status === "over_limit") items.push({ ...base, kind: "over limit" });
        else if (t.status === "stuck") items.push({ ...base, kind: "stuck", detail: t.feedback?.slice(0, 300) ?? undefined });
        else if (t.status === "failed") items.push({ ...base, kind: "failed", detail: t.feedback?.slice(0, 300) ?? undefined });
      }
    }
    return items;
  }

  status() {
    const projects = listProjects(this.db).map((p) => {
      const busy = this.busyTask(p.id);
      const missions = listMissions(this.db, p.id).filter((m) => !["done", "cancelled"].includes(m.status));
      return {
        id: p.id,
        path: p.path,
        busy: busy ? { task: busy.id, title: busy.title, status: busy.status } : null,
        missions: missions.map((m) => ({
          id: m.id,
          title: m.title,
          status: m.status,
          paused: !!m.paused,
          review_mode: m.review_mode,
          progress: (() => {
            const ts = listTasks(this.db, m.id).filter((t) => !t.is_parent && t.kind !== "plan" && t.kind !== "mission_verify" && t.status !== "cancelled");
            return { done: ts.filter((t) => t.status === "done").length, total: ts.length };
          })(),
          spend: missionSpend(this.db, m.id),
          budget: { unit: m.budget_unit, mission: m.budget_mission, task: m.budget_task },
        })),
      };
    });
    const runs = runningRuns(this.db).map((r) => ({ id: r.id, task: r.task_id, role: r.role, profile: r.profile, started: r.started_at, tokens: r.tokens, usd: r.usd }));
    const usage_today = this.db
      .prepare("select coalesce(sum(tokens),0) tokens, coalesce(sum(usd),0) usd from runs where substr(started_at,1,10) = ?")
      .get(new Date().toISOString().slice(0, 10)) as { tokens: number; usd: number };
    return { projects, runs, concurrency: this.config.concurrency, checks_running: [...this.checking.keys()], usage_today };
  }

  taskView(id: string, withDiff = false) {
    const t = this.mustTask(id);
    const m = getMission(this.db, t.mission_id)!;
    const p = getProject(this.db, m.project_id)!;
    const out: Record<string, unknown> = {
      task: t,
      file: renderTaskFile(this.db, m, t),
      questions: openQuestions(this.db, t.id).map((q) => ({ ...q, body: JSON.parse(q.body) })),
      spend: taskSpend(this.db, t.id),
      mission: { id: m.id, title: m.title, status: m.status, review_mode: m.review_mode, project: p.id, budget_unit: m.budget_unit, budget_task: m.budget_task + t.extra_budget },
      log: getLog(this.db, t.id),
      runs: this.db.prepare("select id, role, profile, model, status, stop_reason, started_at, ended_at, tokens, usd, log_path from runs where task_id = ? order by id").all(t.id),
    };
    if (withDiff) {
      const saved = this.diffFile(t.id);
      if (t.status === "done" && fs.existsSync(saved)) out.diff = fs.readFileSync(saved, "utf8");
      else {
        out.diff = t.base_snapshot && fs.existsSync(t.base_snapshot)
          ? diffText(t.base_snapshot, p.path, readSettings(p).snapshot_exclude)
          : "(no snapshot: this task hasn't started)";
        if (t.status === "done") out.diff_note = "Shows the folder as it is now, so it may include changes from later tasks.";
      }
    }
    return out;
  }

  private diffFile(taskId: string): string {
    return path.join(homeDir(), "diffs", `${taskId.replace(/[^A-Za-z0-9._-]/g, "_")}.diff`);
  }

  missionView(id: string) {
    this.flushFiles();
    const m = this.mustMission(id);
    return {
      mission: m,
      tasks: listTasks(this.db, m.id).map((t) => ({ id: t.id, local_id: t.local_id, parent: t.parent_local, kind: t.kind, title: t.title, goal: t.goal, criteria: t.criteria, status: t.status, depends: t.depends, is_parent: t.is_parent, attempt: t.attempt, failures: t.failures, spend: taskSpend(this.db, t.id), updated_at: t.updated_at })),
      project: getProject(this.db, m.project_id),
      running: runningRuns(this.db).filter((r) => r.task_id.startsWith(m.id + ":")).map((r) => ({ id: r.id, task: r.task_id, role: r.role, profile: r.profile, started: r.started_at, tokens: r.tokens, usd: r.usd })),
      overview: readOverview(getProject(this.db, m.project_id)!),
      spend: missionSpend(this.db, m.id),
      todo: fs.existsSync(this.todoPath(m)) ? fs.readFileSync(this.todoPath(m), "utf8") : "",
    };
  }

  private todoPath(m: Mission): string {
    const p = getProject(this.db, m.project_id)!;
    return path.join(missionDir(p, m.id, m.title), "TODO.md");
  }

  // ───────────────────────────── agent tools ─────────────────────────────

  createPullKey(profile: string): string {
    if (!this.config.profiles[profile]) throw new UserError(`Unknown profile "${profile}".`);
    const key = `pull_${crypto.randomBytes(20).toString("hex")}`;
    this.db.prepare("insert into pull_keys(key, profile, created_at) values (?, ?, ?)").run(key, profile, now());
    return key;
  }

  private endPullRun(runId: number, reason: string) {
    const run = getRun(this.db, runId);
    if (!run || run.status !== "running") return;
    this.live.delete(runId);
    for (const [k, v] of this.pullRuns) if (v === runId) this.pullRuns.delete(k);
    updateRun(this.db, runId, { status: reason === "ended" ? "exited" : "killed", ended_at: now(), stop_reason: reason });
    this.finishRun(runId, reason === "ended" ? null : reason, reason === "ended" ? 0 : 1, null);
  }

  private endRunSoon(run: Run) {
    const live = this.live.get(run.id);
    if (!live) return;
    if (!live.handle) {
      // Pull mode: no process of ours; the run is over now.
      setImmediate(() => this.endPullRun(run.id, "ended"));
      return;
    }
    setTimeout(() => {
      if (this.live.has(run.id)) live.handle?.kill("ended");
    }, 90_000).unref();
  }

  /** Handle a tool call from an agent. Returns text for the agent. */
  callTool(key: string, name: string, args: Record<string, any>): string {
    const def = TOOLS.find((t) => t.name === name);
    if (!def) throw new UserError(`Unknown tool "${name}".`);
    let run = runByKey(this.db, key);
    let role: "plan" | "work" | "verify" | "pull";
    if (run) {
      role = run.role;
    } else {
      const pull = this.db.prepare("select * from pull_keys where key = ?").get(key) as { profile: string } | undefined;
      if (!pull) throw new UserError("Unknown key.");
      if (name === "next_task") return this.pullNext(key, pull.profile, String(args.project ?? ""));
      const runId = this.pullRuns.get(key);
      run = runId ? getRun(this.db, runId) : undefined;
      if (!run) throw new UserError("You have no task. Call next_task first.");
      role = "pull";
    }
    if (!def.roles.includes(role) && !(role === "pull" && def.roles.includes("work"))) {
      throw new UserError(`The ${name} tool isn't available to a ${role} agent.`);
    }
    if (run.status !== "running") throw new UserError("This run has ended. Stop now.");
    this.touch(run.id);
    updateRun(this.db, run.id, { last_activity: now() });
    const t = getTask(this.db, run.task_id)!;
    const m = getMission(this.db, t.mission_id)!;
    const p = getProject(this.db, m.project_id)!;
    const who = run.profile;
    const out = this.handleTool(name, args, { run, t, m, p, who, role });
    if (ENDING_TOOLS.has(name) && !out.startsWith("ERROR")) this.endRunSoon(run);
    this.changed(m);
    return out;
  }

  private handleTool(
    name: string,
    a: Record<string, any>,
    c: { run: Run; t: Task; m: Mission; p: Project; who: string; role: string },
  ): string {
    const { t, m, p, who } = c;
    const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");
    switch (name) {
      case "get_task": {
        const other = getTask(this.db, `${m.id}:${s(a.id)}`);
        if (!other) return `ERROR: no task "${a.id}" in mission ${m.id}.`;
        return renderTaskFile(this.db, m, other);
      }
      case "log": {
        if (!s(a.text)) return "ERROR: text is required.";
        addLog(this.db, t.id, who, s(a.text));
        return "Logged.";
      }
      case "note": {
        if (!s(a.text)) return "ERROR: text is required.";
        appendDecision(p, s(a.text), `${who} on ${t.local_id}`);
        addLog(this.db, t.id, who, `Recorded decision: ${s(a.text)}`);
        return "Recorded in DECISIONS.md.";
      }
      case "propose_plan": {
        if (t.kind !== "plan") return "ERROR: only the planner can propose a plan.";
        const tasks = a.tasks as PlanTaskInput[];
        const problems = validatePlan(tasks, new Set(listTasks(this.db, m.id).map((x) => x.local_id)));
        if (!readOverview(p) && !s(a.overview)) problems.push("there is no PROJECT.md yet: include `overview`");
        if (problems.length) return `ERROR: fix these and call propose_plan again:\n- ${problems.join("\n- ")}`;
        const perms = a.permissions ?? {};
        updateMission(this.db, m.id, {
          pending_plan: {
            source: "plan",
            tasks,
            permissions: { commands: perms.commands ?? [], domains: perms.domains ?? [], paths: perms.paths ?? [] },
            overview: s(a.overview) || undefined,
          },
          status: "awaiting_approval",
        });
        updateTask(this.db, t.id, { status: "done" });
        addLog(this.db, t.id, who, `Proposed a plan with ${tasks.length} top-level task(s).`);
        this.notify("plan", `${m.id}: plan to approve`, m.title);
        return "Plan submitted for the human's approval. Your run is over: stop now.";
      }
      case "request_split": {
        const tasks = a.tasks as PlanTaskInput[];
        const problems = validatePlan(tasks, new Set(listTasks(this.db, m.id).map((x) => x.local_id)));
        if (problems.length) return `ERROR: fix these and call request_split again:\n- ${problems.join("\n- ")}`;
        updateTask(this.db, t.id, { status: "needs_split" });
        updateMission(this.db, m.id, {
          status: "awaiting_approval",
          pending_plan: { source: "split", split_of: t.local_id, reason: s(a.reason), tasks },
        });
        addLog(this.db, t.id, who, `Asked to split: ${s(a.reason)}`);
        this.notify("plan", `${t.local_id} wants to split`, s(a.reason));
        return "Split proposed for the human's approval. Your run is over: stop now.";
      }
      case "submit": {
        if (t.kind !== "work") return "ERROR: only work tasks can submit.";
        const files = Array.isArray(a.files) ? a.files.map(String).filter(Boolean) : [];
        const missing = [!s(a.summary) && "summary", !files.length && "files", !s(a.interfaces) && "interfaces (say \"none\" if nothing)"].filter(Boolean);
        if (missing.length) return `ERROR: the Result needs: ${missing.join(", ")}. Call submit again.`;
        updateTask(this.db, t.id, {
          status: "verifying",
          verify_tries: 0,
          result: {
            summary: s(a.summary),
            files,
            interfaces: s(a.interfaces),
            decisions: s(a.decisions) || undefined,
            gotchas: s(a.gotchas) || undefined,
            verify: s(a.verify) || undefined,
          },
          verification: { verdicts: t.verification.verdicts },
        });
        addLog(this.db, t.id, who, `Submitted: ${s(a.summary)}`);
        return "Submitted. Checks and a verifier run next. Your run is over: stop now.";
      }
      case "submit_verdict": {
        if (c.role !== "verify") return "ERROR: only the verifier can submit a verdict.";
        const criteria = (Array.isArray(a.criteria) ? a.criteria : []) as { criterion: string; met: boolean; evidence: string }[];
        const weak = criteria.filter((x) => !x || s(x.evidence).length < 8 || /^(looks good|lgtm|ok|yes|done)\.?$/i.test(s(x.evidence)));
        if (!criteria.length) return "ERROR: give one entry per criterion, each with evidence.";
        if (weak.length) return `ERROR: evidence is missing or too thin for: ${weak.map((x) => x?.criterion ?? "?").join("; ")}. Give a test name, command output, or file:line.`;
        if (t.kind === "work" && criteria.length < t.criteria.length) {
          return `ERROR: the task has ${t.criteria.length} criteria; you gave ${criteria.length}. Cover every one.`;
        }
        if (typeof a.pass !== "boolean") return "ERROR: pass must be true or false.";
        if (a.pass && criteria.some((x) => !x.met)) return "ERROR: pass is true but some criteria are not met.";
        const screenshots = this.collectScreenshots(c.run, t, a.screenshots);
        updateTask(this.db, t.id, {
          pending_verdict: {
            screenshots,
            pass: a.pass,
            criteria: criteria.map((x) => ({ criterion: s(x.criterion), met: !!x.met, evidence: s(x.evidence) })),
            feedback: s(a.feedback) || undefined,
            fix_tasks: t.kind === "mission_verify" ? a.fix_tasks : undefined,
            overview_updates: t.kind === "mission_verify" ? s(a.overview_updates) || undefined : undefined,
            profile: who,
          },
        });
        addLog(this.db, t.id, who, `Verdict: ${a.pass ? "PASS" : "FAIL"}${a.feedback ? ` — ${s(a.feedback).slice(0, 200)}` : ""}`);
        return "Verdict recorded. Your run is over: stop now.";
      }
      case "fail": {
        if (c.role === "verify") {
          addLog(this.db, t.id, who, `Verifier gave up: ${s(a.reason)}`);
          return "Noted. Your run is over: stop now.";
        }
        updateTask(this.db, t.id, { status: "failed", feedback: s(a.reason) });
        addLog(this.db, t.id, who, `Gave up: ${s(a.reason)}`);
        this.notify("failed", `${t.local_id} failed`, s(a.reason));
        return "Noted; the human decides what's next. Your run is over: stop now.";
      }
      case "ask_human": {
        if (!s(a.question) || !s(a.progress)) return "ERROR: question and progress are both required.";
        this.db.prepare("insert into questions(task_id, kind, body, created_at) values (?, 'question', ?, ?)").run(
          t.id,
          JSON.stringify({ question: s(a.question), choices: a.choices ?? [] }),
          now(),
        );
        updateTask(this.db, t.id, { status: "waiting" });
        addLog(this.db, t.id, who, `Progress: ${s(a.progress)}`);
        addLog(this.db, t.id, who, `Asked: ${s(a.question)}`);
        this.notify("question", `${t.local_id} has a question`, s(a.question));
        return "Question sent. A fresh agent will continue with the answer. Your run is over: stop now.";
      }
      case "request_permission": {
        const kind = s(a.kind);
        if (!["command", "domain", "path"].includes(kind) || !s(a.value)) return "ERROR: kind (command/domain/path) and value are required.";
        this.db.prepare("insert into questions(task_id, kind, body, created_at) values (?, 'permission', ?, ?)").run(
          t.id,
          JSON.stringify({ kind, value: s(a.value), reason: s(a.reason) }),
          now(),
        );
        updateTask(this.db, t.id, { status: "waiting" });
        addLog(this.db, t.id, who, `Progress: ${s(a.progress)}`);
        addLog(this.db, t.id, who, `Requested ${kind} "${s(a.value)}": ${s(a.reason)}`);
        this.notify("permission", `${t.local_id} needs permission`, `${kind}: ${s(a.value)}`);
        return "Request sent. A fresh agent will continue once the human decides. Your run is over: stop now.";
      }
    }
    return `ERROR: unhandled tool ${name}`;
  }

  /** Pull mode: give the next task in a project to an agent the human runs themselves. */
  private pullNext(key: string, profile: string, projectRef: string): string {
    const current = this.pullRuns.get(key);
    if (current && getRun(this.db, current)?.status === "running") {
      return "ERROR: you still have a task. Finish it (submit/fail/ask_human) first.";
    }
    const p = getProject(this.db, projectRef);
    if (!p) return `ERROR: no project "${projectRef}".`;
    const m = this.activeMission(p.id);
    if (!m || m.paused || m.status !== "running") return "No task available right now (no running mission, or it's paused / waiting for approval).";
    if (this.busyTask(p.id)) return `No task available: the project is busy with ${this.busyTask(p.id)!.id}. Try later.`;
    const t = listTasks(this.db, m.id).find((x) => x.status === "ready" && x.kind === "work" && !x.is_parent);
    if (!t) return "No ready task right now.";
    let base = t.base_snapshot;
    if (!base) base = takeSnapshot(p.path, p.id, t.local_id, { exclude: readSettings(p).snapshot_exclude });
    updateTask(this.db, t.id, { status: "in_progress", attempt: t.attempt + 1, base_snapshot: base });
    const ts = now();
    const info = this.db
      .prepare("insert into runs (task_id, role, profile, key, status, started_at, last_activity) values (?, 'work', ?, ?, 'running', ?, ?)")
      .run(t.id, profile, `${key}:${Date.now()}`, ts, ts);
    const runId = Number(info.lastInsertRowid);
    this.pullRuns.set(key, runId);
    this.live.set(runId, { handle: null, tracker: null, lastActivityWrite: 0 });
    addLog(this.db, t.id, "northern-lights", `${profile} took this task (pull mode, attempt ${t.attempt + 1})`);
    this.changed(m);
    return workBriefing(this.db, p, m, getTask(this.db, t.id)!, false);
  }
}

function tailOf(file: string, n: number): string {
  try {
    const s = fs.readFileSync(file, "utf8");
    // For stream-json logs, show the last assistant text / result rather than raw JSON.
    const lines = s.trim().split("\n").slice(-30);
    const readable = lines
      .map((l) => {
        try {
          const d = JSON.parse(l);
          if (d.type === "result") return `[result] ${d.subtype}${d.result ? `: ${String(d.result).slice(0, 400)}` : ""}`;
          if (d.type === "assistant") {
            const txt = (d.message?.content ?? []).filter((x: any) => x.type === "text").map((x: any) => x.text).join(" ");
            return txt ? `[agent] ${txt.slice(0, 300)}` : "";
          }
          return "";
        } catch {
          return l;
        }
      })
      .filter(Boolean)
      .join("\n");
    return readable.slice(-n);
  } catch {
    return "";
  }
}
