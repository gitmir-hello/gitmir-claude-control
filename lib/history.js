// How the product changed — read out of the versions the project already has.
//
// A model is rebuilt as the code moves, and every rebuild overwrites the last
// one. Without a record of that, two things are invisible: how the business
// logic drifted over a quarter, and whether a rebuild quietly lost something.
// The second is not hypothetical — a rebuild on a real project dropped an
// entity, an area and two lifecycles, and nobody could have known.
//
// We do not store versions. A project that commits .gitmir/model/ already has
// them, dated, and attached to the work that caused each one: the commit
// message says what was being done. Building a second store would duplicate
// that, need migrating, and — worse — would start empty, where git starts with
// the project's whole life already in it.
//
// Node-side only: it shells out to git.

import { execFile } from 'node:child_process';
import path from 'node:path';
import { DIMENSIONS } from './read.js';
import { kindOf } from './impact.js';

const MODEL_DIR = '.gitmir/model';

function git(cwd, args) {
  return new Promise((resolve) => {
    // No shell: arguments go straight to git, so a path with a space or a
    // semicolon in it is a path, not a command.
    execFile('git', args, { cwd, maxBuffer: 24 * 1024 * 1024, timeout: 15000 },
      (err, stdout) => resolve(err ? null : stdout));
  });
}

/**
 * The versions of the model this project has, newest first. Empty when the
 * project is not in git, or when .gitmir/ is ignored — which is a real answer,
 * not a failure: it tells the reader why there is no history to show.
 */
export async function modelVersions(projectPath, limit = 60) {
  const inRepo = await git(projectPath, ['rev-parse', '--is-inside-work-tree']);
  if (!inRepo || inRepo.trim() !== 'true') return { ok: false, why: 'not-a-repo', versions: [] };

  const ignored = await git(projectPath, ['check-ignore', MODEL_DIR]);
  if (ignored && ignored.trim()) return { ok: false, why: 'ignored', versions: [] };

  const out = await git(projectPath, [
    'log', `--max-count=${Math.max(1, Math.min(500, limit))}`,
    '--date=short', '--format=%H%x1f%ad%x1f%an%x1f%s', '--', MODEL_DIR,
  ]);
  if (out == null) return { ok: false, why: 'git-failed', versions: [] };

  const versions = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [sha, date, author, subject] = line.split('\x1f');
    if (sha) versions.push({ sha, short: sha.slice(0, 7), date, author, subject: subject || '' });
  }
  return { ok: versions.length > 0, why: versions.length ? '' : 'never-committed', versions };
}

/** The model as it stood at one version. Missing dimensions come back empty. */
export async function modelAt(projectPath, sha) {
  const model = {};
  for (const d of DIMENSIONS) {
    const raw = await git(projectPath, ['show', `${sha}:${MODEL_DIR}/${d}.json`]);
    let arr = [];
    if (raw) { try { const p = JSON.parse(raw); if (Array.isArray(p)) arr = p; } catch {} }
    model[d] = arr;
  }
  return model;
}

/**
 * Every link the model asserts between two objects, as a flat set of strings.
 *
 * This is what "the business logic changed" actually means: not that a file was
 * edited, but that the product now says a screen calls an endpoint it did not
 * call before, or that a function stopped writing an object. Comparing the sets
 * is the cheapest honest way to see it.
 */
function linkSet(m) {
  const out = new Set();
  const add = (a, kind, b) => { if (a && b) out.add(`${a}\x1f${kind}\x1f${b}`); };
  for (const e of (m.entities || [])) {
    for (const f of (e.fields || [])) if (f && f.refEntityId) add(e.id, 'references', f.refEntityId);
    for (const s of (e.derivedFrom || [])) add(e.id, 'derived-from', s);
  }
  for (const f of (m.serverFunctions || [])) {
    if (f.routeId) add(f.routeId, 'handled-by', f.id);
    for (const x of (f.callsFunctionIds || [])) add(f.id, 'calls', x);
    for (const x of (f.emitsEventIds || [])) add(f.id, 'raises', x);
    for (const x of (f.subscribesEventIds || [])) add(x, 'handled-by', f.id);
    for (const x of (f.writesFieldIds || [])) add(f.id, 'writes', x);
    for (const x of (f.readsFieldIds || [])) add(x, 'read-by', f.id);
  }
  for (const u of (m.frontendUnits || [])) {
    for (const x of (u.consumesRouteIds || [])) add(u.id, 'calls', x);
    for (const x of (u.dependsOn || [])) add(u.id, 'depends-on', x);
    for (const x of (u.emitsEventIds || [])) add(u.id, 'raises', x);
    for (const x of (u.subscribesEventIds || [])) add(x, 'handled-by', u.id);
  }
  for (const p of (m.processes || [])) for (const s of (p.steps || [])) if (s && s.refId) add(p.id, 'walks', s.refId);
  for (const fl of (m.statusFlows || [])) {
    if (fl.entityId) add(fl.id, 'governs', fl.entityId);
    for (const t of (fl.transitions || [])) for (const ef of (t.effects || [])) if (ef && ef.entityId) add(fl.id, 'affects', ef.entityId);
  }
  for (const r of (m.reactions || [])) for (const ef of (r.effects || [])) if (ef && ef.entityId) add(r.id, 'affects', ef.entityId);
  return out;
}

const nameOf = (o) => (o && (o.name || o.id)) || '';

/**
 * Every id either version knows, to its name.
 *
 * An object that was removed is, by definition, absent from the current model —
 * so the page cannot look its name up and would print the raw id. Ids are for
 * linking, not for reading: the reader is owed the word the product uses.
 */
function nameIndex(...models) {
  const names = new Map();
  for (const m of models) {
    for (const d of DIMENSIONS) {
      for (const o of (m[d] || [])) {
        if (!o || !o.id) continue;
        if (!names.has(o.id)) names.set(o.id, nameOf(o));
        // Fields carry their own ids and appear in links as often as objects do.
        for (const f of (o.fields || [])) if (f && f.id && !names.has(f.id)) names.set(f.id, f.name || f.id);
      }
    }
  }
  return names;
}

/**
 * What changed between two models, in the terms a person argues in.
 *
 * Renames are found by id, which is the whole reason ids are stable: without
 * them a rebuild that translates every name reads as the product being deleted
 * and replaced, and the one real deletion in it is lost in the noise.
 */
export function diffModels(before, after) {
  /** @type {{added:{id:string,dim:string,name:string}[], removed:{id:string,dim:string,name:string}[], renamed:{id:string,dim:string,from:string,to:string}[]}} */
  const objects = { added: [], removed: [], renamed: [] };
  /** @type {{dim:string,was:number,now:number,added:number,removed:number,renamed:number}[]} */
  const perDimension = [];

  for (const d of DIMENSIONS) {
    const oldById = new Map((before[d] || []).filter((o) => o && o.id).map((o) => [o.id, o]));
    const newById = new Map((after[d] || []).filter((o) => o && o.id).map((o) => [o.id, o]));
    let add = 0, rem = 0, ren = 0;
    for (const [id, o] of newById) {
      if (!oldById.has(id)) { objects.added.push({ id, dim: d, name: nameOf(o) }); add++; continue; }
      const was = oldById.get(id);
      if (nameOf(was) !== nameOf(o)) { objects.renamed.push({ id, dim: d, from: nameOf(was), to: nameOf(o) }); ren++; }
    }
    for (const [id, o] of oldById) if (!newById.has(id)) { objects.removed.push({ id, dim: d, name: nameOf(o) }); rem++; }
    if (add || rem || ren || oldById.size !== newById.size) {
      perDimension.push({ dim: d, was: oldById.size, now: newById.size, added: add, removed: rem, renamed: ren });
    }
  }

  // Lifecycles get their own reading: a state or a transition disappearing is a
  // rule the product no longer enforces, which is a different kind of news from
  // a function being renamed.
  /** @type {{id:string,name:string,statesAdded:string[],statesRemoved:string[],transAdded:string[],transRemoved:string[]}[]} */
  const lifecycles = [];
  const flowsBefore = new Map((before.statusFlows || []).filter((f) => f && f.id).map((f) => [f.id, f]));
  for (const f of (after.statusFlows || [])) {
    const was = flowsBefore.get(f && f.id);
    if (!was) continue;
    const sB = new Set((was.states || []).map((s) => s && s.key).filter(Boolean));
    const sA = new Set((f.states || []).map((s) => s && s.key).filter(Boolean));
    const trKey = (t) => `${t.from}>${t.to}`;
    const tB = new Set((was.transitions || []).map(trKey));
    const tA = new Set((f.transitions || []).map(trKey));
    const statesAdded = [...sA].filter((x) => !sB.has(x));
    const statesRemoved = [...sB].filter((x) => !sA.has(x));
    const transAdded = [...tA].filter((x) => !tB.has(x));
    const transRemoved = [...tB].filter((x) => !tA.has(x));
    if (statesAdded.length || statesRemoved.length || transAdded.length || transRemoved.length) {
      lifecycles.push({ id: f.id, name: nameOf(f), statesAdded, statesRemoved, transAdded, transRemoved });
    }
  }

  const lB = linkSet(before), lA = linkSet(after);
  const names = nameIndex(before, after);
  const linkRow = (s) => {
    const [a, kind, b] = s.split('\x1f');
    return { from: a, kind, to: b, fromName: names.get(a) || a, toName: names.get(b) || b };
  };
  const links = {
    added: [...lA].filter((x) => !lB.has(x)).map(linkRow),
    removed: [...lB].filter((x) => !lA.has(x)).map(linkRow),
  };

  // A removal is the finding worth surfacing: something the product used to say
  // it did and no longer does. Whether that is progress or a rebuild losing its
  // grip is a judgement, and the point is that somebody now gets to make it.
  const lost = objects.removed.filter((o) => ['entities', 'statusFlows', 'processes', 'modules'].includes(o.dim));

  return {
    objects, perDimension, lifecycles, links, lost,
    totals: {
      added: objects.added.length,
      removed: objects.removed.length,
      renamed: objects.renamed.length,
      linksAdded: links.added.length,
      linksRemoved: links.removed.length,
    },
  };
}

/** The ids a change touched, for lining up against what any task declared. */
export function idsInDiff(diff) {
  const out = new Set();
  for (const o of diff.objects.added) out.add(o.id);
  for (const o of diff.objects.removed) out.add(o.id);
  for (const o of diff.objects.renamed) out.add(o.id);
  for (const l of diff.lifecycles) out.add(l.id);
  for (const l of diff.links.added.concat(diff.links.removed)) {
    if (kindOf(l.from)) out.add(l.from);
    if (kindOf(l.to)) out.add(l.to);
  }
  return [...out];
}
