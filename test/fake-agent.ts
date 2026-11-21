#!/usr/bin/env node
/**
 * A fake agent for tests. Launched by the engine as a "custom" harness.
 * Behaviour is driven by the role and by keywords in the task title:
 *   [ask]     first run asks a question; continues once answered
 *   [spend]   reports lots of tokens and hangs (to hit the budget)
 *   [slow]    sleeps 30 s before submitting (to test stop / recovery)
 *   [crash]   exits without submitting
 *   [split]   asks to split itself on the first run
 *   [perm]    asks for a permission on the first run
 * Verifier keywords (in the task title): [tamper] verifier edits a file; [vfail] first verdict fails; [shot] attaches screenshots.
 * The plan comes from FAKE_PLAN (JSON) in the environment.
 */
import fs from "node:fs";
import path from "node:path";

const url = process.env.NL_URL!;
const key = process.env.NL_KEY!;
const role = process.env.NL_ROLE!;
const briefing = fs.readFileSync(process.env.NL_BRIEFING_FILE!, "utf8");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function tool(name: string, args: unknown): Promise<string> {
  const res = await fetch(`${url}/api/tool/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify(args),
  });
  const body = (await res.json()) as { text?: string; error?: string };
  return body.text ?? `HTTP ${res.status}: ${body.error}`;
}

function usage(tokens: number, id = String(Math.random())) {
  // Claude stream-json style line, so the tracker counts it.
  console.log(JSON.stringify({ type: "assistant", message: { id, model: "fake-model", usage: { input_tokens: tokens, output_tokens: 0 }, content: [] } }));
}

const title = (briefing.match(/^# Northern Lights briefing: (?:task|verifying task) \S+ "([^"]*)"/m) ?? [])[1] ?? "";
const localId = (briefing.match(/^# Northern Lights briefing: (?:task|verifying task) (\S+)/m) ?? [])[1] ?? "";
const resumed = /## Last attempt/.test(briefing);

async function main() {
  usage(100, "first");
  if (role === "plan") {
    const plan = JSON.parse(process.env.FAKE_PLAN ?? "{}");
    const out = await tool("propose_plan", plan);
    console.log(out);
    if (out.startsWith("ERROR")) process.exit(3);
    return;
  }
  if (role === "verify") {
    const section = briefing.split("Acceptance criteria:\n")[1]?.split("\n\n")[0] ?? "";
    const list = section.split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2));
    if (title.includes("[tamper]") && !fs.existsSync(path.join(process.env.NL_HOME!, "tampered-once"))) {
      fs.writeFileSync(path.join(process.cwd(), "tampered.txt"), "verifier was here");
      // Remember outside the project folder so the second verifier behaves.
      fs.writeFileSync(path.join(process.env.NL_HOME!, "tampered-once"), "1");
    }
    const failFirst = title.includes("[vfail]") && !fs.existsSync(path.join(process.env.NL_HOME!, `vfail-${localId}`));
    if (failFirst) fs.writeFileSync(path.join(process.env.NL_HOME!, `vfail-${localId}`), "1");
    const isFinal = /final mission check/i.test(briefing);
    const items = (isFinal ? ["Mission goal works end to end"] : list).map((c) => ({
      criterion: c,
      met: !failFirst,
      evidence: failFirst ? "test_x fails: expected 1 got 2" : "checked: file exists and test_fake passes",
    }));
    const extra: Record<string, unknown> = isFinal && process.env.FAKE_OVERVIEW_UPDATE ? { overview_updates: process.env.FAKE_OVERVIEW_UPDATE } : {};
    if (title.includes("[shot]") && process.env.NL_SHOTS_DIR) {
      // A 1×1 PNG standing in for an agent-browser screenshot.
      const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
      fs.writeFileSync(path.join(process.env.NL_SHOTS_DIR, "page-loaded.png"), png);
      fs.writeFileSync(path.join(process.env.NL_SHOTS_DIR, "after-click.png"), png);
      fs.writeFileSync(path.join(process.cwd(), "..", "not-an-image.txt"), "x");
      extra.screenshots = [{ path: "page-loaded.png", caption: "Dashboard loaded" }, { path: path.join(process.env.NL_SHOTS_DIR, "after-click.png"), caption: "After clicking Refresh" }, { path: "../../../etc/passwd" }];
    }
    console.log(await tool("submit_verdict", { pass: !failFirst, criteria: items, feedback: failFirst ? "make test_x pass" : undefined, ...extra }));
    return;
  }
  // work
  await tool("log", { text: `starting ${localId}` });
  if (title.includes("[crash]")) process.exit(1);
  if (title.includes("[spend]")) {
    for (let i = 0; i < 100; i++) {
      usage(50_000, `m${i}`);
      await sleep(50);
    }
    await sleep(60_000);
  }
  if (title.includes("[slow]")) await sleep(30_000);
  if (title.includes("[ask]") && !resumed) {
    console.log(await tool("ask_human", { question: "argon2 or bcrypt?", choices: ["argon2", "bcrypt"], progress: "route stubbed" }));
    return;
  }
  if (title.includes("[perm]") && !resumed) {
    console.log(await tool("request_permission", { kind: "command", value: "npm install", reason: "need a package", progress: "half done" }));
    return;
  }
  if (title.includes("[split]") && !resumed && !/\.\d+$/.test(localId)) {
    console.log(
      await tool("request_split", {
        reason: "too big",
        tasks: [
          { key: "a", title: "first half", goal: "do a", criteria: ["a done"] },
          { key: "b", title: "second half", goal: "do b", criteria: ["b done"], depends_on: ["a"] },
        ],
      }),
    );
    return;
  }
  const file = `${localId.replace(/[^A-Za-z0-9.]/g, "_")}.txt`;
  fs.writeFileSync(path.join(process.cwd(), file), `made by ${localId}\n${resumed ? "resumed\n" : ""}`);
  await tool("note", { text: `${localId} files live at the root` });
  console.log(
    await tool("submit", {
      summary: `wrote ${file}`,
      files: [file],
      interfaces: "none",
      decisions: `${localId} uses plain text`,
      verify: `cat ${file}`,
    }),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
