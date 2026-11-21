/** Agent-facing tools. Same definitions are served over MCP and the CLI (`northern-lights tool <name>`). */

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Which run roles may call it. "pull" = pull-mode agents without a launched run. */
  roles: ("plan" | "work" | "verify" | "pull")[];
}

const str = (description: string) => ({ type: "string", description });
const strArr = (description: string) => ({ type: "array", items: { type: "string" }, description });

const planTask: Record<string, unknown> = {
  type: "object",
  properties: {
    key: str("Short unique key, e.g. \"db-schema\". Used in depends_on."),
    title: str("Short title."),
    goal: str("What this task achieves."),
    context: str("Optional: what the agent needs to know (files, prior work)."),
    criteria: strArr("Acceptance criteria (atomic tasks). Each must be checkable with evidence."),
    depends_on: strArr("Keys of tasks that must finish first."),
    for_you: { type: "boolean", description: "True for a step only the human can do." },
    children: { type: "array", description: "Subtasks, if this task is not atomic.", items: { type: "object" } },
  },
  required: ["key", "title", "goal"],
};

const permissionsSchema = {
  type: "object",
  properties: {
    commands: strArr("Command prefixes agents need, e.g. \"npm test\"."),
    domains: strArr("Network domains agents need, e.g. \"registry.npmjs.org\"."),
    paths: strArr("Paths outside the project folder agents need (usually none)."),
  },
};

export const TOOLS: ToolDef[] = [
  {
    name: "next_task",
    description:
      "Pull mode only: take the next task in a project. Returns its briefing. Work it, then submit, then call next_task again in a fresh context.",
    inputSchema: { type: "object", properties: { project: str("Project id or name.") }, required: ["project"] },
    roles: ["pull"],
  },
  {
    name: "get_task",
    description: "Read any task file in your mission (e.g. \"T2.1\").",
    inputSchema: { type: "object", properties: { id: str("Task id, e.g. T2.1") }, required: ["id"] },
    roles: ["plan", "work", "verify", "pull"],
  },
  {
    name: "log",
    description: "Append a line to your task's work log. Call every few steps; it also counts as a heartbeat.",
    inputSchema: { type: "object", properties: { text: str("What you just did.") }, required: ["text"] },
    roles: ["plan", "work", "verify", "pull"],
  },
  {
    name: "note",
    description:
      "Record a decision every later agent in this project must follow (e.g. \"users.email is unique\"). Goes into DECISIONS.md.",
    inputSchema: { type: "object", properties: { text: str("The decision.") }, required: ["text"] },
    roles: ["work", "pull"],
  },
  {
    name: "propose_plan",
    description: "Planner only: submit the task breakdown, the permissions it needs, and PROJECT.md if missing. Ends your run.",
    inputSchema: {
      type: "object",
      properties: {
        tasks: { type: "array", items: planTask, description: "Top-level tasks (with nested children)." },
        permissions: permissionsSchema,
        overview: str("PROJECT.md content (markdown), if there is none yet."),
      },
      required: ["tasks"],
    },
    roles: ["plan"],
  },
  {
    name: "request_split",
    description: "The task is too big for one session: propose subtasks. The human approves them. Ends your run.",
    inputSchema: {
      type: "object",
      properties: {
        reason: str("Why it needs splitting."),
        tasks: { type: "array", items: planTask, description: "Proposed subtasks." },
      },
      required: ["reason", "tasks"],
    },
    roles: ["work", "pull"],
  },
  {
    name: "submit",
    description: "Submit your finished work with a complete Result. Then checks and a verifier run. Ends your run.",
    inputSchema: {
      type: "object",
      properties: {
        summary: str("One or two lines on what you built."),
        files: strArr("Files you created or changed (paths relative to the project folder)."),
        interfaces: str(
          "What later tasks build on: endpoints, function signatures, types, tables, env vars. \"none\" if nothing.",
        ),
        decisions: str("Choices you made that others should follow."),
        gotchas: str("Anything surprising a later agent would trip on."),
        verify: str("How to check it works (command or steps)."),
      },
      required: ["summary", "files", "interfaces"],
    },
    roles: ["work", "pull"],
  },
  {
    name: "submit_verdict",
    description: "Verifier only: pass/fail with evidence for every criterion. Ends your run.",
    inputSchema: {
      type: "object",
      properties: {
        pass: { type: "boolean", description: "True only if every criterion is met." },
        criteria: {
          type: "array",
          items: {
            type: "object",
            properties: {
              criterion: str("The criterion text."),
              met: { type: "boolean" },
              evidence: str("Test name, command + output, or file:line."),
            },
            required: ["criterion", "met", "evidence"],
          },
        },
        feedback: str("If failing: exactly what the worker must fix."),
        fix_tasks: { type: "array", items: planTask, description: "Final mission check only: tasks to fix what's broken." },
        overview_updates: str("Final mission check only: full updated PROJECT.md, if it's out of date."),
        screenshots: {
          type: "array",
          description: "Screenshots you took while testing a UI (files in $NL_SHOTS_DIR), each with a caption saying what it shows. If you leave this out, every image in $NL_SHOTS_DIR is attached.",
          items: { type: "object", properties: { path: str("File path or name in $NL_SHOTS_DIR."), caption: str("What it shows.") }, required: ["path"] },
        },
      },
      required: ["pass", "criteria"],
    },
    roles: ["verify"],
  },
  {
    name: "fail",
    description: "Give up on the task with a reason. The human decides what's next. Ends your run.",
    inputSchema: { type: "object", properties: { reason: str("Why.") }, required: ["reason"] },
    roles: ["plan", "work", "verify", "pull"],
  },
  {
    name: "ask_human",
    description:
      "Ask the human a question. Include your progress so far: a fresh agent will continue from it with the answer. Ends your run.",
    inputSchema: {
      type: "object",
      properties: {
        question: str("The question."),
        choices: strArr("Optional suggested answers."),
        progress: str("What you've done so far and what's left."),
      },
      required: ["question", "progress"],
    },
    roles: ["plan", "work", "pull"],
  },
  {
    name: "request_permission",
    description:
      "Ask for a command, network domain or path you were denied. Include your progress so far. Ends your run.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["command", "domain", "path"] },
        value: str("e.g. \"npm install\", \"api.stripe.com\", \"/Users/me/shared\"."),
        reason: str("Why you need it."),
        progress: str("What you've done so far and what's left."),
      },
      required: ["kind", "value", "reason", "progress"],
    },
    roles: ["plan", "work", "pull"],
  },
];

/** Tools after which the agent's run should end. */
export const ENDING_TOOLS = new Set([
  "propose_plan",
  "request_split",
  "submit",
  "submit_verdict",
  "fail",
  "ask_human",
  "request_permission",
]);
