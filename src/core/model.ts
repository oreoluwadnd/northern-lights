import type { DB } from "./db.ts";

export type MissionStatus =
  | "queued"
  | "planning"
  | "awaiting_approval"
  | "running"
  | "final_review"
  | "done"
  | "cancelled";

export type TaskStatus =
  | "pending"
  | "ready"
  | "in_progress"
  | "verifying"
  | "in_review"
  | "done"
  | "waiting"
  | "over_limit"
  | "stuck"
  | "failed"
  | "needs_split"
  | "your_turn"
  | "cancelled";

/** plan = planner run; work = atomic code task; human = task for you; mission_verify = final check. */
export type TaskKind = "plan" | "work" | "human" | "mission_verify";

/** Statuses during which a task's changes are in the folder and the project must not start anything else. */
export const BUSY_STATUSES: TaskStatus[] = [
  "in_progress",
  "verifying",
  "in_review",
  "waiting",
  "over_limit",
  "stuck",
  "failed",
  "needs_split",
];

export interface Permissions {
  commands: string[];
  domains: string[];
  paths: string[];
}

export interface Criterion {
  text: string;
}

export interface Result {
  summary: string;
  files: string[];
  interfaces: string;
  decisions?: string;
  gotchas?: string;
  verify?: string;
}

export interface CriterionVerdict {
  criterion: string;
  met: boolean;
  evidence: string;
}

export interface Verification {
  checks?: { command: string; ok: boolean; output: string }[];
  files_changed?: string[];
  files_mismatch?: { unlisted: string[]; listed_but_unchanged: string[] };
  verdicts?: {
    attempt: number;
    profile: string;
    pass: boolean;
    criteria: CriterionVerdict[];
    feedback?: string;
    screenshots?: Screenshot[];
  }[];
}

export interface Project {
  id: string;
  name: string;
  path: string;
  created_at: string;
}

export interface Mission {
  id: string;
  project_id: string;
  title: string;
  goal: string;
  status: MissionStatus;
  paused: number;
  review_mode: "every" | "auto";
  permission_mode: "upfront" | "full";
  permissions: Permissions;
  budget_unit: "tokens" | "usd";
  budget_task: number;
  budget_mission: number;
  time_limit_min: number;
  planner_profile: string;
  worker_profile: string;
  verifier_profile: string;
  queue_pos: number;
  pending_plan: PendingPlan | null;
  plan_feedback: string | null;
  overview_proposal: string | null;
  warned: Record<string, boolean>;
  created_at: string;
  updated_at: string;
}

export interface Task {
  id: string;
  mission_id: string;
  local_id: string;
  parent_local: string | null;
  kind: TaskKind;
  is_parent: number;
  title: string;
  goal: string;
  context: string;
  criteria: string[];
  depends: string[];
  order_idx: number;
  status: TaskStatus;
  attempt: number;
  failures: number;
  verify_tries: number;
  result: Result | null;
  verification: Verification;
  pending_verdict: PendingVerdict | null;
  feedback: string | null;
  base_snapshot: string | null;
  submit_snapshot: string | null;
  extra_permissions: Partial<Permissions>;
  extra_budget: number;
  created_at: string;
  updated_at: string;
}

export interface Run {
  id: number;
  task_id: string;
  role: "plan" | "work" | "verify";
  profile: string;
  model: string | null;
  key: string;
  pid: number | null;
  status: "running" | "exited" | "killed" | "orphaned";
  stop_reason: string | null;
  started_at: string;
  ended_at: string | null;
  last_activity: string;
  tokens: number;
  usd: number;
  usd_final: number;
  log_path: string | null;
}

/** A task as the planner proposes it (before IDs are assigned). */
export interface PlanTaskInput {
  key: string;
  title: string;
  goal: string;
  context?: string;
  criteria?: string[];
  depends_on?: string[];
  for_you?: boolean;
  children?: PlanTaskInput[];
}

export interface PendingPlan {
  /** "plan" = initial breakdown, "split" = mid-task split, "fix" = fix tasks from the mission check. */
  source: "plan" | "split" | "fix";
  /** For split: the local ID of the task being split. */
  split_of?: string;
  reason?: string;
  tasks: PlanTaskInput[];
  permissions?: Permissions;
  overview?: string;
}

/** A screenshot a verifier took while testing, stored under ~/.northern-lights/shots/<task>/. */
export interface Screenshot {
  file: string;
  caption: string;
}

export interface PendingVerdict {
  screenshots?: Screenshot[];
  pass: boolean;
  criteria: CriterionVerdict[];
  feedback?: string;
  fix_tasks?: PlanTaskInput[];
  overview_updates?: string;
  profile: string;
}

const j = <T>(s: string | null | undefined, fallback: T): T => {
  if (s === null || s === undefined || s === "") return fallback;
  return JSON.parse(s) as T;
};

export function emptyPermissions(): Permissions {
  return { commands: [], domains: [], paths: [] };
}

function rowToMission(r: any): Mission {
  return {
    ...r,
    permissions: j(r.permissions, emptyPermissions()),
    pending_plan: j(r.pending_plan, null),
    warned: j(r.warned, {}),
  };
}

function rowToTask(r: any): Task {
  return {
    ...r,
    criteria: j(r.criteria, []),
    depends: j(r.depends, []),
    result: j(r.result, null),
    verification: j(r.verification, {}),
    pending_verdict: j(r.pending_verdict, null),
    extra_permissions: j(r.extra_permissions, {}),
  };
}

export function getProject(db: DB, idOrName: string): Project | undefined {
  return db
    .prepare("select * from projects where id = ? or name = ? or path = ?")
    .get(idOrName, idOrName, idOrName) as Project | undefined;
}

export function listProjects(db: DB): Project[] {
  return db.prepare("select * from projects order by created_at").all() as unknown as Project[];
}

export function getMission(db: DB, id: string): Mission | undefined {
  const r = db.prepare("select * from missions where id = ? collate nocase").get(id);
  return r ? rowToMission(r) : undefined;
}

export function listMissions(db: DB, projectId?: string): Mission[] {
  const rows = projectId
    ? db.prepare("select * from missions where project_id = ? order by queue_pos").all(projectId)
    : db.prepare("select * from missions order by project_id, queue_pos").all();
  return rows.map(rowToMission);
}

export function getTask(db: DB, id: string): Task | undefined {
  const r = db.prepare("select * from tasks where id = ? collate nocase").get(id);
  return r ? rowToTask(r) : undefined;
}

export function listTasks(db: DB, missionId: string): Task[] {
  return db
    .prepare("select * from tasks where mission_id = ? order by order_idx")
    .all(missionId)
    .map(rowToTask);
}

export function getRun(db: DB, id: number): Run | undefined {
  return db.prepare("select * from runs where id = ?").get(id) as Run | undefined;
}

export function runByKey(db: DB, key: string): Run | undefined {
  return db.prepare("select * from runs where key = ?").get(key) as Run | undefined;
}

export function runningRuns(db: DB): Run[] {
  return db.prepare("select * from runs where status = 'running'").all() as unknown as Run[];
}

type Patch<T> = { [K in keyof T]?: T[K] };

const JSON_FIELDS = new Set([
  "permissions",
  "pending_plan",
  "warned",
  "criteria",
  "depends",
  "result",
  "verification",
  "pending_verdict",
  "extra_permissions",
]);

function update(db: DB, table: string, id: string | number, patch: Record<string, unknown>) {
  const keys = Object.keys(patch);
  if (!keys.length) return;
  const vals = keys.map((k) => {
    const v = patch[k];
    if (JSON_FIELDS.has(k)) return v === null ? null : JSON.stringify(v);
    return v as any;
  });
  const sets = keys.map((k) => `${k} = ?`).join(", ");
  const hasUpdated = table === "missions" || table === "tasks";
  db.prepare(
    `update ${table} set ${sets}${hasUpdated ? ", updated_at = ?" : ""} where id = ?`,
  ).run(...vals, ...(hasUpdated ? [new Date().toISOString()] : []), id);
}

export function updateMission(db: DB, id: string, patch: Patch<Mission>) {
  update(db, "missions", id, patch as Record<string, unknown>);
}

export function updateTask(db: DB, id: string, patch: Patch<Task>) {
  update(db, "tasks", id, patch as Record<string, unknown>);
}

export function updateRun(db: DB, id: number, patch: Patch<Run>) {
  update(db, "runs", id, patch as Record<string, unknown>);
}

export function addLog(db: DB, taskId: string, actor: string, text: string) {
  db.prepare("insert into worklog(task_id, ts, actor, text) values (?, ?, ?, ?)").run(
    taskId,
    new Date().toISOString(),
    actor,
    text,
  );
}

export function getLog(db: DB, taskId: string): { ts: string; actor: string; text: string }[] {
  return db
    .prepare("select ts, actor, text from worklog where task_id = ? order by id")
    .all(taskId) as any;
}

/** Spend for a task (all its runs, all attempts, including verifier runs). */
export function taskSpend(db: DB, taskId: string): { tokens: number; usd: number } {
  const r = db
    .prepare("select coalesce(sum(tokens),0) tokens, coalesce(sum(usd),0) usd from runs where task_id = ?")
    .get(taskId) as { tokens: number; usd: number };
  return r;
}

export function missionSpend(db: DB, missionId: string): { tokens: number; usd: number } {
  return db
    .prepare(
      `select coalesce(sum(r.tokens),0) tokens, coalesce(sum(r.usd),0) usd
       from runs r join tasks t on t.id = r.task_id where t.mission_id = ?`,
    )
    .get(missionId) as { tokens: number; usd: number };
}

export function openQuestions(db: DB, taskId: string) {
  return db
    .prepare("select * from questions where task_id = ? and answer is null order by id")
    .all(taskId) as { id: number; kind: string; body: string }[];
}
