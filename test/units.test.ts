import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseYaml } from "../src/core/yaml.ts";
import { validatePlan } from "../src/core/plan.ts";
import { UsageTracker } from "../src/core/runner.ts";
import { changedFiles, restoreSnapshot, takeSnapshot } from "../src/core/snapshots.ts";
import { buildLaunch } from "../src/core/runner.ts";

test("yaml subset", () => {
  const y = parseYaml(`# c\nchecks:\n  - npm test\n  - "npm run lint"   # trailing\nempty: []\nname: hello\n`);
  assert.deepEqual(y, { checks: ["npm test", "npm run lint"], empty: [], name: "hello" });
  assert.throws(() => parseYaml("  - orphan\n"), /list item without a key/);
});

test("plan validation", () => {
  const ok = [
    { key: "a", title: "A", goal: "g", criteria: ["c"] },
    { key: "b", title: "B", goal: "g", depends_on: ["a"], children: [{ key: "b1", title: "B1", goal: "g", criteria: ["c"] }] },
  ];
  assert.deepEqual(validatePlan(ok), []);
  assert.match(validatePlan([{ key: "a", title: "A", goal: "g" }]).join(), /need acceptance criteria/);
  assert.match(validatePlan([{ key: "a", title: "A", goal: "g", criteria: ["c"], depends_on: ["zz"] }]).join(), /unknown "zz"/);
  const cyc = [
    { key: "a", title: "A", goal: "g", criteria: ["c"], depends_on: ["b"] },
    { key: "b", title: "B", goal: "g", criteria: ["c"], depends_on: ["a"] },
  ];
  assert.match(validatePlan(cyc).join(), /cycle/);
  const deep = { key: "1", title: "t", goal: "g", children: [{ key: "2", title: "t", goal: "g", children: [{ key: "3", title: "t", goal: "g", children: [{ key: "4", title: "t", goal: "g", criteria: ["c"] }] }] }] };
  assert.match(validatePlan([deep]).join(), /deeper than 3/);
});

test("usage tracker: claude stream de-duplicates messages and excludes cache reads", () => {
  const t = new UsageTracker("claude-stream");
  const msg = (id: string, u: object) => JSON.stringify({ type: "assistant", message: { id, model: "m", usage: u } });
  t.feed(msg("a", { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 5000, output_tokens: 1 }));
  t.feed(msg("a", { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 5000, output_tokens: 20 }));
  t.feed(msg("b", { input_tokens: 5, output_tokens: 5 }));
  assert.equal(t.tokens, 10 + 100 + 20 + 5 + 5);
  assert.equal(t.breakdown().cache_read, 5000);
  t.feed(JSON.stringify({ type: "result", total_cost_usd: 0.42 }));
  assert.equal(t.usdFinal, 0.42);
});

test("snapshots: diff and restore, excluded folders untouched", () => {
  process.env.NL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "nl-home-"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nl-snap-"));
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "src", "a.ts"), "a\n");
  fs.writeFileSync(path.join(dir, "keep.txt"), "keep\n");
  fs.mkdirSync(path.join(dir, "node_modules"));
  fs.writeFileSync(path.join(dir, "node_modules", "x.js"), "x\n");
  const snap = takeSnapshot(dir, "p", "T1", { exclude: ["node_modules"] });
  assert.ok(!fs.existsSync(path.join(snap, "node_modules")));
  fs.writeFileSync(path.join(dir, "src", "a.ts"), "changed\n");
  fs.rmSync(path.join(dir, "keep.txt"));
  fs.mkdirSync(path.join(dir, "new"));
  fs.writeFileSync(path.join(dir, "new", "b.ts"), "b\n");
  fs.writeFileSync(path.join(dir, "node_modules", "y.js"), "y\n");
  assert.deepEqual(changedFiles(snap, dir, ["node_modules"]).map((c) => `${c.kind}:${c.file}`), [
    "deleted:keep.txt",
    "added:new/b.ts",
    "modified:src/a.ts",
  ]);
  const safety = restoreSnapshot(snap, dir, "p", { exclude: ["node_modules"] });
  assert.equal(fs.readFileSync(path.join(dir, "src", "a.ts"), "utf8"), "a\n");
  assert.ok(fs.existsSync(path.join(dir, "keep.txt")));
  assert.ok(!fs.existsSync(path.join(dir, "new")), "empty new folder removed");
  assert.ok(fs.existsSync(path.join(dir, "node_modules", "y.js")), "excluded folder left alone");
  assert.equal(fs.readFileSync(path.join(safety, "src", "a.ts"), "utf8"), "changed\n", "safety snapshot kept the pre-restore state");
});

test("claude launch: permissions become allowed tools; plan/verify are read-only", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nl-run-"));
  const base = {
    cwd: "/proj", briefing: "b", runDir: dir, key: "k", serverUrl: "http://x", mcpScript: "/m.ts", cliScript: "/c.ts", taskId: "M1:T1",
    permissions: { commands: ["npm test"], domains: ["registry.npmjs.org"], paths: ["/shared"] },
  };
  const work = buildLaunch({ harness: "claude", model: "sonnet" }, { ...base, role: "work", permissionMode: "upfront" });
  assert.ok(work.args.includes("Bash(npm test:*)"));
  assert.ok(work.args.includes("WebFetch(domain:registry.npmjs.org)"));
  assert.ok(work.args.includes("Edit"));
  assert.deepEqual(work.args.slice(work.args.indexOf("--permission-mode"), work.args.indexOf("--permission-mode") + 2), ["--permission-mode", "acceptEdits"]);
  assert.ok(work.args.includes("--add-dir") && work.args.includes("/shared"));
  assert.ok(!work.args.includes("--dangerously-skip-permissions"));
  const verify = buildLaunch({ harness: "claude" }, { ...base, role: "verify", permissionMode: "full" });
  assert.ok(verify.args.includes("--dangerously-skip-permissions"));
  assert.ok(verify.args.indexOf("--disallowedTools") >= 0 && verify.args.includes("Write"));
  const mcp = JSON.parse(fs.readFileSync(path.join(dir, "mcp.json"), "utf8"));
  assert.equal(mcp.mcpServers["northern-lights"].env.NL_KEY, "k");
});

test("antigravity launch: per-run allow rules, accept-edits only for workers, prompt attached to -p", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nl-run-"));
  const base = {
    cwd: "/proj", briefing: "do the thing", runDir: dir, key: "k", serverUrl: "http://x", mcpScript: "/m.ts", cliScript: "/c.ts", taskId: "M1:T1",
    permissions: { commands: ["npm test"], domains: [], paths: ["/shared"] },
  };
  const work = buildLaunch({ harness: "antigravity", model: "gemini-3.8-flash-high" }, { ...base, role: "work", permissionMode: "upfront" });
  assert.equal(work.cmd, "agy");
  assert.equal(work.output, "agy-stream");
  assert.equal(work.env.NL_KEY, "k", "the global MCP entry gets the run key from the environment");
  assert.ok(work.args.includes("-p=do the thing"));
  assert.deepEqual(work.args.slice(work.args.indexOf("--model"), work.args.indexOf("--model") + 2), ["--model", "gemini-3.8-flash-high"]);
  assert.deepEqual(work.args.slice(work.args.indexOf("--mode"), work.args.indexOf("--mode") + 2), ["--mode", "accept-edits"]);
  const allow = JSON.parse(work.args[work.args.indexOf("--settings") + 1]).permissions.allow;
  assert.ok(allow.includes("command(npm test)"));
  assert.ok(allow.includes("command(ls)"), "read-only exploration never ends a run");
  assert.ok(allow.includes("mcp(northern-lights/submit)"));
  assert.ok(work.args.includes("/shared"));
  const verify = buildLaunch({ harness: "antigravity" }, { ...base, role: "verify", permissionMode: "upfront" });
  assert.ok(!verify.args.includes("accept-edits"), "verifier edits stay denied in headless mode");
  const full = buildLaunch({ harness: "antigravity" }, { ...base, role: "work", permissionMode: "full" });
  assert.ok(full.args.includes("--dangerously-skip-permissions"));
});

test("usage tracker: agy stream sums steps, counts thinking as output, excludes cache reads", async () => {
  const t = new UsageTracker("agy-stream");
  t.feed(JSON.stringify({ event: "init", init: { model: "gemini-3.8-flash-low" } }));
  t.feed(JSON.stringify({ event: "step_update", step_update: { conversation_id: "c", step_index: 1, state: "DONE", usage: { input_tokens: 9734, output_tokens: 74, thinking_tokens: 6, cache_read_tokens: 0 } } }));
  t.feed(JSON.stringify({ event: "step_update", step_update: { conversation_id: "c", step_index: 2, state: "ACTIVE", tool_name: "read_file" } }));
  t.feed(JSON.stringify({ event: "step_update", step_update: { conversation_id: "c", step_index: 3, state: "DONE", usage: { input_tokens: 2203, output_tokens: 1, thinking_tokens: 0, cache_read_tokens: 7691 } } }));
  assert.equal(t.model, "gemini-3.8-flash-low");
  assert.equal(t.tokens, 9734 + 80 + 2203 + 1);
  assert.equal(t.breakdown().cache_read, 7691);
  const { resolveProfile, defaultConfig } = await import("../src/core/config.ts");
  const c = defaultConfig();
  assert.deepEqual(resolveProfile(c, "antigravity:gemini-4-neon-high"), { harness: "antigravity", model: "gemini-4-neon-high", output: "agy-stream" });
  assert.equal(resolveProfile(c, "claude-opus")?.model, "opus");
  assert.equal(resolveProfile(c, "nope:thing"), null);
});

test("approved commands also match their full path", async () => {
  const { withFullPaths } = await import("../src/core/runner.ts");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nl-bin-"));
  fs.writeFileSync(path.join(dir, "mytool"), "#!/bin/sh\n", { mode: 0o755 });
  const old = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${old}`;
  try {
    const out = withFullPaths(["mytool open", "npm test", "/abs/thing"]);
    assert.ok(out.includes("mytool open"));
    assert.ok(out.includes(`${path.join(dir, "mytool")} open`));
    assert.ok(out.includes("/abs/thing"));
  } finally {
    process.env.PATH = old;
  }
});

test("built-in diff (for Windows): patches apply exactly and match diff -u on simple cases", async () => {
  const { unifiedDiff, diffLines } = await import("../src/core/snapshots.ts");
  const apply = (a: string[], patch: string): string[] => {
    const out: string[] = [];
    let ai = 0;
    const lines = patch.split("\n");
    for (let i = 2; i < lines.length; i++) {
      const h = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@$/.exec(lines[i]);
      if (!h) continue;
      const aStart = Number(h[2]) === 0 ? Number(h[1]) : Number(h[1]) - 1;
      while (ai < aStart) out.push(a[ai++]);
      for (i++; i < lines.length && !lines[i].startsWith("@@"); i++) {
        const l = lines[i];
        if (l === "") continue;
        if (l[0] === " ") (out.push(l.slice(1)), ai++);
        else if (l[0] === "-") ai++;
        else if (l[0] === "+") out.push(l.slice(1));
      }
      i--;
    }
    while (ai < a.length) out.push(a[ai++]);
    return out;
  };
  let seed = 42;
  const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2147483648) % n);
  for (let t = 0; t < 300; t++) {
    const a = Array.from({ length: rnd(40) }, () => `line ${rnd(12)}`);
    const b = a.slice();
    for (let e = rnd(8); e > 0; e--) {
      const k = rnd(3);
      const at = rnd(b.length + 1);
      if (k === 0) b.splice(at, 0, `new ${rnd(50)}`);
      else if (k === 1 && b.length) b.splice(Math.min(at, b.length - 1), 1);
      else if (b.length) b[Math.min(at, b.length - 1)] = `changed ${rnd(50)}`;
    }
    const edits = diffLines(a, b);
    assert.deepEqual(edits.filter((x) => x.op !== "+").map((x) => x.line), a);
    assert.deepEqual(edits.filter((x) => x.op !== "-").map((x) => x.line), b);
    assert.deepEqual(apply(a, unifiedDiff(a, b, "f.txt")), b, `case ${t}`);
  }
  assert.equal(unifiedDiff(["x"], ["x"], "f"), "");
  assert.equal(unifiedDiff([], ["hello"], "new.txt"), "--- a/new.txt\n+++ b/new.txt\n@@ -0,0 +1,1 @@\n+hello\n");
  const a = Array.from({ length: 20 }, (_, i) => `l${i}`);
  const b = a.slice();
  b[2] = "two";
  b[15] = "fifteen";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nl-diff-"));
  fs.writeFileSync(path.join(dir, "a"), a.join("\n") + "\n");
  fs.writeFileSync(path.join(dir, "b"), b.join("\n") + "\n");
  const { spawnSync } = await import("node:child_process");
  const sys = spawnSync("diff", ["-u", "--label", "a/f", "--label", "b/f", path.join(dir, "a"), path.join(dir, "b")], { encoding: "utf8" });
  if (sys.status !== null && sys.stdout) assert.equal(unifiedDiff(a, b, "f"), sys.stdout);
});
