# Northern Lights — Spec (v0.6, phase 1 built)

*Drafted 2026-11-20.*

## 1. What it is

A web app where you connect AI coding agents (Claude Code, Codex, or any agent that speaks MCP or can run a CLI), give them a **mission**, and they work it as a team.

1. You add a **project**: a folder on your machine, e.g. `~/code/my-app`.
2. You write a mission for it ("Build a login system").
3. A planner agent breaks it into tasks. Big tasks get broken down again until each one is **atomic**: small enough for one agent to finish in one session.
4. **You approve the breakdown** before any work starts.
5. Tasks run **one at a time per project**, in dependency order. For each task the server starts a **fresh agent** with a briefing of exactly what it needs to know. The agent works directly in the project folder, submits and exits. Different projects run at the same time.
6. You review each result and accept it, or send it back.

Everything is visible as files: a master `TODO.md` plus one `.md` file per task.

v1 is **code only** and uses **no git** (§7). The model is kept general so non-code missions can come later.

## 2. Core concepts

| Concept | Meaning |
|---|---|
| **Project** | A folder on your machine (one app or codebase). Has its own settings, missions and decisions. Only one task works in it at a time. |
| **Mission** | The goal you give, inside one project. Owns a task tree. |
| **Task** | One unit of work. Either a **parent** (split into subtasks) or **atomic** (worked by one agent). An atomic task can also be **for you**: a step only a human can do (§4). |
| **Plan** | A proposed breakdown: a list of subtasks with dependencies. Needs human approval. |
| **Agent profile** | A harness + model the server can launch (e.g. "Claude Code · Opus", "Codex · gpt-5"). Each launched run is one process working one task, with a short-lived key scoped to that task. |
| **Dependency** | "Task B waits for task A." Sets the order tasks run in, and which Results go into each briefing. |
| **Snapshot** | A copy of the project folder the server takes before each task, used to show the diff and to undo (§7). |

Planning is itself a task. A mission starts as one `plan` task, and its output is a Plan, not code.

**Who plans:** planning needs the strongest reasoning, so plan tasks (including mid-task splits) go only to the agent profile set as **planner**. By default that's the profile with the most capable model (e.g. Claude Code on Opus). You can change it per mission. Atomic tasks can go to any profile, including cheaper or faster models.

## 3. Lifecycles

### Mission
```
Draft → Queued → Planning → Awaiting approval → Running → Done
                                  │                 │
                                  └── rejected ─────┴──→ (back to Planning with your feedback)
```
- **Queued**: another mission in the same project is running. One mission runs per project at a time; you can reorder the queue.
- **Paused**: the mission hit its budget (§6b). Nothing new starts until you raise it.

### Task
```
Pending ──(deps done)──→ Ready ──(its turn)──→ In Progress ──(submit)──→ Verifying ──(pass)──→ In Review ──(you accept)──→ Done
                           ▲                       │                        │                    │        (or auto-accept, see §7a)
                           │                       │                        │ fail (< 3 times)   │
                           ├───────────────────────┼────────────────────────┘                    │
                           ├───────────────────────┼─────────(send back / discard)───────────────┘
                           │                       ├──→ Needs split ──(new plan approved)──→ becomes a parent
                           └──(you retry/reassign)─┼──→ Failed
                                                   └──→ Stuck (failed verification 3 times) ──→ waits for you
```

- **Pending**: waiting on dependencies.
- **Ready**: can start when the project is free.
- **In Progress**: one agent is working in the project folder. Claims expire if the agent goes silent (heartbeat timeout, e.g. 15 min) and the task returns to Ready.
- **Verifying**: automated checks, then a verifier agent, check the work (§7a). A failure returns the task to Ready with the feedback attached; the retry runs on the same agent profile, as a fresh process that gets the feedback in its briefing.
- **Stuck**: failed verification 3 times. Stops looping and waits for you.
- **Waiting on you**: the agent asked a question or needs a permission it doesn't have (§6b). Its process has exited and its changes stay in the folder. When you answer, the task goes back to Ready and a fresh agent continues from where it stopped.
- **Over limit**: the task hit its token/cost budget or time limit and was stopped (§6b). Work so far stays in the folder. You raise the limit and continue, split it, or discard.
- **Needs split**: an agent started work and found the task is too big. It proposes subtasks; that mini-plan also goes to you for approval.
- A **parent** task is Done when all its children are Done.
- **Your turn**: a task for you (§4) whose dependencies are done. It sits in your Inbox until you mark it done.

**The project is busy** from the moment a task starts until it is Done, discarded or cancelled. That includes Verifying, In Review, Waiting on you, Over limit and Stuck, because the task's unaccepted changes are in the folder and the next task must not build on top of them. Tasks for you don't make the project busy: agents keep working on anything that doesn't depend on them. The Inbox (§8) shows what's holding each project up.

## 4. Breaking work down

The planner decides whether a task is atomic. Guidance given to the planner:

A task is **atomic** when:
- it has a clear goal and testable acceptance criteria,
- it touches a small, well-defined area of the code,
- one agent can reasonably finish it in one session,
- it can be checked on its own once its dependencies are done.

Otherwise, split it. Limits: max depth 3, max ~10 children per task (configurable).

The planner also sets the **order**: dependencies first, then the order it lists tasks in. You can reorder on the approval screen.

### Tasks for you
Some steps need a human: creating a Stripe account, adding an API key to `.env`, choosing a domain, approving a design. The planner adds these to the plan as **tasks for you**, as early as possible, so agents don't discover them mid-task.
- They have a goal and "done when" criteria like any task, and show up in your Inbox when it's your turn.
- You mark one done with an optional note (e.g. "key is in `.env` as `STRIPE_SECRET_KEY`"). The note becomes the task's Result, so tasks that depend on it get it in their briefing.
- No agent or verifier runs on them, and they cost nothing.
- If an agent mid-task finds it needs something from you that the plan missed, it uses `ask_human` as before.

### Approval screen
You see the proposed tree with dependencies and can:
- approve as is,
- edit (rename, merge, delete, reorder, change dependencies, edit criteria),
- reject with feedback (planner re-plans).

## 5. Files

Inside the project folder:

```
my-app/
  .northern-lights/
    project.yaml               ← checks, snapshot excludes (§7, §7a)
    PROJECT.md                 ← project overview every agent reads (§6a)
    DECISIONS.md               ← shared rules every agent follows, project-wide (§6a)
    missions/
      M1-login-system/
        MISSION.md             ← the goal, constraints, links
        TODO.md                ← master todo, generated by the app
        tasks/
          T1-db-schema.md
          T2-api.md
          T2.1-signup-endpoint.md
          T2.2-login-endpoint.md
          T3-login-ui.md
```

Snapshots are kept outside the project, in `~/.northern-lights/snapshots/`.

### TODO.md (generated)
```markdown
# Mission: Build a login system
Status: Running · 2/5 done

- [x] T1 DB schema — Claude Code · Opus · accepted
- [ ] T2 API
  - [~] T2.1 Signup endpoint — Codex · in progress
  - [ ] T2.2 Login endpoint — next
- [ ] T3 Login UI — waiting on T2
```

### Task file
```markdown
---
id: T2.1
title: Signup endpoint
project: my-app
mission: M1
parent: T2
status: in_progress
depends_on: [T1]
assignee: codex-1
attempt: 1
---

## Goal
POST /auth/signup creates a user with a hashed password.

## Context
Uses the users table from T1 (see T1 Result).

## Acceptance criteria
- [ ] Returns 201 with user id
- [ ] Rejects duplicate email with 409
- [ ] Tests pass

## Work log
- 14:02 codex-1 started
- 14:10 codex-1: added route + validation

## Result
(Filled in by the agent on submit. Fixed sections, see §6a.)
Summary:     Signup endpoint with hashed passwords.
Files:       routes/auth.ts, lib/hash.ts, tests/signup.test.ts
Interfaces:  POST /auth/signup {email, password} → 201 {id} | 409
             hashPassword(pw): Promise<string>  (lib/hash.ts)
Decisions:   Using argon2, not bcrypt
Gotchas:     Email is lowercased before saving
Verify:      npm test -- signup

## Verification
(Filled in by the server and the verifier.)
- Checks: npm test ✓ · lint ✓ · tsc ✓
- Files changed (from snapshot): routes/auth.ts, lib/hash.ts, tests/signup.test.ts ✓ matches Result
- Verifier: claude-opus-1 · attempt 1 · PASS
  - ✓ Returns 201 with user id: test_signup_ok passes
  - ✓ Rejects duplicate email with 409: test_signup_duplicate passes, routes/auth.ts:42
  - ✓ Tests pass: 48/48
```

**Who writes what:**
- The **server** owns state (status, assignee, order) in its database and writes the frontmatter and `TODO.md`.
- **Agents** write the Work log and Result through tools (section 6), not by editing these files directly, so the format stays consistent.
- **You** can edit Goal, Context and Acceptance criteria in the app or in the file.

The **Result** section is the handoff: when T3 starts, its briefing includes the Results of T1 and T2, even if a different tool wrote them. See §6a for how context moves between tasks.

## 6. How agents connect

All three use the same HTTP API on the server.

1. **MCP server**: the main way in. Works with Claude Code, Codex, Cursor and other MCP clients.
2. **CLI** (`northern-lights tool submit '{...}'`): for harnesses without MCP.
3. **REST API**: for anything else.

### MCP tools (kept small)

| Tool | Does |
|---|---|
| `next_task` | Pull mode only: take the next task for this project. Returns its briefing (§6a). In launch mode the briefing is the agent's starting prompt instead. |
| `get_task` | Read any task file. |
| `log` | Append a line to the Work log (also acts as a heartbeat). |
| `note` | Record a decision later tasks must follow ("users.email is now unique"). Goes into `DECISIONS.md` (§6a). |
| `propose_plan` | For plan tasks: submit subtasks + dependencies for approval. |
| `request_split` | Mid-task: "too big", with proposed subtasks. |
| `submit` | Write the Result and move to Verifying. |
| `submit_verdict` | For verify tasks: pass/fail plus evidence for each acceptance criterion. |
| `fail` | Give up with a reason. |
| `ask_human` | Post a question plus progress so far, then exit. Task goes to Waiting on you (§6b). |
| `request_permission` | Ask for a command, domain or path not on the mission's allow list, then exit. Task goes to Waiting on you (§6b). |

The project ships a **skill / `AGENTS.md`** that explains the workflow to the agent: read the briefing, work in the project folder, log progress, record decisions with `note`, submit with a full Result.

### Getting agents to work

**One fresh agent per task.** No agent stays alive for the whole mission. Only the server does. Reasons:
- A long-running agent's context fills with old diffs and logs after a few tasks. It gets slower, costs more and makes more mistakes.
- Assumptions from one task leak into the next.
- If a long-running agent crashes, everything it remembered is lost. With one agent per task, a crash loses one task's progress.

Memory lives in the files and the server, not in any agent (§6a).

**v1, launch mode (default):** the server starts agents itself in headless mode. One process at a time per project, and up to a total limit across all projects (e.g. 3).
- Each agent profile has a launch command, e.g. `claude -p "<briefing>" --mcp-config ...` or `codex exec "<briefing>"`, run inside the project folder.
- The process does one task, calls `submit` (or `fail` / `request_split` / `ask_human` / `request_permission`) and exits. The next task gets a new process.
- If the process exits or crashes without submitting, the task goes back to Ready right away. Its changes stay in the folder and the next attempt continues from them, or you discard them (§7). Heartbeat timeouts still cover hung processes. A process the server stops for going over budget or time goes to Over limit instead (§6b).
- Permissions, budgets and questions for unattended agents are in §6b.
- stdout/stderr are saved with the task so you can see what happened.

**Fallback, pull mode:** for harnesses that can't run headless. You open the agent yourself in the project folder, it connects over MCP and loops `next_task` → work → `submit`. To keep each task's context fresh, it should handle each task in a new context (e.g. a subagent per task) instead of piling tasks into one conversation. `AGENTS.md` tells it to.

## 6a. Context between tasks

Every agent starts empty. The server makes sure it starts with the right memory, and that what it learns is saved for the agents after it.

### 1. Briefing
Built by the server when a task starts, and used as the agent's starting prompt (launch mode) or returned by `next_task` (pull mode):

```
┌──────────────── Briefing for T3 "Login UI" ────────────────┐
│ 1. Project overview     PROJECT.md                         │  always
│ 2. Mission brief        goal + constraints (MISSION.md)    │  always
│ 3. Shared decisions     DECISIONS.md                       │  always
│ 4. Its own task file    goal, criteria, context            │  always
│ 5. Dependency results   Results of T2.1 + T2.2             │  direct deps only
│ 6. Last attempt         verifier / your feedback, or your  │  only on retry
│                         answer + its previous work log     │  or resume
│                                                            │
│ + Map of all tasks (TODO.md): one line each; open any of   │
│   them with get_task if needed                             │
└────────────────────────────────────────────────────────────┘
```

- Target size: around 5–8k tokens. Full detail only for what the task needs; a one-line summary of everything else, with `get_task` for more.
- Only **direct** dependencies' Results are included. Their own Results already summarize what they built on.
- Other tasks' work logs are never included. They're for you, not for other agents. The one exception is a task resuming after a retry, Waiting on you or Over limit, which gets its own previous work log.

### 2. Project overview
Without one, every fresh agent spends the start of its run exploring the codebase to learn the stack and layout, and pays for it in tokens every task. `.northern-lights/PROJECT.md` gives it that up front:

```markdown
# my-app
Stack:       Next.js 15, TypeScript, Prisma + Postgres, Tailwind
Run:         npm run dev (port 3000) · tests: npm test · lint: npm run lint
Layout:      app/ routes · lib/ shared logic · prisma/ schema · tests/ vitest
Conventions: server actions not API routes; zod for all input; no default exports
Watch out:   tests need DATABASE_URL from .env.test
```

- **Written with the first plan:** if a project has no PROJECT.md, the planner writes one as part of its first plan (it reads the code anyway), and you review it together with the breakdown.
- **Kept up to date:** after each mission's final check, the planner proposes updates (new folders, new commands, new conventions) and you approve them along with the mission.
- You can edit it any time. Kept short, around 1–2k tokens, since it goes into every briefing.

### 3. Structured Result
"Done, added the endpoint" isn't enough for the next agent. `submit` requires these sections (see the task file example in §5):

| Section | What goes in it |
|---|---|
| **Summary** | One or two lines on what was built. |
| **Files** | Files created or changed. |
| **Interfaces** | What later tasks build on: endpoints, function signatures, types, tables, env vars. The most important section. |
| **Decisions** | Choices made that others should follow. |
| **Gotchas** | Anything surprising a later agent would trip on. |
| **Verify** | How to check it works (command or steps). |

`submit` is rejected if Summary, Files or Interfaces is empty. Interfaces can say "none" for tasks that expose nothing. The server also compares **Files** with the files that actually changed since the snapshot, and flags any difference for the verifier.

### 4. Shared decisions log
`.northern-lights/DECISIONS.md` holds rules every agent in the project follows ("API errors are `{error:{code,msg}}`", "use zod for validation", "dates are ISO strings"). It's per project, so later missions in the same project keep following it.
- Written by you, by agents through `note`, and copied automatically from each accepted Result's Decisions section.
- Included in every briefing.
- If it grows too long, the planner condenses it between tasks and you approve the condensed version.

### 5. The code is the final source of truth
Tasks run in order, so when a task starts, everything it depends on is already accepted and in the folder. The briefing points the agent at the files listed in its dependencies' Results; when the Result and the code disagree, the code wins and the agent says so in its own Gotchas.

## 6b. Running agents unattended

In launch mode nobody is watching each agent, so it can't stop to ask for permission, can't wait hours for an answer, and can't be trusted to stop spending on its own. Three mission settings handle this, all chosen when you create the mission and changeable later.

### Permissions
Each mission has a **permission mode**:

| Mode | What agents can do |
|---|---|
| **Approve up front** (default) | The planner lists what the mission needs as part of its plan: commands (`npm install`, `npm test`, `npx prisma migrate dev`), network domains (`registry.npmjs.org`) and any paths outside the project folder (none by default). You approve the list together with the breakdown. Agents get exactly that list and nothing else. |
| **Full access** | Agents run with all permission prompts skipped (`claude -p --dangerously-skip-permissions`, `codex exec --dangerously-bypass-approvals-and-sandbox`). No interruptions. |

- **Approve up front:** the server turns the list into each harness's own permission and sandbox settings (e.g. Claude Code allowed tools, Codex sandbox config). Where a harness can't enforce part of the list, for example limiting network domains, the agent profile shows a warning so you know.
- **Something missing from the list:** `AGENTS.md` tells agents to call `request_permission` when something is denied, instead of working around it. The task goes to Waiting on you. You choose **allow once**, **allow for this mission** (added to the list) or **deny**, and a fresh agent continues.
- **Full access is real access.** The agent can do anything your user account can, including outside the project folder, e.g. deleting files elsewhere or reading `~/.ssh`. Task status and accepting work are still enforced, because they live on the server, but nothing stops a full-access agent from acting on your machine directly. Snapshots only cover the project folder. Running full-access agents in a container is planned for v2.

### Budgets
Each mission has a budget **unit**, either **tokens** or **dollars**, and limits:

| Limit | Example default | When it's hit |
|---|---|---|
| **Per task** (all attempts and retries together) | 2M tokens / $5 | The process is stopped and the task goes to Over limit. |
| **Per mission** (all tasks, verifiers and the planner) | 20M tokens / $50 | No new agents are started and the mission is **Paused**. A running agent can finish, still within its own task limit. |
| **Time per run** (always on) | 30 min | The process is stopped and the task goes to Over limit. |

- You get a warning at 80% of any limit.
- **Measuring:** launched agents run with streaming JSON output (`claude -p --output-format stream-json`, `codex exec --json`), which reports token usage as the run goes. The server totals it live and stops the process the moment it goes over. Dollars are tokens × a per-model price table that you can edit in settings.
- Because the per-task limit counts all attempts together, a task that keeps failing verification can't burn money on retries.
- **Pull mode:** the server can't see usage for agents you run yourself, so only the time limit applies.
- Spend is shown per task, per agent profile, per mission and per project.

### Questions (`ask_human`)
An agent can't wait hours for an answer, so a question ends its run:
1. The agent calls `ask_human` with the question, optional choices, and its progress so far. Progress is required, and the server adds it to the Work log.
2. The process exits. The task goes to **Waiting on you**, and its changes stay in the folder as they are.
3. This project waits (§3, "The project is busy"). Other projects keep running.
4. You answer in the app or the CLI (`northern-lights answer T2.1 "use argon2"`).
5. The task goes back to Ready. A fresh agent starts in the same folder, and its briefing includes the question, your answer and the previous work log.

`request_permission` works the same way, and you can also add a standing rule to `DECISIONS.md` so later agents don't ask the same thing again.

### Stopping everything
One button in the app and `northern-lights stop` on the CLI stop every running agent at once. Their tasks go back to Ready with their changes left in the folder, so you can discard or continue them. `northern-lights stop my-app` stops one project. Missions stay paused until you resume them.

### Crash recovery
If the server crashes or your Mac restarts, on startup it:
1. finds tasks marked In Progress or Verifying whose agent process is gone,
2. moves them back to Ready, with a Work log line saying what happened (their snapshots are still there, so discard works as usual),
3. leaves all missions **paused**. Nothing restarts on its own until you resume, so a crash loop can't burn budget.

### Notifications
Agents work while you're away, so the server sends a **macOS notification** whenever something lands in your Inbox: a question, a permission request, a task to review, a task for you, Over limit, Stuck, a plan to approve, or a mission done. You can turn each kind on or off in `~/.northern-lights/config.json`. (v1 notifications can't be clicked; clicking through to the item comes with the UI.)

## 7. No git: snapshots

v1 doesn't use git. Agents work directly in your project folder, one task at a time, and the server takes **snapshots** to show diffs and undo changes.

- **Before a task first starts**, the server snapshots the project folder into `~/.northern-lights/snapshots/<project>/`. Retries continue from the task's changes, so the diff always shows everything since the task started. On macOS this is a copy-on-write clone (`cp -c` on APFS): instant, and it uses almost no disk space until files change. Other systems fall back to a normal copy.
- **Excluded from snapshots:** `.northern-lights/` itself, plus heavy or generated folders listed in `project.yaml`:
  ```yaml
  snapshot_exclude:
    - node_modules
    - .next
    - dist
    - .venv
  ```
  Excluded folders aren't restored on undo; if a task changed dependencies, rerun your install after discarding it.
- **Diff for review:** the server compares the folder with the task's snapshot. In Review shows that diff, the Result and the check output.
- **Accept:** the changes simply stay. The next task starts from there.
- **Send back:** the changes stay and a fresh agent fixes them using your feedback.
- **Discard:** the server restores the snapshot, so the folder is exactly as it was before the task. The task goes back to Ready to start over, or you cancel it.
- **Safety:** before any restore, the server first snapshots the current folder, so a discard can itself be undone.
- **Your own edits:** while a project is busy, the app shows a banner. Don't edit the folder yourself during a task, because a discard would also roll back your edits (though the safety snapshot keeps them).
- **Keeping snapshots:** they're kept until the mission is Done, then deleted, except the one from before the mission started, so you can roll back a whole mission.
- **If your project uses git anyway,** Northern Lights leaves it alone. Agents don't commit, and you commit accepted work whenever you like.

## 7a. Verification

Agents often say "done" when the work isn't. Every atomic task is verified before it can be accepted.

### Step 1: automated checks
The server runs the project's checks in the project folder. No AI involved. Configured in `project.yaml`, e.g.:
```yaml
checks:
  - npm test
  - npm run lint
  - npx tsc --noEmit
```
Any failure returns the task straight to the agent with the output. The verifier is not called.

### Step 2: verifier agent
A `verify` task runs right after the checks, with these rules:
- **The verifier is never the agent that did the work.** Prefer a different model, e.g. Codex verifies Claude's work and vice versa.
- It gets the task file, the diff, the check output and the Results of dependencies.
- It must give **evidence for every acceptance criterion**: a passing test, command output, or file and line. "Looks good" is rejected.
- It can run code and tests but must not change files. The server snapshots the folder at submit; if anything changed when the verifier finishes, those changes are undone and its verdict is thrown out.
- Verdict: pass, or fail with specific feedback written into the task's Verification section.

### Step 3: you (depends on review mode)
Each mission has a **review mode**, set when you create it and changeable at any time:

| Mode | What happens after the verifier passes |
|---|---|
| **Review every task** (default) | Task goes to In Review; you accept each one. The project waits for you between tasks. |
| **Auto-accept verified** | Task is accepted automatically and the next one starts. You only review the final mission check and anything Stuck. |

### Retry limit
3 failed verifications (checks or verifier) → **Stuck**. You can add guidance and retry, reassign, split, discard or cancel.

### Mission-level check
When every task is accepted, a final **mission verify** task runs the full checks in the project folder and checks the mission goal end to end. Tasks can each pass on their own and still break when combined. Its failures become new fix tasks, which go through planning approval like any other breakdown. The mission is Done only after this passes and you approve it, whatever the review mode.

## 8. Web app screens

1. **Projects**: your project folders, each showing busy/free, the running mission and queued missions. "Add project" and "New mission".
2. **Mission view**: task tree / dependency graph, the TODO, current task and agent, budget used, live updates.
3. **Plan approval**: edit and approve the breakdown, plus the permission list.
4. **Task detail**: rendered task file, live work log, diff, accept / send back / discard, comment.
5. **Agents**: agent profiles (launch command, model), running processes and what each is on, concurrency limit, last heartbeat, spend, price table.
6. **Inbox**: everything waiting on you in one list: tasks for you, questions, permission requests, Over limit and Stuck tasks, plans to approve, tasks to review. Each item shows which project it's holding up. A **Stop all** button sits in the header on every screen.

## 9. Guardrails

- Task order, status changes and accepting work are enforced by the server, not by instructions in a prompt.
- Agents cannot mark tasks Done or accept their own work. Only you can, or auto-accept after a passing verification.
- Each agent's API key is scoped to the one task it was started for.
- What agents may run on your machine is set by the mission's permission mode (§6b). Budgets and time limits are enforced by the server stopping the process.
- Every agent action is in the Work log, so you can audit and debug.

## 10. Stack (proposed)

- **Engine:** a standalone Node server in TypeScript, run directly by Node (no build step), zero runtime dependencies. HTTP API + server-sent events. The UI (phase 2) talks to the same API.
- **DB:** SQLite built into Node (`node:sqlite`). Postgres later if it goes multi-user.
- **MCP server + CLI:** TypeScript, same repo. The MCP server is a small stdio bridge to the HTTP API; agents without MCP use `northern-lights tool <name> '<json>'`.
- **Snapshots and diffs:** APFS clones (`cp -c`) on macOS, plain copy elsewhere. Diffs computed by the server.
- **Auth:** single user on localhost. No login screen. Your actions (approve, accept, …) need an admin token in `~/.northern-lights/admin-token`, which the CLI reads; agents only get a key scoped to their one run, so they can't accept their own work over the API.

## 10a. Projects

**v1: each mission works in one project folder.** The data model stores the project per task (not just per mission), so missions spanning several projects can be added later without a rewrite.

## 11. Scope

**v1**
- Projects (folders), missions, planning task, plan approval (with edit)
- Recursive breakdown, dependencies, task order
- One task at a time per project; projects run in parallel up to a total limit; mission queue per project
- `.northern-lights/` files (TODO.md + task files + DECISIONS.md)
- MCP server + skill/AGENTS.md; CLI
- Snapshots: diff for review, accept / send back / discard, undo of a discard
- Verification: automated checks, verifier agent, retry limit/Stuck, mission-level check
- Review mode per mission (review every task / auto-accept verified)
- Launch mode: one fresh headless agent per task, agent profiles
- Pull mode as a fallback
- Context between tasks: briefings, structured Results, `DECISIONS.md`, `note`
- Permission modes (approve up front / full access), `request_permission`
- Budgets (tokens or dollars, per task + per mission), time limit, live usage tracking
- `ask_human` → Waiting on you → resume with a fresh agent; Inbox
- `PROJECT.md` overview: written by a survey task, updated after each mission, in every briefing
- Tasks for you in the plan
- Stop all / stop a project; crash recovery (orphaned tasks back to Ready, missions paused)
- macOS notifications for Inbox items

**v1 build order**
1. **Engine + CLI.** Server, database, task files, MCP tools, CLI, launch mode, snapshots, verification, budgets, permissions. Every approval step works from the CLI (`northern-lights plan M1`, `approve M1`, `review T2.1`, `accept T2.1`, `answer T2.1 "..."`). The server publishes events ("task started", "status changed") from day one so the UI can listen later with no rework. Tested on one real mission with Claude Code before moving on (done; Codex untested).
2. **UI, core screens:** plan approval (editing the tree) and task review (diff, verifier report, accept / send back / discard). These are the two things the CLI is worst at.
3. **UI, the rest:** Projects, Mission view, Agents, Inbox.

**v2**
- Parallel tasks inside one project (each task in its own isolated copy of the folder, merged back on accept), with live notes between agents running at the same time
- Push your comments into a running agent (via hooks)
- Agent capabilities/routing ("UI tasks → Claude Code")
- Run full-access agents in a container
- Agent scorecards: verification pass rate, cost and time per task for each agent profile, broken down by kind of task. Used to pick cheaper models for easy tasks and to estimate a mission's cost before you approve the plan.

**Later**
- Missions spanning several projects
- Non-code missions (research, docs, ops): same task model, a different kind of workspace instead of a code folder
- Teams, logins, Postgres

## 12. Decisions

- Localhost, single user.
- Name: **Northern Lights** (CLI `northern-lights`; short alias TBD, see §13).
- A project is a folder; one mission works in one project.
- No git in v1. One task at a time per project, working directly in the folder; different projects run in parallel. Snapshots give diffs and undo.
- Planner = strongest model available by default, changeable per mission.
- Every breakdown needs human approval.
- Every task is verified (checks + a different agent) before it's accepted; review mode is per mission, default "review every task".
- One fresh agent per task; nothing stays alive for the mission except the server. v1 uses launch mode, with pull mode as the fallback.
- Agents share context only through server-built briefings, structured Results and `DECISIONS.md`, never through a long-running agent's memory.
- Code first; other mission types later.
- Permission mode per mission: approve up front (default) or full access.
- Budget per mission in tokens or dollars, with per-task and per-mission limits plus a time limit per run. Enforced live by the server.
- Questions end the agent's run; the task waits on you and a fresh agent resumes with your answer.
- Build order: engine + CLI first, then the core UI screens, then the rest.
- Every project has a `PROJECT.md` overview that goes into every briefing.
- The planner adds tasks for you to the plan for steps only a human can do.
- After a crash, nothing restarts on its own: orphaned tasks go back to Ready and missions stay paused.
- Inbox items send a macOS notification.

## 13. Open questions

1. **CLI alias:** macOS already has a `/usr/bin/nl` (line numbering), so phase 1 ships only `northern-lights`. Pick another short alias, or skip it.
2. **Verifier cost:** in the first real mission, each verifier run (Sonnet) cost ~$0.09 while each worker run (Haiku) cost under $0.01. Verification is most of the bill. Consider a cheaper default verifier, or skipping the verifier for tasks whose checks fully cover the criteria.
3. **Codex:** the Codex profile is written from its docs but untested (Codex isn't installed here).

## 14. Implementation notes (phase 1)

Where the build fills in details the spec left open:
- **Tokens** counted against budgets = new input + cache writes + output. Cache reads (re-reading the same context every turn) are excluded; they'd make token budgets meaningless.
- **Live dollar limits:** Claude reports a run's exact cost only when it ends. During a run, dollars are estimated from the price table if you set one, otherwise from the cost-per-token learned from earlier runs of the same model. The very first run of a new model is only checked at its end.
- **Verifier runs count toward the task's budget**, as well as the mission's.
- **Runs that exit without submitting** count as failed attempts (3 → Stuck), so a crashing agent can't loop forever.
- **Verifier picks:** the mission's verifier profile; if that's the profile that did the work, another installed profile is used when one exists.
- **Cancelled tasks** count as done for their dependents.
- **A broken `project.yaml`** fails the task with the error and notifies you.
- **Approve up front with Claude Code:** edits are auto-accepted inside the project folder (`acceptEdits`), shell commands must match an approved prefix, everything else is denied. Plan and verify runs can't edit files at all.
