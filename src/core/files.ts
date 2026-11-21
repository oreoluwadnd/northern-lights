import fs from "node:fs";
import path from "node:path";
import type { DB } from "./db.ts";
import type { Mission, Project, Task } from "./model.ts";
import { getLog, getProject, listTasks, runningRuns, taskSpend } from "./model.ts";
import { missionDir, slug } from "./project.ts";

const STATUS_MARK: Record<string, string> = {
  done: "x",
  in_progress: "~",
  verifying: "~",
  in_review: "?",
  cancelled: "-",
};

function statusLabel(t: Task): string {
  switch (t.status) {
    case "pending":
      return t.depends.length ? `waiting on ${t.depends.join(", ")}` : "pending";
    case "ready":
      return "next";
    case "your_turn":
      return "your turn";
    case "in_review":
      return "waiting for your review";
    case "waiting":
      return "waiting on you (question)";
    case "over_limit":
      return "over limit";
    case "needs_split":
      return "needs split";
    case "done":
      return "accepted";
    default:
      return t.status.replace(/_/g, " ");
  }
}

export function renderResult(r: Task["result"]): string {
  if (!r) return "";
  const lines = [
    `Summary:     ${r.summary}`,
    `Files:       ${r.files.join(", ") || "(none)"}`,
    `Interfaces:  ${r.interfaces.split("\n").join("\n             ")}`,
  ];
  if (r.decisions) lines.push(`Decisions:   ${r.decisions.split("\n").join("\n             ")}`);
  if (r.gotchas) lines.push(`Gotchas:     ${r.gotchas.split("\n").join("\n             ")}`);
  if (r.verify) lines.push(`Verify:      ${r.verify}`);
  return lines.join("\n");
}

export function renderVerification(t: Task): string {
  const v = t.verification;
  const out: string[] = [];
  if (v.checks?.length) out.push(`- Checks: ${v.checks.map((c) => `${c.command} ${c.ok ? "✓" : "✗"}`).join(" · ")}`);
  if (v.files_changed) {
    const mm = v.files_mismatch;
    const flag =
      mm && (mm.unlisted.length || mm.listed_but_unchanged.length)
        ? ` ⚠ differs from Result (not listed: ${mm.unlisted.join(", ") || "-"}; listed but unchanged: ${mm.listed_but_unchanged.join(", ") || "-"})`
        : " ✓ matches Result";
    out.push(`- Files changed (from snapshot): ${v.files_changed.join(", ") || "(none)"}${flag}`);
  }
  for (const vd of v.verdicts ?? []) {
    out.push(`- Verifier: ${vd.profile} · attempt ${vd.attempt} · ${vd.pass ? "PASS" : "FAIL"}`);
    for (const c of vd.criteria) out.push(`  - ${c.met ? "✓" : "✗"} ${c.criterion}: ${c.evidence}`);
    if (vd.feedback) out.push(`  - Feedback: ${vd.feedback}`);
  }
  return out.join("\n");
}

export function renderTaskFile(db: DB, m: Mission, t: Task): string {
  const project = getProject(db, m.project_id)!;
  const fm = [
    "---",
    `id: ${t.local_id}`,
    `title: ${t.title}`,
    `project: ${project.id}`,
    `mission: ${m.id}`,
    t.parent_local ? `parent: ${t.parent_local}` : null,
    `kind: ${t.kind === "human" ? "for you" : t.kind}`,
    `status: ${t.status}`,
    `depends_on: [${t.depends.join(", ")}]`,
    t.attempt ? `attempt: ${t.attempt}` : null,
    "---",
  ].filter(Boolean);
  const log = getLog(db, t.id)
    .map((l) => `- ${l.ts.slice(11, 16)} ${l.actor}: ${l.text}`)
    .join("\n");
  const spend = taskSpend(db, t.id);
  const parts = [
    fm.join("\n"),
    `## Goal\n${t.goal || "(none)"}`,
    t.context ? `## Context\n${t.context}` : null,
    t.criteria.length
      ? `## ${t.kind === "human" ? "Done when" : "Acceptance criteria"}\n${t.criteria
          .map((c) => `- [${t.status === "done" ? "x" : " "}] ${c}`)
          .join("\n")}`
      : null,
    `## Work log\n${log || "(empty)"}`,
    `## Result\n${renderResult(t.result) || "(not submitted yet)"}`,
    t.kind === "work" || t.kind === "mission_verify"
      ? `## Verification\n${renderVerification(t) || "(not verified yet)"}`
      : null,
    spend.tokens || spend.usd ? `<!-- spend: ${Math.round(spend.tokens)} tokens · $${spend.usd.toFixed(2)} -->` : null,
  ].filter(Boolean);
  return parts.join("\n\n") + "\n";
}

function todoLines(db: DB, tasks: Task[], parent: string | null, depth: number): string[] {
  const running = new Map(runningRuns(db).map((r) => [r.task_id, r]));
  const out: string[] = [];
  for (const t of tasks.filter((x) => x.parent_local === parent && x.kind !== "plan")) {
    const mark = STATUS_MARK[t.status] ?? " ";
    const who = running.get(t.id)?.profile;
    const label = t.is_parent ? "" : ` — ${who ? `${who} · ` : ""}${statusLabel(t)}`;
    const you = t.kind === "human" ? " (for you)" : "";
    out.push(`${"  ".repeat(depth)}- [${mark}] ${t.local_id} ${t.title}${you}${label}`);
    if (t.is_parent) out.push(...todoLines(db, tasks, t.local_id, depth + 1));
  }
  return out;
}

export function renderTodo(db: DB, m: Mission): string {
  const tasks = listTasks(db, m.id);
  const leaves = tasks.filter((t) => !t.is_parent && t.kind !== "plan");
  const done = leaves.filter((t) => t.status === "done").length;
  const status = `${m.status.replace(/_/g, " ")}${m.paused ? " (paused)" : ""}`;
  return [
    `# Mission: ${m.title}`,
    `Status: ${status} · ${done}/${leaves.length} done`,
    "",
    ...todoLines(db, tasks, null, 0),
    "",
  ].join("\n");
}

/** Rewrite MISSION.md, TODO.md and every task file for a mission. */
export function writeMissionFiles(db: DB, m: Mission) {
  const project: Project = getProject(db, m.project_id)!;
  const dir = missionDir(project, m.id, m.title);
  const tasksDir = path.join(dir, "tasks");
  fs.mkdirSync(tasksDir, { recursive: true });
  const missionMd = `# ${m.title}\n\n## Goal\n${m.goal}\n\n## Settings\n- Review mode: ${
    m.review_mode === "every" ? "review every task" : "auto-accept verified"
  }\n- Permission mode: ${m.permission_mode === "upfront" ? "approve up front" : "full access"}\n- Budget: ${
    m.budget_unit === "usd" ? `$${m.budget_task}/task, $${m.budget_mission}/mission` : `${m.budget_task} tokens/task, ${m.budget_mission} tokens/mission`
  }, ${m.time_limit_min} min per run\n`;
  fs.writeFileSync(path.join(dir, "MISSION.md"), missionMd);
  fs.writeFileSync(path.join(dir, "TODO.md"), renderTodo(db, m));
  const wanted = new Set<string>();
  for (const t of listTasks(db, m.id)) {
    if (t.kind === "plan") continue;
    const name = `${t.local_id}-${slug(t.title)}.md`;
    wanted.add(name);
    fs.writeFileSync(path.join(tasksDir, name), renderTaskFile(db, m, t));
  }
  for (const f of fs.readdirSync(tasksDir)) if (!wanted.has(f)) fs.rmSync(path.join(tasksDir, f));
}

export function missionGoalFile(db: DB, m: Mission): string {
  const project = getProject(db, m.project_id)!;
  return path.join(missionDir(project, m.id, m.title), "MISSION.md");
}
