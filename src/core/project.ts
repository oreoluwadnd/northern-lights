import fs from "node:fs";
import path from "node:path";
import { parseYaml } from "./yaml.ts";
import type { DB } from "./db.ts";
import { now } from "./db.ts";
import type { Project } from "./model.ts";
import { getProject } from "./model.ts";

export interface ProjectSettings {
  checks: string[];
  snapshot_exclude: string[];
}

const DEFAULT_EXCLUDE = ["node_modules", ".next", "dist", "build", ".venv", "venv", "__pycache__", "target", ".turbo", ".cache"];

export function nlDir(project: Project | string): string {
  const p = typeof project === "string" ? project : project.path;
  return path.join(p, ".northern-lights");
}

export function missionDir(project: Project, missionId: string, title: string): string {
  return path.join(nlDir(project), "missions", `${missionId}-${slug(title)}`);
}

export function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "item"
  );
}

/** Guess check commands from package.json scripts. You can edit project.yaml afterwards. */
function guessChecks(folder: string): string[] {
  const pkgFile = path.join(folder, "package.json");
  if (!fs.existsSync(pkgFile)) return [];
  try {
    const scripts = (JSON.parse(fs.readFileSync(pkgFile, "utf8")).scripts ?? {}) as Record<string, string>;
    const out: string[] = [];
    if (scripts.test && !/no test specified/.test(scripts.test)) out.push("npm test");
    if (scripts.lint) out.push("npm run lint");
    if (scripts.typecheck) out.push("npm run typecheck");
    return out;
  } catch {
    return [];
  }
}

function projectYaml(checks: string[]): string {
  const list = (xs: string[]) => (xs.length ? xs.map((x) => `  - ${x}`).join("\n") : "  []");
  return `# Northern Lights project settings.
# checks: commands run after every task (all must pass). Leave empty for none.
checks:${checks.length ? "\n" + list(checks) : " []"}

# Folders/files never copied into snapshots (matched by name at any depth).
# .northern-lights and .git are always excluded.
snapshot_exclude:
${list(DEFAULT_EXCLUDE)}
`;
}

export function readSettings(project: Project): ProjectSettings {
  const file = path.join(nlDir(project), "project.yaml");
  if (!fs.existsSync(file)) return { checks: [], snapshot_exclude: DEFAULT_EXCLUDE };
  const y = parseYaml(fs.readFileSync(file, "utf8"), file);
  const list = (v: unknown): string[] => (Array.isArray(v) ? v : typeof v === "string" && v ? [v] : []);
  return {
    checks: list(y.checks),
    snapshot_exclude: y.snapshot_exclude === undefined ? DEFAULT_EXCLUDE : list(y.snapshot_exclude),
  };
}

export function addProject(db: DB, folder: string, name?: string): Project {
  const abs = path.resolve(folder.replace(/^~(?=$|\/)/, process.env.HOME ?? "~"));
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw new Error(`Not a folder: ${abs}`);
  const existing = getProject(db, abs);
  if (existing) return existing;
  const projName = name || path.basename(abs);
  let id = slug(projName);
  if (getProject(db, id)) id = `${id}-${Date.now().toString(36).slice(-4)}`;
  const dir = nlDir(abs);
  fs.mkdirSync(path.join(dir, "missions"), { recursive: true });
  const yml = path.join(dir, "project.yaml");
  if (!fs.existsSync(yml)) fs.writeFileSync(yml, projectYaml(guessChecks(abs)));
  const dec = path.join(dir, "DECISIONS.md");
  if (!fs.existsSync(dec)) {
    fs.writeFileSync(dec, `# Decisions\n\nRules every agent in this project follows. Add your own any time.\n\n`);
  }
  db.prepare("insert into projects(id, name, path, created_at) values (?, ?, ?, ?)").run(id, projName, abs, now());
  return getProject(db, id)!;
}

export function readOverview(project: Project): string | null {
  const f = path.join(nlDir(project), "PROJECT.md");
  return fs.existsSync(f) ? fs.readFileSync(f, "utf8") : null;
}

export function writeOverview(project: Project, text: string) {
  fs.writeFileSync(path.join(nlDir(project), "PROJECT.md"), text.endsWith("\n") ? text : text + "\n");
}

export function readDecisions(project: Project): string {
  const f = path.join(nlDir(project), "DECISIONS.md");
  return fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "";
}

export function appendDecision(project: Project, text: string, who: string) {
  const f = path.join(nlDir(project), "DECISIONS.md");
  const line = `- ${text.trim().replace(/\n+/g, " ")}  _(${who}, ${new Date().toISOString().slice(0, 10)})_\n`;
  fs.appendFileSync(f, line);
}
