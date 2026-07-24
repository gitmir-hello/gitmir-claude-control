'use strict';
// GitMir team bridge — dashboard-side connection manager.
//
// Holds ONE live connection to the GitMir relay for this machine, bound to a
// local project folder. Incoming model snapshots are saved under that project's
// .gitmir/shared/<from>/ (so you view a teammate's model in YOUR local instance);
// incoming tasks are written to the project's tasks/todo/ (so your local Claude
// picks them up). Nothing is stored on the server — the relay only routes.
//
// Zero dependencies: Node's built-in global WebSocket (Node 21+) and fs.

const fs = require('fs');
const path = require('path');

const state = {
  connected: false, connecting: false,
  key: null, name: 'me', projectPath: null,
  url: process.env.GITMIR_RELAY_URL || 'ws://localhost:4600',
  plan: null, self: null, members: [], activity: [], autoShare: false,
};
let ws = null;
let sentModelTo = 0;
let reconnectTimer = null;
let backoff = 0;         // ms; grows on each failed attempt
let deliberate = false;  // true when the user asked to disconnect — suppresses auto-reconnect
let denied = false;      // true after a plan/auth denial — never auto-reconnect

const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'x';
function log(kind, text) { state.activity.unshift({ t: Date.now(), kind, text }); state.activity.length = Math.min(state.activity.length, 50); }

function readLocalModel() {
  if (!state.projectPath) return null;
  const dir = path.join(state.projectPath, '.gitmir', 'model');
  if (!fs.existsSync(dir)) return null;
  const files = {};
  for (const f of fs.readdirSync(dir)) if (f.endsWith('.json')) files[f] = fs.readFileSync(path.join(dir, f), 'utf8');
  return Object.keys(files).length ? files : null;
}
function saveSharedModel(from, files) {
  if (!state.projectPath || !files) return;
  const dir = path.join(state.projectPath, '.gitmir', 'shared', slug(from), 'model');
  fs.mkdirSync(dir, { recursive: true });
  for (const [f, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), content);
  log('model', `received ${Object.keys(files).length} file(s) from ${from} → .gitmir/shared/${slug(from)}/`);
}
function writeIncomingTask(from, task) {
  if (!state.projectPath) { log('task', `from ${from} (no project bound, dropped): ${task.title}`); return; }
  const todo = path.join(state.projectPath, 'tasks', 'todo');
  fs.mkdirSync(todo, { recursive: true });
  const nums = fs.readdirSync(todo).map((f) => parseInt(f, 10)).filter((n) => !Number.isNaN(n));
  const next = String((nums.length ? Math.max(...nums) : 0) + 1).padStart(3, '0');
  const file = path.join(todo, `${next}-${slug(task.title)}.md`);
  fs.writeFileSync(file, `# ${task.title}\n\n## Context\nReceived from ${from} via the GitMir team bridge.\n\n## Task\n${task.body || task.title}\n`);
  log('task', `from ${from} → tasks/todo/${path.basename(file)}`);
}

function pushModel() {
  const files = readLocalModel();
  if (!files) { log('model', 'no local .gitmir/model to share'); return false; }
  ws.send(JSON.stringify({ type: 'model', body: { files } }));
  log('model', `shared ${Object.keys(files).length} file(s) with the team`);
  return true;
}

function handle(m) {
  switch (m.type) {
    case 'welcome': state.connected = true; state.connecting = false; state.self = m.self; state.plan = m.plan; backoff = 0; denied = false; log('bridge', `connected · plan ${m.plan}`); break;
    case 'presence':
      state.members = m.members;
      log('presence', m.members.map((x) => x.name).join(', '));
      if (state.autoShare && m.members.length > sentModelTo) { sentModelTo = m.members.length; pushModel(); }
      break;
    case 'msg': log('msg', `<${m.from.name}> ${JSON.stringify(m.body)}`); break;
    case 'task': writeIncomingTask(m.from.name, m.body || {}); break;
    case 'model': saveSharedModel(m.from.name, m.body && m.body.files); break;
    case 'denied': state.connected = false; state.connecting = false; denied = true; log('denied', m.reason); break;
  }
}

// Open a socket for the current state.key/url. Guards against stale sockets so a
// replaced connection's late 'close' can't trigger a spurious reconnect.
function openSocket() {
  const wsurl = `${state.url}/?key=${encodeURIComponent(state.key)}&name=${encodeURIComponent(state.name)}`;
  let sock;
  try { sock = new WebSocket(wsurl); }
  catch (e) { state.connecting = false; log('bridge', `connect failed: ${(e && e.message) || e}`); scheduleReconnect(); return; }
  ws = sock;
  sock.addEventListener('message', (e) => { if (ws !== sock) return; let m; try { m = JSON.parse(e.data); } catch { return; } handle(m); });
  sock.addEventListener('close', (ev) => {
    if (ws !== sock) return;                 // superseded socket — ignore
    state.connected = false; state.members = [];
    if (deliberate) { state.connecting = false; return; }
    log('bridge', `closed (${ev.code})`);
    scheduleReconnect();
  });
  sock.addEventListener('error', () => {});
}

// Reconnect with exponential backoff (1s → 15s), unless the drop was deliberate or
// the workspace was denied (e.g. free plan) — those must not loop.
function scheduleReconnect() {
  if (deliberate || denied || !state.key) { state.connecting = false; return; }
  backoff = Math.min(backoff ? backoff * 2 : 1000, 15000);
  state.connecting = true;
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => { if (!deliberate && !denied) openSocket(); }, backoff);
  log('bridge', `reconnecting in ${Math.round(backoff / 1000)}s…`);
}

function connect({ key, name, projectPath, url }) {
  disconnect();
  deliberate = false; denied = false; backoff = 0;
  state.key = key; state.name = name || 'me'; state.projectPath = projectPath || null;
  state.url = url || state.url; state.connecting = true; state.autoShare = false; sentModelTo = 0; state.members = [];
  openSocket();
  return true;
}
function shareModel() { if (!state.connected) return { ok: false, error: 'not connected' }; state.autoShare = true; sentModelTo = state.members.length; return { ok: pushModel() }; }
function sendTask({ title, body }) {
  if (!state.connected) return { ok: false, error: 'not connected' };
  if (!title) return { ok: false, error: 'no title' };
  ws.send(JSON.stringify({ type: 'task', body: { title, body: body || '' } }));
  log('task', `sent → team: ${title}`);
  return { ok: true };
}
function status() {
  return { connected: state.connected, connecting: state.connecting, plan: state.plan, self: state.self, name: state.name, projectPath: state.projectPath, url: state.url, members: state.members, activity: state.activity };
}
function disconnect() { deliberate = true; clearTimeout(reconnectTimer); try { if (ws) ws.close(); } catch {} ws = null; state.connected = false; state.connecting = false; state.members = []; }

module.exports = { connect, status, shareModel, sendTask, disconnect };
