// How much of a change was first-pass work, and how much was everything after.
//
// Every change has two times: from the request to the first version worth
// showing, and from there to acceptance — the "you misunderstood", the second
// attempt, the second review. A tracker records one duration and calls it the
// task, so the expensive half has never had a number against it.
//
// Nothing is marked by hand. The rounds a developer goes through with an agent
// already leave task files behind, and the queue already moves them between four
// folders. This watches those moves and writes them down.
//
// Two rules the rest of this file exists to keep:
//
//   The record is append-only. A metric nobody can take apart is a metric nobody
//   argues with, and one nobody argues with is one nobody believes.
//
//   No person is in it. Not a name, not an email, not a machine. The audit cuts
//   by area of the product, never by who did the work — an engineer who finds a
//   tool reporting upward how many rounds they needed will uninstall it, and be
//   right to.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const DIR = ['.gitmir', 'audit'];
const MAX_BYTES = 20 * 1024 * 1024;      // then a new file; nothing is ever deleted
const COLS = { todo: 'todo', inprogress: 'doing', verify: 'verify', done: 'done' };

const dirOf = (p) => path.join(p, ...DIR);
const logOf = (p) => path.join(dirOf(p), 'events.jsonl');

/** `Change:` — which request this task belongs to, however many tasks it grew into. */
export function parseChange(md) {
  const head = String(md || '').split(/\r?\n/).slice(0, 14).join('\n');
  const m = head.match(/^\s*Change:\s*(.+?)\s*$/im);
  return m ? m[1].replace(/\.md$/i, '').trim().slice(0, 200) : '';
}

/** Where every task in the queue is right now, and what it says about itself. */
export function snapshot(projectPath) {
  const out = new Map();
  // Which area each model id belongs to, so a task's `Touches:` can be written onto
  // the event as areas. Resolved here rather than when the audit is read: a task
  // gets deleted, a model gets rebuilt, and an append-only record that depends on
  // either of those to still exist is not append-only in any useful sense.
  const area = areaIndex(projectPath);
  for (const [folder, col] of Object.entries(COLS)) {
    const dir = path.join(projectPath, 'tasks', folder);
    let names = [];
    try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.md')); } catch { continue; }
    for (const f of names.slice(0, 800)) {
      const full = path.join(dir, f);
      let md = '', mtime = 0;
      try { md = fs.readFileSync(full, 'utf8').slice(0, 20000); } catch { continue; }
      try { mtime = fs.statSync(full).mtimeMs; } catch {}
      const id = f.replace(/\.md$/i, '');
      const head = md.split(/\r?\n/).slice(0, 14).join('\n');
      const attempt = parseInt((head.match(/^\s*Attempt:\s*(\d+)\s*$/im) || [])[1], 10);
      out.set(id, {
        id, col, mtime,
        // A task with no Change: is its own root. That is the honest reading of a
        // task nobody traced to a request, and it keeps old queues countable.
        change: parseChange(md) || id,
        kind: ((head.match(/^\s*Type:\s*(build|verify|fix)\s*$/im) || [])[1] || '').toLowerCase() || undefined,
        attempt: Number.isNaN(attempt) ? undefined : attempt,
          areas: touchedAreas(head, area),
      });
    }
  }
  return out;
}

/**
 * Every model id mapped to the area that owns it.
 *
 * Read straight off `.gitmir/model/*.json` — an object names its module, and an
 * area names itself. Missing model, missing file, half-written file: all of them
 * mean "no areas", never a crash. The audit is worth less without the area cut and
 * worth nothing if it stops the dashboard.
 */
function areaIndex(projectPath) {
  const idx = new Map();
  const dir = path.join(projectPath, '.gitmir', 'model');
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return idx; }
  for (const f of files) {
    let data;
    try { data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    for (const list of Object.values(data || {})) {
      if (!Array.isArray(list)) continue;
      for (const o of list) {
        if (!o || typeof o !== 'object' || !o.id) continue;
        const owner = o.moduleId || (/^(mod|area)-/.test(o.id) ? o.id : null);
        if (owner) idx.set(o.id, owner);
      }
    }
  }
  return idx;
}

/** The areas a task said it would change, from its `Touches:` line. */
function touchedAreas(head, area) {
  const line = (head.match(/^\s*Touches:\s*(.+?)\s*$/im) || [])[1];
  if (!line || !area.size) return undefined;
  const set = new Set();
  for (const raw of line.split(/[,\s]+/)) {
    const id = raw.trim();
    if (!id) continue;
    const owner = area.get(id);
    if (owner) set.add(owner);
  }
  return set.size ? [...set].slice(0, 8) : undefined;
}

/**
 * What moved between two snapshots.
 *
 * The time of a move is taken from the file when the file says something
 * plausible — the runner rewrites a task as it moves it, so its mtime is the
 * move — and from the clock when it does not. A dashboard that was closed all
 * night must not date the whole night to the moment it opened.
 */
export function transitions(prev, next, { since = 0, now = Date.now() } = {}) {
  const events = [];
  const at = (mtime) => new Date(mtime > since && mtime <= now + 1000 ? mtime : now).toISOString();
  for (const [id, cur] of next) {
    const was = prev.get(id);
    if (!was) { events.push(ev(cur, null, cur.col, at(cur.mtime))); continue; }
    if (was.col !== cur.col) events.push(ev(cur, was.col, cur.col, at(cur.mtime)));
  }
  for (const [id, was] of prev) {
    // A task that disappeared is not an acceptance. Somebody deleted it, or a
    // branch changed under the queue; either way it is not work that landed.
    if (!next.has(id)) events.push(ev(was, was.col, null, new Date(now).toISOString()));
  }
  return events;
  function ev(t, from, to, tISO) {
    const e = { t: tISO, change: t.change, task: t.id, from, to };
    if (t.attempt != null) e.attempt = t.attempt;
    if (t.kind) e.kind = t.kind;
      if (t.areas && t.areas.length) e.areas = t.areas;
    return e;
  }
}

/** Append, never rewrite. Rotates by size; nothing is deleted. */
export function record(projectPath, events) {
  if (!events || !events.length) return 0;
  try { fs.mkdirSync(dirOf(projectPath), { recursive: true }); } catch { return 0; }
  let file = logOf(projectPath);
  try {
    const st = fs.statSync(file);
    if (st.size > MAX_BYTES) {
      let n = 2;
      while (fs.existsSync(path.join(dirOf(projectPath), `events-${n}.jsonl`))) n++;
      fs.renameSync(file, path.join(dirOf(projectPath), `events-${n}.jsonl`));
    }
  } catch {}
  try { fs.appendFileSync(file, events.map((e) => JSON.stringify(e)).join('\n') + '\n'); }
  catch { return 0; }
  return events.length;
}

/** Every event recorded for this project, oldest first, across rotations. */
export function readEvents(projectPath) {
  let names = [];
  try { names = fs.readdirSync(dirOf(projectPath)).filter((f) => /^events(-\d+)?\.jsonl$/.test(f)); }
  catch { return []; }
  // events-2 is older than events.jsonl: rotation moves the full file aside.
  names.sort((a, b) => (b === 'events.jsonl' ? -1 : a === 'events.jsonl' ? 1 : a.localeCompare(b)));
  const out = [];
  for (const n of names) {
    let raw = '';
    try { raw = fs.readFileSync(path.join(dirOf(projectPath), n), 'utf8'); } catch { continue; }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { const e = JSON.parse(line); if (e && e.t && e.change) out.push(e); } catch {}
    }
  }
  out.sort((a, b) => String(a.t).localeCompare(String(b.t)));
  return out;
}

/**
 * Working time between two moments.
 *
 * A gap longer than the cutoff is not work. A task left overnight did not take
 * fourteen hours, and a number that says it did is one nobody will defend in the
 * room where it matters. The cutoff is shown beside every figure it touched.
 */
function workedMs(stamps, cutoffMs) {
  if (stamps.length < 2) return { ms: 0, dropped: 0, droppedMs: 0 };
  let total = 0, dropped = 0, droppedMs = 0;
  for (let i = 1; i < stamps.length; i++) {
    const d = stamps[i] - stamps[i - 1];
    if (d <= 0) continue;
    if (d <= cutoffMs) { total += d; continue; }
    // Over the cutoff, so it is not counted — the rule is that a night is not work.
    // But a queue move cannot tell a night from six hours of unbroken work, so what
    // was dropped is counted and shown. A timer that quietly discards the longest
    // stretches reads as fast work, which is the opposite of what happened.
    dropped++; droppedMs += d;
  }
  return { ms: total, dropped, droppedMs };
}

/**
 * The numbers, and enough of their working to take them apart.
 *
 * Definitions are the ones published on /audit-methodology. If this ever
 * disagrees with that page, the page is the contract — change it deliberately or
 * change this, but never let them drift.
 */
export function metrics(events, { periodDays = 7, idleCutoffHours = 4, now = Date.now() } = {}) {
  const cutoffMs = idleCutoffHours * 3600 * 1000;
  const from = periodDays ? now - periodDays * 86400 * 1000 : 0;

  // Grouped over every event, then filtered by when the change STARTED — not by
  // which of its events happen to fall inside the window.
  //
  // Cutting the events themselves looks equivalent and is not: a change that began
  // the day before the window opens loses the move that started it, and its first
  // pass is then measured from whatever it did next. That reports "0m to the first
  // review" for work that took two days, which is worse than reporting nothing.
  // A change belongs to the window it began in, whole, or it is left out.
  const all = new Map();
  for (const e of events) {
    const ts = Date.parse(e.t);
    if (!ts) continue;
    if (!all.has(e.change)) all.set(e.change, []);
    all.get(e.change).push({ ...e, ts });
  }
  const byChange = new Map();
  for (const [change, list] of all) {
    let first = Infinity;
    for (const e of list) if (e.ts < first) first = e.ts;
    if (first >= from) byChange.set(change, list);
  }

  const rows = [];
  for (const [change, list] of byChange) {
    list.sort((a, b) => a.ts - b.ts);
    const firstDoing = list.find((e) => e.to === 'doing');
    if (!firstDoing) continue;                    // never started: backlog, not cost
    const firstVerify = list.find((e) => e.to === 'verify' && e.ts >= firstDoing.ts);

    // Returns from review, and the reviews themselves.
    const iterations = list.filter((e) => e.from === 'verify' && e.to === 'doing').length;
    const reviewCycles = list.filter((e) => e.to === 'verify').length;

    // Tasks of this change that were created after the first version was shown —
    // the work nobody knew about when the estimate was given.
    // A task withdrawn before it ever landed is not a discovery — somebody wrote it
    // and thought better of it. One deleted *after* reaching done is ordinary tidying
    // and still counts: it was real work.
    const withdrawn = new Set();
    for (const e of list) if (e.to === null) withdrawn.add(e.task);
    for (const e of list) if (e.to === 'done') withdrawn.delete(e.task);
    const late = firstVerify
      ? new Set(list.filter((e) => e.from === null && e.ts > firstVerify.ts && !withdrawn.has(e.task))
          .map((e) => e.task)).size
      : 0;

    // The last landing that stuck: a done with nothing after it.
    let settled = null;
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].to === 'done') { settled = list[i]; break; }
      if (list[i].from === 'done') { settled = null; break; }
    }

    // Which areas of the product this change reached, taken off its own events so
    // the record stays readable after the tasks are gone.
    const areas = new Set();
    for (const e of list) for (const a of (e.areas || [])) areas.add(a);

    const upToFirst = list.filter((e) => firstVerify ? e.ts <= firstVerify.ts : true).map((e) => e.ts);
    const afterFirst = firstVerify
      ? list.filter((e) => e.ts >= firstVerify.ts && (!settled || e.ts <= settled.ts)).map((e) => e.ts)
      : [];

    const fp = workedMs(upToFirst.filter((t) => t >= firstDoing.ts), cutoffMs);
    const af = workedMs(afterFirst, cutoffMs);

    rows.push({
      change, areas: [...areas],
      tasks: new Set(list.map((e) => e.task)).size,
      firstPassMs: fp.ms,
      afterFirstPassMs: af.ms,
      // What the cutoff refused to count, kept beside the number it shaped.
      droppedGaps: fp.dropped + af.dropped,
      droppedMs: fp.droppedMs + af.droppedMs,
      // Minutes as well as milliseconds: every reader of a row wants minutes, and a
      // row that reports raw milliseconds under a column headed "First pass" rounds
      // to a confident zero.
      get firstPassMinutes() { return Math.round(this.firstPassMs / 60000); },
      get afterFirstPassMinutes() { return Math.round(this.afterFirstPassMs / 60000); },
      iterations, reviewCycles, lateDiscoveries: late,
      reachedVerify: !!firstVerify,
      settled: !!settled,
      startedAt: new Date(firstDoing.ts).toISOString(),
    });
  }

  const n = rows.length;
  const sum = (f) => rows.reduce((a, r) => a + f(r), 0);
  const clean = rows.filter((r) => r.iterations === 0 && r.reachedVerify).length;

  return {
    periodDays, idleCutoffHours,
    changes: n,
    firstPassMinutes: Math.round(sum((r) => r.firstPassMs) / 60000),
    afterFirstPassMinutes: Math.round(sum((r) => r.afterFirstPassMs) / 60000),
    iterationsPerChange: n ? Math.round((sum((r) => r.iterations) / n) * 10) / 10 : 0,
    reviewCycles: sum((r) => r.reviewCycles),
    lateDiscoveries: sum((r) => r.lateDiscoveries),
    // What the cutoff threw away, so the timers above can be read knowing it.
    droppedGaps: sum((r) => r.droppedGaps),
    droppedMinutes: Math.round(sum((r) => r.droppedMs) / 60000),
    // Only over changes that got as far as a review: a change still in its first
    // pass has not passed or failed anything yet.
    firstPassRatio: rows.filter((r) => r.reachedVerify).length
      ? Math.round((clean / rows.filter((r) => r.reachedVerify).length) * 100) / 100
      : 0,
    rows,
  };
}

/**
 * Where the time after the first pass concentrates, by area of the product.
 *
 * By area, never by person. The map from a change to an area comes from the ids
 * its tasks declared in `Touches:`, so it says "returns cost 29h", never "Pyotr
 * cost 29h" — and there is no cut in this file, in the API, or in the export
 * that could say the second thing.
 */
export function byArea(rows, names = {}) {
  const acc = new Map();
  for (const r of rows) {
    // A change spanning two areas counts once in each: it cost both of them. Splitting
    // the time between them would make the column sum to less than the total and
    // invite the reading that some of the hours went nowhere.
    for (const a of (r.areas || [])) {
      const cur = acc.get(a) || { ms: 0, changes: 0 };
      cur.ms += r.afterFirstPassMs; cur.changes++;
      acc.set(a, cur);
    }
  }
  return [...acc.entries()]
    .map(([area, v]) => ({ area, name: names[area] || area,
      afterFirstPassMinutes: Math.round(v.ms / 60000), changes: v.changes }))
    .sort((a, b) => b.afterFirstPassMinutes - a.afterFirstPassMinutes);
}

/**
 * How many people worked in this repository over the period — the number only.
 *
 * The event log deliberately carries no author, so this cannot be counted from
 * it, and it should not be: the promise is that the audit cuts work by process
 * and by area, never by person. But "four developers" is what makes "105 hours
 * after the first pass" mean anything, so the count is taken from git at the
 * moment it is asked for, and only ever as a count. No name is stored, sent, or
 * shown anywhere.
 */
export function developerCount(projectPath, periodDays = 30) {
  try {
    const out = execFileSync('git', ['log', `--since=${periodDays}.days.ago`, '--format=%aE'],
      { cwd: projectPath, encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] });
    const set = new Set();
    for (const line of out.split('\n')) { const e = line.trim().toLowerCase(); if (e) set.add(e); }
    return set.size;
  } catch { return 0; }
}
