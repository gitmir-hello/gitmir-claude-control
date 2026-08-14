// Where the code does not do what the product says it does.
//
// A finding is not a task and not part of the model.
//
// Not a task, because a task is work somebody intends to do. A finding is a fact
// about the product that stays true until it is closed, and a good half of them
// are never worked at all — they are accepted, deliberately, by somebody who
// writes down why. That decision is the artifact worth keeping.
//
// Not part of the model, because the model is derived from code and rebuilt
// whole. A rebuild on a real project dropped an entity, an area and two
// lifecycles; putting a person's judgement in the same file would eventually
// throw it away too. The model answers "what does the product do". A finding
// answers "what was it supposed to do, and does not". Different provenance,
// different lifetime, different file.
//
// One file per finding, so two people flagging at once do not collide in git and
// each finding carries its own history.

import fs from 'node:fs';
import path from 'node:path';

const DIR = ['.gitmir', 'findings'];

export const KINDS = ['contradicts-spec', 'not-implemented', 'undefined', 'risk'];
export const SEVERITIES = ['high', 'medium', 'low'];
export const STATUSES = ['open', 'accepted', 'fixed'];

const dirOf = (projectPath) => path.join(projectPath, ...DIR);

/**
 * @typedef {{by:string, why:string, at:string}} Decision
 * @typedef {{id:string, rule:string, actual:string, consequence:string, source:string,
 *   touches:string[], kind:string, severity:string, status:string, readFrom:string[],
 *   checkedAt:string, foundAt:string, decision:Decision|null,
 *   stale?:boolean, movedFile?:string|null}} Finding
 */

/** Ids are file names, so they must not be able to name a file somewhere else. */
export function safeId(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 72);
}

// A short, stable fingerprint of the rule. Ids are file names, so they stay
// ascii — and a product written in Russian yields no latin words at all, where
// naming the file after the object it sits on would make the second finding on
// that object silently overwrite the first.
function fingerprint(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36).slice(0, 6);
}

function idFrom(rule, touches) {
  const words = String(rule || '').toLowerCase().match(/[a-z][a-z0-9]{2,}/g) || [];
  const latin = safeId(words.slice(0, 5).join('-'));
  if (latin.length >= 8) return latin;
  const on = safeId((touches && touches[0]) || '') || 'finding';
  return `${on}-${fingerprint(String(rule || ''))}`;
}

/**
 * Every finding recorded for this project, newest first.
 *
 * Staleness is per finding, not per project: a finding asserts "this file does
 * X", and only that file moving casts doubt on it. Marking every finding stale
 * because some unrelated file changed would train people to ignore the mark.
 */
/** @returns {{ok:boolean, dir:string, findings:Finding[]}} */
export function readFindings(projectPath) {
  const dir = dirOf(projectPath);
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); }
  catch { return { ok: false, dir, findings: [] }; }

  /** @type {Finding[]} */
  const findings = [];
  for (const name of names) {
    let raw;
    try { raw = fs.readFileSync(path.join(dir, name), 'utf8'); } catch { continue; }
    let o;
    try { o = JSON.parse(raw); } catch { continue; }
    if (!o || typeof o !== 'object') continue;
    o.id = o.id || name.replace(/\.json$/, '');
    o.touches = Array.isArray(o.touches) ? o.touches : [];
    o.readFrom = Array.isArray(o.readFrom) ? o.readFrom : [];
    o.status = STATUSES.includes(o.status) ? o.status : 'open';
    o.kind = KINDS.includes(o.kind) ? o.kind : 'contradicts-spec';
    o.severity = SEVERITIES.includes(o.severity) ? o.severity : 'medium';

    // A finding claims the code does something. When the file it was read from
    // has moved since it was checked, the claim is not wrong — it is unverified,
    // which is a different thing and has to be said differently.
    const checked = Date.parse(o.checkedAt || '') || 0;
    let moved = null;
    if (checked && o.readFrom.length) {
      for (const rel of o.readFrom) {
        let st;
        try { st = fs.statSync(path.join(projectPath, rel)); } catch { continue; }
        if (st.mtimeMs > checked + 1000) { moved = rel; break; }
      }
    }
    o.stale = !!moved;
    o.movedFile = moved;
    findings.push(o);
  }
  findings.sort((a, b) => String(b.checkedAt || '').localeCompare(String(a.checkedAt || '')));
  return { ok: true, dir, findings };
}

/** Findings by the model id they sit on, so a view can mark an object in one lookup. */
export function findingsByTarget(findings) {
  /** @type {Map<string, Finding[]>} */
  const by = new Map();
  for (const f of findings) {
    for (const id of f.touches) {
      if (!by.has(id)) by.set(id, []);
      by.get(id).push(f);
    }
  }
  return by;
}

/**
 * Only the ones still asserting a problem — accepted and fixed are decided.
 * @param {Finding[]} findings @returns {Finding[]}
 */
export const openOnly = (findings) => findings.filter((f) => f.status === 'open');

/**
 * Record one, or update it in place when the id already exists.
 *
 * Refuses without `rule` and `actual`: a finding that says only "this is wrong"
 * cannot be checked by the next person, and cannot be closed by anyone.
 */
/** @returns {{ok:true, finding:Finding, file:string, updated:boolean}|{ok:false, why:string}} */
export function writeFinding(projectPath, input) {
  const rule = String(input.rule || '').trim();
  const actual = String(input.actual || '').trim();
  if (!rule) return { ok: false, why: 'A finding needs `rule` — what the product is supposed to do, in the product\'s own words.' };
  if (!actual) return { ok: false, why: 'A finding needs `actual` — what the code does instead. Without it nobody can check or close it.' };

  const touches = (Array.isArray(input.touches) ? input.touches : []).map(String).filter(Boolean);
  const id = safeId(input.id) || idFrom(rule, touches);
  const dir = dirOf(projectPath);
  try { fs.mkdirSync(dir, { recursive: true }); } catch { return { ok: false, why: `Cannot create ${dir}` }; }
  const file = path.join(dir, id + '.json');

  let existing = null;
  try { existing = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}

  // A full timestamp, not a date: midnight is always earlier than the moment the
  // finding was written, so a date would mark every finding stale on creation.
  const now = new Date().toISOString();
  const rec = {
    id,
    rule,
    actual,
    consequence: String(input.consequence || '').trim(),
    source: String(input.source || '').trim(),
    touches,
    kind: KINDS.includes(input.kind) ? input.kind : 'contradicts-spec',
    severity: SEVERITIES.includes(input.severity) ? input.severity : 'medium',
    status: existing && STATUSES.includes(existing.status) ? existing.status : 'open',
    readFrom: (Array.isArray(input.readFrom) ? input.readFrom : []).map(String).filter(Boolean),
    checkedAt: now,
    foundAt: (existing && existing.foundAt) || now,
    decision: (existing && existing.decision) || null,
  };
  try { fs.writeFileSync(file, JSON.stringify(rec, null, 2) + '\n', 'utf8'); }
  catch (e) { return { ok: false, why: String(e && e.message || e) }; }
  return { ok: true, finding: rec, file, updated: !!existing };
}

/**
 * Move a finding to accepted or fixed.
 *
 * Accepting requires a reason and a name. An accepted deviation with nobody
 * attached is indistinguishable from one everybody forgot about, and the whole
 * value of the record is that somebody can be asked about it later.
 */
/** @returns {{ok:true, finding:Finding}|{ok:false, why:string}} */
export function setFindingStatus(projectPath, id, status, decision) {
  if (!STATUSES.includes(status)) return { ok: false, why: `status must be one of ${STATUSES.join(', ')}` };
  const file = path.join(dirOf(projectPath), safeId(id) + '.json');
  let rec;
  try { rec = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { ok: false, why: `No finding ${id}` }; }

  if (status === 'accepted') {
    const by = String((decision && decision.by) || '').trim();
    const why = String((decision && decision.why) || '').trim();
    if (!by || !why) {
      return { ok: false, why: 'Accepting a deviation needs `by` and `why` — a decision nobody signed is one everybody forgot.' };
    }
    rec.decision = { by, why, at: new Date().toISOString().slice(0, 10) };
  } else if (status === 'fixed') {
    rec.decision = null;
  }
  rec.status = status;
  try { fs.writeFileSync(file, JSON.stringify(rec, null, 2) + '\n', 'utf8'); }
  catch (e) { return { ok: false, why: String(e && e.message || e) }; }
  return { ok: true, finding: rec };
}

/** A one-line count for anywhere that has room for one line. */
export function findingsSummary(findings) {
  const open = openOnly(findings);
  return {
    total: findings.length,
    open: open.length,
    high: open.filter((f) => f.severity === 'high').length,
    accepted: findings.filter((f) => f.status === 'accepted').length,
    fixed: findings.filter((f) => f.status === 'fixed').length,
    stale: open.filter((f) => f.stale).length,
  };
}
