# Northern Lights

You give it a mission. A planner agent breaks it into tasks. You approve the plan. Fresh AI agents (Claude Code, Codex, or anything that can run a CLI) then work the tasks one at a time in your project folder. Every task is checked by your test commands and by a second agent before you accept it.

The full design is in [SPEC.md](SPEC.md). There's a Mac app (Electron), a CLI, and the engine they both talk to.

## Downloads

Every version tag (`v0.2.1`, …) builds the app for **macOS (Apple Silicon and Intel), Windows and Linux**, smoke-tests each on its own OS, and publishes them on the repo's **Releases** page. To cut a release:

```sh
git tag v0.2.1 && git push origin v0.2.1     # or: Actions → Release → Run workflow
```

Local builds: `cd app && sh package.sh` (Mac, `ARCH=arm64|x86_64`), `PLATFORM=win32 sh package-other.sh`, `PLATFORM=linux sh package-other.sh`.

## The Mac app

```sh
cd app && sh build.sh      # once; installs ~/Applications/Northern Lights.app
```

Open **Northern Lights** from Applications or Spotlight. It starts the engine if it isn't running, so you don't need a terminal. Closing the window keeps agents working; ⌘Q stops them (it asks first).

- **Inbox:** everything waiting on you, with a preview pane. Use ↑/↓ to move, A to accept.
- **Missions:** a board (Up next, Working, Needs you, Done), the plan to approve, PROJECT.md and settings (auto-accept, full access, budgets).
- **Tasks:** what the agent did, every check with its evidence, the diff, and the activity log.
- **⌘K** searches everything, **⌘N** starts a new mission.
- **New mission:** type a rough idea and press **Sharpen**: an agent reads the project and drafts a title, a testable goal and "done when" checks. Pick **Quick / Balanced / Thorough** (models + budget) or open **Advanced**. A new mission starts from the settings of the project's last one.
- **Harnesses:** Claude Code, Antigravity (`agy`) and Codex, chosen per mission (and per role: plans / builds / checks). Antigravity reports tokens, not dollars, so its missions use token budgets.
- **UI checks:** verifiers test anything with a UI in a real browser through `agent-browser` (each agent gets its own session) and attach captioned screenshots to the task.
- **Usage:** tokens and cost today, this week and all time, by model and by mission.

The same screens work in a browser: `northern-lights open`.

## Requirements

- Node 24+ (Node runs the TypeScript directly; there's no build step and there are no runtime dependencies). The `northern-lights` command finds a new enough Node by itself, even if nvm puts an older one first on your PATH. To force one, set `NL_NODE=/path/to/node`.
- Claude Code (`claude`) for the default agent profiles. Codex is supported but untested.
- macOS for notifications and instant snapshots. Other systems work, but snapshots fall back to a normal copy.

## Quick start

```sh
cd ~/Developer/Personal/northern-lights
npm link                                  # once: puts `northern-lights` on your PATH
northern-lights serve                     # keep this running in its own terminal (or just open the app)

# in another terminal
northern-lights project add ~/code/my-app
#   → edit ~/code/my-app/.northern-lights/project.yaml: the check commands run after every task
northern-lights mission new my-app "Add password reset" --goal "Users can reset their password by email link"
northern-lights inbox                     # wait for "plan to approve"
northern-lights plan M1                   # read the plan, the permissions it asks for, and PROJECT.md
northern-lights approve M1
northern-lights inbox                     # reviews, questions, tasks for you, …
northern-lights review M1:T1              # task file + diff
northern-lights accept M1:T1
```

The `inbox` command shows everything waiting on you. `status` shows what's running and what it has cost, and `watch` streams events live.

## How a mission runs

1. **Plan:** the planner (by default your strongest model) reads the code and proposes a task tree, the commands and domains agents will need, and a `PROJECT.md` overview if the project has none. You approve, edit (`plan edit M1`) or reject it with feedback.
2. **Work:** each task gets a fresh agent with a briefing: the project overview, the mission, shared decisions, its task, the Results of the tasks it depends on, and feedback from earlier attempts. **One task runs at a time per project**, and different projects run in parallel.
3. **Verify:** when the agent submits, your check commands run, then a different agent checks every acceptance criterion and must give evidence for each. Failures go back to a fresh agent with the feedback. After 3 failures the task is Stuck.
4. **Review:** you accept, send back with feedback, or discard. Discarding restores the folder from the snapshot taken before the task started, and `undo-discard` reverses that. With `--review auto`, verified tasks are accepted automatically.
5. **Final check:** once every task is accepted, a verifier checks the whole mission goal. You give the final approval.

Agents can ask you a question (`answer`), ask for a permission (`permit … once|mission|deny`), or ask to split a task that's too big (`approve`). The planner can also add **tasks for you**, like "put the Stripe key in `.env`" (`done M1:T2 "key is STRIPE_SECRET_KEY"`).

## Budgets, permissions, stopping

- **Budgets** are per mission, in dollars (default) or tokens: `--unit usd --task-budget 5 --mission-budget 50 --time-limit 30`. Each run is stopped the moment it goes over. To continue, run `raise M1:T3 2` or `raise M1 20`.
- **Permissions:** with `--access upfront` (the default), agents get only the commands, domains and paths you approved with the plan. `--access full` skips every prompt, so agents can do anything your user account can.
- **`stop`** stops every agent and pauses its missions. `stop my-app` does the same for one project, and `resume` continues. After a crash, nothing restarts on its own.

## Where things live

| Path | What |
|---|---|
| `<project>/.northern-lights/project.yaml` | check commands and snapshot excludes |
| `<project>/.northern-lights/PROJECT.md` | the overview every agent reads |
| `<project>/.northern-lights/DECISIONS.md` | rules every agent follows; add your own |
| `<project>/.northern-lights/missions/M1-…/` | `MISSION.md`, `TODO.md`, one file per task |
| `~/.northern-lights/config.json` | agent profiles, defaults, concurrency, prices, notifications |
| `~/.northern-lights/runs/<id>/` | each run's briefing and raw output (`log M1:T1`) |
| `~/.northern-lights/snapshots/` | snapshots for diffs and undo |

Agent profiles live in `config.json`. Each one is a harness (`claude`, `codex` or `custom`) plus a model. A `custom` profile runs any command: it gets the briefing on stdin and calls tools with `northern-lights tool <name> '<json>'`.

## Development

```sh
npm install        # TypeScript + Node types, for type checking only
npm run typecheck
npm test           # end-to-end tests with a fake agent; no real models are called
```
