// Reading a project off disk — the model, and what the queue says work will touch.
//
// Shared by the dashboard and the MCP server for the same reason lib/impact.js is:
// "which objects does this task touch" is a product decision, not a file-format
// detail. Two implementations of `Touches:` would eventually disagree about whether
// a task declared its scope, and the two surfaces would report different blast
// radii for the same task.
//
// Node-side only — this one touches the filesystem.

import fs from 'node:fs';
import path from 'node:path';

export const DIMENSIONS = ['modules', 'entities', 'serverUnits', 'serverFunctions',
  'apiRoutes', 'frontendUnits', 'events', 'processes', 'statusFlows', 'reactions'];

// Model ids are prefixed per collection (ent-, sf-, ev-, …) — see the gitmir-model
// skill. Matching on those prefixes is what lets a task name real objects in plain
// text without a second file format to keep in sync.
export const MODEL_ID = /\b(?:mod|ent|f|su|sf|rt|fe|ev|proc|sfw|rx)-[a-z0-9][a-z0-9-]{0,60}\b/g;

export function idList(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const x of v.slice(0, 400)) {
    const s = String(x == null ? '' : x).trim().slice(0, 80);
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

// Read the ids a task declares it will touch. Two spellings are accepted because
// both read naturally in a task file: a `Touches:` line next to `Type:`, and a
// `## Touches` section listing one id per bullet. Ids are only taken from those
// places — the `## Context` section legitimately names ids the task merely reads,
// and counting those as changes would inflate every blast radius.
export function parseTouches(text) {
  // Split on both endings. A file checked out on Windows ends its lines with
  // \r\n, and in JavaScript `.` does not match \r — it is a line terminator —
  // so `(.*)$` stopped short of it and the Touches: line never matched at all.
  // Every task then looked as though it had declared no scope.
  const lines = text.split(/\r?\n/);
  let picked = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const inline = /^\s*touches\s*:\s*(.*)$/i.exec(line);
    if (inline) {
      picked += ' ' + inline[1];
      for (let j = i + 1; j < lines.length && /^\s+\S/.test(lines[j]); j++) picked += ' ' + lines[j];
      continue;
    }
    if (/^\s*#{1,6}\s*touches\b/i.test(line)) {
      for (let j = i + 1; j < lines.length && !/^\s*#{1,6}\s/.test(lines[j]); j++) picked += ' ' + lines[j];
    }
  }
  return idList(picked.match(MODEL_ID) || []);
}

// Every id the model actually defines, fields included. Used to throw away ids a
// task mentions that the model does not know — a typo or a stale reference would
// otherwise put a phantom node in the blast radius.
export function modelIdSet(dir) {
  const out = new Set();
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'index.json'); } catch { return out; }
  for (const f of files) {
    let arr;
    try { arr = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    if (!Array.isArray(arr)) continue;
    for (const o of arr) {
      if (!o || typeof o !== 'object') continue;
      if (typeof o.id === 'string') out.add(o.id);
      if (Array.isArray(o.fields)) for (const fl of o.fields) if (fl && typeof fl.id === 'string') out.add(fl.id);
    }
  }
  return out;
}

// The model as the impact engine expects it: one array per dimension, plus whether
// anything was found at all and when it was last written.
export function readModel(projectPath) {
  const dir = path.join(projectPath, '.gitmir', 'model');
  const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
  const index = readJson(path.join(dir, 'index.json'));
  const model = {};
  let exists = !!index;
  for (const d of DIMENSIONS) {
    const arr = readJson(path.join(dir, d + '.json'));
    model[d] = Array.isArray(arr) ? arr : [];
    if (model[d].length) exists = true;
  }
  let builtAt = (index && typeof index.at === 'string') ? index.at : null;
  let writtenMs = 0;
  try {
    for (const f of fs.readdirSync(dir)) if (f.endsWith('.json')) {
      const st = fs.statSync(path.join(dir, f));
      if (st.mtimeMs > writtenMs) writtenMs = st.mtimeMs;
    }
  } catch {}
  return { exists, dir, model, index, builtAt, writtenMs };
}

// A model that is older than the code is worse than no model: it looks
// authoritative and quietly lies. Answer that here rather than trusting that every
// session remembered to refresh it.
export function modelStaleness(projectPath, writtenMs) {
  const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'out', 'vendor',
    'coverage', '.cache', '.venv', '__pycache__', '.gitmir', 'tasks', 'docs', '.claude']);
  const EXT = /\.(js|jsx|ts|tsx|vue|svelte|astro|mjs|cjs|py|rb|go|java|kt|cs|swift|php|rs|sql|prisma)$/i;
  let changed = 0, scanned = 0, newest = 0, newestFile = '';
  const walk = (d, depth) => {
    if (depth > 7 || scanned > 6000) return;
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (scanned > 6000) return;
      if (e.name.startsWith('.')) continue;
      const full = path.join(d, e.name);
      // Build output is not source: a bundle rewritten by a build makes the model look
      // stale when nothing about the product moved. One name does not cover it —
      // dist-device and dist-server sit next to dist in real repositories.
      if (e.isDirectory() && /^(dist|build|out|target)([-.].*)?$/i.test(e.name)) continue;
      if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(full, depth + 1); continue; }
      if (!EXT.test(e.name)) continue;
      scanned++;
      let st; try { st = fs.statSync(full); } catch { continue; }
      if (st.mtimeMs > newest) { newest = st.mtimeMs; newestFile = path.relative(projectPath, full); }
      if (st.mtimeMs > writtenMs + 1000) changed++;
    }
  };
  try { walk(projectPath, 0); } catch {}
  return { stale: changed > 0, changed, scanned, newestFile };
}

// Every task in the queue with the model ids it names. A `Touches:` line is the task
// saying so itself; without one, fall back to every model id the task mentions
// anywhere — the planner is told to write the slice of the product a task touches
// into `## Context`, so those ids are a statement of scope rather than a
// coincidence. `declared` says which it was, because that decides how much to trust
// the numbers computed from it.
export function readTasks(projectPath, known) {
  const out = [];
  for (const col of ['todo', 'inprogress', 'verify', 'done']) {
    const dir = path.join(projectPath, 'tasks', col);
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort(); } catch { continue; }
    for (const f of files.slice(0, 400)) {
      let text = '';
      try { text = fs.readFileSync(path.join(dir, f), 'utf8').slice(0, 60000); } catch { continue; }
      const title = (text.split(/\r?\n/).find((l) => l.trim()) || f).replace(/^#+\s*/, '').trim().slice(0, 160);
      const declaredIds = parseTouches(text).filter((i) => known.has(i));
      const ids = declaredIds.length ? declaredIds
        : idList(text.match(MODEL_ID) || []).filter((i) => known.has(i));
      const ap = /^\s*approved\s*:\s*(.+)$/im.exec(text);
      // The request this task grew out of. Everything the audit counts is grouped
      // by it, so a round that produced four tasks reads as one change.
      const chg = /^\s*change\s*:\s*(.+)$/im.exec(text.split(/\r?\n/).slice(0, 14).join('\n'));
      let mtime = 0; try { mtime = fs.statSync(path.join(dir, f)).mtimeMs; } catch {}
      out.push({
        col, file: f, n: Number((/^(\d+)/.exec(f) || [])[1]) || 0, title, ids,
        change: chg ? chg[1].replace(/\.md$/i, '').trim().slice(0, 200) : '',
        declared: declaredIds.length > 0, approved: ap ? ap[1].trim().slice(0, 80) : null, mtime,
      });
    }
  }
  return out;
}
