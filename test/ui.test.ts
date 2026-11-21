import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { adminToken } from "../src/server.ts";
import { setup, waitMission, waitTask } from "./helpers.ts";

const atomic = (key: string, title: string, extra: Record<string, unknown> = {}) => ({
  key,
  title,
  goal: `goal of ${title}`,
  criteria: [`${title} file exists`],
  ...extra,
});

test("ui: login cookie, static files, task/mission views, settings switch auto-accepts", async () => {
  const env = await setup({ tasks: [atomic("one", "Write one"), atomic("two", "Write two", { depends_on: ["one"] })], overview: "# toy\n" });
  try {
    const base = env.s.url;
    // Without a cookie, / shows the "open the app" page and the API refuses.
    assert.equal((await fetch(base + "/")).status, 401);
    assert.equal((await fetch(base + "/api/status")).status, 401);
    assert.equal((await fetch(base + "/login?k=wrong", { redirect: "manual" })).status, 401);

    const login = await fetch(base + `/login?k=${adminToken()}`, { redirect: "manual" });
    assert.equal(login.status, 302);
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
    assert.match(cookie, /^nl_admin=/);
    assert.match(login.headers.get("set-cookie") ?? "", /HttpOnly/);
    assert.match(login.headers.get("set-cookie") ?? "", /SameSite=Strict/);

    const page = await fetch(base + "/", { headers: { cookie } });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<script src="\/app.js">/);
    const js = await fetch(base + "/app.js", { headers: { cookie } });
    assert.match(js.headers.get("content-type") ?? "", /javascript/);
    assert.equal((await fetch(base + "/../package.json", { headers: { cookie } })).status, 404);
    assert.equal((await fetch(base + "/%2e%2e/package.json", { headers: { cookie } })).status, 404);
    assert.equal((await fetch(base + "/api/status", { headers: { cookie } })).status, 200);
    // The cookie is ignored when the Host isn't this machine (DNS rebinding).
    const evilStatus = await new Promise<number>((resolve, reject) => {
      const u = new URL(base + "/api/status");
      http
        .get({ host: u.hostname, port: u.port, path: u.pathname, headers: { cookie, host: "evil.example:7477" } }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        })
        .on("error", reject);
    });
    assert.equal(evilStatus, 401);

    const p = await env.api("POST", "/api/projects", { path: env.proj });
    await env.api("POST", "/api/missions", { project: p.id, title: "UI mission", goal: "two files" });
    await waitMission(env, "M1", "awaiting_approval");
    await env.api("POST", "/api/missions/M1/approve", {});
    await waitTask(env, "M1:T1", "in_review");

    const tv = await env.api("GET", "/api/tasks/M1:T1?diff=1");
    assert.ok(tv.log.length > 0, "task view has the activity log");
    assert.equal(tv.mission.id, "M1");
    const mv = await env.api("GET", "/api/missions/M1");
    assert.ok(mv.tasks[0].spend, "mission view has per-task spend");
    const st = await env.api("GET", "/api/status");
    assert.deepEqual(st.projects[0].missions[0].progress, { done: 0, total: 2 });

    // Bad values are refused.
    await assert.rejects(env.api("PATCH", "/api/missions/M1", { review_mode: "sometimes" }), /review must be/);
    await assert.rejects(env.api("PATCH", "/api/missions/M1", { budget_task: -1 }), /positive/);

    // Switching to auto-accept accepts the task waiting in review, and the rest flows on its own.
    const r = await env.api("PATCH", "/api/missions/M1", { review_mode: "auto", budget_task: 3 });
    assert.deepEqual(r.accepted, ["M1:T1"]);
    assert.equal(r.mission.budget_task, 3);
    await waitTask(env, "M1:T2", "done");
    await waitMission(env, "M1", "final_review");

    // A finished task's diff is frozen at accept time: T1's doesn't pick up T2's file.
    const d1 = await env.api("GET", "/api/tasks/M1:T1?diff=1");
    assert.match(d1.diff, /T1\.txt/);
    assert.doesNotMatch(d1.diff, /T2\.txt/);
    assert.equal(d1.diff_note, undefined);
  } finally {
    await env.close();
  }
});

test("ui: verifier screenshots are stored with captions and served to the app", async () => {
  const env = await setup({ tasks: [atomic("one", "[shot] Dashboard page")], overview: "# toy\n" });
  try {
    const p = await env.api("POST", "/api/projects", { path: env.proj });
    await env.api("POST", "/api/missions", { project: p.id, title: "Shots", goal: "a page" });
    await waitMission(env, "M1", "awaiting_approval");
    await env.api("POST", "/api/missions/M1/approve", {});
    await waitTask(env, "M1:T1", "in_review");
    const tv = await env.api("GET", "/api/tasks/M1:T1");
    const shots = tv.task.verification.verdicts.at(-1).screenshots;
    assert.deepEqual(shots.map((s: any) => s.caption), ["Dashboard loaded", "After clicking Refresh"], "paths outside the shots folder that aren't images are dropped");
    const login = await fetch(env.s.url + `/login?k=${adminToken()}`, { redirect: "manual" });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
    const img = await fetch(env.s.url + `/api/shots/M1%3AT1/${shots[0].file}`, { headers: { cookie } });
    assert.equal(img.status, 200);
    assert.equal(img.headers.get("content-type"), "image/png");
    assert.equal((await fetch(env.s.url + `/api/shots/M1%3AT1/${shots[0].file}`)).status, 401, "needs the admin cookie");
    assert.equal((await fetch(env.s.url + `/api/shots/M1%3AT1/..%2F..%2Fadmin-token`, { headers: { cookie } })).status, 404);
  } finally {
    await env.close();
  }
});
