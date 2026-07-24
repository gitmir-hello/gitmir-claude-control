// GitMir team bridge — local client.
//
// Connects this machine to your team through the GitMir relay. Zero dependencies:
// Node's built-in global WebSocket (Node 21+) and fs. Nothing about your product
// is stored on the server — the relay only routes live messages between your
// team's machines. What flows:
//   • model  — a builder shares their local .gitmir/model with the team; each
//              viewer receives it and keeps a copy under .gitmir/shared/<from>/
//              so they read the visualization in THEIR OWN local instance.
//   • task   — anyone sends a task; it lands in the recipient builder's local
//              tasks/todo/ so their local Claude can pick it up. The server never
//              sees it stored — it is relayed live and forgotten.
//
// Usage:
//   node relay-client.mjs <workspace-key> [name] [--url ws://host:port]
//        [--project <dir>]        bind to a local project (enables model/task I/O)
//        [--share-model]          builder: push .gitmir/model to teammates (and to late joiners)
//        [--send-task "<title>"]  send one task to the team  [--body "<markdown>"]
//        [--say "<text>"]         send one plain message (debug)

import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const has = (name) => args.includes(name);

const key = args[0];
const name = args[1] && !args[1].startsWith("--") ? args[1] : "anon";
const BASE = flag("--url") || process.env.GITMIR_RELAY_URL || "ws://localhost:4600";
const projectDir = flag("--project");
const shareModel = has("--share-model");
const sendTaskTitle = flag("--send-task");
const sendTaskBody = flag("--body") || "";
const sayText = flag("--say");

if (!key) {
  console.error("usage: node relay-client.mjs <workspace-key> [name] [--project dir] [--share-model] [--send-task title]");
  process.exit(1);
}

/* -------------------------- local disk (project) -------------------------- */

function readLocalModel() {
  if (!projectDir) return null;
  const dir = path.join(projectDir, ".gitmir", "model");
  if (!fs.existsSync(dir)) return null;
  const files = {};
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith(".json")) files[f] = fs.readFileSync(path.join(dir, f), "utf8");
  }
  return Object.keys(files).length ? files : null;
}

function saveSharedModel(fromName, files) {
  if (!projectDir || !files) return;
  const dir = path.join(projectDir, ".gitmir", "shared", slug(fromName), "model");
  fs.mkdirSync(dir, { recursive: true });
  for (const [f, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), content);
  console.log(`  [model] saved ${Object.keys(files).length} file(s) from ${fromName} → .gitmir/shared/${slug(fromName)}/model/`);
}

function writeIncomingTask(fromName, task) {
  if (!projectDir) { console.log(`  [task] (no --project, not written) from ${fromName}: ${task.title}`); return; }
  const todo = path.join(projectDir, "tasks", "todo");
  fs.mkdirSync(todo, { recursive: true });
  const nums = fs.readdirSync(todo).map((f) => parseInt(f, 10)).filter((n) => !Number.isNaN(n));
  const next = String((nums.length ? Math.max(...nums) : 0) + 1).padStart(3, "0");
  const file = path.join(todo, `${next}-${slug(task.title)}.md`);
  const md = `# ${task.title}\n\n## Context\nReceived from ${fromName} via the GitMir team bridge.\n\n## Task\n${task.body || task.title}\n`;
  fs.writeFileSync(file, md);
  console.log(`  [task] from ${fromName} → wrote ${path.relative(projectDir, file)}`);
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "x";

/* ------------------------------- the bridge ------------------------------- */

const url = `${BASE}/?key=${encodeURIComponent(key)}&name=${encodeURIComponent(name)}`;
const ws = new WebSocket(url);
let sentModelTo = 0; // resend the model when the team grows, so late joiners get it

function pushModel() {
  const files = readLocalModel();
  if (!files) { console.log("  [model] no local .gitmir/model to share"); return; }
  ws.send(JSON.stringify({ type: "model", body: { files } }));
  console.log(`  [model] shared ${Object.keys(files).length} file(s) with the team`);
}

ws.addEventListener("open", () => console.log(`[bridge] connecting as "${name}"…`));

ws.addEventListener("message", (e) => {
  let m; try { m = JSON.parse(e.data); } catch { return; }
  switch (m.type) {
    case "welcome":
      console.log(`[bridge] connected · id=${m.self.id} · plan=${m.plan}`);
      if (sayText) ws.send(JSON.stringify({ type: "msg", body: { text: sayText } }));
      if (sendTaskTitle) ws.send(JSON.stringify({ type: "task", body: { title: sendTaskTitle, body: sendTaskBody } }));
      break;
    case "presence": {
      console.log(`[bridge] team online: ${m.members.map((x) => x.name).join(", ")}`);
      // builder re-shares whenever the team grows, so a member who joins later
      // still receives the current model (the relay itself keeps nothing)
      if (shareModel && m.members.length > sentModelTo) { sentModelTo = m.members.length; pushModel(); }
      break;
    }
    case "msg":
      console.log(`  <${m.from.name}> ${JSON.stringify(m.body)}`);
      break;
    case "task":
      writeIncomingTask(m.from.name, m.body || {});
      break;
    case "model":
      saveSharedModel(m.from.name, m.body?.files);
      break;
    case "denied":
      console.log(`[bridge] DENIED: ${m.reason}`);
      break;
  }
});

ws.addEventListener("close", (e) => console.log(`[bridge] closed (${e.code}${e.reason ? " " + e.reason : ""})`));
ws.addEventListener("error", () => {});
