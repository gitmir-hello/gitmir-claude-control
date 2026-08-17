// What the object context actually did — measured, not estimated.
//
// The product is sold on a claim: an agent answering from the model spends far
// less than one crawling the repository, and a person deciding from the model
// sees things a diff cannot show. Until now nothing in the product measured
// either. A tool that claims to reduce what you spend and never counts anything
// is asking to be believed, which is a weaker position than showing the number.
//
// So every answer served leaves one line: what was asked, how big the answer
// was, and — the honest part — how big the files are that those objects live in.
// That second number is not a guess about what an agent "would have done". It is
// a fact about this repository: these objects live in these files, and the files
// are this size. What somebody does with that comparison is their judgement; the
// measurement is not.
//
// The record never leaves the machine. It is a file in the project, like the
// model, and nothing reads it but the dashboard on localhost.

import fs from 'node:fs';
import path from 'node:path';
import { DIMENSIONS } from './read.js';

const LOG = ['.gitmir', 'usage.jsonl'];
const FOOT = ['.gitmir', 'footprint.json'];
const MAX_LINES = 4000;          // a few months of heavy use; trimmed oldest-first
const FOOT_TTL = 60 * 60 * 1000; // an hour: the source tree does not shrink by surprise

const logPath = (p) => path.join(p, ...LOG);

/**
 * The files a set of model objects lives in, and what they weigh.
 *
 * Endpoints are skipped on purpose: `apiRoutes.path` is a URL, not a file, and
 * counting "/api/v1/orders" as source would inflate the number in our favour.
 * A measurement that flatters the product is worth nothing in the room where it
 * matters.
 */
export function fileBytesFor(projectPath, ids, model) {
  const want = new Set(ids || []);
  const files = new Set();
  for (const d of DIMENSIONS) {
    if (d === 'apiRoutes') continue;
    for (const o of (model[d] || [])) {
      if (!o || !want.has(o.id)) continue;
      const list = Array.isArray(o.paths) ? o.paths : (o.file ? [o.file] : []);
      for (const rel of list) if (rel && !/^https?:|^\//.test(rel)) files.add(rel);
    }
  }
  let bytes = 0, counted = 0;
  for (const rel of files) {
    let st;
    try { st = fs.statSync(path.join(projectPath, rel)); } catch { continue; }
    if (st.isDirectory()) continue;   // a module's `paths` can name a folder
    bytes += st.size; counted++;
  }
  return { files: counted, bytes };
}

/** Everything the model weighs, as one number. */
export function modelBytes(projectPath) {
  const dir = path.join(projectPath, '.gitmir', 'model');
  let bytes = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      try { bytes += fs.statSync(path.join(dir, f)).size; } catch {}
    }
  } catch {}
  return bytes;
}

/**
 * Everything the repository's source weighs.
 *
 * Cached for an hour in the project: walking a large tree on every page load
 * would make the one screen that reports speed the slowest screen in the tool.
 */
export function sourceBytes(projectPath, { fresh = false } = {}) {
  const cache = path.join(projectPath, ...FOOT);
  if (!fresh) {
    try {
      const c = JSON.parse(fs.readFileSync(cache, 'utf8'));
      if (Date.now() - (c.at || 0) < FOOT_TTL) return { bytes: c.bytes, files: c.files, cached: true };
    } catch {}
  }
  const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'out', 'vendor',
    'coverage', '.cache', '.venv', '__pycache__', '.gitmir', 'tasks', '.claude']);
  const EXT = /\.(js|jsx|ts|tsx|vue|svelte|astro|mjs|cjs|py|rb|go|java|kt|cs|swift|php|rs|sql|prisma)$/i;
  let bytes = 0, files = 0, seen = 0;
  const walk = (d, depth) => {
    if (depth > 8 || seen > 40000) return;
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(d, e.name);
      // Build output is not source: a bundle rewritten by a build makes the model look
      // stale when nothing about the product moved. One name does not cover it —
      // dist-device and dist-server sit next to dist in real repositories.
      if (e.isDirectory() && /^(dist|build|out|target)([-.].*)?$/i.test(e.name)) continue;
      if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(full, depth + 1); continue; }
      seen++;
      if (!EXT.test(e.name)) continue;
      try { const st = fs.statSync(full); bytes += st.size; files++; } catch {}
    }
  };
  try { walk(projectPath, 0); } catch {}
  try {
    fs.mkdirSync(path.dirname(cache), { recursive: true });
    fs.writeFileSync(cache, JSON.stringify({ at: Date.now(), bytes, files }) + '\n');
  } catch {}
  return { bytes, files, cached: false };
}

/**
 * Append one served answer to the record.
 *
 * Never throws: a tool that fails to answer because it failed to write its own
 * diary is a worse tool than one that keeps no diary.
 */
export function record(projectPath, entry) {
  if (!projectPath) return;
  const line = JSON.stringify({
    at: new Date().toISOString(),
    tool: String(entry.tool || '').slice(0, 40),
    q: String(entry.q || '').slice(0, 160),
    served: Number(entry.served) || 0,
    ids: Array.isArray(entry.ids) ? entry.ids.length : 0,
    wouldFiles: Number(entry.wouldFiles) || 0,
    wouldBytes: Number(entry.wouldBytes) || 0,
    by: String(entry.by || 'agent').slice(0, 20),
  });
  const file = logPath(projectPath);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, line + '\n');
  } catch { return; }
  // Trim rarely and cheaply: only once the file is well past the cap.
  try {
    const st = fs.statSync(file);
    if (st.size > MAX_LINES * 260) {
      const keep = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-MAX_LINES);
      fs.writeFileSync(file, keep.join('\n') + '\n');
    }
  } catch {}
}

/** The record, newest last. */
export function readUsage(projectPath, limit = 500) {
  let raw = '';
  try { raw = fs.readFileSync(logPath(projectPath), 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch {}
  }
  return out.slice(-Math.max(1, limit));
}

/** Totals a person can read out loud. */
export function summarise(entries) {
  const byTool = new Map();
  let served = 0, wouldBytes = 0, wouldFiles = 0;
  let first = null, last = null;
  for (const e of entries) {
    served += e.served || 0;
    wouldBytes += e.wouldBytes || 0;
    wouldFiles += e.wouldFiles || 0;
    byTool.set(e.tool, (byTool.get(e.tool) || 0) + 1);
    if (!first || e.at < first) first = e.at;
    if (!last || e.at > last) last = e.at;
  }
  return {
    answers: entries.length,
    served, wouldBytes, wouldFiles,
    // Only meaningful when something was actually asked; a ratio out of nothing
    // is the kind of number that gets a demo laughed at.
    ratio: served > 0 ? wouldBytes / served : 0,
    tools: [...byTool.entries()].sort((a, b) => b[1] - a[1]).map(([tool, n]) => ({ tool, n })),
    first, last,
  };
}
