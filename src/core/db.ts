import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { homeDir } from "./config.ts";

const SCHEMA = `
create table if not exists projects (
  id text primary key,
  name text not null,
  path text not null unique,
  created_at text not null
);

create table if not exists missions (
  id text primary key,
  project_id text not null references projects(id),
  title text not null,
  goal text not null,
  status text not null,
  paused integer not null default 0,
  review_mode text not null,
  permission_mode text not null,
  permissions text not null,
  budget_unit text not null,
  budget_task real not null,
  budget_mission real not null,
  time_limit_min integer not null,
  planner_profile text not null,
  worker_profile text not null,
  verifier_profile text not null,
  queue_pos integer not null,
  pending_plan text,
  plan_feedback text,
  overview_proposal text,
  warned text not null default '{}',
  created_at text not null,
  updated_at text not null
);

create table if not exists tasks (
  id text primary key,
  mission_id text not null references missions(id),
  local_id text not null,
  parent_local text,
  kind text not null,
  is_parent integer not null default 0,
  title text not null,
  goal text not null default '',
  context text not null default '',
  criteria text not null default '[]',
  depends text not null default '[]',
  order_idx integer not null,
  status text not null,
  attempt integer not null default 0,
  failures integer not null default 0,
  verify_tries integer not null default 0,
  result text,
  verification text,
  pending_verdict text,
  feedback text,
  base_snapshot text,
  submit_snapshot text,
  extra_permissions text not null default '{}',
  extra_budget real not null default 0,
  created_at text not null,
  updated_at text not null
);

create table if not exists runs (
  id integer primary key autoincrement,
  task_id text not null references tasks(id),
  role text not null,
  profile text not null,
  model text,
  key text not null unique,
  pid integer,
  status text not null,
  stop_reason text,
  started_at text not null,
  ended_at text,
  last_activity text not null,
  tokens real not null default 0,
  usd real not null default 0,
  usd_final integer not null default 0,
  log_path text
);

create table if not exists worklog (
  id integer primary key autoincrement,
  task_id text not null,
  ts text not null,
  actor text not null,
  text text not null
);

create table if not exists questions (
  id integer primary key autoincrement,
  task_id text not null,
  kind text not null,
  body text not null,
  answer text,
  created_at text not null,
  answered_at text
);

create table if not exists pull_keys (
  key text primary key,
  profile text not null,
  created_at text not null
);

create table if not exists counters (
  name text primary key,
  value integer not null
);
`;

export type DB = DatabaseSync;

export function openDb(file = path.join(homeDir(), "northern-lights.db")): DB {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("pragma journal_mode = wal; pragma foreign_keys = on;");
  db.exec(SCHEMA);
  return db;
}

export function now(): string {
  return new Date().toISOString();
}

export function nextCounter(db: DB, name: string): number {
  db.prepare(
    "insert into counters(name, value) values (?, 1) on conflict(name) do update set value = value + 1",
  ).run(name);
  const row = db.prepare("select value from counters where name = ?").get(name) as { value: number };
  return row.value;
}

/** Run fn inside a transaction. */
export function tx<T>(db: DB, fn: () => T): T {
  db.exec("begin");
  try {
    const out = fn();
    db.exec("commit");
    return out;
  } catch (e) {
    db.exec("rollback");
    throw e;
  }
}
