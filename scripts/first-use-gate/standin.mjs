// The first-use gate's stand-in agent: an ACP agent with no model. Its steps come from the JSON
// file named by its first argument, keyed by a phrase of the prompt (the first key the prompt
// contains wins). It reaches the game tools as real ACP agents do, through `kurambit
// acp-mcp-call`, and appends every prompt's steps and tool answers to the JSONL file named by its
// second argument. Steps: {"write":[path,text]}, {"tool":[name,args]}, {"say":text}; a string
// "$last.<field>" in a tool's args is that field of the previous tool answer's structured content.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

const [stepsFile, answersFile] = process.argv.slice(2);
const send = (message) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const sessions = new Map();
let nextSession = 1;

/** One game tool call through the MCP bridge the server handed this session. */
function callTool(session, tool, args) {
  const server = session.mcpServers.find((each) => (each.args ?? []).includes("acp-mcp-bridge"));
  if (server === undefined) return Promise.resolve({ error: "no kurambit MCP server" });
  const env = Object.fromEntries((server.env ?? []).map((each) => [each.name, each.value]));
  const argv = server.args.map((each) => (each === "acp-mcp-bridge" ? "acp-mcp-call" : each));
  return new Promise((resolve) =>
    NodeChildProcess.execFile(
      server.command,
      [...argv, tool, JSON.stringify(args)],
      { env: { ...process.env, ...env }, cwd: session.cwd, maxBuffer: 1 << 26 },
      (error, stdout, stderr) => {
        if (error) return resolve({ error: String(error), stderr: String(stderr).slice(0, 2000) });
        try {
          resolve(JSON.parse(stdout.trim().split("\n").at(-1) || "{}"));
        } catch {
          resolve({ raw: stdout.slice(0, 4000) });
        }
      },
    ),
  );
}

const chunk = (sessionId, text) =>
  send({
    method: "session/update",
    params: {
      sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
    },
  });

async function prompt(id, params) {
  const session = sessions.get(params.sessionId);
  const text = (params.prompt ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  const table = JSON.parse(NodeFS.readFileSync(stepsFile, "utf8"));
  const key = Object.keys(table).find((each) => text.includes(each));
  const steps = key === undefined ? [] : table[key];
  const answers = [];
  for (const step of steps) {
    if (step.write) {
      const file = NodePath.join(session.cwd, step.write[0]);
      NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
      NodeFS.writeFileSync(file, step.write[1]);
    } else if (step.merge) {
      // Keys merged into a JSON file the game already has (game.json's recipes).
      const file = NodePath.join(session.cwd, step.merge[0]);
      const json = JSON.parse(NodeFS.readFileSync(file, "utf8"));
      NodeFS.writeFileSync(file, `${JSON.stringify({ ...json, ...step.merge[1] }, null, 2)}\n`);
    } else if (step.say) {
      chunk(params.sessionId, step.say);
    } else if (step.tool) {
      const last = answers.at(-1)?.answer?.structuredContent ?? {};
      const args = JSON.parse(JSON.stringify(step.tool[1]), (_key, value) =>
        typeof value === "string" && value.startsWith("$last.") ? last[value.slice(6)] : value,
      );
      const toolCallId = `standin-${Date.now()}-${answers.length}`;
      const update = (fields) =>
        send({
          method: "session/update",
          params: { sessionId: params.sessionId, update: { toolCallId, ...fields } },
        });
      update({
        sessionUpdate: "tool_call",
        title: `kurambit.${step.tool[0]}`,
        kind: "other",
        status: "in_progress",
        rawInput: args,
      });
      const started = Date.now();
      const answer = await callTool(session, step.tool[0], args);
      answers.push({ tool: step.tool[0], args, ms: Date.now() - started, answer });
      update({
        sessionUpdate: "tool_call_update",
        status: answer?.error || answer?.isError ? "failed" : "completed",
      });
    }
  }
  NodeFS.appendFileSync(
    answersFile,
    `${JSON.stringify({ at: new Date().toISOString(), key: key ?? null, cwd: session.cwd, answers })}\n`,
  );
  chunk(params.sessionId, `${steps.find((step) => step.reply)?.reply ?? "Done."}\n\nNext: none`);
  send({ id, result: { stopReason: "end_turn" } });
}

const input = NodeReadline.createInterface({ input: process.stdin });
input.on("close", () => process.exit(0));
input.on("line", (line) => {
  if (line.trim() === "") return;
  const { id, method, params } = JSON.parse(line);
  switch (method) {
    case undefined:
      return;
    case "initialize":
      return send({
        id,
        result: {
          protocolVersion: 1,
          agentCapabilities: { loadSession: true, promptCapabilities: {} },
          authMethods: [],
        },
      });
    case "session/new": {
      const sessionId = `standin-${process.pid}-${nextSession++}`;
      sessions.set(sessionId, { cwd: params.cwd, mcpServers: params.mcpServers ?? [] });
      return send({ id, result: { sessionId } });
    }
    case "session/load":
      sessions.set(params.sessionId, { cwd: params.cwd, mcpServers: params.mcpServers ?? [] });
      return send({ id, result: {} });
    case "session/prompt":
      void prompt(id, params).catch((error) => {
        NodeFS.appendFileSync(answersFile, `${JSON.stringify({ error: String(error) })}\n`);
        send({ id, result: { stopReason: "end_turn" } });
      });
      return;
    default:
      if (id !== undefined) send({ id, result: {} });
  }
});
