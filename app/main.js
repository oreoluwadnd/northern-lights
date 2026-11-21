// Northern Lights Mac app.
// The engine (src/, run by Node) does the work. This app starts it if it isn't running,
// shows its screens in a window, and turns its events into Mac notifications and a Dock badge.
const { app, BrowserWindow, dialog, ipcMain, Menu, Notification, shell } = require("electron");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const HOME = process.env.NL_HOME || path.join(os.homedir(), ".northern-lights");
// Shareable builds carry the engine inside the app and run it with Electron's own Node (no Node install needed).
// Local builds run it from this checkout (nl-path.json points there).
const BUNDLED_ENGINE = process.resourcesPath ? path.join(process.resourcesPath, "engine") : "";
const IS_BUNDLED = !!BUNDLED_ENGINE && fs.existsSync(path.join(BUNDLED_ENGINE, "src", "cli.ts"));
const ROOT = (() => {
  if (IS_BUNDLED) return BUNDLED_ENGINE;
  const f = path.join(__dirname, "nl-path.json"); // written by build.sh into the packaged app
  if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, "utf8")).root;
  return path.resolve(__dirname, "..");
})();

let win = null;
let engine = null; // child process, if this app started the engine
let engineUrl = null;
let events = null;
let quitting = false;

const IS_MAC = process.platform === "darwin";
const IS_WIN = process.platform === "win32";

if (!app.requestSingleInstanceLock()) app.quit();
app.setName("Northern Lights");
if (IS_WIN) app.setAppUserModelId("dev.northernlights.app");

// Apps opened from the Dock get a bare PATH. Borrow the login shell's so the engine finds node, claude, codex…
function loginPath() {
  if (IS_WIN) return process.env.PATH ?? "";
  try {
    const r = spawnSync(process.env.SHELL || "/bin/zsh", ["-ilc", 'printf "__P__%s__P__" "$PATH"'], { encoding: "utf8", timeout: 8000 });
    const m = /__P__(.*)__P__/.exec(r.stdout || "");
    if (m && m[1]) return m[1];
  } catch {}
  return [process.env.PATH, "/opt/homebrew/bin", "/usr/local/bin", path.join(os.homedir(), ".local/bin")].filter(Boolean).join(":");
}

function readToken() {
  try {
    return fs.readFileSync(path.join(HOME, "admin-token"), "utf8").trim();
  } catch {
    return "";
  }
}

function configuredUrl() {
  try {
    return JSON.parse(fs.readFileSync(path.join(HOME, "server.json"), "utf8")).url;
  } catch {}
  try {
    return `http://127.0.0.1:${JSON.parse(fs.readFileSync(path.join(HOME, "config.json"), "utf8")).port || 7477}`;
  } catch {}
  return "http://127.0.0.1:7477";
}

async function alive(url) {
  try {
    const r = await fetch(`${url}/api/status`, { headers: { authorization: `Bearer ${readToken()}` }, signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

/** An engine from before the app existed answers the API but doesn't serve the screens. */
async function servesUi(url) {
  try {
    return (await fetch(`${url}/app.js`, { signal: AbortSignal.timeout(1500) })).ok;
  } catch {
    return false;
  }
}

function enginePid() {
  try {
    return JSON.parse(fs.readFileSync(path.join(HOME, "server.json"), "utf8")).pid;
  } catch {
    return null;
  }
}

async function replaceOldEngine(url) {
  const pid = enginePid();
  const { response } = await dialog.showMessageBox({
    type: "warning",
    message: "An older Northern Lights engine is running",
    detail: `It was probably started with "northern-lights serve" in a terminal${pid ? ` (process ${pid})` : ""}, before the app was installed. It can't show the app's screens.\n\nRestart it with the current version? Running agents stop and their missions pause; you can resume them in the app.`,
    buttons: ["Restart engine", "Quit"],
    defaultId: 0,
    cancelId: 1,
  });
  if (response !== 0) throw new Error("quit");
  if (pid) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
  for (let i = 0; i < 40 && (await alive(url)); i++) await new Promise((r) => setTimeout(r, 250));
  if (await alive(url)) throw new Error(`The old engine didn't stop. Stop it with Ctrl+C in its terminal${pid ? ` (process ${pid})` : ""}, then open the app again.`);
}

async function ensureEngine() {
  const url = configuredUrl();
  if (await alive(url)) {
    if (await servesUi(url)) return url;
    await replaceOldEngine(url);
  }
  fs.mkdirSync(HOME, { recursive: true });
  const log = fs.openSync(path.join(HOME, "engine.log"), "a");
  const env = { ...process.env, PATH: loginPath(), NL_NO_NOTIFY: "1" };
  if (IS_BUNDLED) {
    engine = spawn(process.execPath, [path.join(ROOT, "src", "cli.ts"), "serve"], {
      cwd: ROOT,
      env: { ...env, ELECTRON_RUN_AS_NODE: "1", NODE_NO_WARNINGS: "1" },
      stdio: ["ignore", log, log],
    });
  } else {
    const launcher = path.join(ROOT, "bin", "northern-lights");
    if (!fs.existsSync(launcher)) throw new Error(`Can't find the engine at ${ROOT}. Was the project folder moved? Rebuild the app from its new place.`);
    engine = spawn(launcher, ["serve"], { cwd: ROOT, env, stdio: ["ignore", log, log] });
  }
  engine.on("exit", (code) => {
    engine = null;
    if (!quitting) {
      dialog.showErrorBox("The engine stopped", `Northern Lights' engine exited (code ${code}).\nDetails: ${path.join(HOME, "engine.log")}\n\nReopen the app to start it again.`);
    }
  });
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const u = configuredUrl();
    if (await alive(u)) return u;
  }
  throw new Error(`The engine didn't start. Details: ${path.join(HOME, "engine.log")}`);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 900,
    minHeight: 600,
    title: "Northern Lights",
    ...(IS_MAC ? { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 16, y: 14 } } : { autoHideMenuBar: true }),
    ...(IS_MAC ? {} : { icon: path.join(__dirname, "icon.png") }),
    backgroundColor: "#0c1019",
    show: false,
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, sandbox: true },
  });
  win.once("ready-to-show", () => win.show());
  win.loadURL(`${engineUrl}/login?k=${readToken()}`);
  // Links to anything other than the engine open in your browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith(engineUrl)) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });
  win.on("close", (e) => {
    // On a Mac, closing the window keeps the app (and the agents) running; quit with ⌘Q.
    // Elsewhere there's no Dock to bring it back from, so closing the window quits.
    if (quitting) return;
    e.preventDefault();
    if (IS_MAC) win.hide();
    else app.quit(); // runs the "agents are still working" check; the window stays if you keep them running
  });
}

function showWindow(hash) {
  if (!win) return;
  if (hash) win.webContents.executeJavaScript(`location.hash = ${JSON.stringify(hash)}`).catch(() => {});
  win.show();
  win.focus();
}

async function refreshBadge() {
  try {
    const r = await fetch(`${engineUrl}/api/inbox`, { headers: { authorization: `Bearer ${readToken()}` } });
    const items = await r.json();
    app.dock?.setBadge(items.length ? String(items.length) : "");
  } catch {}
}

/** Follow the engine's live events: notifications (when we own the engine) and the Dock badge. */
async function followEvents() {
  try {
    const res = await fetch(`${engineUrl}/events`, { headers: { authorization: `Bearer ${readToken()}` } });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let badgeTimer = null;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const line = chunk.split("\n").find((l) => l.startsWith("data: "));
        if (!line) continue;
        let e;
        try {
          e = JSON.parse(line.slice(6));
        } catch {
          continue;
        }
        if (e.type === "notify" && !e.muted && engine && Notification.isSupported()) {
          const [title, ...rest] = String(e.message || "").split(": ");
          const n = new Notification({ title: title || "Northern Lights", body: rest.join(": ") });
          const task = /\b(M\d+:[A-Z]+[\d.]*)\b/.exec(e.message || "")?.[1];
          const mission = /\b(M\d+)\b/.exec(e.message || "")?.[1];
          n.on("click", () => showWindow(task ? `#/t/${task}` : mission ? `#/m/${mission}` : "#/"));
          n.show();
        }
        clearTimeout(badgeTimer);
        badgeTimer = setTimeout(refreshBadge, 300);
      }
    }
  } catch {}
  if (!quitting) setTimeout(followEvents, 3000);
}

async function running() {
  try {
    const r = await fetch(`${engineUrl}/api/status`, { headers: { authorization: `Bearer ${readToken()}` } });
    return (await r.json()).runs.length;
  } catch {
    return 0;
  }
}

function buildMenu() {
  const template = [
    {
      label: "Northern Lights",
      submenu: [
        { role: "about" },
        { type: "separator" },
        { label: "Open engine log", click: () => shell.openPath(path.join(HOME, "engine.log")) },
        { label: "Open settings folder", click: () => shell.openPath(HOME) },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "File",
      submenu: [
        { label: "New Mission", accelerator: "CmdOrCtrl+N", click: () => showWindow("#/new") },
        { label: "Inbox", accelerator: "CmdOrCtrl+1", click: () => showWindow("#/") },
        { type: "separator" },
        { role: "close" },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [{ role: "reload" }, { role: "toggleDevTools" }, { type: "separator" }, { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { type: "separator" }, { role: "togglefullscreen" }],
    },
    {
      label: "Agents",
      submenu: [
        {
          label: "Stop All Agents",
          accelerator: "CmdOrCtrl+Shift+.",
          click: async () => {
            await fetch(`${engineUrl}/api/stop`, { method: "POST", headers: { authorization: `Bearer ${readToken()}`, "content-type": "application/json" }, body: "{}" }).catch(() => {});
          },
        },
      ],
    },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

ipcMain.handle("pick-folder", async () => {
  const r = await dialog.showOpenDialog(win, { properties: ["openDirectory"], message: "Choose a project folder" });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle("open-path", (_e, p) => (typeof p === "string" && path.isAbsolute(p) ? shell.openPath(p) : null));

app.on("second-instance", () => showWindow());
app.on("window-all-closed", () => {
  if (!IS_MAC) app.quit();
});
app.on("activate", () => showWindow());

app.on("before-quit", async (e) => {
  if (quitting) return;
  if (engine) {
    e.preventDefault();
    const n = await running();
    if (n > 0) {
      const { response } = await dialog.showMessageBox({
        type: "question",
        message: `${n} agent${n > 1 ? "s are" : " is"} still working`,
        detail: "Quitting stops them and pauses their missions. You can resume when you reopen the app.",
        buttons: ["Quit and stop agents", "Keep running"],
        defaultId: 1,
        cancelId: 1,
      });
      if (response === 1) return;
    }
    quitting = true;
    const proc = engine;
    proc.once("exit", () => app.quit());
    // Ask the engine to stop its agents and exit; force it only if it doesn't.
    fetch(`${engineUrl}/api/shutdown`, { method: "POST", headers: { authorization: `Bearer ${readToken()}`, "content-type": "application/json" }, body: "{}" }).catch(() => proc.kill("SIGTERM"));
    setTimeout(() => {
      if (proc.exitCode === null) proc.kill("SIGKILL");
      app.exit(0);
    }, 8000);
    return;
  }
  quitting = true;
});

app.whenReady().then(async () => {
  buildMenu();
  try {
    engineUrl = await ensureEngine();
  } catch (err) {
    if (err.message !== "quit") dialog.showErrorBox("Northern Lights couldn't start", String(err.message || err));
    app.exit(1);
    return;
  }
  createWindow();
  refreshBadge();
  followEvents();
});
