"use strict";
// Northern Lights UI. Plain JS, no build step. Talks to the local engine's /api.

const IS_APP = /Electron/.test(navigator.userAgent);
// Only the Mac app hides the title bar (traffic lights over the sidebar), so only it needs the drag strip.
if (IS_APP && (window.nl?.platform ?? "darwin") === "darwin") {
  document.documentElement.classList.add("electron");
  document.body.insertAdjacentHTML("afterbegin", '<div class="drag"></div>');
}

const $main = document.getElementById("main");
const $side = document.getElementById("side");
const drafts = {}; // text typed into forms survives re-renders
const tabs = {}; // per-task / per-mission selected tab
let lastSide = "";
let refreshTimer = null;
let engineUp = true;
let cache = { status: null, inbox: [], missions: [] };
let inboxKeys = [];

// ───────────────────────── helpers ─────────────────────────

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const enc = encodeURIComponent;

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "same-origin",
  });
  if (res.status === 401) {
    location.reload();
    throw new Error("Not signed in");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}
const get = (p) => api("GET", p);
const post = (p, b = {}) => api("POST", p, b);

const usd = (n) => "$" + (n ?? 0).toFixed(2);
const tokens = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? Math.round(n / 1e3) + "k" : String(Math.round(n ?? 0))) + " tok";
const budgetFmt = (unit, n) => (unit === "tokens" ? tokens(n) : usd(n));
const spent = (unit, s) => (unit === "tokens" ? s.tokens : s.usd);
function ago(ts) {
  if (!ts) return "";
  const s = (Date.now() - new Date(ts).getTime()) / 1000;
  if (s < 45) return "now";
  if (s < 3600) return Math.round(s / 60) + "m";
  if (s < 86400) return Math.round(s / 3600) + "h";
  return Math.round(s / 86400) + "d";
}
const clock = (ts) => new Date(ts).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

// ───────────────────────── agents (harnesses) ─────────────────────────

let harnessData = null;
async function loadHarnesses() {
  if (!harnessData) harnessData = await get("/api/harnesses");
  return harnessData;
}
const HARNESS_DEFAULTS = {
  claude: { planner: "opus", worker: "sonnet", verifier: "opus", unit: "usd" },
  antigravity: { planner: null, worker: "gemini-3.8-flash-high", verifier: null, unit: "tokens" },
  codex: { planner: "", worker: "", verifier: "", unit: "usd" },
};
function defaultModels(h) {
  const d = HARNESS_DEFAULTS[h] ?? {};
  const models = harnessData?.harnesses?.[h]?.models ?? [];
  const has = (id) => models.some((m) => m.id === id);
  const best = models[0]?.id ?? "";
  const pick = (want) => (want && has(want) ? want : want === "" ? "" : best);
  return { planner: pick(d.planner), worker: pick(d.worker), verifier: pick(d.verifier), unit: d.unit ?? "usd" };
}
/** "antigravity:gemini-3.8-flash-high" → "Antigravity · Gemini 3.8 Flash (High)"; named profiles show their harness + model. */
function agentLabel(spec, short = false) {
  if (!spec) return "";
  const H = harnessData?.harnesses ?? {};
  let harness;
  let model;
  const m = /^(claude|codex|antigravity)(?::(.+))?$/.exec(spec);
  if (m) [, harness, model] = m;
  else {
    const p = harnessData?.profiles?.[spec];
    if (!p) return spec;
    harness = p.harness;
    model = p.model;
  }
  const hl = H[harness]?.label ?? { claude: "Claude Code", antigravity: "Antigravity", codex: "Codex" }[harness] ?? harness;
  const ml = (H[harness]?.models ?? []).find((x) => x.id === model)?.label ?? model ?? "default model";
  return short ? ml : `${hl} · ${ml}`;
}
function parseAmount(v) {
  const m = /^\s*([\d.]+)\s*([kKmM]?)\s*$/.exec(String(v ?? ""));
  if (!m) return NaN;
  return Number(m[1]) * (m[2].toLowerCase() === "k" ? 1e3 : m[2].toLowerCase() === "m" ? 1e6 : 1);
}
const shortNum = (n) => (n >= 1e6 ? +(n / 1e6).toFixed(1) + "M" : n >= 1e3 ? Math.round(n / 1e3) + "k" : String(n));

// ───────────────────────── icons ─────────────────────────

const P = {
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  right: '<path d="m9 18 6-6-6-6"/>',
  play: '<path d="M7 4v16l13-8z"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  spark: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
  shield: '<path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z"/><path d="m9 12 2 2 4-4"/>',
  coin: '<circle cx="12" cy="12" r="9"/><path d="M15 9.5c-.6-1-1.7-1.5-3-1.5-1.7 0-3 .9-3 2s1.3 1.8 3 2 3 .9 3 2-1.3 2-3 2c-1.3 0-2.4-.5-3-1.5M12 6v2M12 16v2"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.7 12.3 9.3-9.3M17 6l3 3M14 9l2 2"/>',
  msg: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
  flag: '<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  board: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16M15 4v16"/>',
  doc: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  retry: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>',
  send: '<path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/>',
  diff: '<path d="M12 3v10M7 8h10M7 19h10"/>',
  pulse: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  bolt: '<path d="M13 2 3 14h9l-1 8 10-12h-9z"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  unlock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.6-1.7"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  cmd: '<path d="M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3z"/>',
  chart: '<path d="M3 3v18h18"/><path d="M7 15l4-4 3 3 6-6"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
};
const ic = (name, size = 15, sw = 1.7) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${P[name] ?? ""}</svg>`;

/** Linear-style status glyphs. */
function glyph(kind, color, size = 14) {
  const s = `width="${size}" height="${size}" viewBox="0 0 14 14" style="color:${color}"`;
  const ring = `<circle cx="7" cy="7" r="5.6" fill="none" stroke="currentColor" stroke-width="1.5"/>`;
  switch (kind) {
    case "dashed":
      return `<svg ${s}><circle cx="7" cy="7" r="5.6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="2.2 2"/></svg>`;
    case "empty":
      return `<svg ${s}>${ring}</svg>`;
    case "half":
      return `<svg ${s}>${ring}<path d="M7 3.4A3.6 3.6 0 0 1 7 10.6Z" fill="currentColor"/></svg>`;
    case "three":
      return `<svg ${s}>${ring}<path d="M7 7V3.4A3.6 3.6 0 1 1 3.4 7Z" fill="currentColor"/></svg>`;
    case "spin":
      return `<svg ${s} class="spin">${ring.replace('stroke-width="1.5"', 'stroke-width="1.5" stroke-dasharray="9 26"')}</svg>`;
    case "bang":
      return `<svg ${s}><circle cx="7" cy="7" r="6.3" fill="currentColor"/><path d="M7 3.9v3.6M7 9.9v.1" stroke="var(--sheet)" stroke-width="1.7" stroke-linecap="round"/></svg>`;
    case "done":
      return `<svg ${s}><circle cx="7" cy="7" r="6.3" fill="currentColor"/><path d="M4.4 7.2 6.2 9 9.7 5.3" fill="none" stroke="var(--sheet)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    case "cancel":
      return `<svg ${s}><circle cx="7" cy="7" r="6.3" fill="currentColor"/><path d="M5 5l4 4M9 5 5 9" stroke="var(--sheet)" stroke-width="1.5" stroke-linecap="round"/></svg>`;
    case "paused":
      return `<svg ${s}>${ring}<path d="M5.8 5v4M8.2 5v4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;
  }
  return "";
}

const TASK = {
  pending: ["Waiting", "dashed", "var(--faint)"],
  ready: ["Up next", "empty", "var(--muted)"],
  in_progress: ["Working", "half", "var(--blue)"],
  verifying: ["Checking", "three", "var(--violet)"],
  in_review: ["Ready for review", "three", "var(--green)"],
  waiting: ["Needs your answer", "bang", "var(--amber)"],
  your_turn: ["Your turn", "bang", "var(--amber)"],
  over_limit: ["Over budget", "bang", "var(--amber)"],
  needs_split: ["Needs split", "bang", "var(--amber)"],
  stuck: ["Stuck", "bang", "var(--red)"],
  failed: ["Failed", "bang", "var(--red)"],
  done: ["Done", "done", "var(--violet)"],
  cancelled: ["Cancelled", "cancel", "var(--faint)"],
};
const MISSION = {
  queued: ["Queued", "dashed", "var(--faint)"],
  planning: ["Planning", "spin", "var(--violet)"],
  awaiting_approval: ["Plan to approve", "bang", "var(--amber)"],
  running: ["Running", "half", "var(--blue)"],
  final_review: ["Final approval", "bang", "var(--green)"],
  done: ["Done", "done", "var(--violet)"],
  cancelled: ["Cancelled", "cancel", "var(--faint)"],
};
const tGlyph = (s, size) => glyph(TASK[s]?.[1] ?? "empty", TASK[s]?.[2] ?? "var(--muted)", size);
const tLabel = (s) => TASK[s]?.[0] ?? s;
function mInfo(m) {
  if (m.paused && !["done", "cancelled"].includes(m.status)) return ["Paused", "paused", "var(--amber)"];
  return MISSION[m.status] ?? [m.status, "empty", "var(--muted)"];
}
const mGlyph = (m, size) => glyph(mInfo(m)[1], mInfo(m)[2], size);
const statusPill = (s) => `<span class="pill">${tGlyph(s)}${esc(tLabel(s))}</span>`;
const missionPill = (m) => `<span class="pill">${mGlyph(m)}${esc(mInfo(m)[0])}</span>`;

function projColor(id) {
  let h = 0;
  for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${h} 52% 48%)`;
}
const projChip = (id) => `<span class="chip-ic" style="background:${projColor(id)}">${esc(String(id)[0]?.toUpperCase() ?? "?")}</span>`;

function meter(frac) {
  const pct = frac > 0 ? Math.max(3, Math.min(100, frac * 100)) : 0;
  return `<span class="meter ${frac >= 1 ? "over" : frac >= 0.8 ? "warn" : ""}"><i style="width:${pct}%"></i></span>`;
}

/** Tiny markdown: headings, lists, code fences, inline code, bold, italics. Input is escaped first. */
function md(src) {
  const lines = String(src ?? "").split("\n");
  let out = "";
  let list = null;
  let code = null;
  const inline = (s) =>
    esc(s)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
      .replace(/(^|[\s(])_([^_]+)_(?=[\s).,]|$)/g, "$1<i>$2</i>");
  const closeList = () => {
    if (list) out += `</${list}>`;
    list = null;
  };
  for (const line of lines) {
    if (code !== null) {
      if (/^```/.test(line)) {
        out += `<pre><code>${esc(code)}</code></pre>`;
        code = null;
      } else code += (code ? "\n" : "") + line;
      continue;
    }
    if (/^```/.test(line)) {
      closeList();
      code = "";
      continue;
    }
    const h = /^(#{1,3})\s+(.*)/.exec(line);
    if (h) {
      closeList();
      out += `<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`;
      continue;
    }
    const li = /^\s*(?:[-*]|(\d+)\.)\s+(.*)/.exec(line);
    if (li) {
      const kind = li[1] ? "ol" : "ul";
      if (list !== kind) {
        closeList();
        out += `<${kind}>`;
        list = kind;
      }
      out += `<li>${inline(li[2])}</li>`;
      continue;
    }
    closeList();
    if (line.trim()) out += `<p>${inline(line)}</p>`;
  }
  closeList();
  if (code !== null) out += `<pre><code>${esc(code)}</code></pre>`;
  return `<div class="md">${out}</div>`;
}

function draftInput(key, { placeholder = "", rows = 0, type = "text", value, cls = "input" } = {}) {
  const v = drafts[key] ?? value ?? "";
  if (rows) return `<textarea class="${cls}" rows="${rows}" data-draft="${esc(key)}" placeholder="${esc(placeholder)}">${esc(v)}</textarea>`;
  return `<input class="${cls}" type="${type}" data-draft="${esc(key)}" placeholder="${esc(placeholder)}" value="${esc(v)}">`;
}

function toast(msg, err = false) {
  const el = document.createElement("div");
  el.className = "toast" + (err ? " err" : "");
  el.innerHTML = `<span style="color:${err ? "var(--red)" : "var(--green)"}">${ic(err ? "alert" : "check", 14, 2)}</span><span>${esc(msg)}</span>`;
  document.getElementById("toasts").append(el);
  setTimeout(() => el.remove(), err ? 7000 : 3200);
}

const $modal = document.getElementById("modal");
function closeModal() {
  $modal.hidden = true;
  $modal.innerHTML = "";
  $modal.onclick = null;
}
function confirmBox(title, body, okLabel, danger = false) {
  return new Promise((resolve) => {
    $modal.innerHTML = `<div class="dialog"><h2>${esc(title)}</h2><div class="muted">${esc(body)}</div>
      <div class="row"><button class="btn" data-x="no">Cancel</button><button class="btn ${danger ? "danger" : "primary"}" data-x="yes">${esc(okLabel)}</button></div></div>`;
    $modal.hidden = false;
    const done = (v) => {
      closeModal();
      resolve(v);
    };
    $modal.onclick = (e) => {
      const x = e.target.closest("[data-x]");
      if (x) done(x.dataset.x === "yes");
      else if (e.target === $modal) done(false);
    };
    $modal.querySelector('[data-x="yes"]').focus();
  });
}

// ───────────────────────── routing & render ─────────────────────────

function route() {
  const parts = location.hash.replace(/^#\/?/, "").split("/").map(decodeURIComponent);
  const kind = parts[0] || "inbox";
  return { kind, id: parts[1] || null, sub: parts[2] || null };
}
const go = (hash) => {
  if (location.hash === hash) render();
  else location.hash = hash;
};

async function render() {
  clearTimeout(refreshTimer);
  const r = route();
  try {
    const [status, inbox, missions] = await Promise.all([get("/api/status"), get("/api/inbox"), get("/api/missions")]);
    cache = { status, inbox, missions };
    engineUp = true;
  } catch (e) {
    engineUp = false;
    renderSide();
    $main.innerHTML = `<div class="sheet"><div class="empty" style="margin:auto">${ic("bolt", 28)}<div class="big">Can't reach the engine</div><div>${esc(e.message)}</div></div></div>`;
    refreshTimer = setTimeout(render, 3000);
    return;
  }
  if (!harnessData) loadHarnesses().then(() => render()).catch(() => {});
  renderSide();
  let html;
  try {
    if (r.kind === "m" && r.id) html = await missionScreen(r.id, r.sub);
    else if (r.kind === "t" && r.id) html = await taskScreen(r.id);
    else if (r.kind === "new") html = await newScreen();
    else if (r.kind === "usage") html = await usageScreen();
    else html = await inboxScreen(r.id);
  } catch (e) {
    html = `<div class="sheet">${topbar(`<span class="here">Error</span>`)}<div class="body"><div class="wrap narrow"><div class="note soft-red">${ic("alert", 16)}<div><b>Something went wrong</b><pre>${esc(e.message)}</pre></div></div><br><a class="btn" href="#/">Back to inbox</a></div></div></div>`;
  }
  const scrolls = [...$main.querySelectorAll("[data-scroll]")].map((el) => [el.dataset.scroll, el.scrollTop]);
  const open = [...$main.querySelectorAll("details[data-k]")].map((d) => [d.dataset.k, d.open]);
  const focus = document.activeElement?.dataset?.draft;
  $main.innerHTML = html;
  for (const [k, o] of open) {
    const d = $main.querySelector(`details[data-k="${CSS.escape(k)}"]`);
    if (d) d.open = o;
  }
  for (const [k, top] of scrolls) {
    const el = $main.querySelector(`[data-scroll="${CSS.escape(k)}"]`);
    if (el) el.scrollTop = top;
  }
  if (focus) $main.querySelector(`[data-draft="${CSS.escape(focus)}"]`)?.focus();
  $main.querySelectorAll("textarea.cgoal").forEach(autoGrow);
  if (cache.status.runs.length || cache.status.checks_running?.length) refreshTimer = setTimeout(softRefresh, 4000);
}

/** Re-render unless you're typing or a dialog is open. */
function softRefresh() {
  const a = document.activeElement;
  if (!$modal.hidden || (a && (a.tagName === "TEXTAREA" || (a.tagName === "INPUT" && a.type !== "checkbox") || a.tagName === "SELECT"))) {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(softRefresh, 1500);
    return;
  }
  render();
}

const topbar = (crumbs, right = "") => `<div class="topbar"><div class="crumbs">${crumbs}</div><div class="right">${right}</div></div>`;

// ───────────────────────── sidebar ─────────────────────────

function renderSide() {
  const r = route();
  const { status, inbox, missions } = cache;
  const projects = status?.projects ?? [];
  const working = new Set(projects.filter((p) => p.busy && ["in_progress", "verifying"].includes(p.busy.status)).map((p) => p.id));
  const byProject = {};
  for (const m of missions) (byProject[m.project_id] ??= []).push(m);
  let html = `<div class="brand"><div class="brand-mark"></div><b>Northern Lights</b>
      <button class="icon-btn" data-act="palette" title="Search (⌘K)">${ic("search", 15)}</button>
      <a class="icon-btn boxed" href="#/new" title="New mission (⌘N)">${ic("plus", 15, 2)}</a></div>
    <a class="nav ${r.kind === "inbox" ? "on" : ""}" href="#/">${ic("inbox", 15)}Inbox${inbox.length ? `<span class="count hot">${inbox.length}</span>` : ""}</a>
    <a class="nav ${r.kind === "usage" ? "on" : ""}" href="#/usage">${ic("chart", 15)}Usage${status?.usage_today ? `<span class="count">${shortNum(status.usage_today.tokens)} today</span>` : ""}</a>
    <div class="side-h">Projects<button class="icon-btn" style="margin-left:auto;width:22px;height:22px" data-act="addProjectDialog" title="Add project">${ic("plus", 14, 2)}</button></div>`;
  if (!projects.length) html += `<a class="side-m" href="#/new" style="padding-left:8px">${ic("plus", 14)}<span class="t">Add a project</span></a>`;
  for (const p of projects) {
    html += `<div class="proj">${projChip(p.id)}<span>${esc(p.id)}</span>${working.has(p.id) ? `<span class="live" title="An agent is working">${glyph("spin", "var(--blue)", 13)}</span>` : ""}</div>`;
    const ms = (byProject[p.id] ?? []).slice().reverse();
    const active = ms.filter((m) => !["done", "cancelled"].includes(m.status));
    const rest = ms.filter((m) => ["done", "cancelled"].includes(m.status)).slice(0, Math.max(0, 4 - active.length));
    if (!ms.length) html += `<div class="side-m faint">No missions yet</div>`;
    for (const m of [...active, ...rest]) {
      html += `<a class="side-m ${r.kind === "m" && r.id === m.id ? "on" : ""}" href="#/m/${esc(m.id)}">${mGlyph(m, 13)}<span class="t">${esc(m.title)}</span></a>`;
    }
  }
  const running = status?.runs?.length ?? 0;
  html += `<div class="side-foot">
    ${running ? `<button class="btn" data-act="stopAll" style="justify-content:center">${ic("stop", 13)} Stop all agents</button>` : ""}
    <div class="engine ${engineUp ? "" : "off"}"><span class="dot"></span>${engineUp ? (running ? `${plural(running, "agent")} working` : "Engine running") : "Engine offline"}<kbd>⌘K</kbd></div>
  </div>`;
  if (html !== lastSide) {
    $side.innerHTML = html;
    lastSide = html;
  }
}

// ───────────────────────── inbox ─────────────────────────

const KIND = {
  "plan to approve": ["list", "soft-amber", "Plan to approve"],
  "split to approve": ["list", "soft-amber", "Split to approve"],
  "fix tasks to approve": ["list", "soft-amber", "Fix tasks to approve"],
  "final approval": ["flag", "soft-green", "Final approval"],
  paused: ["pause", "soft-amber", "Paused"],
  "task for you": ["user", "soft-amber", "Your turn"],
  "permission request": ["key", "soft-violet", "Permission request"],
  question: ["msg", "soft-violet", "Question"],
  review: ["diff", "soft-green", "Ready for review"],
  "over limit": ["coin", "soft-red", "Over budget"],
  stuck: ["alert", "soft-red", "Stuck"],
  failed: ["alert", "soft-red", "Failed"],
};
const itemKey = (it) => it.task ?? `m:${it.mission}`;

async function inboxScreen(key) {
  const { inbox, status, missions } = cache;
  inboxKeys = inbox.map(itemKey);
  const sel = key && inboxKeys.includes(key) ? key : inboxKeys[0] ?? (key && key.startsWith("run:") ? key : null);
  let list = `<div class="list-h">Needs you<span class="faint" style="font-weight:500">${inbox.length || ""}</span></div>`;
  if (!inbox.length) list += `<div class="muted small" style="padding:6px 18px 10px">Nothing right now.</div>`;
  for (const it of inbox) {
    const [icon, cls, label] = KIND[it.kind] ?? ["inbox", "soft-gray", it.kind];
    const k = itemKey(it);
    list += `<a class="li ${k === sel ? "on" : ""}" href="#/inbox/${enc(k)}"><span class="ic ${cls}">${ic(icon, 15)}</span><div class="grow">
      <div class="row" style="flex-wrap:nowrap;gap:6px"><span class="t">${esc(it.title)}</span><span class="when">${ago(it.since)}</span></div>
      <div class="k">${esc(label)} · <span class="id">${esc(it.task ?? it.mission)}</span> · ${esc(it.project)}</div></div></a>`;
  }
  if (status.runs.length) {
    list += `<div class="list-h" style="margin-top:8px">Working now<span class="faint" style="font-weight:500">${status.runs.length}</span></div>`;
    for (const r of status.runs) {
      const k = `run:${r.task}`;
      list += `<a class="li ${sel === k ? "on" : ""}" href="#/inbox/${enc(k)}"><span class="ic soft-blue">${glyph("spin", "var(--blue)", 14)}</span><div class="grow">
        <div class="row" style="flex-wrap:nowrap;gap:6px"><span class="t">${esc(r.task)}</span><span class="when">${ago(r.started)}</span></div>
        <div class="k">${esc(r.role === "verify" ? "Checking" : r.role === "plan" ? "Planning" : "Working")} · ${esc(agentLabel(r.profile, true))} · ${tokens(r.tokens)}${r.usd ? ` · ${usd(r.usd)}` : ""}</div></div></a>`;
    }
  }
  const active = missions.filter((m) => !["done", "cancelled"].includes(m.status));
  if (active.length) {
    list += `<div class="list-h" style="margin-top:8px">Active missions</div>`;
    for (const m of active.slice().reverse()) {
      list += `<a class="li" href="#/m/${esc(m.id)}"><span class="ic soft-gray">${mGlyph(m, 14)}</span><div class="grow"><div class="t">${esc(m.title)}</div><div class="k">${esc(mInfo(m)[0])} · <span class="id">${esc(m.id)}</span> · ${esc(m.project_id)}</div></div></a>`;
    }
  }

  let pane;
  if (!sel) pane = emptyPane(status);
  else if (sel.startsWith("run:")) pane = await taskDetail(sel.slice(4), { embedded: true });
  else if (sel.startsWith("m:")) pane = await missionDecisionPane(sel.slice(2));
  else pane = await taskDetail(sel, { embedded: true });

  return `<div class="sheet">${topbar(`${ic("inbox", 15)}<span class="here">Inbox</span>`, `<a class="btn" href="#/new">${ic("plus", 14, 2)} New mission</a>`)}
    <div class="split"><div class="list" data-scroll="inbox-list">${list}</div><div class="pane" data-scroll="inbox-pane-${esc(sel ?? "")}">${pane}</div></div></div>`;
}

function emptyPane(status) {
  if (!status.projects.length) {
    return `<div class="empty" style="padding-top:18vh">${ic("folder", 32, 1.4)}<div class="big">Add your first project</div><div>A project is any folder with code in it.</div><br><a class="btn primary lg" href="#/new">Get started</a></div>`;
  }
  return `<div class="empty" style="padding-top:18vh"><svg width="64" height="40" viewBox="0 0 64 40" fill="none"><path d="M2 30C14 6 26 30 38 14s20 8 24-4" stroke="url(#g)" stroke-width="3" stroke-linecap="round"/><defs><linearGradient id="g" x1="0" x2="64" y1="0" y2="0"><stop stop-color="#22d3a0"/><stop offset=".5" stop-color="#22c3e6"/><stop offset="1" stop-color="#8b7cf6"/></linearGradient></defs></svg>
    <div class="big">You're all caught up</div><div>Agents will put things here when they need you.</div><br><a class="btn" href="#/new">${ic("plus", 14, 2)} New mission</a></div>`;
}

async function missionDecisionPane(id) {
  const v = await get(`/api/missions/${enc(id)}`);
  const m = v.mission;
  let body = `<div class="task-main"><div class="row muted small">${projChip(m.project_id)} ${esc(m.project_id)} <span class="faint">›</span> <span class="id">${esc(m.id)}</span></div>
    <div class="title" style="margin-top:10px">${esc(m.title)}</div><div class="lede">${esc(m.goal)}</div>
    <div class="inline-props">${missionPill(m)}<a class="pill" href="#/m/${esc(m.id)}">${ic("board", 13)} Open mission</a></div>`;
  if (m.status === "awaiting_approval" && m.pending_plan) body += planContent(m, v.overview);
  else if (m.status === "final_review") body += await finalContent(m, v);
  else if (m.paused) body += pausedCard(m, v);
  return body + `</div>`;
}

function pausedCard(m, v) {
  const sp = spent(m.budget_unit, v.spend);
  const over = sp >= m.budget_mission;
  return `<div class="decision amber"><div class="bar"><div><div class="q">${glyph("paused", "var(--amber)")} ${over ? "Mission budget used up" : "Mission paused"}</div>
    <div class="why">${over ? `Spent ${budgetFmt(m.budget_unit, sp)} of ${budgetFmt(m.budget_unit, m.budget_mission)}. Raise the limit to continue.` : "No new agents start until you resume."}</div></div>
    <div class="acts">${over ? `<a class="btn" href="#/m/${esc(m.id)}/settings">${ic("gear", 14)} Raise limit</a>` : `<button class="btn primary" data-act="resume" data-target="${esc(m.id)}">${ic("play", 13)} Resume</button>`}</div></div></div>`;
}

// ───────────────────────── mission ─────────────────────────

const COLUMNS = [
  ["Up next", "empty", "var(--muted)", ["pending", "ready"]],
  ["Working", "half", "var(--blue)", ["in_progress", "verifying"]],
  ["Needs you", "bang", "var(--amber)", ["in_review", "waiting", "your_turn", "over_limit", "stuck", "failed", "needs_split"]],
  ["Done", "done", "var(--violet)", ["done", "cancelled"]],
];

async function missionScreen(id, tab) {
  const v = await get(`/api/missions/${enc(id)}`);
  const m = v.mission;
  const unit = m.budget_unit;
  const sp = spent(unit, v.spend);
  const leaves = v.tasks.filter((t) => !t.is_parent && t.kind !== "plan" && t.kind !== "mission_verify");
  const live = leaves.filter((t) => t.status !== "cancelled");
  const doneN = live.filter((t) => t.status === "done").length;
  const isOpen = !["done", "cancelled"].includes(m.status);
  const hasPlan = m.status === "awaiting_approval" && !!m.pending_plan;
  tab = tab || (hasPlan ? "plan" : "tasks");
  const running = v.running[0];

  const right = `${running ? `<button class="btn" data-act="stop" data-project="${esc(m.project_id)}">${ic("pause", 13)} Pause</button>` : ""}${
    m.paused && isOpen ? `<button class="btn primary" data-act="resume" data-target="${esc(m.id)}">${ic("play", 13)} Resume</button>` : ""
  }`;
  let html = `<div class="sheet">${topbar(`${projChip(m.project_id)}<span>${esc(m.project_id)}</span><span class="sep">›</span><span class="here">${esc(m.title)}</span>`, right)}<div class="body" data-scroll="m-${esc(m.id)}-${tab}">`;

  html += `<div class="mhead"><div class="title">${esc(m.title)}</div><div class="lede">${esc(m.goal)}</div>
    <div class="meta">
      ${missionPill(m)}
      ${live.length ? `<span class="pill"><span class="ring" style="--p:${Math.round((doneN / live.length) * 100)}"></span>${doneN}/${live.length} <span class="k">tasks</span></span>` : ""}
      <span class="pill">${ic("coin", 13)}${budgetFmt(unit, sp)} <span class="k">of ${budgetFmt(unit, m.budget_mission)}</span>${meter(sp / m.budget_mission)}</span>
      ${unit === "usd" ? `<span class="pill" title="Tokens used (cache reads not counted)">${ic("chart", 13)}${tokens(v.spend.tokens)}</span>` : v.spend.usd > 0 ? `<span class="pill">${usd(v.spend.usd)}</span>` : ""}
      <a class="pill" href="#/m/${esc(m.id)}/settings" title="Agents">${ic("spark", 13)}${esc(agentLabel(m.worker_profile))}</a>
      ${running ? `<a class="pill soft-blue" style="border-color:transparent" href="#/t/${esc(running.task)}"><span class="live-dot"></span>${esc(running.task.split(":")[1])} ${running.role === "verify" ? "being checked" : "in progress"}</a>` : ""}
      <a class="pill" href="#/m/${esc(m.id)}/settings">${ic(m.review_mode === "auto" ? "bolt" : "user", 13)}${m.review_mode === "auto" ? "Auto-accept" : "You review each task"}</a>
      <a class="pill" href="#/m/${esc(m.id)}/settings">${ic(m.permission_mode === "full" ? "unlock" : "lock", 13)}${m.permission_mode === "full" ? "Full access" : "Approved commands only"}</a>
    </div>
    <div class="tabs">
      ${hasPlan ? `<a class="tab ${tab === "plan" ? "on" : ""}" href="#/m/${esc(m.id)}/plan">${glyph("bang", "var(--amber)", 12)} Plan</a>` : ""}
      <a class="tab ${tab === "tasks" ? "on" : ""}" href="#/m/${esc(m.id)}/tasks">${ic("board", 14)} Tasks <span class="n">${live.length || ""}</span></a>
      ${v.overview ? `<a class="tab ${tab === "overview" ? "on" : ""}" href="#/m/${esc(m.id)}/overview">${ic("doc", 14)} PROJECT.md</a>` : ""}
      <a class="tab ${tab === "settings" ? "on" : ""}" href="#/m/${esc(m.id)}/settings">${ic("gear", 14)} Settings</a>
    </div></div>`;

  if (tab === "plan" && hasPlan) {
    html += `<div class="wrap" style="padding-top:4px">${planContent(m, v.overview)}</div>`;
  } else if (tab === "overview") {
    html += `<div class="wrap narrow">${v.overview ? md(v.overview) : '<div class="muted">No PROJECT.md yet.</div>'}</div>`;
  } else if (tab === "settings") {
    html += `<div class="wrap narrow">${settingsContent(m, v)}</div>`;
  } else {
    let top = "";
    if (m.status === "final_review") top = await finalContent(m, v);
    else if (hasPlan) top = `<div class="decision amber"><div class="bar"><div><div class="q">${glyph("bang", "var(--amber)")} A plan is waiting for you</div><div class="why">Nothing runs until you approve it.</div></div><div class="acts"><a class="btn primary" href="#/m/${esc(m.id)}/plan">Review plan ${ic("arrow", 13)}</a></div></div></div>`;
    else if (m.status === "planning" || m.status === "queued")
      top = `<div class="note soft-violet">${glyph(m.status === "planning" ? "spin" : "dashed", "var(--violet)", 16)}<div><b>${m.status === "planning" ? "The planner is reading your code" : "Queued"}</b>${
        m.status === "planning" ? "You'll get a plan to approve in a few minutes." : "Starts when the project is free."
      }</div></div>`;
    else if (m.paused && isOpen) top = pausedCard(m, v);
    if (top) html += `<div style="padding:0 18px">${top}</div>`;
    html += board(v, leaves);
  }
  return html + `</div></div>`;
}

function board(v, leaves) {
  const m = v.mission;
  if (!leaves.length) return `<div class="empty">${ic("board", 26, 1.4)}<div class="big">No tasks yet</div><div>Tasks appear here once you approve the plan.</div></div>`;
  const parentTitle = Object.fromEntries(v.tasks.filter((t) => t.is_parent).map((t) => [t.local_id, t.title]));
  const runningTask = new Set(v.running.map((r) => r.task));
  let html = `<div class="board-scroll"><div class="board">`;
  for (const [name, g, color, statuses] of COLUMNS) {
    const ts = leaves.filter((t) => statuses.includes(t.status));
    html += `<div><div class="col-h">${glyph(g, color)}${name}<span class="n">${ts.length}</span></div><div class="col">`;
    if (!ts.length) html += `<div class="none">No tasks</div>`;
    for (const t of ts) {
      const cost = t.kind === "human" || !t.spend.tokens ? "" : m.budget_unit === "usd" ? `${usd(t.spend.usd)} · ${shortNum(t.spend.tokens)}` : tokens(t.spend.tokens);
      html += `<a class="card ${runningTask.has(t.id) ? "working" : ""}" href="#/t/${esc(t.id)}">
        ${t.parent && parentTitle[t.parent] ? `<div class="parent">${esc(parentTitle[t.parent])}</div>` : ""}
        <div class="top"><span class="id">${esc(t.local_id)}</span>${t.kind === "human" ? `<span class="tag soft-amber">${ic("user", 11, 2)} For you</span>` : ""}${t.failures ? `<span class="tag soft-red">${t.failures} failed</span>` : ""}</div>
        <div class="ct">${esc(t.title)}</div>
        <div class="bot">${tGlyph(t.status, 13)}<span>${esc(tLabel(t.status))}</span><span class="r">${cost}</span></div></a>`;
    }
    html += `</div></div>`;
  }
  return html + `</div></div>`;
}

let planNums = {};
function numberPlan(tasks, prefix = "") {
  tasks.forEach((t, i) => {
    const n = prefix ? `${prefix}.${i + 1}` : `${i + 1}`;
    planNums[t.key] = n;
    if (t.children?.length) numberPlan(t.children, n);
  });
}
function planTask(t, num) {
  let h = `<div class="pt"><div class="ph"><span class="num">${esc(num)}</span><div class="grow"><div class="row" style="flex-wrap:nowrap"><span class="ptitle grow">${esc(t.title)}</span>${
    t.for_you ? `<span class="tag soft-amber">${ic("user", 11, 2)} For you</span>` : ""
  }${t.depends_on?.length ? `<span class="faint small" style="white-space:nowrap">after ${t.depends_on.map((k) => esc(planNums[k] ?? k)).join(", ")}</span>` : ""}</div>`;
  if (t.goal) h += `<div class="pgoal">${esc(t.goal)}</div>`;
  if (!t.children?.length && t.criteria?.length) {
    h += `<details class="fold" data-k="pc-${esc(t.key)}" style="margin-top:6px"><summary class="faint small row" style="gap:4px">${ic("shield", 12)} ${plural(t.criteria.length, "check")} before it counts as done</summary><ul class="crit">${t.criteria
      .map((c) => `<li>${ic("check", 12, 2)}<span>${esc(c)}</span></li>`)
      .join("")}</ul></details>`;
  }
  h += `</div></div>`;
  if (t.children?.length) h += `<div class="kids">${t.children.map((c, i) => planTask(c, `${num}.${i + 1}`)).join("")}</div>`;
  return h + `</div>`;
}

function planContent(m, currentOverview) {
  const p = m.pending_plan;
  planNums = {};
  numberPlan(p.tasks);
  const count = (ts) => ts.reduce((n, t) => n + (t.children?.length ? count(t.children) : 1), 0);
  const n = count(p.tasks);
  const head =
    p.source === "plan" ? "Here's the plan" : p.source === "split" ? `An agent asked to split ${p.split_of} into smaller tasks` : "The final check found problems; here are fix tasks";
  let html = `<div class="h2" style="margin-top:22px">${ic("list", 15)} ${esc(head)} <span class="n">${plural(n, "task")} · run one at a time</span></div>`;
  if (p.reason) html += `<div class="note soft-gray" style="margin:0 0 12px">${ic("msg", 15)}<div>${esc(p.reason)}</div></div>`;
  html += `<div class="ptree">${p.tasks.map((t, i) => planTask(t, `${i + 1}`)).join("")}</div>`;
  const perms = p.permissions;
  html += `<div class="h2">${ic("lock", 15)} What agents may do <span class="n">${m.permission_mode === "full" ? "full access is on, so this is informational" : "anything else, they must ask"}</span></div><div class="panel"><div class="panel-b">
    <div class="row" style="align-items:flex-start;flex-wrap:nowrap"><span class="muted small" style="width:110px;flex:none;padding-top:3px">Run commands</span><div>${
      perms?.commands?.length ? perms.commands.map((c) => `<span class="chip mono">${esc(c)}</span>`).join("") : '<span class="faint">None</span>'
    }</div></div>
    <div class="row" style="align-items:flex-start;flex-wrap:nowrap;margin-top:8px"><span class="muted small" style="width:110px;flex:none;padding-top:3px">Websites</span><div>${
      perms?.domains?.length ? perms.domains.map((c) => `<span class="chip mono">${esc(c)}</span>`).join("") : '<span class="faint">No internet access</span>'
    }</div></div>
    ${perms?.paths?.length ? `<div class="row" style="align-items:flex-start;flex-wrap:nowrap;margin-top:8px"><span class="muted small" style="width:110px;flex:none;padding-top:3px">Outside folders</span><div>${perms.paths.map((c) => `<span class="chip mono">${esc(c)}</span>`).join("")}</div></div>` : ""}
  </div></div>`;
  if (p.overview) {
    html += `<details class="panel fold" data-k="plan-overview" style="margin-top:22px"><summary class="panel-h" style="border-bottom:0">${ic("doc", 15)} ${currentOverview ? "Updated" : "New"} PROJECT.md <span class="right faint small">the project summary every agent reads ${ic("down", 13)}</span></summary><div class="panel-b" style="border-top:1px solid var(--line)">${md(p.overview)}</div></details>`;
  }
  const open = !!drafts[`reject:${m.id}`];
  html += `<div class="decision sticky"><div class="bar"><div><div class="q">Approve this plan?</div><div class="why">Nothing touches your code until you do.</div></div>
      <div class="acts"><button class="btn" data-act="toggle" data-target="reject-box">Ask for changes</button>
      <button class="btn primary lg" data-act="approve" data-id="${esc(m.id)}">${ic("check", 14, 2.2)} Approve and start</button></div></div>
      <div id="reject-box" ${open ? "" : "hidden"}>${draftInput(`reject:${m.id}`, { rows: 2, placeholder: "What should the planner change? e.g. fewer tasks, don't touch the database…" })}
      <div class="row" style="justify-content:flex-end;margin-top:8px"><button class="btn" data-act="reject" data-id="${esc(m.id)}">${ic("send", 13)} Send to planner</button></div></div></div>`;
  return html;
}

async function finalContent(m, v) {
  const fin = [...v.tasks].reverse().find((t) => t.kind === "mission_verify");
  let verdict = null;
  if (fin) {
    const tv = await get(`/api/tasks/${enc(fin.id)}`);
    const vs = tv.task.verification?.verdicts ?? [];
    verdict = vs[vs.length - 1] ?? tv.task.pending_verdict;
  }
  let html = `<div class="decision"><div class="bar"><div><div class="q">${glyph("done", "var(--green)")} All tasks are done and the whole mission passed its final check</div><div class="why">Give it your final approval to close the mission.</div></div>
    <div class="acts">${m.overview_proposal ? `<label class="row small muted" style="gap:6px;cursor:pointer"><input type="checkbox" id="keep-overview" checked> Update PROJECT.md</label>` : ""}
    <button class="btn primary lg" data-act="acceptMission" data-id="${esc(m.id)}">${ic("check", 14, 2.2)} Approve mission</button></div></div></div>`;
  if (verdict) html += `<div class="h2">${ic("shield", 15)} Checked against your goal ${verdict.pass ? '<span class="tag soft-green">Passed</span>' : '<span class="tag soft-red">Failed</span>'}</div><div class="panel">${verdictRows(verdict, fin?.id)}</div>`;
  if (m.overview_proposal) html += `<details class="panel fold" data-k="final-overview" style="margin-top:10px"><summary class="panel-h" style="border-bottom:0">${ic("doc", 15)} Suggested PROJECT.md update<span class="right">${ic("down", 13)}</span></summary><div class="panel-b" style="border-top:1px solid var(--line)">${md(m.overview_proposal)}</div></details>`;
  return html;
}

function settingsContent(m, v) {
  const unit = m.budget_unit === "usd" ? "$" : "tokens";
  const isOpen = !["done", "cancelled"].includes(m.status);
  return `<div class="h2" style="margin-top:6px">How agents work</div><div class="slist">
    <div class="srow"><div class="grow"><b>Auto-accept verified tasks</b><span>Tasks that pass your checks and the verifier are accepted without waiting for you. You still approve the plan and the finished mission.</span></div>
      <label class="switch"><input type="checkbox" data-set="review_mode" data-id="${esc(m.id)}" ${m.review_mode === "auto" ? "checked" : ""} ${isOpen ? "" : "disabled"}><i></i></label></div>
    <div class="srow"><div class="grow"><b>Full access</b><span>Agents can run any command without asking. Off: they can only use what you approved with the plan.</span></div>
      <label class="switch"><input type="checkbox" data-set="permission_mode" data-id="${esc(m.id)}" ${m.permission_mode === "full" ? "checked" : ""} ${isOpen ? "" : "disabled"}><i></i></label></div>
  </div>
  <div class="h2">Limits</div><div class="slist">
    <div class="srow"><div class="grow"><b>Budget per task</b><span>An agent is stopped the moment its task goes over. You can then add more.</span></div><div class="num">${draftInput(`bt:${m.id}`, { value: m.budget_unit === "usd" ? m.budget_task : shortNum(m.budget_task) })}</div><span class="muted small" style="width:40px">${unit}</span></div>
    <div class="srow"><div class="grow"><b>Mission budget</b><span>Everything pauses when the whole mission reaches this. Spent so far: ${budgetFmt(m.budget_unit, spent(m.budget_unit, v.spend))}.</span></div><div class="num">${draftInput(`bm:${m.id}`, { value: m.budget_unit === "usd" ? m.budget_mission : shortNum(m.budget_mission) })}</div><span class="muted small" style="width:40px">${unit}</span></div>
    <div class="srow"><div class="grow"><b>Time limit per run</b><span>Agents that run longer are stopped.</span></div><div class="num">${draftInput(`tl:${m.id}`, { type: "number", value: m.time_limit_min })}</div><span class="muted small" style="width:40px">min</span></div>
  </div>
  <div class="row" style="justify-content:flex-end;margin-top:10px"><button class="btn primary" data-act="saveBudgets" data-id="${esc(m.id)}">Save limits</button></div>
  <div class="h2">Agents <span class="n">changes apply to the next agent that starts</span></div><div class="slist">
    ${[
      ["planner", "Plans", "Breaks the mission into tasks and writes fix tasks."],
      ["worker", "Builds", "Does each task."],
      ["verifier", "Checks", "Checks every task and the finished mission against its criteria."],
    ]
      .map(
        ([role, label, desc]) =>
          `<div class="srow"><div class="grow"><b>${label}</b><span>${desc}</span></div>${agentPicker(m.id, role, m[`${role}_profile`], isOpen)}</div>`,
      )
      .join("")}
  </div>
  ${isOpen ? `<div class="h2" style="color:var(--red)">Danger zone</div><div class="slist"><div class="srow"><div class="grow"><b>Cancel mission</b><span>Running agents stop and no more tasks start. Changes already made stay in your folder.</span></div><button class="btn danger" data-act="cancelMission" data-id="${esc(m.id)}">Cancel mission</button></div></div>` : ""}`;
}

function agentPicker(mid, role, current, enabled) {
  const H = harnessData?.harnesses ?? {};
  const opts = [];
  for (const [h, v] of Object.entries(H)) {
    if (!v.installed) continue;
    const models = v.models.length ? v.models : [{ id: "", label: "Default model" }];
    opts.push(`<optgroup label="${esc(v.label)}">${models.map((x) => {
      const spec = x.id ? `${h}:${x.id}` : h;
      return `<option value="${esc(spec)}" ${spec === current ? "selected" : ""}>${esc(x.label)}</option>`;
    }).join("")}</optgroup>`);
  }
  const known = opts.join("").includes(`value="${esc(current)}"`);
  const extra = known ? "" : `<option value="${esc(current)}" selected>${esc(agentLabel(current))}</option>`;
  return `<select class="input" style="width:260px" data-agent="${esc(role)}" data-id="${esc(mid)}" ${enabled ? "" : "disabled"}>${extra}${opts.join("")}</select>`;
}

function shotsGallery(v, taskId) {
  if (!v.screenshots?.length || !taskId) return "";
  return `<div class="shots">${v.screenshots
    .map((s) => {
      const src = `/api/shots/${enc(taskId)}/${enc(s.file)}`;
      return `<figure data-act="shot" data-src="${esc(src)}" data-cap="${esc(s.caption)}"><img src="${esc(src)}" loading="lazy" alt="${esc(s.caption)}"><figcaption>${esc(s.caption)}</figcaption></figure>`;
    })
    .join("")}</div>`;
}

function verdictRows(v, taskId) {
  let h = (v.criteria ?? [])
    .map(
      (c) =>
        `<div class="vrow"><span class="mark ${c.met ? "ok" : "no"}">${ic(c.met ? "check" : "x", 11, 3)}</span><div style="min-width:0"><div class="c">${esc(c.criterion)}</div><div class="e">${esc(c.evidence)}</div></div></div>`,
    )
    .join("");
  if (v.feedback) h += `<div class="vrow"><span class="mark" style="background:var(--hover);color:var(--muted)">${ic("msg", 11, 2)}</span><div><div class="c">Checker's notes</div><div class="e">${esc(v.feedback)}</div></div></div>`;
  if (v.screenshots?.length) h += `<div class="vrow" style="display:block"><div class="c row" style="gap:6px">${ic("search", 13)} Tested in a browser <span class="faint small">${plural(v.screenshots.length, "screenshot")}</span></div>${shotsGallery(v, taskId)}</div>`;
  return h;
}

// ───────────────────────── task ─────────────────────────

function parseDiff(text) {
  const files = [];
  let cur = null;
  for (const line of String(text ?? "").split("\n")) {
    if (line.startsWith("--- ")) {
      cur = { name: "", lines: [], add: 0, del: 0, isNew: false, isDel: false };
      files.push(cur);
      continue;
    }
    if (!cur || line === "") continue;
    if (line.startsWith("+++ ") && !cur.name) {
      cur.name = line.slice(4).replace(/^b\//, "");
      continue;
    }
    if (line.startsWith("@@")) {
      const m = /@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
      cur.lines.push({ t: "h", s: line, a: m ? +m[1] : 0, b: m ? +m[2] : 0 });
      if (/^@@ -0,0 /.test(line)) cur.isNew = true;
      if (/ \+0,0 @@/.test(line)) cur.isDel = true;
      continue;
    }
    if (line.startsWith("Binary or unreadable")) {
      files.push({ name: line.replace(/^Binary or unreadable file \w+: /, ""), lines: [], add: 0, del: 0, binary: true });
      cur = null;
      continue;
    }
    cur.lines.push({ t: line[0] === "+" ? "a" : line[0] === "-" ? "d" : "c", s: line.slice(1) });
    if (line[0] === "+") cur.add++;
    else if (line[0] === "-") cur.del++;
  }
  return files;
}

function bars(add, del) {
  const tot = add + del || 1;
  const a = Math.round((add / tot) * 5);
  const d = Math.min(5 - a, Math.round((del / tot) * 5));
  return `<span class="bars">${"<i class='a'></i>".repeat(a)}${"<i class='d'></i>".repeat(d)}${"<i></i>".repeat(5 - a - d)}</span>`;
}

function diffHtml(files, taskId) {
  return files
    .map((f, i) => {
      let a = 0;
      let b = 0;
      let rows = "";
      for (const l of f.lines) {
        if (l.t === "h") {
          a = l.a;
          b = l.b;
          rows += `<tr class="h"><td class="ln"></td><td class="ln"></td><td class="sg"></td><td>${esc(l.s)}</td></tr>`;
        } else if (l.t === "a") rows += `<tr class="a"><td class="ln"></td><td class="ln">${b++}</td><td class="sg">+</td><td class="code">${esc(l.s)}</td></tr>`;
        else if (l.t === "d") rows += `<tr class="d"><td class="ln">${a++}</td><td class="ln"></td><td class="sg">−</td><td class="code">${esc(l.s)}</td></tr>`;
        else rows += `<tr><td class="ln">${a++}</td><td class="ln">${b++}</td><td class="sg"></td><td class="code">${esc(l.s)}</td></tr>`;
      }
      const badge = f.binary ? '<span class="tag soft-gray">binary</span>' : f.isNew ? '<span class="tag soft-green">new</span>' : f.isDel ? '<span class="tag soft-red">deleted</span>' : "";
      return `<details class="dfile" id="df-${esc(taskId)}-${i}" data-k="df-${esc(taskId)}-${esc(f.name)}" open><summary><span class="chev">${ic("down", 13)}</span>${ic("file", 13)}<span class="name">${esc(f.name)}</span>${badge}<span class="plus">+${f.add}</span><span class="minus">−${f.del}</span></summary>${
        rows ? `<table class="dtable">${rows}</table>` : ""
      }</details>`;
    })
    .join("");
}

async function taskScreen(id) {
  const html = await taskDetail(id, { embedded: false });
  return html;
}

async function taskDetail(id, { embedded }) {
  const v = await get(`/api/tasks/${enc(id)}?diff=1`);
  const t = v.task;
  const m = v.mission;
  const ver = t.verification ?? {};
  const verdicts = ver.verdicts ?? [];
  const last = verdicts[verdicts.length - 1];
  const q = v.questions?.[0];
  const files = t.kind === "work" && t.base_snapshot && v.diff && !/^\((no changes|no snapshot)/.test(v.diff) ? parseDiff(v.diff) : [];
  const adds = files.reduce((n, f) => n + f.add, 0);
  const dels = files.reduce((n, f) => n + f.del, 0);
  const tab = tabs[t.id] ?? "overview";
  const lastWork = [...(v.runs ?? [])].reverse().find((r) => r.role === "work");
  const taskSpent = spent(m.budget_unit, v.spend);

  let main = `<div class="row small muted">${embedded ? `${projChip(m.project)} ${esc(m.project)} <span class="faint">›</span> <a href="#/m/${esc(m.id)}">${esc(m.title)}</a> <span class="faint">›</span>` : ""}${tGlyph(t.status, 13)}<span class="id">${esc(t.local_id)}</span></div>
    <div class="title" style="margin-top:10px">${esc(t.title)}</div><div class="lede">${esc(t.goal)}</div>`;
  if (embedded) {
    main += `<div class="inline-props">${statusPill(t.status)}${t.kind === "human" ? `<span class="pill">${ic("user", 13)} For you</span>` : `<span class="pill">${ic("spark", 13)}${esc(lastWork?.model || m.worker || "agent")}</span>`}
      ${t.kind === "human" ? "" : `<span class="pill">${ic("coin", 13)}${budgetFmt(m.budget_unit, taskSpent)} <span class="k">of ${budgetFmt(m.budget_unit, m.budget_task)}</span></span><span class="pill">${ic("chart", 13)}${tokens(v.spend.tokens)}</span>`}
      ${t.attempt > 1 ? `<span class="pill">${ic("retry", 13)} Attempt ${t.attempt}</span>` : ""}<a class="pill" href="#/t/${esc(t.id)}">${ic("arrow", 13)} Full page</a></div>`;
  }
  main += decision(t, m, q, last);

  if (t.kind === "work" || t.kind === "mission_verify") {
    main += `<div class="tabs">
      <button class="tab ${tab === "overview" ? "on" : ""}" data-act="tab" data-id="${esc(t.id)}" data-tab="overview">${ic("doc", 14)} Overview</button>
      ${t.kind === "work" ? `<button class="tab ${tab === "changes" ? "on" : ""}" data-act="tab" data-id="${esc(t.id)}" data-tab="changes">${ic("diff", 14)} Changes <span class="n">${files.length}</span>${files.length ? `<span class="plus">+${adds}</span><span class="minus">−${dels}</span>` : ""}</button>` : ""}
      <button class="tab ${tab === "activity" ? "on" : ""}" data-act="tab" data-id="${esc(t.id)}" data-tab="activity">${ic("pulse", 14)} Activity <span class="n">${v.log?.length || ""}</span></button></div>`;
  } else if (t.kind === "human") {
    tabs[t.id] = "overview";
  }

  if (tab === "changes" && t.kind === "work") {
    main += `<div style="margin-top:16px">${v.diff_note ? `<div class="faint small" style="margin-bottom:8px">${esc(v.diff_note)}</div>` : ""}${
      files.length ? diffHtml(files, t.id) : `<div class="empty">${ic("diff", 24, 1.4)}<div class="big">No changes yet</div></div>`
    }</div>`;
  } else if (tab === "activity") {
    main += activity(v, m);
  } else {
    main += overview(t, m, v, files, last, ver);
  }

  if (embedded) return `<div class="task-main">${main}</div>`;

  const props = `<div class="props">
    <h4>Properties</h4>
    <div class="prop"><span class="k">Status</span><span class="v">${tGlyph(t.status)}${esc(tLabel(t.status))}</span></div>
    <div class="prop"><span class="k">${t.kind === "human" ? "Owner" : "Agent"}</span><span class="v">${t.kind === "human" ? `${ic("user", 14)} You` : `${ic("spark", 14)}${esc(lastWork?.model || lastWork?.profile || "not started")}`}</span></div>
    ${t.kind === "human" ? "" : `<div class="prop"><span class="k">Budget</span><span class="v">${budgetFmt(m.budget_unit, taskSpent)} <span class="faint">/ ${budgetFmt(m.budget_unit, m.budget_task)}</span> ${meter(taskSpent / m.budget_task)}</span></div>
    <div class="prop"><span class="k">Tokens</span><span class="v">${tokens(v.spend.tokens)}</span></div>
    ${v.spend.usd > 0 ? `<div class="prop"><span class="k">Cost</span><span class="v">${usd(v.spend.usd)}</span></div>` : ""}`}
    ${t.attempt ? `<div class="prop"><span class="k">Attempt</span><span class="v">${t.attempt}${t.failures ? ` <span class="tag soft-red">${t.failures} failed</span>` : ""}</span></div>` : ""}
    ${t.depends?.length ? `<div class="prop"><span class="k">After</span><span class="v">${t.depends.map((d) => `<a href="#/t/${esc(m.id)}:${esc(d)}" class="id">${esc(d)}</a>`).join(", ")}</span></div>` : ""}
    <div class="prop"><span class="k">Updated</span><span class="v">${ago(t.updated_at) === "now" ? "just now" : esc(ago(t.updated_at)) + " ago"}</span></div>
    <h4>Mission</h4>
    <a class="prop" href="#/m/${esc(m.id)}"><span class="v">${glyph(MISSION[m.status]?.[1] ?? "empty", MISSION[m.status]?.[2] ?? "var(--muted)")}${esc(m.title)}</span></a>
    <div class="prop"><span class="v">${projChip(m.project)} ${esc(m.project)}</span></div>
    <div class="prop"><span class="v">${ic(m.review_mode === "auto" ? "bolt" : "user", 14)}${m.review_mode === "auto" ? "Auto-accept on" : "You review each task"}</span></div>
  </div>`;
  return `<div class="sheet">${topbar(
    `${projChip(m.project)}<span>${esc(m.project)}</span><span class="sep">›</span><a href="#/m/${esc(m.id)}">${esc(m.title)}</a><span class="sep">›</span><span class="here">${esc(t.local_id)} ${esc(t.title)}</span>`,
  )}<div class="body" data-scroll="t-${esc(t.id)}-${tab}"><div class="task-grid"><div class="task-main">${main}</div>${props}</div></div></div>`;
}

function overview(t, m, v, files, last, ver) {
  let h = "";
  if (t.feedback && !["done", "cancelled", "in_review", "stuck", "failed"].includes(t.status)) {
    h += `<div class="note soft-amber">${ic("msg", 15)}<div><b>Latest feedback to the agent</b><pre>${esc(t.feedback)}</pre></div></div>`;
  }
  if (t.result) {
    const r = t.result;
    h += `<div class="h2">${ic("spark", 15)} What the agent did</div><div class="summary">${md(r.summary)}</div>`;
    const none = (s) => !s || /^(none|n\/a|-)$/i.test(s.trim());
    if (!none(r.decisions)) h += `<div class="note soft-gray">${ic("flag", 15)}<div><b>Decisions it made</b>${md(r.decisions)}</div></div>`;
    if (!none(r.gotchas)) h += `<div class="note soft-gray">${ic("alert", 15)}<div><b>Things to know</b>${md(r.gotchas)}</div></div>`;
  }
  if (files.length) {
    h += `<div class="h2">${ic("diff", 15)} Files changed <span class="n">${files.length}</span></div><div class="files-list">${files
      .map(
        (f, i) =>
          `<div class="fl" data-act="jump" data-id="${esc(t.id)}" data-i="${i}">${ic("file", 13)}<span class="p">${esc(f.name)}</span>${f.isNew ? '<span class="tag soft-green">new</span>' : f.isDel ? '<span class="tag soft-red">deleted</span>' : ""}<span class="plus">+${f.add}</span><span class="minus">−${f.del}</span>${bars(f.add, f.del)}</div>`,
      )
      .join("")}</div>`;
    if (ver.files_mismatch && (ver.files_mismatch.unlisted?.length || ver.files_mismatch.listed_but_unchanged?.length)) {
      h += `<div class="note soft-amber">${ic("alert", 15)}<div><b>Files don't match what the agent reported</b>${
        ver.files_mismatch.unlisted?.length ? `Changed but not mentioned: ${ver.files_mismatch.unlisted.map(esc).join(", ")}. ` : ""
      }${ver.files_mismatch.listed_but_unchanged?.length ? `Mentioned but unchanged: ${ver.files_mismatch.listed_but_unchanged.map(esc).join(", ")}.` : ""}</div></div>`;
    }
  }
  if (ver.checks?.length || last) {
    const allOk = (ver.checks ?? []).every((c) => c.ok) && (!last || last.pass);
    h += `<div class="h2">${ic("shield", 15)} Checks ${allOk ? '<span class="tag soft-green">All passed</span>' : '<span class="tag soft-red">Failed</span>'}</div>`;
    if (ver.checks?.length) {
      h += `<div class="panel"><div class="panel-h">${ic("bolt", 14)} Your check commands</div>${ver.checks
        .map(
          (c, i) =>
            `<details class="vrow fold" data-k="chk-${esc(t.id)}-${i}" style="display:block"><summary class="row" style="flex-wrap:nowrap"><span class="mark ${c.ok ? "ok" : "no"}">${ic(c.ok ? "check" : "x", 11, 3)}</span><code class="grow">${esc(c.command)}</code><span class="faint small">output ${ic("down", 12)}</span></summary><pre class="out">${esc(c.output || "(no output)")}</pre></details>`,
        )
        .join("")}</div>`;
    }
    if (last) {
      h += `<div class="panel"><div class="panel-h">${ic("spark", 14)} Checked by a second agent<span class="right faint small">${esc(agentLabel(last.profile))} · attempt ${last.attempt}</span></div>${verdictRows(last, t.id)}</div>`;
    }
  } else if (t.criteria?.length) {
    h += `<div class="h2">${ic("shield", 15)} Done when</div><div class="panel"><div class="panel-b"><ul class="crit" style="margin:0">${t.criteria.map((c) => `<li>${ic("check", 12, 2)}<span>${esc(c)}</span></li>`).join("")}</ul></div></div>`;
  }
  if (t.context) h += `<details class="panel fold" data-k="ctx-${esc(t.id)}" style="margin-top:22px"><summary class="panel-h" style="border-bottom:0">${ic("doc", 14)} Context given to the agent<span class="right">${ic("down", 13)}</span></summary><div class="panel-b" style="border-top:1px solid var(--line)">${md(t.context)}</div></details>`;
  return h;
}

function activity(v, m) {
  const who = (a) => (a === "you" ? ["user", "You"] : a === "northern-lights" ? ["bolt", "Northern Lights"] : a === "auto-accept" ? ["bolt", "Auto-accept"] : ["spark", a]);
  let h = `<div class="h2">${ic("pulse", 15)} Timeline</div>`;
  h += v.log?.length
    ? `<ul class="tl">${v.log
        .slice()
        .reverse()
        .map((l) => {
          const [icon, name] = who(l.actor);
          return `<li><span class="dot">${ic(icon, 11, 2)}</span><div><span class="who">${esc(name)}</span><span class="when">${esc(clock(l.ts))}</span><div class="what">${esc(l.text)}</div></div></li>`;
        })
        .join("")}</ul>`
    : `<div class="muted">Nothing yet.</div>`;
  if (v.runs?.length) {
    h += `<div class="h2">${ic("spark", 15)} Agent runs <span class="n">${budgetFmt(m.budget_unit, spent(m.budget_unit, v.spend))} total</span></div><div class="panel"><table class="runs"><tr><th>#</th><th>Role</th><th>Agent</th><th>Result</th><th>Tokens</th><th>Cost</th><th>Started</th></tr>${v.runs
      .map(
        (r) =>
          `<tr><td class="id">${r.id}</td><td>${esc(r.role === "verify" ? "check" : r.role)}</td><td>${esc(r.model || r.profile)}</td><td>${
            r.status === "running" ? `<span class="tag soft-blue"><span class="live-dot"></span> running</span>` : esc(r.stop_reason || r.status)
          }</td><td>${tokens(r.tokens)}</td><td>${usd(r.usd)}</td><td class="faint">${ago(r.started_at) === "now" ? "just now" : ago(r.started_at) + " ago"}</td></tr>`,
      )
      .join("")}</table></div>`;
  }
  return h;
}

function decision(t, m, q, last) {
  const id = esc(t.id);
  const s = t.status;
  if (s === "in_review") {
    const open = !!drafts[`sb:${t.id}`];
    return `<div class="decision"><div class="bar"><div><div class="q">${tGlyph("in_review")} Ready for your review</div><div class="why">${
      last?.pass ? "It passed every check. Look over the changes, then accept." : "Look over the changes, then decide."
    }</div></div><div class="acts">
      <button class="btn ghost danger" data-act="discard" data-id="${id}">${ic("trash", 13)} Discard</button>
      <button class="btn" data-act="toggle" data-target="sb-${id}">${ic("undo", 13)} Send back</button>
      <button class="btn primary lg" data-act="accept" data-id="${id}">${ic("check", 14, 2.2)} Accept <kbd>A</kbd></button></div></div>
      <div id="sb-${id}" ${open ? "" : "hidden"}>${draftInput(`sb:${t.id}`, { rows: 2, placeholder: "What should the agent change?" })}
      <div class="row" style="justify-content:flex-end;margin-top:8px"><button class="btn" data-act="sendBack" data-id="${id}">${ic("send", 13)} Send back with feedback</button></div></div></div>`;
  }
  if (s === "waiting" && q) {
    const b = q.body;
    if (q.kind === "permission") {
      return `<div class="decision amber"><div class="q">${ic("key", 15)} The agent is asking for permission</div>
        <div class="panel"><div class="panel-b"><div class="faint small">${esc(b.kind)}</div><code style="font-size:13px;color:var(--text)">${esc(b.value)}</code><div class="muted" style="margin-top:6px">${esc(b.reason)}</div></div></div>
        <div class="acts" style="justify-content:flex-end"><button class="btn ghost danger" data-act="permit" data-d="deny" data-id="${id}">Deny</button>
        <button class="btn" data-act="permit" data-d="once" data-id="${id}">Allow for this task</button>
        <button class="btn primary" data-act="permit" data-d="mission" data-id="${id}">${ic("check", 14, 2.2)} Allow for the mission</button></div></div>`;
    }
    return `<div class="decision amber"><div class="q">${ic("msg", 15)} The agent has a question</div><div style="font-size:14px">${md(b.question)}</div>
      ${b.choices?.length ? `<div class="acts" style="justify-content:flex-start">${b.choices.map((c) => `<button class="btn" data-act="answer" data-text="${esc(c)}" data-id="${id}">${esc(c)}</button>`).join("")}</div>` : ""}
      ${draftInput(`ans:${t.id}`, { rows: 2, placeholder: "Your answer…" })}
      <div class="acts" style="justify-content:flex-end"><button class="btn primary" data-act="answer" data-id="${id}">${ic("send", 13)} Send answer</button></div></div>`;
  }
  if (s === "your_turn") {
    return `<div class="decision amber"><div class="q">${ic("user", 15)} This one is for you</div><div class="why">Do it yourself, then mark it done. Your note is passed on to the agents.</div>
      ${draftInput(`done:${t.id}`, { rows: 2, placeholder: "Optional note, e.g. the key is in .env as STRIPE_SECRET_KEY" })}
      <div class="acts" style="justify-content:flex-end"><button class="btn ghost danger" data-act="cancelTask" data-id="${id}">Skip it</button><button class="btn primary" data-act="done" data-id="${id}">${ic("check", 14, 2.2)} Mark done</button></div></div>`;
  }
  if (s === "over_limit") {
    const unit = m.budget_unit === "usd" ? "$" : "tokens";
    return `<div class="decision amber"><div class="q">${ic("coin", 15)} This task hit its budget (${budgetFmt(m.budget_unit, m.budget_task)})</div><div class="why">The agent was stopped. Its work so far is still in the folder.</div>
      <div class="acts" style="justify-content:flex-start"><span class="muted">Add</span><div style="width:90px">${draftInput(`raise:${t.id}`, { type: "number", value: m.budget_unit === "usd" ? 2 : 1000000 })}</div><span class="muted">${unit}</span>
      <button class="btn primary" data-act="raise" data-id="${id}">${ic("play", 12)} Add and continue</button><span style="flex:1"></span>
      <button class="btn" data-act="retry" data-id="${id}">${ic("retry", 13)} Start over</button><button class="btn ghost danger" data-act="discard" data-id="${id}">${ic("trash", 13)} Discard</button></div></div>`;
  }
  if (s === "stuck" || s === "failed") {
    return `<div class="decision red"><div class="q">${ic("alert", 15)} ${s === "stuck" ? "The agent got stuck" : "This task failed"}</div>
      ${t.feedback ? `<pre class="out" style="margin:0">${esc(t.feedback)}</pre>` : ""}
      ${draftInput(`retry:${t.id}`, { rows: 2, placeholder: "Optional hint for the next try" })}
      <div class="acts" style="justify-content:flex-end"><button class="btn ghost danger" data-act="discard" data-id="${id}">${ic("trash", 13)} Discard changes</button><button class="btn" data-act="cancelTask" data-id="${id}">Skip task</button><button class="btn primary" data-act="retry" data-id="${id}">${ic("retry", 13)} Try again</button></div></div>`;
  }
  if (s === "in_progress" || s === "verifying") {
    return `<div class="note soft-blue">${glyph("spin", "var(--blue)", 16)}<div><b>${s === "verifying" ? "Being checked right now" : "An agent is working on this"}</b>This page updates by itself.</div></div>`;
  }
  if (s === "pending" || s === "ready") {
    return `<div class="note soft-gray">${tGlyph(s, 16)}<div class="grow"><b>${s === "ready" ? "Up next" : "Waiting for earlier tasks"}</b>${
      t.depends?.length ? `Starts after ${t.depends.map(esc).join(", ")}.` : "Starts when the project is free."
    }</div><button class="btn ghost danger" data-act="cancelTask" data-id="${id}">Skip</button></div>`;
  }
  if (s === "cancelled") {
    return `<div class="note soft-gray">${tGlyph(s, 16)}<div class="grow"><b>Cancelled</b>If its changes were discarded, you can bring them back.</div><button class="btn" data-act="undoDiscard" data-id="${id}">${ic("undo", 13)} Undo discard</button></div>`;
  }
  return "";
}

// ───────────────────────── new mission ─────────────────────────

function agentSelect(key, harness, value) {
  const models = harnessData?.harnesses?.[harness]?.models ?? [];
  if (!models.length) return `<span class="faint">default</span>`;
  return `<select data-draft="${esc(key)}">${models.map((m) => `<option value="${esc(m.id)}" ${m.id === value ? "selected" : ""}>${esc(m.label)}</option>`).join("")}</select>`;
}

const PRESETS = [
  ["quick", "Quick", "Small, well-defined changes. Fast and cheap."],
  ["balanced", "Balanced", "Most work. Strong planning and checking."],
  ["thorough", "Thorough", "Big or risky changes. Best models everywhere."],
];
function presetConfig(harness, preset) {
  if (harness === "antigravity") {
    const models = harnessData?.harnesses?.antigravity?.models ?? [];
    const find = (re) => models.find((m) => re.test(m.id))?.id;
    const best = models[0]?.id ?? "";
    const flash = find(/flash-high/) ?? best;
    const bestX = find(/neon-xhigh/) ?? find(/xhigh/) ?? best;
    return {
      quick: { planner: flash, worker: flash, verifier: flash, unit: "tokens", bt: "1M", bm: "5M", tl: "15" },
      balanced: { planner: best, worker: flash, verifier: best, unit: "tokens", bt: "2M", bm: "20M", tl: "30" },
      thorough: { planner: bestX, worker: best, verifier: bestX, unit: "tokens", bt: "4M", bm: "40M", tl: "45" },
    }[preset];
  }
  if (harness === "claude") {
    return {
      quick: { planner: "sonnet", worker: "haiku", verifier: "sonnet", unit: "usd", bt: "1", bm: "5", tl: "15" },
      balanced: { planner: "opus", worker: "sonnet", verifier: "opus", unit: "usd", bt: "2", bm: "10", tl: "30" },
      thorough: { planner: "opus", worker: "opus", verifier: "opus", unit: "usd", bt: "5", bm: "30", tl: "45" },
    }[preset];
  }
  return { quick: { bt: "1", bm: "5", tl: "15" }, balanced: { bt: "2", bm: "10", tl: "30" }, thorough: { bt: "5", bm: "30", tl: "45" } }[preset] && {
    planner: "", worker: "", verifier: "", unit: "usd", ...{ quick: { bt: "1", bm: "5", tl: "15" }, balanced: { bt: "2", bm: "10", tl: "30" }, thorough: { bt: "5", bm: "30", tl: "45" } }[preset],
  };
}
function applyPreset(preset) {
  const c = presetConfig(drafts["nm:harness"], preset);
  if (!c) return;
  for (const k of ["planner", "worker", "verifier", "unit", "bt", "bm", "tl"]) drafts[`nm:${k}`] = c[k];
  drafts["nm:preset"] = preset;
}
/** Split a stored agent spec into harness + model ("antigravity:x", "claude", or a named profile). */
function parseSpec(spec) {
  const m = /^(claude|codex|antigravity)(?::(.+))?$/.exec(spec ?? "");
  if (m) return { harness: m[1], model: m[2] ?? "" };
  const p = harnessData?.profiles?.[spec];
  return p ? { harness: p.harness, model: p.model ?? "" } : null;
}
/** Start a new mission from the settings of this project's last mission, or from Balanced. */
function seedComposer(projectId) {
  drafts["nm:seeded"] = projectId;
  delete drafts["nm:seededFrom"];
  const H = harnessData.harnesses;
  const last = cache.missions.filter((m) => m.project_id === projectId).slice(-1)[0];
  const w = last && parseSpec(last.worker_profile);
  if (last && w && H[w.harness]?.installed) {
    drafts["nm:harness"] = w.harness;
    for (const role of ["planner", "worker", "verifier"]) drafts[`nm:${role}`] = parseSpec(last[`${role}_profile`])?.model ?? "";
    drafts["nm:unit"] = last.budget_unit;
    drafts["nm:bt"] = last.budget_unit === "usd" ? String(last.budget_task) : shortNum(last.budget_task);
    drafts["nm:bm"] = last.budget_unit === "usd" ? String(last.budget_mission) : shortNum(last.budget_mission);
    drafts["nm:tl"] = String(last.time_limit_min);
    drafts["nm:auto"] = last.review_mode === "auto";
    drafts["nm:full"] = last.permission_mode === "full";
    const match = PRESETS.map(([k]) => k).find((k) => {
      const c = presetConfig(w.harness, k);
      return c && ["planner", "worker", "verifier", "unit", "bt", "bm", "tl"].every((f) => String(c[f]) === String(drafts[`nm:${f}`]));
    });
    drafts["nm:preset"] = match ?? "custom";
    drafts["nm:seededFrom"] = last.id;
    return;
  }
  const installed = Object.keys(H).filter((h) => H[h].installed);
  drafts["nm:harness"] = installed.includes("claude") ? "claude" : installed[0] ?? "claude";
  applyPreset("balanced");
}

let sharpening = false;
let sharpenInfo = null;

async function newScreen() {
  const [projects] = await Promise.all([get("/api/projects"), loadHarnesses()]);
  const has = projects.length > 0;
  if (has && !projects.some((p) => p.id === drafts["nm:project"])) drafts["nm:project"] = projects[projects.length - 1].id;
  const H = harnessData.harnesses;
  if (has && drafts["nm:seeded"] !== drafts["nm:project"]) seedComposer(drafts["nm:project"]);
  const harness = drafts["nm:harness"];
  const preset = drafts["nm:preset"] ?? "balanced";
  const unit = drafts["nm:unit"] ?? "usd";
  const auto = drafts["nm:auto"] !== false;
  const full = !!drafts["nm:full"];
  const adv = !!drafts["nm:advanced"];
  const sharpenHarness = harness === "codex" ? (H.claude?.installed ? "claude" : H.antigravity?.installed ? "antigravity" : null) : harness;
  const modelName = (h, id) => (H[h]?.models ?? []).find((m) => m.id === id)?.label ?? (id || "default");
  let body = `<div class="wrap narrow" style="padding-top:40px">`;
  if (has) {
    const seeded = drafts["nm:seededFrom"] ? cache.missions.find((m) => m.id === drafts["nm:seededFrom"]) : null;
    body += `<div class="composer">
      <div class="ctop"><label class="optbtn">${ic("folder", 13)}<select data-draft="nm:project">${projects
        .map((p) => `<option value="${esc(p.id)}" ${p.id === drafts["nm:project"] ? "selected" : ""}>${esc(p.id)}</option>`)
        .join("")}</select></label><span class="faint small">${ic("right", 12)}</span><span class="muted small grow">New mission</span>
        ${seeded ? `<span class="faint small" title="Settings start from the last mission in this project">${ic("retry", 12)} Settings from “${esc(seeded.title)}”</span>` : ""}</div>
      ${draftInput("nm:title", { placeholder: "Mission title", cls: "bare ctitle" })}
      ${draftInput("nm:goal", { rows: 5, placeholder: "Describe what you want, roughly is fine. Then press Sharpen and an agent turns it into a testable goal.\n\ne.g. “add a ui to the tracking code so i can see stock status”", cls: "bare cgoal" })}
      <div class="sharpen">
        ${
          sharpenHarness
            ? `<button class="btn ${sharpening ? "" : "sparkle"}" data-act="sharpen" ${sharpening ? "disabled" : ""}>${sharpening ? `${glyph("spin", "var(--violet)", 13)} Reading your project…` : `${ic("spark", 13)} Sharpen`}</button>
               <span class="faint small grow">${sharpening ? "This takes about 20–60 seconds." : `Drafts a clear title, goal and “done when” checks from your idea, using ${esc(H[sharpenHarness].label)}.`}</span>`
            : ""
        }
        ${drafts["nm:prev"] && !sharpening ? `<button class="btn ghost" data-act="unsharpen">${ic("undo", 13)} Undo</button>` : ""}
      </div>
      ${
        sharpenInfo && !sharpening
          ? `<div class="note soft-violet" style="margin:0 16px 12px">${ic("spark", 14)}<div class="grow"><b>Sharpened${sharpenInfo.tokens ? ` · ${shortNum(sharpenInfo.tokens)} tokens` : ""}${sharpenInfo.usd ? ` · ${usd(sharpenInfo.usd)}` : ""}</b>${
              sharpenInfo.questions?.length
                ? `Worth deciding before you start (answer in the goal if you like):<ul style="margin:4px 0 0;padding-left:18px">${sharpenInfo.questions.map((q) => `<li>${esc(q)}</li>`).join("")}</ul>`
                : "Edit anything you like, then start planning."
            }</div></div>`
          : ""
      }
      <div class="presets-h"><span class="muted small">Agents from</span><div class="seg">${Object.entries(H)
        .map(
          ([h, v]) =>
            `<button data-act="nmHarness" data-h="${h}" class="${h === harness ? "on" : ""}" ${v.installed ? "" : `disabled title="${esc(v.label)} isn't installed"`}>${esc(v.label)}</button>`,
        )
        .join("")}</div></div>
      <div class="presets">${PRESETS.map(([k, label, desc]) => {
        const c = presetConfig(harness, k);
        const cap = c ? (c.unit === "usd" ? `up to $${c.bm}` : `up to ${c.bm} tokens`) : "";
        const who = c && H[harness]?.models?.length ? `${esc(modelName(harness, c.planner))} plans · ${esc(modelName(harness, c.worker))} builds` : "Default model";
        return `<button class="preset ${preset === k ? "on" : ""}" data-act="nmPreset" data-p="${k}"><b>${label}</b><span>${esc(desc)}</span><span class="who">${who}</span><span class="cap">${cap}</span></button>`;
      }).join("")}</div>
      <div class="opts">
        <button class="optbtn ${auto ? "on" : ""}" data-act="nmToggle" data-k="nm:auto" title="Accept tasks that pass every check without asking you">${ic("bolt", 13)} Auto-accept ${auto ? "on" : "off"}</button>
        <button class="optbtn ${full ? "on" : ""}" data-act="nmToggle" data-k="nm:full" title="Agents can run any command without asking">${ic(full ? "unlock" : "lock", 13)} ${full ? "Full access" : "Ask before new commands"}</button>
        <button class="optbtn ${adv ? "on" : ""}" data-act="nmToggle" data-k="nm:advanced">${ic("gear", 13)} ${preset === "custom" ? "Custom settings" : "Advanced"} ${ic(adv ? "down" : "right", 12)}</button>
      </div>
      ${
        adv
          ? `<div class="advanced">
        <div class="roles">
          <label class="optbtn"><span class="k">Plans</span>${agentSelect("nm:planner", harness, drafts["nm:planner"])}</label>
          <label class="optbtn"><span class="k">Builds</span>${agentSelect("nm:worker", harness, drafts["nm:worker"])}</label>
          <label class="optbtn"><span class="k">Checks</span>${agentSelect("nm:verifier", harness, drafts["nm:verifier"])}</label>
        </div>
        <div class="roles">
          <span class="seg" title="Budget in dollars or tokens"><button data-act="nmUnit" data-u="usd" class="${unit === "usd" ? "on" : ""}">$</button><button data-act="nmUnit" data-u="tokens" class="${unit === "tokens" ? "on" : ""}">Tokens</button></span>
          <label class="optbtn">${ic("coin", 13)} Task ${unit === "usd" ? "$" : ""}${draftInput("nm:bt", { value: drafts["nm:bt"], cls: "amt" })}</label>
          <label class="optbtn">${ic("coin", 13)} Mission ${unit === "usd" ? "$" : ""}${draftInput("nm:bm", { value: drafts["nm:bm"], cls: "amt" })}</label>
          <label class="optbtn">${ic("clock", 13)} ${draftInput("nm:tl", { value: drafts["nm:tl"], cls: "amt" })} min/run</label>
        </div>
      </div>`
          : ""
      }
      ${harness === "antigravity" && unit === "usd" ? `<div class="note soft-amber" style="margin:0 16px 12px">${ic("alert", 14)}<div>Antigravity doesn't report dollar costs, so a dollar budget would never stop it. Use a token budget.</div></div>` : ""}
      <div class="cfoot"><span class="faint small grow">The planner reads your code and proposes tasks. Nothing changes until you approve.</span>
        <a class="btn ghost" href="#/">Cancel</a><button class="btn primary" data-act="createMission">${ic("spark", 13)} Start planning <kbd>⌘↵</kbd></button></div>
    </div>`;
  } else {
    body += `<div class="empty" style="padding:30px 0 10px">${ic("folder", 30, 1.4)}<div class="big">Add a project to start</div><div>A project is any folder with code in it.</div></div>`;
  }
  body += `<div class="h2" style="margin-top:${has ? 36 : 10}px">${ic("folder", 15)} ${has ? "Add another project" : "Add your first project"}</div>${addProjectForm(!has)}`;
  return `<div class="sheet">${topbar(`${ic("plus", 15, 2)}<span class="here">New mission</span>`)}<div class="body">${body}</div></div></div>`;
}

function addProjectForm(primary) {
  return `<div class="slist"><div class="srow"><div class="grow">${draftInput("np:path", { placeholder: "~/code/my-app or /Users/you/Developer/thing" })}<div class="hint" style="margin-top:6px">Any folder with code. Northern Lights adds a <code>.northern-lights</code> folder inside it.</div></div>
    <div class="row" style="align-self:flex-start">${window.nl?.pickFolder ? `<button class="btn" data-act="pickFolder">${ic("folder", 13)} Choose…</button>` : ""}<button class="btn ${primary ? "primary" : ""}" data-act="addProject">Add project</button></div></div></div>`;
}

// ───────────────────────── usage ─────────────────────────

async function usageScreen() {
  const u = await get("/api/usage");
  const max = Math.max(1, ...u.by_day.map((d) => d.tokens));
  const stat = (label, x) =>
    `<div class="panel stat"><div class="k">${label}</div><div class="v">${shortNum(x.tokens)}<small> tokens</small></div><div class="faint small">${x.usd ? usd(x.usd) + " · " : ""}${plural(x.runs, "run")}</div></div>`;
  let body = `<div class="wrap"><div class="title">Usage</div><div class="lede">Tokens your agents used. Cache reads (re-reading context they've already seen) aren't counted, the same as budgets.</div>
    <div class="stats3" style="margin-top:20px">${stat("Today", u.today)}${stat("Last 7 days", u.week)}${stat("All time", u.all)}</div>
    <div class="h2">${ic("chart", 15)} Last 14 days</div>
    <div class="panel"><div class="chart">${u.by_day
      .map((d) => {
        const h = Math.round((d.tokens / max) * 100);
        const lbl = new Date(d.day + "T12:00:00").toLocaleDateString([], { month: "short", day: "numeric" });
        return `<div class="bar-col" title="${esc(lbl)}: ${d.tokens.toLocaleString()} tokens${d.usd ? ` · ${usd(d.usd)}` : ""}"><div class="bar-v">${d.tokens ? shortNum(d.tokens) : ""}</div><div class="bar-track"><i style="height:${d.tokens ? Math.max(3, h) : 0}%"></i></div><div class="bar-l">${esc(lbl.split(" ")[1] ?? lbl)}</div></div>`;
      })
      .join("")}</div></div>
    <div class="h2">${ic("spark", 15)} By model</div>`;
  body += u.by_model.length
    ? `<div class="panel"><table class="runs"><tr><th>Model</th><th>Harness</th><th>Runs</th><th>Tokens</th><th>Cost</th></tr>${u.by_model
        .map((r) => `<tr><td>${esc(r.model)}</td><td class="muted">${esc(r.harness)}</td><td>${r.runs}</td><td>${r.tokens.toLocaleString()}</td><td>${r.usd ? usd(r.usd) : '<span class="faint">—</span>'}</td></tr>`)
        .join("")}</table></div>`
    : `<div class="muted">No agent runs yet.</div>`;
  if (u.by_mission.length) {
    body += `<div class="h2">${ic("board", 15)} By mission</div><div class="panel"><table class="runs"><tr><th>Mission</th><th>Project</th><th>Runs</th><th>Tokens</th><th>Cost</th></tr>${u.by_mission
      .map((r) => `<tr><td><a href="#/m/${esc(r.id)}">${esc(r.title)}</a> <span class="id">${esc(r.id)}</span></td><td class="muted">${esc(r.project)}</td><td>${r.runs}</td><td>${r.tokens.toLocaleString()}</td><td>${r.usd ? usd(r.usd) : '<span class="faint">—</span>'}</td></tr>`)
      .join("")}</table></div>`;
  }
  return `<div class="sheet">${topbar(`${ic("chart", 15)}<span class="here">Usage</span>`)}<div class="body" data-scroll="usage">${body}</div></div></div>`;
}

function addProjectDialog() {
  $modal.innerHTML = `<div class="dialog" style="width:min(520px,92vw)"><h2>Add a project</h2><div class="muted" style="margin-bottom:12px">Any folder with code in it.</div>
    <div class="row" style="flex-wrap:nowrap"><div class="grow">${draftInput("np:path", { placeholder: "/Users/you/Developer/my-app" })}</div>${
      window.nl?.pickFolder ? `<button class="btn" data-x="pick">${ic("folder", 13)} Choose…</button>` : ""
    }</div>
    <div class="row"><button class="btn" data-x="no">Cancel</button><button class="btn primary" data-x="add">Add project</button></div></div>`;
  $modal.hidden = false;
  const input = $modal.querySelector("input");
  input.focus();
  const add = async () => {
    const p = (drafts["np:path"] ?? input.value ?? "").trim();
    if (!p) return toast("Enter a folder path.", true);
    try {
      const proj = await post(`/api/projects`, { path: p });
      delete drafts["np:path"];
      drafts["nm:project"] = proj.id;
      closeModal();
      toast(`Added ${proj.id}. Start a mission for it.`);
      go("#/new");
    } catch (e) {
      toast(e.message, true);
    }
  };
  input.onkeydown = (e) => e.key === "Enter" && add();
  $modal.onclick = async (e) => {
    const x = e.target.closest("[data-x]")?.dataset.x;
    if (x === "add") add();
    else if (x === "pick") {
      const p = await window.nl.pickFolder();
      if (p) (drafts["np:path"] = p), (input.value = p);
    } else if (x === "no" || e.target === $modal) closeModal();
  };
}

// ───────────────────────── command palette ─────────────────────────

let pal = null;
async function openPalette() {
  const items = [
    { g: "Go to", icon: "inbox", t: "Inbox", go: "#/" },
    { g: "Go to", icon: "plus", t: "New mission", go: "#/new", k: "⌘N" },
    { g: "Go to", icon: "chart", t: "Usage", go: "#/usage" },
    { g: "Actions", icon: "folder", t: "Add project…", act: "addProjectDialog" },
  ];
  if (cache.status?.runs.length) items.push({ g: "Actions", icon: "stop", t: "Stop all agents", act: "stopAll" });
  for (const m of cache.missions.slice().reverse()) items.push({ g: "Missions", glyph: mGlyph(m), t: m.title, sub: `${m.id} · ${m.project_id}`, go: `#/m/${m.id}` });
  const active = cache.missions.filter((m) => !["done", "cancelled"].includes(m.status));
  const views = await Promise.all(active.map((m) => get(`/api/missions/${enc(m.id)}`).catch(() => null)));
  for (const v of views.filter(Boolean)) {
    for (const t of v.tasks.filter((t) => !t.is_parent && t.kind !== "plan")) items.push({ g: "Tasks", glyph: tGlyph(t.status), t: t.title, sub: t.id, go: `#/t/${t.id}` });
  }
  pal = { items, q: "", i: 0 };
  $modal.innerHTML = `<div class="palette"><input id="pal-q" placeholder="Search missions, tasks and actions…" autocomplete="off"><div class="res" id="pal-res"></div>
    <div class="foot"><span><kbd>↑</kbd> <kbd>↓</kbd> move</span><span><kbd>↵</kbd> open</span><span><kbd>esc</kbd> close</span></div></div>`;
  $modal.hidden = false;
  $modal.onclick = (e) => {
    const pi = e.target.closest("[data-pi]");
    if (pi) return runPalette(+pi.dataset.pi);
    if (e.target === $modal) closeModal();
  };
  const input = document.getElementById("pal-q");
  input.oninput = () => {
    pal.q = input.value;
    pal.i = 0;
    drawPalette();
  };
  input.focus();
  drawPalette();
}
function palResults() {
  const q = pal.q.trim().toLowerCase();
  return pal.items.filter((x) => !q || `${x.t} ${x.sub ?? ""} ${x.g}`.toLowerCase().includes(q)).slice(0, 60);
}
function drawPalette() {
  const res = palResults();
  let html = "";
  let g = null;
  res.forEach((x, i) => {
    if (x.g !== g) {
      html += `<div class="grp">${esc(x.g)}</div>`;
      g = x.g;
    }
    html += `<div class="pi ${i === pal.i ? "on" : ""}" data-pi="${i}">${x.glyph ?? ic(x.icon, 15)}<span class="t">${esc(x.t)}</span>${x.sub ? `<span class="id">${esc(x.sub)}</span>` : ""}${x.k ? `<kbd>${x.k}</kbd>` : ""}</div>`;
  });
  document.getElementById("pal-res").innerHTML = html || `<div class="muted" style="padding:14px">No matches</div>`;
  document.querySelector(".pi.on")?.scrollIntoView({ block: "nearest" });
}
function runPalette(i) {
  const x = palResults()[i];
  closeModal();
  pal = null;
  if (!x) return;
  if (x.go) go(x.go);
  else if (x.act) actions[x.act]({}).then(render).catch((e) => toast(e.message, true));
}

// ───────────────────────── actions ─────────────────────────

const afterTaskAction = (id) => {
  const r = route();
  if (r.kind === "inbox") go("#/inbox");
  else go(`#/m/${id.split(":")[0]}`);
};
const actions = {
  palette: () => openPalette(),
  toggle: (d) => {
    const el = document.getElementById(d.target);
    if (el) {
      el.hidden = !el.hidden;
      el.querySelector("textarea,input")?.focus();
    }
  },
  tab: (d) => {
    tabs[d.id] = d.tab;
  },
  jump: (d) => {
    tabs[d.id] = "changes";
    return render().then(() => document.getElementById(`df-${d.id}-${d.i}`)?.scrollIntoView({ block: "start", behavior: "smooth" }));
  },
  addProjectDialog: () => addProjectDialog(),
  shot: (d) => {
    $modal.innerHTML = `<figure class="lightbox"><img src="${esc(d.src)}" alt=""><figcaption>${esc(d.cap)}</figcaption></figure>`;
    $modal.hidden = false;
    $modal.style.placeItems = "center";
    $modal.style.paddingTop = "0";
    $modal.onclick = () => {
      $modal.style.placeItems = "";
      $modal.style.paddingTop = "";
      closeModal();
    };
  },
  nmHarness: (d) => {
    drafts["nm:harness"] = d.h;
    applyPreset(drafts["nm:preset"] && drafts["nm:preset"] !== "custom" ? drafts["nm:preset"] : "balanced");
  },
  nmPreset: (d) => applyPreset(d.p),
  nmUnit: (d) => {
    drafts["nm:unit"] = d.u;
    drafts["nm:bt"] = d.u === "usd" ? "2" : "2M";
    drafts["nm:bm"] = d.u === "usd" ? "10" : "20M";
    drafts["nm:preset"] = "custom";
  },
  sharpen: async () => {
    const H = harnessData.harnesses;
    const h = drafts["nm:harness"] === "codex" ? (H.claude?.installed ? "claude" : "antigravity") : drafts["nm:harness"];
    const idea = [drafts["nm:title"], drafts["nm:goal"]].filter((x) => x && x.trim()).join("\n\n");
    if (!idea.trim()) return toast("Write a rough idea first, even one sentence.", true);
    sharpening = true;
    sharpenInfo = null;
    render();
    try {
      const r = await post("/api/sharpen", { project: drafts["nm:project"], idea, harness: h });
      drafts["nm:prev"] = { title: drafts["nm:title"] ?? "", goal: drafts["nm:goal"] ?? "" };
      if (r.title) drafts["nm:title"] = r.title;
      drafts["nm:goal"] = r.goal + (r.done_when.length ? `\n\nDone when:\n${r.done_when.map((x) => `- ${x}`).join("\n")}` : "");
      sharpenInfo = r;
    } finally {
      sharpening = false;
    }
  },
  unsharpen: () => {
    const prev = drafts["nm:prev"];
    if (!prev) return;
    drafts["nm:title"] = prev.title;
    drafts["nm:goal"] = prev.goal;
    delete drafts["nm:prev"];
    sharpenInfo = null;
  },
  nmToggle: (d) => {
    drafts[d.k] = d.k === "nm:auto" ? drafts[d.k] === false : !drafts[d.k];
  },
  approve: async (d) => {
    await post(`/api/missions/${enc(d.id)}/approve`);
    toast("Plan approved. The first agent is starting.");
    go(`#/m/${d.id}/tasks`);
  },
  reject: async (d) => {
    const fb = (drafts[`reject:${d.id}`] ?? "").trim();
    if (!fb) return toast("Write what should change first.", true);
    await post(`/api/missions/${enc(d.id)}/reject`, { feedback: fb });
    delete drafts[`reject:${d.id}`];
    toast("Sent back to the planner.");
  },
  accept: async (d) => {
    await post(`/api/tasks/${enc(d.id)}/accept`);
    toast(`Accepted ${d.id}.`);
    afterTaskAction(d.id);
  },
  sendBack: async (d) => {
    const fb = (drafts[`sb:${d.id}`] ?? "").trim();
    if (!fb) return toast("Write your feedback first.", true);
    await post(`/api/tasks/${enc(d.id)}/send-back`, { feedback: fb });
    delete drafts[`sb:${d.id}`];
    toast("Sent back to a fresh agent.");
  },
  discard: async (d) => {
    if (!(await confirmBox("Discard this task's changes?", "The project folder goes back to how it was before this task started. You can undo this.", "Discard", true))) return;
    await post(`/api/tasks/${enc(d.id)}/discard`, { cancel: true });
    toast("Changes discarded.");
  },
  undoDiscard: async (d) => {
    await post(`/api/tasks/${enc(d.id)}/undo-discard`);
    toast("Changes restored.");
  },
  retry: async (d) => {
    await post(`/api/tasks/${enc(d.id)}/retry`, { note: (drafts[`retry:${d.id}`] ?? "").trim() || undefined });
    delete drafts[`retry:${d.id}`];
    toast("Trying again with a fresh agent.");
  },
  cancelTask: async (d) => {
    if (!(await confirmBox("Skip this task?", "It won't be worked on. Tasks that depend on it may not be able to start.", "Skip task", true))) return;
    await post(`/api/tasks/${enc(d.id)}/cancel`);
    toast("Task skipped.");
  },
  raise: async (d) => {
    const n = Number(drafts[`raise:${d.id}`] ?? document.querySelector(`[data-draft="raise:${CSS.escape(d.id)}"]`)?.value);
    await post(`/api/tasks/${enc(d.id)}/raise`, { amount: n });
    toast("Budget raised. The agent will continue.");
  },
  answer: async (d) => {
    const text = (d.text ?? drafts[`ans:${d.id}`] ?? "").trim();
    if (!text) return toast("Write an answer first.", true);
    await post(`/api/tasks/${enc(d.id)}/answer`, { text });
    delete drafts[`ans:${d.id}`];
    toast("Answer sent. A fresh agent picks it up.");
  },
  permit: async (d) => {
    await post(`/api/tasks/${enc(d.id)}/permit`, { decision: d.d });
    toast(d.d === "deny" ? "Denied." : "Allowed.");
  },
  done: async (d) => {
    await post(`/api/tasks/${enc(d.id)}/done`, { note: (drafts[`done:${d.id}`] ?? "").trim() || undefined });
    delete drafts[`done:${d.id}`];
    toast("Marked done.");
  },
  acceptMission: async (d) => {
    const keep = document.getElementById("keep-overview");
    await post(`/api/missions/${enc(d.id)}/accept`, { overview: keep ? keep.checked : undefined });
    toast("Mission complete.");
  },
  cancelMission: async (d) => {
    if (!(await confirmBox("Cancel this mission?", "Running agents stop and no more tasks start. Changes already made stay in your folder.", "Cancel mission", true))) return;
    await post(`/api/missions/${enc(d.id)}/cancel`);
    toast("Mission cancelled.");
  },
  stop: async (d) => {
    await post(`/api/stop`, { project: d.project });
    toast("Paused. Resume when you're ready.");
  },
  stopAll: async () => {
    if (!(await confirmBox("Stop every agent?", "All running agents stop and their missions pause. Nothing is lost.", "Stop all", true))) return;
    await post(`/api/stop`, {});
    toast("All agents stopped.");
  },
  resume: async (d) => {
    const r = await post(`/api/resume`, { target: d.target });
    toast(r.resumed?.length ? "Resumed." : "Nothing to resume" + (r.skipped?.length ? `: ${r.skipped.join("; ")}` : "."));
  },
  saveBudgets: async (d) => {
    const val = (k) => drafts[`${k}:${d.id}`] ?? document.querySelector(`[data-draft="${k}:${CSS.escape(d.id)}"]`)?.value;
    await api("PATCH", `/api/missions/${enc(d.id)}`, { budget_task: parseAmount(val("bt")), budget_mission: parseAmount(val("bm")), time_limit_min: val("tl") });
    for (const k of ["bt", "bm", "tl"]) delete drafts[`${k}:${d.id}`];
    toast("Limits saved.");
  },
  createMission: async () => {
    const v = (k) => (drafts[`nm:${k}`] ?? document.querySelector(`[data-draft="nm:${k}"]`)?.value ?? "").toString().trim();
    if (!v("title")) return toast("Give the mission a title.", true);
    if (!v("goal")) return toast("Describe the goal: what does done look like?", true);
    const unit = drafts["nm:unit"] ?? "usd";
    const bt = parseAmount(v("bt"));
    const bm = parseAmount(v("bm"));
    if (!(bt > 0) || !(bm > 0)) return toast("Budgets must be numbers, e.g. 2, 500k or 2M.", true);
    const h = drafts["nm:harness"] ?? "claude";
    const spec = (role) => (drafts[`nm:${role}`] ? `${h}:${drafts[`nm:${role}`]}` : h);
    const m = await post(`/api/missions`, {
      project: v("project"),
      title: v("title"),
      goal: v("goal"),
      review_mode: drafts["nm:auto"] === false ? "every" : "auto",
      permission_mode: drafts["nm:full"] ? "full" : "upfront",
      budget_unit: unit,
      budget_task: bt,
      budget_mission: bm,
      time_limit_min: Number(v("tl") || 30),
      planner: spec("planner"),
      worker: spec("worker"),
      verifier: spec("verifier"),
    });
    for (const k of ["nm:title", "nm:goal", "nm:prev", "nm:seeded", "nm:seededFrom"]) delete drafts[k];
    sharpenInfo = null;
    toast("Mission created. The planner is starting.");
    go(`#/m/${m.id}`);
  },
  pickFolder: async () => {
    const p = await window.nl.pickFolder();
    if (p) drafts["np:path"] = p;
  },
  addProject: async () => {
    const p = (drafts["np:path"] ?? "").trim();
    if (!p) return toast("Enter a folder path.", true);
    const proj = await post(`/api/projects`, { path: p });
    delete drafts["np:path"];
    drafts["nm:project"] = proj.id;
    toast(`Added ${proj.id}.`);
  },
};

document.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-act]");
  if (!el) return;
  e.preventDefault();
  const fn = actions[el.dataset.act];
  if (!fn) return;
  if (el.tagName === "BUTTON") el.disabled = true;
  try {
    await fn({ ...el.dataset }, el);
    if (!["toggle", "palette", "jump", "shot"].includes(el.dataset.act)) await render();
  } catch (err) {
    toast(err.message, true);
  } finally {
    if (el.isConnected) el.disabled = false;
  }
});

function autoGrow(el) {
  el.style.height = "auto";
  el.style.height = Math.min(520, el.scrollHeight + 2) + "px";
}

document.addEventListener("input", (e) => {
  if (e.target.matches?.("textarea.cgoal")) autoGrow(e.target);
  const k = e.target.dataset?.draft;
  if (k) drafts[k] = e.target.value;
  if (/^nm:(bt|bm|tl)$/.test(k ?? "")) drafts["nm:preset"] = "custom";
});

document.addEventListener("change", async (e) => {
  const el = e.target;
  if (el.dataset?.draft) drafts[el.dataset.draft] = el.value;
  if (/^nm:(planner|worker|verifier)$/.test(el.dataset?.draft ?? "")) drafts["nm:preset"] = "custom";
  if (el.dataset?.draft === "nm:project") return render();
  if (el.dataset?.agent) {
    try {
      await api("PATCH", `/api/missions/${enc(el.dataset.id)}`, { [el.dataset.agent]: el.value });
      toast(`${{ planner: "Planner", worker: "Builder", verifier: "Checker" }[el.dataset.agent]}: ${agentLabel(el.value)}.`);
      render();
    } catch (err) {
      toast(err.message, true);
    }
    return;
  }
  if (!el.dataset?.set) return;
  const field = el.dataset.set;
  const value = field === "review_mode" ? (el.checked ? "auto" : "every") : el.checked ? "full" : "upfront";
  if (field === "permission_mode" && el.checked) {
    const ok = await confirmBox("Give agents full access?", "They'll be able to run any command on your Mac without asking, including deleting files. Only do this for projects you trust them with.", "Give full access", true);
    if (!ok) {
      el.checked = false;
      return;
    }
  }
  try {
    const r = await api("PATCH", `/api/missions/${enc(el.dataset.id)}`, { [field]: value });
    toast(
      field === "review_mode"
        ? value === "auto"
          ? `Auto-accept on.${r.accepted?.length ? ` Accepted ${r.accepted.join(", ")}.` : ""}`
          : "You'll review every task."
        : value === "full"
          ? "Full access on."
          : "Agents need approval for anything new.",
    );
    render();
  } catch (err) {
    el.checked = !el.checked;
    toast(err.message, true);
  }
});

// Keyboard: ⌘K palette, ⌘N new mission, ⌘↵ submit, ↑↓/jk in the inbox, A to accept.
document.addEventListener("keydown", (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? "");
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    if (pal) closeModal(), (pal = null);
    else openPalette();
    return;
  }
  if (pal) {
    const n = palResults().length;
    if (e.key === "ArrowDown") (pal.i = Math.min(n - 1, pal.i + 1)), drawPalette(), e.preventDefault();
    else if (e.key === "ArrowUp") (pal.i = Math.max(0, pal.i - 1)), drawPalette(), e.preventDefault();
    else if (e.key === "Enter") runPalette(pal.i), e.preventDefault();
    else if (e.key === "Escape") closeModal(), (pal = null);
    return;
  }
  if (!$modal.hidden) {
    if (e.key === "Escape") $modal.querySelector('[data-x="no"]')?.click();
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "n") {
    e.preventDefault();
    go("#/new");
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && route().kind === "new") {
    e.preventDefault();
    document.querySelector('[data-act="createMission"]')?.click();
    return;
  }
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
  const r = route();
  if (r.kind === "inbox" && ["ArrowDown", "ArrowUp", "j", "k"].includes(e.key)) {
    const keys = [...document.querySelectorAll(".list .li[href^='#/inbox/']")].map((a) => decodeURIComponent(a.getAttribute("href").slice(8)));
    if (!keys.length) return;
    const cur = keys.indexOf(r.id ?? keys[0]);
    const next = keys[Math.max(0, Math.min(keys.length - 1, cur + (e.key === "ArrowDown" || e.key === "j" ? 1 : -1)))];
    e.preventDefault();
    go(`#/inbox/${enc(next)}`);
    return;
  }
  if (e.key === "a" || e.key === "A") document.querySelector('[data-act="accept"]')?.click();
});

window.addEventListener("hashchange", () => render());

// Live updates from the engine.
let debounce = null;
function listen() {
  const es = new EventSource("/events");
  es.onmessage = () => {
    clearTimeout(debounce);
    debounce = setTimeout(softRefresh, 250);
  };
  es.onerror = () => {
    es.close();
    engineUp = false;
    setTimeout(() => {
      listen();
      render();
    }, 3000);
  };
}

$main.innerHTML = `<div class="sheet"><div class="loading">${glyph("spin", "var(--faint)", 20)}</div></div>`;
render();
listen();
