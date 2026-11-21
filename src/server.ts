import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "./core/config.ts";
import { homeDir, loadConfig } from "./core/config.ts";
import type { DB } from "./core/db.ts";
import { openDb } from "./core/db.ts";
import type { EngineEvent } from "./core/engine.ts";
import { Engine, UserError } from "./core/engine.ts";
import { listMissions, listProjects } from "./core/model.ts";
import { TOOLS } from "./core/tools.ts";

/** Token for human-only actions (approve, accept, …). Agents get task-scoped keys instead. */
export function adminToken(): string {
  const file = path.join(homeDir(), "admin-token");
  if (!fs.existsSync(file)) {
    fs.mkdirSync(homeDir(), { recursive: true });
    fs.writeFileSync(file, crypto.randomBytes(24).toString("hex"), { mode: 0o600 });
  }
  return fs.readFileSync(file, "utf8").trim();
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const s = Buffer.concat(chunks).toString("utf8");
  if (!s) return {};
  try {
    return JSON.parse(s);
  } catch {
    throw new UserError("Body must be JSON.");
  }
}

function send(res: http.ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "ui");
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

function serveStatic(res: http.ServerResponse, pathname: string, authed: boolean) {
  if (!authed && pathname === "/") {
    res.writeHead(401, { "content-type": "text/html; charset=utf-8" });
    return res.end(`<!doctype html><meta charset=utf-8><title>Northern Lights</title><body style="font:15px system-ui;background:#0b1020;color:#cfd6e6;display:grid;place-items:center;height:100vh;margin:0"><p>Open the Northern Lights app, or run <code>northern-lights open</code>.</p>`);
  }
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const file = path.resolve(UI_DIR, rel);
  if (!file.startsWith(UI_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { "content-type": "text/plain" });
    return res.end("Not found");
  }
  res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" });
  res.end(fs.readFileSync(file));
}

type Handler = (p: { params: string[]; body: any; query: URLSearchParams }) => unknown;

export function createServer(engine: Engine, token: string) {
  const human: [string, RegExp, Handler][] = [];
  const route = (method: string, pattern: string, h: Handler) => {
    const re = new RegExp("^" + pattern.replace(/:[a-z]+/g, "([^/]+)") + "$");
    human.push([method, re, h]);
  };
  const num = (v: unknown, what: string) => {
    const n = Number(v);
    if (!Number.isFinite(n)) throw new UserError(`${what} must be a number.`);
    return n;
  };

  route("GET", "/api/status", () => engine.status());
  route("GET", "/api/inbox", () => engine.inbox());
  route("GET", "/api/projects", () => listProjects(engine.db));
  route("POST", "/api/projects", ({ body }) => engine.addProject(body.path, body.name));
  route("GET", "/api/missions", ({ query }) => listMissions(engine.db, query.get("project") ?? undefined));
  route("POST", "/api/missions", ({ body }) => engine.createMission(body));
  route("GET", "/api/missions/:id", ({ params }) => engine.missionView(params[0]));
  route("GET", "/api/missions/:id/plan", ({ params }) => engine.planView(params[0]));
  route("PUT", "/api/missions/:id/plan", ({ params, body }) => engine.editPlan(params[0], body));
  route("POST", "/api/missions/:id/approve", ({ params }) => engine.approvePlan(params[0]));
  route("POST", "/api/missions/:id/reject", ({ params, body }) => engine.rejectPlan(params[0], String(body.feedback ?? "")));
  route("POST", "/api/missions/:id/accept", ({ params, body }) => engine.acceptMission(params[0], { overview: body.overview }));
  route("PATCH", "/api/missions/:id", ({ params, body }) => engine.missionSettings(params[0], body));
  route("POST", "/api/missions/:id/cancel", ({ params }) => engine.cancelMission(params[0]));
  route("POST", "/api/missions/:id/raise", ({ params, body }) => engine.raiseMissionBudget(params[0], num(body.amount, "amount")));
  route("GET", "/api/tasks/:id", ({ params, query }) => engine.taskView(params[0], query.get("diff") === "1"));
  route("POST", "/api/tasks/:id/accept", ({ params }) => engine.acceptTask(params[0]));
  route("POST", "/api/tasks/:id/send-back", ({ params, body }) => engine.sendBack(params[0], String(body.feedback ?? "")));
  route("POST", "/api/tasks/:id/discard", ({ params, body }) => engine.discard(params[0], !!body.cancel));
  route("POST", "/api/tasks/:id/undo-discard", ({ params }) => engine.undoDiscard(params[0]));
  route("POST", "/api/tasks/:id/retry", ({ params, body }) => engine.retry(params[0], body.note));
  route("POST", "/api/tasks/:id/cancel", ({ params }) => engine.cancelTask(params[0]));
  route("POST", "/api/tasks/:id/raise", ({ params, body }) => engine.raiseLimit(params[0], num(body.amount, "amount")));
  route("POST", "/api/tasks/:id/answer", ({ params, body }) => engine.answer(params[0], String(body.text ?? "")));
  route("POST", "/api/tasks/:id/permit", ({ params, body }) => engine.permit(params[0], body.decision));
  route("POST", "/api/tasks/:id/done", ({ params, body }) => engine.markDone(params[0], body.note));
  route("POST", "/api/stop", ({ body }) => ({ stopped: engine.stopAll(body.project) }));
  // Lets the app shut the engine down cleanly (stopping agents first) on every OS, including Windows where signals can't.
  route("POST", "/api/shutdown", () => {
    setTimeout(() => engine.events.emit("shutdown-request"), 50);
    return { ok: true };
  });
  route("POST", "/api/resume", ({ body }) => engine.resume(body.target));
  route("POST", "/api/pull-keys", ({ body }) => ({ key: engine.createPullKey(body.profile) }));
  route("GET", "/api/profiles", () => ({ profiles: engine.config.profiles, defaults: engine.config.defaults }));
  route("GET", "/api/harnesses", () => engine.harnesses());
  route("GET", "/api/usage", () => engine.usage());
  route("POST", "/api/sharpen", ({ body }) => engine.sharpen(body));

  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const bearer = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    // The app window (or a browser) logs in once via /login?k=<admin token> and then uses a cookie.
    // The cookie is SameSite=Strict and only honoured when the Host is this machine, so other sites can't use it.
    const localHost = /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host ?? "");
    const cookie = /(?:^|;\s*)nl_admin=([a-f0-9]+)/.exec(req.headers.cookie ?? "")?.[1] ?? "";
    const auth = bearer || (localHost ? cookie : "");
    try {
      if (req.method === "GET" && url.pathname === "/login") {
        if (!localHost || url.searchParams.get("k") !== token) {
          res.writeHead(401, { "content-type": "text/plain" });
          return res.end("Wrong or missing key. Open the app, or run: northern-lights open");
        }
        res.writeHead(302, {
          "set-cookie": `nl_admin=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`,
          location: "/",
        });
        return res.end();
      }
      if (req.method === "GET" && !url.pathname.startsWith("/api/") && url.pathname !== "/events") {
        return serveStatic(res, url.pathname, auth === token);
      }
      // Agent side: tools, authenticated by the run's (or pull agent's) key.
      if (url.pathname === "/api/tools" && req.method === "GET") return send(res, 200, TOOLS);
      const toolMatch = url.pathname.match(/^\/api\/tool\/([a-z_]+)$/);
      if (toolMatch && req.method === "POST") {
        const body = await readBody(req);
        const text = engine.callTool(auth, toolMatch[1], body ?? {});
        return send(res, 200, { text, error: text.startsWith("ERROR") });
      }
      // Human side: needs the admin token.
      if (auth !== token) return send(res, 401, { error: "Missing or wrong admin token." });
      if (url.pathname === "/events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        res.write(": connected\n\n");
        const on = (e: EngineEvent) => res.write(`data: ${JSON.stringify(e)}\n\n`);
        engine.events.on("event", on);
        const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
        req.on("close", () => {
          clearInterval(ping);
          engine.events.off("event", on);
        });
        return;
      }
      const shot = req.method === "GET" && /^\/api\/shots\/([^/]+)\/([^/]+)$/.exec(url.pathname);
      if (shot) {
        const f = engine.screenshotPath(decodeURIComponent(shot[1]), decodeURIComponent(shot[2]));
        if (!f) return send(res, 404, { error: "No such screenshot." });
        const ext = path.extname(f).toLowerCase();
        res.writeHead(200, { "content-type": ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : ext === ".gif" ? "image/gif" : "image/jpeg", "cache-control": "private, max-age=86400" });
        return void fs.createReadStream(f).pipe(res);
      }
      for (const [method, re, h] of human) {
        if (method !== req.method) continue;
        const m = url.pathname.match(re);
        if (!m) continue;
        const body = method === "GET" ? {} : await readBody(req);
        const out = await h({ params: m.slice(1).map(decodeURIComponent), body, query: url.searchParams });
        engine.flushFiles();
        return send(res, 200, out ?? { ok: true });
      }
      send(res, 404, { error: `No route ${req.method} ${url.pathname}` });
    } catch (e) {
      if (e instanceof UserError) return send(res, 400, { error: e.message });
      send(res, 500, { error: (e as Error).stack ?? String(e) });
    }
  });
}

export interface Running {
  engine: Engine;
  server: http.Server;
  url: string;
  close(): Promise<void>;
}

export async function startServer(opts: { port?: number; config?: Config; db?: DB; tickMs?: number; notify?: boolean } = {}): Promise<Running> {
  const config = opts.config ?? loadConfig();
  const db = opts.db ?? openDb();
  const port = opts.port ?? config.port;
  const token = adminToken();
  const placeholder = `http://127.0.0.1:${port}`;
  const engine = new Engine(db, config, { url: placeholder, notify: opts.notify });
  const server = createServer(engine, token);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  const realPort = typeof addr === "object" && addr ? addr.port : port;
  engine.url = `http://127.0.0.1:${realPort}`;
  fs.writeFileSync(path.join(homeDir(), "server.json"), JSON.stringify({ url: engine.url, pid: process.pid }));
  engine.start(opts.tickMs);
  return {
    engine,
    server,
    url: engine.url,
    async close() {
      engine.shutdown();
      const closed = new Promise<void>((r) => server.close(() => r()));
      server.closeAllConnections?.();
      await closed;
      try {
        fs.rmSync(path.join(homeDir(), "server.json"));
      } catch {}
    },
  };
}
