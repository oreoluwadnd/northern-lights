import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileCheck, setup, taskStatus, waitFor, waitMission, waitTask, writeChecks } from "./helpers.ts";

const atomic = (key: string, title: string, extra: Record<string, unknown> = {}) => ({
  key,
  title,
  goal: `goal of ${title}`,
  criteria: [`${title} file exists`],
  ...extra,
});

test("happy path: plan → approve → work → verify → review → task for you → final check → done", async () => {
  const plan = {
    tasks: [
      atomic("one", "Write one"),
      { key: "key", title: "Add API key", goal: "put KEY in .env", criteria: ["KEY in .env"], for_you: true },
      atomic("two", "Write two", { depends_on: ["one", "key"] }),
    ],
    permissions: { commands: ["npm test"], domains: [], paths: [] },
    overview: "# toy\nStack: none\nRun: cat README.md\n",
  };
  const env = await setup(plan, { extraEnv: { FAKE_OVERVIEW_UPDATE: "# toy\nStack: none\nUpdated after M1\n" } });
  try {
    const p = await env.api("POST", "/api/projects", { path: env.proj });
    writeChecks(env.proj, [fileCheck("README.md")]);
    const m = await env.api("POST", "/api/missions", { project: p.id, title: "Toy mission", goal: "two files" });
    assert.equal(m.id, "M1");

    await waitMission(env, "M1", "awaiting_approval");
    const pv = await env.api("GET", "/api/missions/M1/plan");
    assert.match(pv.tree, /Write one/);
    assert.match(pv.tree, /for you/);
    const inbox1 = await env.api("GET", "/api/inbox");
    assert.ok(inbox1.some((i: any) => i.kind === "plan to approve"));

    await env.api("POST", "/api/missions/M1/approve", {});
    // PROJECT.md written from the plan.
    assert.match(fs.readFileSync(path.join(env.proj, ".northern-lights", "PROJECT.md"), "utf8"), /Stack: none/);
    // The task for you is up right away (no deps) and does not block agents.
    await waitTask(env, "M1:T2", "your_turn");
    await waitTask(env, "M1:T1", "in_review");

    const review = await env.api("GET", "/api/tasks/M1:T1?diff=1");
    assert.match(review.diff, /\+made by T1/);
    assert.doesNotMatch(review.diff, /node_modules/);
    assert.match(review.file, /Verifier: fake2 · attempt 1 · PASS/);
    assert.match(review.file, /Checks: node -e .*README\.md.* ✓/);
    assert.match(review.file, /matches Result/);

    await env.api("POST", "/api/tasks/M1:T1/accept", {});
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(await taskStatus(env, "M1:T3"), "pending", "T3 waits for the task for you");

    await env.api("POST", "/api/tasks/M1:T2/done", { note: "KEY is in .env as API_KEY" });
    await waitTask(env, "M1:T3", "in_review");
    const t3 = await env.api("GET", "/api/tasks/M1:T3");
    assert.ok(fs.readFileSync(t3.runs[0].log_path.replace("output.log", "briefing.md"), "utf8").includes("KEY is in .env as API_KEY"), "briefing carries the human's note");
    await env.api("POST", "/api/tasks/M1:T3/accept", {});

    await waitMission(env, "M1", "final_review");
    const inbox2 = await env.api("GET", "/api/inbox");
    assert.ok(inbox2.some((i: any) => i.kind === "final approval"));
    await env.api("POST", "/api/missions/M1/accept", {});
    await waitMission(env, "M1", "done");

    const nl = path.join(env.proj, ".northern-lights");
    assert.match(fs.readFileSync(path.join(nl, "PROJECT.md"), "utf8"), /Updated after M1/);
    const decisions = fs.readFileSync(path.join(nl, "DECISIONS.md"), "utf8");
    assert.match(decisions, /T1 uses plain text/);
    assert.match(decisions, /T1 files live at the root/);
    const mdir = path.join(nl, "missions", "M1-toy-mission");
    const todo = fs.readFileSync(path.join(mdir, "TODO.md"), "utf8");
    assert.match(todo, /- \[x\] T1 Write one/);
    assert.match(todo, /- \[x\] T2 Add API key \(for you\)/);
    assert.ok(fs.existsSync(path.join(mdir, "tasks", "T1-write-one.md")));
    assert.ok(fs.existsSync(path.join(env.proj, "T1.txt")) && fs.existsSync(path.join(env.proj, "T3.txt")));
  } finally {
    await env.close();
  }
});

test("questions, permission requests, verifier failure and auto-accept", async () => {
  const plan = {
    tasks: [
      atomic("a", "[ask] hashing"),
      atomic("b", "[perm] install", { depends_on: ["a"] }),
      atomic("c", "[vfail] third", { depends_on: ["b"] }),
    ],
    overview: "# toy\n",
  };
  const env = await setup(plan);
  try {
    const p = await env.api("POST", "/api/projects", { path: env.proj });
    await env.api("POST", "/api/missions", { project: p.id, title: "Asks", review_mode: "auto" });
    await waitMission(env, "M1", "awaiting_approval");
    await env.api("POST", "/api/missions/M1/approve", {});

    await waitTask(env, "M1:T1", "waiting");
    const inbox = await env.api("GET", "/api/inbox");
    const q = inbox.find((i: any) => i.kind === "question");
    assert.match(q.detail, /argon2 or bcrypt\?/);
    await env.api("POST", "/api/tasks/M1:T1/answer", { text: "argon2" });
    await waitTask(env, "M1:T1", "done");
    assert.match(fs.readFileSync(path.join(env.proj, "T1.txt"), "utf8"), /resumed/);

    await waitTask(env, "M1:T2", "waiting");
    const inbox2 = await env.api("GET", "/api/inbox");
    assert.ok(inbox2.some((i: any) => i.kind === "permission request" && /npm install/.test(i.detail)));
    await env.api("POST", "/api/tasks/M1:T2/permit", { decision: "mission" });
    await waitTask(env, "M1:T2", "done");
    const mv = await env.api("GET", "/api/missions/M1");
    assert.ok(mv.mission.permissions.commands.includes("npm install"));

    await waitTask(env, "M1:T3", "done");
    const t3 = await env.api("GET", "/api/tasks/M1:T3");
    assert.equal(t3.task.verification.verdicts.length, 2);
    assert.equal(t3.task.verification.verdicts[0].pass, false);
    assert.equal(t3.task.failures, 1);
    await waitMission(env, "M1", "final_review");
  } finally {
    await env.close();
  }
});

test("budget: a task that overspends is stopped and goes to Over limit", async () => {
  const env = await setup({ tasks: [atomic("x", "[spend] big")], overview: "# toy\n" });
  try {
    const p = await env.api("POST", "/api/projects", { path: env.proj });
    await env.api("POST", "/api/missions", {
      project: p.id,
      title: "Spendy",
      budget_unit: "tokens",
      budget_task: 1_000_000,
      budget_mission: 50_000_000,
    });
    await waitMission(env, "M1", "awaiting_approval");
    await env.api("POST", "/api/missions/M1/approve", {});
    await waitTask(env, "M1:T1", "over_limit");
    const t = await env.api("GET", "/api/tasks/M1:T1");
    const run = t.runs.find((r: any) => r.role === "work");
    assert.equal(run.stop_reason, "budget");
    assert.ok(run.tokens >= 1_000_000 && run.tokens < 2_000_000, `stopped near the limit (${run.tokens})`);
    const inbox = await env.api("GET", "/api/inbox");
    assert.ok(inbox.some((i: any) => i.kind === "over limit"));
    // Project stays busy while over limit.
    const st = await env.api("GET", "/api/status");
    assert.equal(st.projects[0].busy.task, "M1:T1");
  } finally {
    await env.close();
  }
});

test("mission budget pauses the mission", async () => {
  const env = await setup({ tasks: [atomic("x", "[spend] big")], overview: "# toy\n" });
  try {
    const p = await env.api("POST", "/api/projects", { path: env.proj });
    await env.api("POST", "/api/missions", { project: p.id, title: "Cap", budget_unit: "tokens", budget_task: 100_000_000, budget_mission: 800_000 });
    await waitMission(env, "M1", "awaiting_approval");
    await env.api("POST", "/api/missions/M1/approve", {});
    await waitFor("mission paused", async () => (await env.api("GET", "/api/missions/M1")).mission.paused === 1);
    const inbox = await env.api("GET", "/api/inbox");
    assert.ok(inbox.some((i: any) => i.kind === "paused" && /budget used up/.test(i.detail)));
    await env.api("POST", "/api/stop", {});
    const r = await env.api("POST", "/api/resume", {});
    assert.equal(r.resumed.length, 0);
    assert.match(r.skipped[0], /raise it first/);
  } finally {
    await env.close();
  }
});

test("stop all, resume, and discard / undo-discard", async () => {
  const env = await setup({ tasks: [atomic("x", "[slow] first"), atomic("y", "plain second")], overview: "# toy\n" });
  try {
    const p = await env.api("POST", "/api/projects", { path: env.proj });
    await env.api("POST", "/api/missions", { project: p.id, title: "Stoppable" });
    await waitMission(env, "M1", "awaiting_approval");
    await env.api("POST", "/api/missions/M1/approve", {});
    await waitTask(env, "M1:T1", "in_progress");
    const r = await env.api("POST", "/api/stop", {});
    assert.equal(r.stopped, 1);
    await waitTask(env, "M1:T1", "ready");
    const mv = await env.api("GET", "/api/missions/M1");
    assert.equal(mv.mission.paused, 1);
    await new Promise((res) => setTimeout(res, 400));
    assert.equal(await taskStatus(env, "M1:T1"), "ready", "nothing restarts while paused");

    // Cancel the slow task instead, let T2 run, then discard T2.
    await env.api("POST", "/api/tasks/M1:T1/cancel", {});
    await env.api("POST", "/api/resume", { target: "M1" });
    await waitTask(env, "M1:T2", "in_review");
    assert.ok(fs.existsSync(path.join(env.proj, "T2.txt")));
    fs.writeFileSync(path.join(env.proj, "README.md"), "# changed by a task\n"); // simulate an edit inside the task
    await env.api("POST", "/api/stop", {}); // pause, so the final check doesn't take the folder after the discard
    await env.api("POST", "/api/tasks/M1:T2/discard", { cancel: true });
    assert.ok(!fs.existsSync(path.join(env.proj, "T2.txt")), "discard removed the task's file");
    assert.equal(fs.readFileSync(path.join(env.proj, "README.md"), "utf8"), "# toy\n", "discard restored edited files");
    assert.ok(fs.existsSync(path.join(env.proj, "node_modules", "dep", "index.js")), "excluded folders untouched");
    await env.api("POST", "/api/tasks/M1:T2/undo-discard", {});
    assert.ok(fs.existsSync(path.join(env.proj, "T2.txt")), "undo brought it back");
  } finally {
    await env.close();
  }
});

test("verifier that edits files: changes undone, verdict thrown out, verified again", async () => {
  const env = await setup({ tasks: [atomic("x", "[tamper] guarded")], overview: "# toy\n" });
  try {
    const p = await env.api("POST", "/api/projects", { path: env.proj });
    await env.api("POST", "/api/missions", { project: p.id, title: "Tamper" });
    await waitMission(env, "M1", "awaiting_approval");
    await env.api("POST", "/api/missions/M1/approve", {});
    await waitTask(env, "M1:T1", "in_review");
    assert.ok(!fs.existsSync(path.join(env.proj, "tampered.txt")));
    const t = await env.api("GET", "/api/tasks/M1:T1");
    assert.match(t.file, /Verifier changed 1 file/);
    assert.equal(t.runs.filter((r: any) => r.role === "verify").length, 2);
  } finally {
    await env.close();
  }
});

test("failing checks go back to the agent, then Stuck after 3", async () => {
  const env = await setup({ tasks: [atomic("x", "never passes")], overview: "# toy\n" });
  try {
    const p = await env.api("POST", "/api/projects", { path: env.proj });
    writeChecks(env.proj, [fileCheck("never.txt")]);
    await env.api("POST", "/api/missions", { project: p.id, title: "Checks" });
    await waitMission(env, "M1", "awaiting_approval");
    await env.api("POST", "/api/missions/M1/approve", {});
    await waitTask(env, "M1:T1", "stuck", 30000);
    const t = await env.api("GET", "/api/tasks/M1:T1");
    assert.equal(t.task.failures, 3);
    assert.match(t.task.feedback, /never\.txt/);
    assert.equal(t.runs.filter((r: any) => r.role === "verify").length, 0, "verifier never ran");
    await env.api("POST", "/api/tasks/M1:T1/retry", { note: "create never.txt" });
    assert.ok(["ready", "in_progress"].includes(await taskStatus(env, "M1:T1")), "retry puts it back in the queue");
    const after = await env.api("GET", "/api/tasks/M1:T1");
    assert.equal(after.task.failures, 0);
    assert.match(after.task.feedback, /create never.txt/);
    await env.api("POST", "/api/stop", {});
  } finally {
    await env.close();
  }
});

test("a task too big asks to split; approving makes it a parent", async () => {
  const env = await setup({ tasks: [atomic("x", "[split] huge")], overview: "# toy\n" });
  try {
    const p = await env.api("POST", "/api/projects", { path: env.proj });
    await env.api("POST", "/api/missions", { project: p.id, title: "Split", review_mode: "auto" });
    await waitMission(env, "M1", "awaiting_approval");
    await env.api("POST", "/api/missions/M1/approve", {});
    await waitTask(env, "M1:T1", "needs_split");
    const pv = await env.api("GET", "/api/missions/M1/plan");
    assert.equal(pv.plan.source, "split");
    await env.api("POST", "/api/missions/M1/approve", {});
    await waitTask(env, "M1:T1.2", "done");
    assert.equal(await taskStatus(env, "M1:T1"), "done");
    await waitMission(env, "M1", "final_review");
  } finally {
    await env.close();
  }
});

test("crash recovery: orphaned task back to Ready, missions paused", async () => {
  const env = await setup({ tasks: [atomic("x", "[slow] long")], overview: "# toy\n" });
  try {
    const p = await env.api("POST", "/api/projects", { path: env.proj });
    await env.api("POST", "/api/missions", { project: p.id, title: "Crashy" });
    await waitMission(env, "M1", "awaiting_approval");
    await env.api("POST", "/api/missions/M1/approve", {});
    await waitTask(env, "M1:T1", "in_progress");
    await env.restart({ crash: true });
    assert.equal(await taskStatus(env, "M1:T1"), "ready");
    const mv = await env.api("GET", "/api/missions/M1");
    assert.equal(mv.mission.paused, 1);
    const t = await env.api("GET", "/api/tasks/M1:T1");
    assert.equal(t.runs[0].status, "orphaned");
    assert.match(t.file, /Server restarted while this task was running/);
  } finally {
    await env.close();
  }
});

test("one task at a time per project; a second mission waits in the queue", async () => {
  const env = await setup({ tasks: [atomic("x", "[slow] hold")], overview: "# toy\n" });
  try {
    const p = await env.api("POST", "/api/projects", { path: env.proj });
    await env.api("POST", "/api/missions", { project: p.id, title: "First" });
    await env.api("POST", "/api/missions", { project: p.id, title: "Second" });
    await waitMission(env, "M1", "awaiting_approval");
    await env.api("POST", "/api/missions/M1/approve", {});
    await waitTask(env, "M1:T1", "in_progress");
    const m2 = await env.api("GET", "/api/missions/M2");
    assert.equal(m2.mission.status, "queued");
    const st = await env.api("GET", "/api/status");
    assert.equal(st.runs.length, 1);
    await env.api("POST", "/api/stop", {});
  } finally {
    await env.close();
  }
});
