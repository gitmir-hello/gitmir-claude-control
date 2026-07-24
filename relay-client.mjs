// GitMir team bridge — local client.
//
// Connects this machine to your team through the GitMir relay. Zero dependencies:
// Node's built-in global WebSocket (Node 22+) and fs. Nothing about your product
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

// The peer controls these keys, so they are path input. Accept only a plain
// "<name>.json" basename that resolves inside the destination — otherwise
// "../../../../.ssh/authorized_keys" would be written wherever this runs.
function safeModelName(dir, f) {
  const name = String(f == null ? "" : f);
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(name)) return null;
  if (name.startsWith(".") || !name.endsWith(".json")) return null;
  const dest = path.resolve(dir, name);
  if (dest !== path.join(path.resolve(dir), name)) return null;
  if (!dest.startsWith(path.resolve(dir) + path.sep)) return null;
  return dest;
}

function saveSharedModel(fromName, files) {
  if (!projectDir || !files || typeof files !== "object") return;
  const dir = path.join(projectDir, ".gitmir", "shared", slug(fromName), "model");
  let written = 0, skipped = 0, total = 0, made = false;
  for (const [f, content] of Object.entries(files).slice(0, 40)) {
    const dest = safeModelName(dir, f);
    if (!dest || typeof content !== "string") { skipped++; continue; }
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > 2 * 1024 * 1024 || total + bytes > 16 * 1024 * 1024) { skipped++; continue; }
    if (!made) { fs.mkdirSync(dir, { recursive: true }); made = true; }
    fs.writeFileSync(dest, content);
    total += bytes; written++;
  }
  console.log(`  [model] saved ${written} file(s) from ${fromName} → .gitmir/shared/${slug(fromName)}/model/` +
    (skipped ? `  (${skipped} rejected: unsafe name or too large)` : ""));
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

if (typeof WebSocket === "undefined") {
  console.error(`This client needs Node 22+ for the built-in WebSocket (you are on ${process.version}).`);
  process.exit(1);
}

// Build with the URL API so a hosted relay works at the root (wss://relay.gitmir.com)
// or on a path (wss://ide.gitmir.com/relay, with or without a trailing slash).
let url;
try {
  const u = new URL(String(BASE).trim());
  if (u.protocol === "http:") u.protocol = "ws:";
  if (u.protocol === "https:") u.protocol = "wss:";
  if (u.protocol !== "ws:" && u.protocol !== "wss:") throw new Error(`must start with ws:// or wss:// (got "${u.protocol}//")`);
  u.pathname = u.pathname.replace(/\/+$/, "") || "/";
  u.searchParams.set("key", key);
  u.searchParams.set("name", name);
  url = u.href;
} catch (e) {
  console.error(`Bad relay URL "${BASE}": ${e.message}`);
  process.exit(1);
}
const ws = new WebSocket(url);
let sharedWith = ""; // ids the model was last pushed to, so late joiners get it

function pushModel() {
  const files = readLocalModel();
  if (!files) { console.log("  [model] no local .gitmir/model to share"); return; }
  ws.send(JSON.stringify({ type: "model", body: { files } }));
  console.log(`  [model] shared ${Object.keys(files).length} file(s) with the team`);
}

ws.addEventListener("open", () => console.log(`[bridge] connecting as "${name}"…`));

ws.addEventListener("message", (e) => {
  let m; try { m = JSON.parse(e.data); } catch { return; }
  try { onFrame(m); } catch (err) { console.log(`  [bridge] bad frame from peer: ${err?.message || err}`); }
});

const peerName = (m) => (m?.from && typeof m.from.name === "string" && m.from.name) || "a teammate";

function onFrame(m) {
  switch (m.type) {
    case "welcome":
      console.log(`[bridge] connected · id=${m.self?.id} · plan=${m.plan}`);
      if (sayText) ws.send(JSON.stringify({ type: "msg", body: { text: sayText } }));
      if (sendTaskTitle) ws.send(JSON.stringify({ type: "task", body: { title: sendTaskTitle, body: sendTaskBody } }));
      break;
    case "presence": {
      const members = Array.isArray(m.members) ? m.members.filter(Boolean) : [];
      console.log(`[bridge] team online: ${members.map((x) => x.name).join(", ")}`);
      // Re-share to late joiners, keyed on WHO is present (not a high-water count)
      // so a member who leaves and rejoins still receives the model.
      if (shareModel) {
        const ids = members.map((x) => String(x.id)).sort().join(",");
        if (ids !== sharedWith && members.length > 1) { sharedWith = ids; pushModel(); }
      }
      break;
    }
    case "msg":
      console.log(`  <${peerName(m)}> ${JSON.stringify(m.body)}`);
      break;
    case "task":
      writeIncomingTask(peerName(m), m.body && typeof m.body === "object" ? m.body : {});
      break;
    case "model":
      saveSharedModel(peerName(m), m.body?.files);
      break;
    case "denied":
      console.log(`[bridge] DENIED: ${m.reason}`);
      break;
  }
}

ws.addEventListener("close", (e) => console.log(`[bridge] closed (${e.code}${e.reason ? " " + e.reason : ""})`));
ws.addEventListener("error", () => {});
