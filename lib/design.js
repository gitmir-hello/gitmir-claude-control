// What the product should become, drawn before it exists.
//
// The model says what the product is, read out of the code. A design says what
// somebody decided it should be, and it is written in exactly the same shapes —
// same dimensions, same id prefixes, same relationship fields. That is the whole
// trick: because a design is model-shaped, every piece of machinery already here
// works on it. The map draws it. The radius walks it. The comparison that reports
// how the model changed between two commits reports, unchanged, how much of the
// design exists yet.
//
// The alternative was a drawing tool. A drawing tool produces boxes with no
// meaning, and nothing downstream can check anything against a box. This produces
// declarations — "this function writes that field" — and a declaration is
// checkable the moment the code catches up with it.
//
// Positions are not stored, on purpose. The product's own rule is that nothing on
// a diagram is hand-placed: a picture somebody can drag into a preferred shape can
// be made to say anything. You add elements and say what moves between them; the
// layout is computed from that, as it is for the model.

import fs from 'node:fs';
import path from 'node:path';
import { DIMENSIONS } from './read.js';
import { kindOf, objById, labelOf } from './impact.js';

const DIR = ['.gitmir', 'design'];
const dirOf = (p) => path.join(p, ...DIR);

/** Which dimension a kind lives in, and which prefix its ids take. */
export const DIM_OF_KIND = {
  module: 'modules', entity: 'entities', serverUnit: 'serverUnits', function: 'serverFunctions',
  route: 'apiRoutes', frontend: 'frontendUnits', event: 'events', process: 'processes',
  statusFlow: 'statusFlows', reaction: 'reactions',
};
export const PREFIX_OF_KIND = {
  module: 'mod', entity: 'ent', serverUnit: 'su', function: 'sf', route: 'rt',
  frontend: 'fe', event: 'ev', process: 'proc', statusFlow: 'sfw', reaction: 'rx',
};

/**
 * The links a design can declare, in the words somebody would use out loud.
 *
 * Each names the field it writes into, so a declaration lands in the same place
 * the model keeps the same fact — and the comparison is then a plain lookup
 * rather than a special case.
 */
export const LINKS = [
  { key: 'writes',   label: 'writes',        from: ['function'],            to: ['field'],    field: 'writesFieldIds',    list: true },
  { key: 'reads',    label: 'reads',         from: ['function'],            to: ['field'],    field: 'readsFieldIds',     list: true },
  { key: 'calls',    label: 'calls',         from: ['function'],            to: ['function'], field: 'callsFunctionIds',  list: true },
  { key: 'raises',   label: 'raises',        from: ['function', 'frontend'], to: ['event'],   field: 'emitsEventIds',     list: true },
  { key: 'handles',  label: 'handles',       from: ['function', 'frontend'], to: ['event'],   field: 'subscribesEventIds',list: true },
  { key: 'serves',   label: 'answers',       from: ['function'],            to: ['route'],    field: 'routeId',           list: false },
  { key: 'consumes', label: 'calls endpoint',from: ['frontend'],            to: ['route'],    field: 'consumesRouteIds',  list: true },
  { key: 'depends',  label: 'depends on',    from: ['frontend'],            to: ['frontend'], field: 'dependsOn',         list: true },
];

const safe = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);

/** An id for a new element, not colliding with the model or with the design. */
export function newId(kind, name, taken) {
  const p = PREFIX_OF_KIND[kind] || 'sf';
  let base = `${p}-${safe(name) || 'new'}`;
  if (!taken.has(base)) return base;
  for (let i = 2; i < 200; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
  return `${base}-${Date.now().toString(36)}`;
}

/** Everything declared for this project, oldest first. */
export function readDesign(projectPath) {
  let names = [];
  try { names = fs.readdirSync(dirOf(projectPath)).filter((f) => f.endsWith('.json')); }
  catch { return { ok: false, items: [] }; }
  const items = [];
  for (const n of names) {
    let o;
    try { o = JSON.parse(fs.readFileSync(path.join(dirOf(projectPath), n), 'utf8')); } catch { continue; }
    if (!o || !o.id || !o.dim) continue;
    o.object = o.object || {};
    o.object.id = o.id;
    items.push(o);
  }
  items.sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));
  return { ok: true, items };
}

/** Write one declaration, replacing it if the id is already declared. */
export function writeItem(projectPath, item) {
  const kind = kindOf(item.id) || '';
  const dim = item.dim || DIM_OF_KIND[kind];
  if (!dim || !DIMENSIONS.includes(dim)) return { ok: false, why: `Unknown kind for ${item.id}` };
  const name = String((item.object && item.object.name) || '').trim();
  if (!name && dim !== 'apiRoutes') return { ok: false, why: 'An element needs a name — it is what everything else refers to.' };

  const rec = {
    id: item.id, dim,
    object: { ...(item.object || {}), id: item.id },
    note: String(item.note || '').trim(),
    at: item.at || new Date().toISOString(),
  };
  try {
    fs.mkdirSync(dirOf(projectPath), { recursive: true });
    fs.writeFileSync(path.join(dirOf(projectPath), `${item.id}.json`), JSON.stringify(rec, null, 2) + '\n');
  } catch (e) { return { ok: false, why: String(e && e.message || e) }; }
  return { ok: true, item: rec };
}

export function removeItem(projectPath, id) {
  try { fs.unlinkSync(path.join(dirOf(projectPath), `${String(id).replace(/[^a-z0-9-]/gi, '')}.json`)); return { ok: true }; }
  catch (e) { return { ok: false, why: String(e && e.message || e) }; }
}

/**
 * The design as a model.
 *
 * Same shape in, same shape out — which is why the map, the radius and the
 * version comparison need to know nothing about designs to work on one.
 */
export function designAsModel(items) {
  const m = {};
  for (const d of DIMENSIONS) m[d] = [];
  for (const it of items) (m[it.dim] || (m[it.dim] = [])).push(it.object);
  return m;
}

/** Every id the model or the design has already spoken for. */
export function takenIds(model, items) {
  const t = new Set();
  for (const d of DIMENSIONS) for (const o of (model[d] || [])) {
    if (o && o.id) t.add(o.id);
    for (const f of (o && o.fields) || []) if (f && f.id) t.add(f.id);
  }
  for (const it of items) t.add(it.id);
  return t;
}

/**
 * How much of what was drawn actually exists.
 *
 * Per element: is it in the model at all, and does every relationship it declared
 * hold there? A relationship the design asserts and the code does not have is the
 * useful half — it is the difference between "we built it" and "we built the
 * thing we drew".
 */
export function conformance(items, model) {
  const rows = [];
  for (const it of items) {
    const real = objById(it.id, model);
    const links = [];
    for (const L of LINKS) {
      const want = it.object[L.field];
      if (!want) continue;
      const list = L.list ? (Array.isArray(want) ? want : [want]) : [want];
      for (const target of list) {
        if (!target) continue;
        let held = false;
        if (real) {
          const got = real[L.field];
          held = L.list ? (Array.isArray(got) && got.includes(target)) : got === target;
        }
        links.push({ kind: L.key, label: L.label, to: target, held });
      }
    }
    const state = !real ? 'missing'
      : links.some((l) => !l.held) ? 'differs'
      : 'present';
    rows.push({
      id: it.id, dim: it.dim, name: it.object.name || it.id,
      note: it.note, state, links,
      missingLinks: links.filter((l) => !l.held).length,
    });
  }
  const n = (s) => rows.filter((r) => r.state === s).length;
  return {
    rows,
    total: rows.length,
    present: n('present'), differs: n('differs'), missing: n('missing'),
  };
}

/**
 * Tasks from a design.
 *
 * One task per element that is not there yet, carrying the ids it touches and —
 * the part that matters — checks written from the declared relationships. A task
 * generated this way cannot be called done just because code appeared: the
 * relationship it declared has to be in the rebuilt model.
 */
export function tasksFrom(items, model) {
  const c = conformance(items, model);
  const out = [];
  for (const r of c.rows) {
    if (r.state === 'present') continue;
    const it = items.find((x) => x.id === r.id);
    const touches = [r.id, ...r.links.map((l) => l.to)].filter(Boolean);
    const verify = [
      r.state === 'missing'
        ? `\`${r.id}\` exists in .gitmir/model after a rebuild`
        : `\`${r.id}\` still exists in .gitmir/model after a rebuild`,
      ...r.links.filter((l) => !l.held).map((l) =>
        `the model records that ${labelOf(r.id, model) || r.name} ${l.label} ${labelOf(l.to, model) || l.to}`),
      'the Design view reports this element as present, not missing or differing',
    ];
    out.push({
      title: r.state === 'missing' ? `Build ${r.name}` : `Finish ${r.name}`,
      id: r.id,
      body: [
        it && it.note ? it.note : `Declared on the product map as ${r.dim.replace(/s$/, '')}.`,
        '',
        r.links.length ? 'It has to end up doing this:' : '',
        ...r.links.map((l) => `- ${l.label} \`${l.to}\`${l.held ? '  (already true)' : ''}`),
      ].filter((x) => x !== '').join('\n'),
      touches, verify,
    });
  }
  return out;
}
