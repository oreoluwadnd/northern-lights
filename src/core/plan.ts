import type { DB } from "./db.ts";
import { now } from "./db.ts";
import type { Mission, PendingPlan, PlanTaskInput, Task } from "./model.ts";
import { listTasks } from "./model.ts";

export const MAX_DEPTH = 3;
export const MAX_CHILDREN = 10;

/** Check a proposed plan. Returns a list of problems (empty = OK). */
export function validatePlan(tasks: PlanTaskInput[], existingIds: Set<string> = new Set()): string[] {
  const problems: string[] = [];
  const keys = new Set<string>();
  const walk = (ts: PlanTaskInput[], depth: number, where: string) => {
    if (!Array.isArray(ts) || !ts.length) {
      problems.push(`${where}: needs at least one task`);
      return;
    }
    if (ts.length > MAX_CHILDREN) problems.push(`${where}: ${ts.length} tasks; max is ${MAX_CHILDREN} per level`);
    if (depth > MAX_DEPTH) problems.push(`${where}: nested deeper than ${MAX_DEPTH} levels`);
    for (const t of ts) {
      if (!t.key || typeof t.key !== "string") problems.push(`${where}: a task is missing "key"`);
      else if (keys.has(t.key)) problems.push(`duplicate key "${t.key}"`);
      else keys.add(t.key);
      if (!t.title) problems.push(`task "${t.key}": missing title`);
      if (!t.goal) problems.push(`task "${t.key}": missing goal`);
      if (t.children?.length) {
        if (t.for_you) problems.push(`task "${t.key}": a task for you can't have children`);
        walk(t.children, depth + 1, `children of "${t.key}"`);
      } else if (!t.criteria?.length) {
        problems.push(`task "${t.key}": atomic tasks need acceptance criteria (for tasks for you: "done when" criteria)`);
      }
    }
  };
  walk(tasks, 1, "plan");
  const checkDeps = (ts: PlanTaskInput[]) => {
    for (const t of ts) {
      for (const d of t.depends_on ?? []) {
        if (!keys.has(d) && !existingIds.has(d)) problems.push(`task "${t.key}": depends on unknown "${d}"`);
        if (d === t.key) problems.push(`task "${t.key}": depends on itself`);
      }
      if (t.children) checkDeps(t.children);
    }
  };
  checkDeps(tasks);
  if (!problems.length && hasCycle(tasks)) problems.push("dependencies form a cycle");
  return problems;
}

function flatten(ts: PlanTaskInput[]): PlanTaskInput[] {
  return ts.flatMap((t) => [t, ...flatten(t.children ?? [])]);
}

function hasCycle(tasks: PlanTaskInput[]): boolean {
  const all = flatten(tasks);
  const deps = new Map(all.map((t) => [t.key, t.depends_on ?? []]));
  const state = new Map<string, number>();
  const visit = (k: string): boolean => {
    if (state.get(k) === 1) return true;
    if (state.get(k) === 2) return false;
    state.set(k, 1);
    for (const d of deps.get(k) ?? []) if (deps.has(d) && visit(d)) return true;
    state.set(k, 2);
    return false;
  };
  return all.some((t) => visit(t.key));
}

/**
 * Turn an approved plan into task rows. IDs are assigned by position:
 * T1, T2, T2.1 … (or <parent>.1, <parent>.2 for a split / fix).
 */
export function applyPlan(db: DB, m: Mission, plan: PendingPlan) {
  const existing = listTasks(db, m.id);
  const keyToId = new Map<string, string>();
  let orderBase = existing.reduce((mx, t) => Math.max(mx, t.order_idx), 0);
  // Existing task local IDs can be referenced directly in depends_on.
  for (const t of existing) keyToId.set(t.local_id, t.local_id);

  let topPrefix = "T";
  let topStart = 1;
  let parentLocal: string | null = null;
  if (plan.source === "split" && plan.split_of) {
    parentLocal = plan.split_of;
    topPrefix = `${plan.split_of}.`;
  } else {
    const nums = existing
      .filter((t) => t.parent_local === null && /^T\d+$/.test(t.local_id))
      .map((t) => Number(t.local_id.slice(1)));
    topStart = (nums.length ? Math.max(...nums) : 0) + 1;
  }

  type Row = { input: PlanTaskInput; id: string; parent: string | null };
  const rows: Row[] = [];
  const assign = (ts: PlanTaskInput[], prefix: string, start: number, parent: string | null) => {
    ts.forEach((t, i) => {
      const id = `${prefix}${start + i}`;
      keyToId.set(t.key, id);
      rows.push({ input: t, id, parent });
      if (t.children?.length) assign(t.children, `${id}.`, 1, id);
    });
  };
  assign(plan.tasks, topPrefix, topStart, parentLocal);

  const ins = db.prepare(`insert into tasks
    (id, mission_id, local_id, parent_local, kind, is_parent, title, goal, context, criteria, depends,
     order_idx, status, created_at, updated_at)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const ts = now();
  for (const r of rows) {
    const t = r.input;
    const isParent = t.children?.length ? 1 : 0;
    const kind = t.for_you ? "human" : "work";
    const depends = (t.depends_on ?? []).map((d) => keyToId.get(d) ?? d);
    ins.run(
      `${m.id}:${r.id}`,
      m.id,
      r.id,
      r.parent,
      kind,
      isParent,
      t.title,
      t.goal,
      t.context ?? "",
      JSON.stringify(t.criteria ?? []),
      JSON.stringify(depends),
      ++orderBase,
      "pending",
      ts,
      ts,
    );
  }
  if (plan.source === "split" && plan.split_of) {
    db.prepare("update tasks set is_parent = 1, status = 'pending', updated_at = ? where id = ?").run(
      ts,
      `${m.id}:${plan.split_of}`,
    );
  }
}

/** Expand a dependency on a parent task into its leaf tasks. */
export function leafIdsUnder(tasks: Task[], localId: string): string[] {
  const t = tasks.find((x) => x.local_id === localId);
  if (!t) return [];
  if (!t.is_parent) return [t.local_id];
  return tasks.filter((x) => x.parent_local === localId).flatMap((c) => leafIdsUnder(tasks, c.local_id));
}

export function renderPlanTree(tasks: PlanTaskInput[], indent = 0): string {
  const out: string[] = [];
  for (const t of tasks) {
    const deps = t.depends_on?.length ? `  (after ${t.depends_on.join(", ")})` : "";
    out.push(`${"  ".repeat(indent)}- [${t.key}] ${t.title}${t.for_you ? "  ← for you" : ""}${deps}`);
    out.push(`${"  ".repeat(indent + 1)}goal: ${t.goal}`);
    for (const c of t.criteria ?? []) out.push(`${"  ".repeat(indent + 1)}✓ ${c}`);
    if (t.children?.length) out.push(renderPlanTree(t.children, indent + 1));
  }
  return out.join("\n");
}
