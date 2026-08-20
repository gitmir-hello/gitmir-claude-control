// What the object context says needs a person, right now.
//
// The model already knows more than anyone reads out of it: that the code has
// moved past it, that a finding describes a file which has since changed, that a
// planned task reaches two areas while its ticket named one, that nobody owns a
// third of the product. Every one of those is derivable, and every one of them
// was sitting in a view somebody had to think to open.
//
// So it is derived here instead, continuously, and each item carries the one
// action that answers it. That is the honest form of "it does it by itself": the
// system does the noticing, a person still does the deciding. A governance tool
// that quietly acts on its own findings is a tool nobody can defend in an audit.
//
// Ordered by what it costs to ignore, not by how easy it is to compute.

import { blastRadius, riskOf, moduleOf, kindOf } from './impact.js';
import { readFindings, openOnly } from './findings.js';
import { readDesign, conformance } from './design.js';

/**
 * @typedef {{key:string, level:'act'|'check'|'note', title:string, why:string,
 *   action:{label:string, go:string, arg?:string}, n?:number}} Item
 * @typedef {{col:string, file:string, title:string, ids:string[], declared:boolean,
 *   approved:string|null, mtime:number, n:number}} Task
 */

/**
 * Everything worth a person's attention, worst first.
 *
 * Takes what the caller already loaded rather than reading again: this runs on
 * every visit to the first screen, and re-walking a repository to render a list
 * would make the fastest claim in the product the slowest page in it.
 */
/** @param {{projectPath:string, model:any, exists:boolean, stale?:boolean, staleFile?:string, tasks?:Task[]}} a @returns {Item[]} */
export function attention({ projectPath, model, exists, stale = false, staleFile = '', tasks = [] }) {
  /** @type {Item[]} */
  const out = [];

  if (!exists) {
    out.push({
      key: 'no-model', level: 'act',
      title: 'There is no object context yet',
      why: 'Everything else here answers from it — impact, deviations, the context your agent reads.',
      action: { label: 'Build it', go: 'build-model' },
    });
    return out;
  }

  // --- the model no longer describes the code ------------------------------
  // First, because every other number on the screen is quoted from it.
  if (stale) {
    out.push({
      key: 'stale-model', level: 'act',
      title: 'Your code has changed since the map was made',
      why: `${staleFile ? staleFile + ' changed most recently. ' : ''}Anything you read here is about the product as it was, not as it is now. Ask your assistant to refresh the map.`,
      action: { label: 'Rebuild it', go: 'build-model' },
    });
  }

  // --- findings whose ground shifted ---------------------------------------
  const F = readFindings(projectPath).findings;
  const open = openOnly(F);
  const staleFindings = open.filter((f) => f.stale);
  if (staleFindings.length) {
    out.push({
      key: 'stale-findings', level: 'check', n: staleFindings.length,
      title: `${staleFindings.length} recorded deviation${staleFindings.length > 1 ? 's need' : ' needs'} re-checking`,
      why: 'The code they were found in has changed since. A confident answer about code that moved is worse than no answer.',
      action: { label: 'Re-check them', go: 'spec' },
    });
  }
  const undecided = open.filter((f) => !f.stale && f.severity === 'high');
  if (undecided.length) {
    out.push({
      key: 'high-findings', level: 'act', n: undecided.length,
      title: `${undecided.length} place${undecided.length > 1 ? 's where' : ' where'} your product does something other than what you promised`,
      why: 'These matter. Either somebody fixes them, or somebody decides to live with them — and that decision gets written down here.',
      action: { label: 'Look at them', go: 'spec' },
    });
  }

  // --- planned work that reaches further than its ticket admits ------------
  // The cheapest thing this product does: the gap between what a ticket named
  // and what the model says it touches, found before anyone writes code.
  const planned = tasks.filter((t) => t.col !== 'done' && t.ids && t.ids.length);
  const wide = [];
  for (const t of planned) {
    let br;
    try { br = blastRadius(t.ids, model); } catch { continue; }
    const reached = br.dist ? br.dist.size : 0;
    const areas = (br.modules || []).length;
    const homeAreas = new Set(t.ids.map((id) => moduleOf(id, model)).filter(Boolean));
    if (reached > t.ids.length * 2 || areas > homeAreas.size) {
      wide.push({ t, reached, areas, named: t.ids.length, risk: riskOf(br, model) });
    }
  }
  if (wide.length) {
    const w = wide.sort((a, b) => b.risk.share - a.risk.share)[0];
    out.push({
      key: 'wide-task', level: 'act', n: wide.length,
      title: `${wide.length} planned task${wide.length > 1 ? 's reach' : ' reaches'} further than the ticket says`,
      why: `"${w.t.title}" names ${w.named} object${w.named > 1 ? 's' : ''} and touches ${w.reached} across ${w.areas} area${w.areas > 1 ? 's' : ''} — ${w.risk.level.toUpperCase()}, ${Math.round(w.risk.share * 100)}% of the product.`,
      action: { label: 'See what it reaches', go: 'impact', arg: w.t.file },
    });
  }

  // --- what was drawn and is not there ---------------------------------------
  // The design is a decision somebody already made. An element declared and never
  // built is not a gap in the model, it is work nobody started.
  const design = readDesign(projectPath).items;
  if (design.length) {
    const c = conformance(design, model);
    if (c.missing) {
      out.push({
        key: 'design-missing', level: 'act', n: c.missing,
        title: `${c.missing} declared element${c.missing > 1 ? 's are' : ' is'} not built yet`,
        why: 'You drew these on the map as things your product should have. Turn them into work and the checks get written from your drawing.',
        action: { label: 'See the design', go: 'design' },
      });
    }
    if (c.differs) {
      out.push({
        key: 'design-differs', level: 'check', n: c.differs,
        title: `${c.differs} element${c.differs > 1 ? 's do' : ' does'} not do everything that was declared`,
        why: 'The code exists, and the model does not record every relationship the design asked for. That gap is the difference between building something and building the thing that was drawn.',
        action: { label: 'See what is missing', go: 'design' },
      });
    }
  }

  // --- work waiting on a decision ------------------------------------------
  const unapproved = tasks.filter((t) => t.col === 'todo' && !t.approved && t.ids && t.ids.length);
  if (unapproved.length) {
    out.push({
      key: 'unapproved', level: 'check', n: unapproved.length,
      title: `${unapproved.length} task${unapproved.length > 1 ? 's are' : ' is'} queued without an approval`,
      why: 'Nobody has said yes to these yet. Your assistant is told to ask before starting work nobody approved.',
      action: { label: 'Look at the work', go: 'queue' },
    });
  }

  // --- nobody answers for part of the product -------------------------------
  const mods = model.modules || [];
  const orphan = mods.filter((m) => m && !m.owner);
  if (orphan.length) {
    out.push({
      key: 'no-owner', level: 'note', n: orphan.length,
      title: `${orphan.length} of ${mods.length} areas have no owner`,
      why: 'When something goes wrong here, nobody knows who to ask, and a change here has nobody to check it.',
      action: { label: 'Show me', go: 'ownership' },
    });
  }

  // --- nothing has ever been checked against the written rules --------------
  if (!F.length) {
    out.push({
      key: 'never-audited', level: 'note',
      title: 'Nobody has checked the code against what you promised',
      why: 'When the code and the plan quietly disagree, you usually find out in front of a customer. This finds it first and writes it down.',
      action: { label: 'Check it now', go: 'skill', arg: 'spec-audit' },
    });
  }

  const rank = { act: 0, check: 1, note: 2 };
  return out.sort((a, b) => rank[a.level] - rank[b.level]);
}

/**
 * What the model caught before it shipped.
 *
 * Distinct sets, not sums. Twenty tasks each reaching the same forty objects is
 * forty objects, not eight hundred — and a number that counts them eight hundred
 * times is the kind that gets picked apart in the first minute of a review.
 */
/** @param {{model:any, tasks?:Task[]}} a */
export function caught({ model, tasks = [] }) {
  const named = new Set(), reached = new Set();
  let n = 0, high = 0;
  for (const t of tasks) {
    if (!t.ids || !t.ids.length) continue;
    let br;
    try { br = blastRadius(t.ids, model); } catch { continue; }
    n++;
    for (const id of t.ids) named.add(id);
    // Fields ride in the radius and are not objects; counting them would report
    // more things reached than the model contains, which reads as a bug.
    if (br.dist) for (const id of br.dist.keys()) if (kindOf(id) !== 'field') reached.add(id);
    try { if (riskOf(br, model).level === 'high') high++; } catch {}
  }
  const unnamed = [...reached].filter((id) => !named.has(id));
  return { tasks: n, named: named.size, reached: reached.size, unnamed: unnamed.length, high };
}

/** The one skill that fits where this project actually is. */
/** @param {{exists:boolean, stale?:boolean, model?:any, tasks?:Task[], findings?:number, sourceFiles?:number}} a */
export function nextSkill({ exists, stale, model, tasks = [], findings = 0, sourceFiles = 0 }) {
  if (!exists) {
    // A repository too large to read in one pass needs the fragmenting variant,
    // and finding that out after a failed pass is an expensive way to learn it.
    return sourceFiles > 600
      ? { name: 'model-ingest', why: 'This repository is large — build the model in fragments rather than one pass.' }
      : { name: 'gitmir-model', why: 'Read the repository once and write what the product is.' };
  }
  if (stale) return { name: 'gitmir-model', why: 'The code has moved past the model. One more pass brings it back.' };
  if (!findings) return { name: 'spec-audit', why: 'Read the written rules against the code and record where they disagree.' };
  const todo = tasks.filter((t) => t.col === 'todo').length;
  const running = tasks.filter((t) => t.col === 'inprogress' || t.col === 'verify').length;
  if (running) return { name: 'task-runner', why: 'Work is in flight. Run the queue to empty, checks and all.' };
  if (todo) return { name: 'task-runner', why: `${todo} task${todo > 1 ? 's are' : ' is'} queued and nothing is running them.` };
  return { name: 'task-planner', why: 'Turn what you found into tasks that carry their own checks.' };
}
