// Smoke test for a packaged app: start its bundled engine on the app's own Electron binary,
// check the API and the screens respond, then shut it down cleanly.
// Usage: node smoke.mjs <electron-binary> <path-to-engine/src/cli.ts>
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const [bin, cli] = process.argv.slice(2);
if (!bin || !cli) {
  console.error("usage: node smoke.mjs <electron-binary> <engine cli.ts>");
  process.exit(2);
}
const home = fs.mkdtempSync(path.join(os.tmpdir(), "nl-smoke-"));
const port = 7600 + Math.floor(Math.random() * 300);
const child = spawn(bin, [cli, "serve", "--port", String(port)], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", NL_HOME: home, NL_NO_NOTIFY: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
child.stdout.on("data", (d) => (log += d));
child.stderr.on("data", (d) => (log += d));
const exited = new Promise((r) => child.on("exit", (code) => r(code)));
const fail = (msg) => {
  console.error(`SMOKE FAILED: ${msg}\n--- engine output ---\n${log}`);
  child.kill();
  process.exit(1);
};

const url = `http://127.0.0.1:${port}`;
let token = "";
for (let i = 0; i < 120 && !token; i++) {
  await new Promise((r) => setTimeout(r, 500));
  try {
    const r = await fetch(`${url}/api/tools`);
    if (r.ok) token = fs.readFileSync(path.join(home, "admin-token"), "utf8").trim();
  } catch {}
}
if (!token) fail("engine didn't start within 60s");

const auth = { authorization: `Bearer ${token}` };
const status = await fetch(`${url}/api/status`, { headers: auth });
if (!status.ok) fail(`/api/status → ${status.status}`);
const st = await status.json();
if (!Array.isArray(st.projects)) fail("unexpected /api/status body");

const login = await fetch(`${url}/login?k=${token}`, { redirect: "manual" });
const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
const page = await fetch(`${url}/`, { headers: { cookie } });
if (!(await page.text()).includes("app.js")) fail("UI page not served");
const js = await fetch(`${url}/app.js`, { headers: { cookie } });
if (!js.ok) fail("app.js not served");

// A real project + mission creation exercises the database, snapshots dir and file writes.
const proj = fs.mkdtempSync(path.join(os.tmpdir(), "nl-smoke-proj-"));
fs.writeFileSync(path.join(proj, "README.md"), "# smoke\n");
const add = await fetch(`${url}/api/projects`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ path: proj }) });
if (!add.ok) fail(`add project → ${add.status} ${await add.text()}`);
if (!fs.existsSync(path.join(proj, ".northern-lights", "project.yaml"))) fail("project.yaml not created");

const down = await fetch(`${url}/api/shutdown`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: "{}" });
if (!down.ok) fail(`/api/shutdown → ${down.status}`);
const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r("timeout"), 15000))]);
if (code === "timeout") fail("engine didn't exit after /api/shutdown");
console.log(`SMOKE OK (${process.platform}, engine exit ${code})`);
