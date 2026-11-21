#!/usr/bin/env node
/**
 * MCP server (stdio) for agents. Forwards every tool call to the Northern Lights server
 * using the run's key (NL_KEY). Implements just what MCP clients need: initialize, tools/list, tools/call, ping.
 */
import readline from "node:readline";
import { TOOLS } from "./core/tools.ts";

const URL_BASE = process.env.NL_URL ?? "http://127.0.0.1:7477";
const KEY = process.env.NL_KEY ?? "";

function reply(id: unknown, result: unknown) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

function replyError(id: unknown, code: number, message: string) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
}

async function callTool(name: string, args: unknown): Promise<{ text: string; isError: boolean }> {
  try {
    const res = await fetch(`${URL_BASE}/api/tool/${name}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
      body: JSON.stringify(args ?? {}),
    });
    const body = (await res.json()) as { text?: string; error?: string | boolean };
    if (!res.ok) return { text: String(body.error ?? `HTTP ${res.status}`), isError: true };
    return { text: body.text ?? "", isError: body.error === true };
  } catch (e) {
    return { text: `Northern Lights server unreachable at ${URL_BASE}: ${(e as Error).message}`, isError: true };
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  if (!line.trim()) return;
  let msg: any;
  try {
    msg = JSON.parse(line);
  } catch {
    return replyError(null, -32700, "Parse error");
  }
  const { id, method, params } = msg;
  if (id === undefined) return; // notification
  switch (method) {
    case "initialize":
      return reply(id, {
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "northern-lights", version: "0.1.0" },
        instructions: "Northern Lights task tools. Follow your briefing; end your run after submit/ask_human/fail.",
      });
    case "ping":
      return reply(id, {});
    case "tools/list":
      // Without a run key this was started outside Northern Lights (e.g. a normal agy session): offer nothing.
      return reply(id, {
        tools: KEY ? TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) : [],
      });
    case "tools/call": {
      const r = await callTool(params?.name, params?.arguments);
      return reply(id, { content: [{ type: "text", text: r.text }], isError: r.isError });
    }
    default:
      return replyError(id, -32601, `Method not found: ${method}`);
  }
});
