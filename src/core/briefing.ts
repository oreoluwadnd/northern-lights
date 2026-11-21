import type { DB } from "./db.ts";
import type { Mission, Project, Task } from "./model.ts";
import { getLog, listTasks } from "./model.ts";
import { readDecisions, readOverview, readSettings } from "./project.ts";
import { renderResult, renderTodo, renderVerification } from "./files.ts";
import { leafIdsUnder, MAX_CHILDREN, MAX_DEPTH } from "./plan.ts";

export type Role = "plan" | "work" | "verify";

function cap(text: string, maxChars: number, what: string): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + `\n… (${what} truncated; read the file for the rest)\n`;
}

function toolHowTo(viaCli: boolean): string {
  if (!viaCli) {
    return "Call these through the `northern-lights` MCP tools.";
  }
  return [
    "Call these with the CLI (the NL_KEY and NL_URL environment variables are already set):",
    "  northern-lights tool <name> '<json arguments>'",
    "  e.g. northern-lights tool log '{\"text\":\"added the route\"}'",
  ].join("\n");
}

const COMMON_RULES = (p: Project) => `- Work only in the project folder: ${p.path}
- Never edit anything under .northern-lights/ yourself; the server owns those files. Use the tools.
- Never run git commands that commit, push, reset, checkout or stash. Leave version control to the human.
- If an action you need is denied by permissions, don't work around it: call \`request_permission\` (with your progress so far), then stop.
- If you need a decision only the human can make, call \`ask_human\` (with your progress so far), then stop.
- Your run ends after any of these tools: submit, submit_verdict, propose_plan, request_split, ask_human, request_permission, fail. After calling one, end your turn immediately without further work.`;

function header(p: Project, m: Mission, t: Task, role: Role): string {
  const what =
    role === "plan"
      ? `planning mission ${m.id} "${m.title}"`
      : role === "verify"
        ? `verifying task ${t.local_id} "${t.title}" (mission ${m.id})`
        : `task ${t.local_id} "${t.title}" (mission ${m.id})`;
  return `# Northern Lights briefing: ${what}\nProject: ${p.name} — ${p.path}\n`;
}

function overviewSection(p: Project): string {
  const ov = readOverview(p);
  return `## Project overview (PROJECT.md)\n${ov ? cap(ov, 8000, "overview") : "(none yet)"}\n`;
}

function decisionsSection(p: Project): string {
  const d = readDecisions(p).trim();
  return `## Shared decisions (DECISIONS.md) — follow these\n${d ? cap(d, 8000, "decisions") : "(none yet)"}\n`;
}

function missionSection(m: Mission): string {
  return `## Mission\n${m.title}\n\n${m.goal}\n`;
}

function taskSection(t: Task): string {
  return [
    `## Your task: ${t.local_id} ${t.title}`,
    `Goal: ${t.goal}`,
    t.context ? `Context: ${t.context}` : "",
    `Acceptance criteria:\n${t.criteria.map((c) => `- ${c}`).join("\n")}`,
  ]
    .filter(Boolean)
    .join("\n") + "\n";
}

function depResults(db: DB, m: Mission, t: Task): string {
  const tasks = listTasks(db, m.id);
  const ids = [...new Set(t.depends.flatMap((d) => leafIdsUnder(tasks, d)))];
  if (!ids.length) return "";
  const parts = ids.map((id) => {
    const d = tasks.find((x) => x.local_id === id);
    if (!d) return "";
    const body = d.kind === "human" ? `Done by the human. Note: ${d.result?.summary || "(none)"}` : renderResult(d.result);
    return `### ${d.local_id} ${d.title}\n${body}`;
  });
  return `## What your dependencies built (their Results)\n${cap(parts.join("\n\n"), 12000, "results")}\n`;
}

function lastAttempt(db: DB, t: Task): string {
  if (!t.feedback && t.attempt <= 1) return "";
  const log = getLog(db, t.id)
    .map((l) => `- ${l.actor}: ${l.text}`)
    .join("\n");
  return [
    "## Last attempt",
    "This task was worked on before. Its changes are still in the folder; continue from them.",
    t.feedback ? `Feedback / answers to act on:\n${t.feedback}` : "",
    log ? `Previous work log:\n${cap(log, 6000, "work log")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n") + "\n";
}

function todoSection(db: DB, m: Mission): string {
  return `## Map of all tasks (TODO.md)\n${cap(renderTodo(db, m), 4000, "todo")}\nUse \`get_task\` to read any task in full.\n`;
}

export function workBriefing(db: DB, p: Project, m: Mission, t: Task, viaCli: boolean): string {
  const checks = readSettings(p).checks;
  return [
    header(p, m, t, "work"),
    `## How this works
You are one agent in a team. Each task gets a fresh agent; you only do this one task, then your run ends.
- Read your task and the Results of the tasks it depends on below. The code they describe is already in the folder.
- Log progress with \`log\` every few steps (it also tells the server you're alive).
- If you make a decision later tasks must follow (a convention, a schema change, an API shape), record it with \`note\`.
- When the acceptance criteria are met, call \`submit\` with a complete Result: summary, files you changed, interfaces later tasks build on (endpoints, function signatures, types, tables, env vars — or "none"), decisions, gotchas, and how to verify.
- After you submit, the server runs these checks: ${checks.length ? checks.join(" · ") : "(none configured)"}. Then a different agent verifies every acceptance criterion with evidence. Run the checks yourself before submitting if you can.
- If the task is too big for one session, call \`request_split\` with proposed subtasks. If it's impossible, call \`fail\` with the reason.
${COMMON_RULES(p)}
${toolHowTo(viaCli)}
`,
    overviewSection(p),
    missionSection(m),
    decisionsSection(p),
    taskSection(t),
    depResults(db, m, t),
    lastAttempt(db, t),
    todoSection(db, m),
  ]
    .filter(Boolean)
    .join("\n");
}

export function planBriefing(db: DB, p: Project, m: Mission, planTask: Task, viaCli: boolean): string {
  const hasOverview = !!readOverview(p);
  const split = m.pending_plan?.source === "split";
  return [
    header(p, m, planTask, "plan"),
    `## How this works
You are the planner. Read the code (read-only: do not change any files) and break the mission into tasks for other agents. Each task will be done by a fresh agent with no memory except its briefing, one task at a time in this folder.

A task is **atomic** when it has a clear goal and testable acceptance criteria, touches a small well-defined area of the code, and one agent can finish it in one session. Otherwise give it children. Max depth ${MAX_DEPTH}, max ${MAX_CHILDREN} tasks per level.

- Give every task a short unique \`key\`, a title, a goal, optional context, and acceptance criteria (atomic tasks only). Criteria must be checkable with evidence (a test, a command's output, a file and line).
- \`depends_on\` lists keys of tasks that must be finished first. Tasks run in dependency order, then in the order you list them.
- Steps only a human can do (creating accounts, API keys, adding secrets to .env, choosing a domain, approving a design) become tasks with \`for_you: true\`. Put them as early as possible. Their "criteria" say what done looks like.
- If the project has a UI (web app, dashboard, local page), include the command that starts it in \`permissions\` and in PROJECT.md (Run section, with the URL), and write UI criteria a checker can confirm in a browser (e.g. "Opening http://localhost:3000/settings shows a Dark mode toggle; turning it on makes the page background dark"). The checker tests them with a real browser and attaches screenshots.
- \`permissions\`: every command prefix agents will need to run (e.g. "npm install", "npm test", "npx prisma migrate dev"), network domains they need, and any paths outside the project folder. Keep it minimal; the human approves it with the plan.
${hasOverview ? "- PROJECT.md exists (below). Don't send `overview` unless it is clearly wrong." : "- There is no PROJECT.md yet. Write one and pass it as `overview`: markdown with Stack, Run (dev/test/lint commands), Layout, Conventions, Watch out. Keep it under ~1500 tokens; it goes into every agent's briefing."}
- Call \`propose_plan\` once with everything, then stop.
${COMMON_RULES(p)}
${toolHowTo(viaCli)}
`,
    overviewSection(p),
    missionSection(m),
    decisionsSection(p),
    m.plan_feedback ? `## Feedback on your previous plan (address this)\n${m.plan_feedback}\n` : "",
    split ? "" : listTasks(db, m.id).some((t) => t.kind !== "plan") ? todoSection(db, m) : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** How a verifier tests UI with agent-browser. `shotsDir` is null when agent-browser isn't installed. */
function browserSection(shotsDir: string | null): string {
  if (!shotsDir) return "";
  return `## Testing UI in a real browser
If this work changes anything a person sees or clicks (a web page, a dashboard, a form), don't stop at reading code: test it like a user with the \`agent-browser\` CLI, and attach screenshots as evidence.
1. Start the app if it isn't running (use the run/dev command from PROJECT.md, in the background), and wait until it answers.
2. \`agent-browser open <url>\`, then \`agent-browser snapshot\` to see the page, \`agent-browser click <ref>\` / \`fill <ref> <text>\` to use it, \`agent-browser errors\` for console errors.
3. \`agent-browser screenshot $NL_SHOTS_DIR/<short-name>.png\` for each thing a criterion promises (e.g. \`dashboard-loaded.png\`, \`toggle-dark.png\`). Screenshots go in that folder (${shotsDir}), never in the project.
4. In \`submit_verdict\`, cite what you saw as evidence and list the files in \`screenshots\` with a caption each.
5. Stop any server you started before you finish. Your browser session is closed for you.
Skip this for changes with no UI (libraries, scripts, docs).
`;
}

export function verifyBriefing(
  db: DB,
  p: Project,
  m: Mission,
  t: Task,
  diff: string,
  viaCli: boolean,
  shotsDir: string | null = null,
): string {
  if (t.kind === "mission_verify") return missionVerifyBriefing(db, p, m, t, viaCli, shotsDir);
  return [
    header(p, m, t, "verify"),
    `## How this works
You are the verifier. A different agent did this task and says it's done. Your job is to check every acceptance criterion against the actual code and behaviour, and give **evidence** for each one: a passing test name, a command and its output, or a file and line. "Looks good" is not evidence.
- Do NOT change any files. You may read code and run tests and commands. If any file changes during your run, your changes are undone and your verdict is thrown out.
- Call \`submit_verdict\` with \`pass\` (true only if every criterion is met), one entry per criterion (criterion, met, evidence), and \`feedback\` telling the worker exactly what to fix if it fails. Then stop.
${COMMON_RULES(p)}
${toolHowTo(viaCli)}
`,
    overviewSection(p),
    missionSection(m),
    browserSection(shotsDir),
    taskSection(t),
    `## The worker's Result\n${renderResult(t.result)}\n`,
    `## Automated checks and file comparison\n${renderVerification(t) || "(no checks configured)"}\n`,
    `## Diff of this task (folder vs. before the task started)\n\`\`\`diff\n${cap(diff, 60000, "diff")}\n\`\`\`\n`,
    depResults(db, m, t),
  ]
    .filter(Boolean)
    .join("\n");
}

function missionVerifyBriefing(db: DB, p: Project, m: Mission, t: Task, viaCli: boolean, shotsDir: string | null): string {
  const tasks = listTasks(db, m.id).filter((x) => !x.is_parent && x.kind !== "plan" && x.kind !== "mission_verify");
  const results = tasks
    .map((x) => `### ${x.local_id} ${x.title}${x.kind === "human" ? " (done by the human)" : ""}\n${x.kind === "human" ? x.result?.summary ?? "" : renderResult(x.result)}`)
    .join("\n\n");
  return [
    header(p, m, t, "verify"),
    `## How this works
Every task in this mission has been accepted. You run the **final mission check**: does the project now achieve the mission goal end to end? Tasks can each pass on their own and still break when combined.
- Do NOT change any files. Read code, run the app's tests and commands.
- In \`submit_verdict\`, use \`criteria\` for the parts of the mission goal you checked, each with evidence.
- If something is broken or missing, set \`pass: false\` and list \`fix_tasks\` (same shape as plan tasks: key, title, goal, criteria, depends_on). The human approves them.
- If PROJECT.md is now out of date (new folders, commands, conventions), pass the full updated text as \`overview_updates\`.
${COMMON_RULES(p)}
${toolHowTo(viaCli)}
`,
    browserSection(shotsDir),
    overviewSection(p),
    missionSection(m),
    decisionsSection(p),
    `## Automated checks\n${renderVerification(t) || "(no checks configured)"}\n`,
    `## What each task built\n${cap(results, 30000, "results")}\n`,
  ].join("\n");
}
