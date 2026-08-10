#!/usr/bin/env node
/**
 * GITMIR Claude Control — MCP server.
 *
 * The dashboard draws the product model for a person. This serves the same model,
 * as text, to whatever agent the developer already works in — Claude Code, Cursor,
 * anything that speaks MCP. Both read the same files on disk and share the same
 * arithmetic (lib/impact.js), so they cannot answer the same question differently.
 *
 * Transport is stdio, per the MCP spec: newline-delimited JSON-RPC on stdin/stdout,
 * UTF-8, and NOTHING on stdout that is not a protocol message. Every diagnostic
 * goes to stderr — a stray console.log here corrupts the stream and the client
 * silently loses the connection.
 *
 * Launch: the MCP client starts this as a subprocess. Nothing listens on a port,
 * nothing leaves the machine, and the dashboard does not need to be running.
 *
 *   node mcp.ts [--project <path>]
 *
 * Without --project it reads the working directory the client launched it in; every
 * tool also takes an explicit `project` argument, which wins.
 */

import fs from 'node:fs';
import path from 'node:path';
import { readModel, modelStaleness, modelIdSet, readTasks } from './lib/read.js';
import { createTask, setApproval, COLUMNS } from './lib/write.js';
import { blastRadius, riskOf, kindOf, labelOf, moduleOf, objById, isJourney } from './lib/impact.js';

const PROTOCOL = '2025-06-18';           // the version this server implements
const SUPPORTED = new Set([PROTOCOL, '2025-03-26', '2024-11-05']);
const NAME = 'gitmir-claude-control';
const VERSION = '1.0.0';

// ---------- project resolution ----------

function argProject(): string {
  const i = process.argv.indexOf('--project');
  const raw = i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : process.cwd();
  return path.resolve(raw);
}
const DEFAULT_PROJECT = argProject();

function projectOf(args: Record<string, unknown>): string {
  const p = typeof args.project === 'string' && args.project.trim() ? args.project.trim() : DEFAULT_PROJECT;
  return path.resolve(p);
}

// ---------- loading ----------

type Loaded = { ok: true; model: any; note: string } | { ok: false; text: string };

// The one honest answer when there is nothing to read. A tool that returns an empty
// result here reads as "the tool is broken" and gets uninstalled; this says what is
// missing and exactly how to fix it, which is the difference between losing the user
// and keeping them.
function noModel(project: string): Loaded {
  return {
    ok: false,
    text:
      `No GitMir model in ${project}.\n\n` +
      `This server answers from .gitmir/model/ — an id-linked map of the product ` +
      `(entities, server functions, API routes, screens, events, business processes, ` +
      `lifecycles) built from the code itself. That folder does not exist here yet.\n\n` +
      `To build it: open the gitmir-model skill from this repository ` +
      `(skills/gitmir-model.md) and follow it against this project. It reads the ` +
      `repository once and writes .gitmir/model/. After that every tool here works, ` +
      `and the dashboard (node server.ts) draws the same model.`,
  };
}

// Every answer carries how fresh the model is. In the dashboard a stale model is
// flagged by an amber banner above the diagram; here there is no banner and no
// dashboard — so the warning has to travel inside the answer, or a confident reply
// about a product as it was two weeks ago goes straight into someone's editor.
function load(project: string): Loaded {
  let read;
  try { read = readModel(project); } catch { return noModel(project); }
  if (!read.exists) return noModel(project);

  const built = read.builtAt ? `built ${String(read.builtAt).slice(0, 16).replace('T', ' ')}` : 'build time not recorded';
  let note = `Model: ${built}.`;
  try {
    const s = modelStaleness(project, read.writtenMs);
    if (s.stale) {
      note += ` STALE — ${s.changed} source file(s) changed since it was built` +
        (s.newestFile ? `, most recently ${s.newestFile}` : '') +
        `. Everything below describes the product as it was then. Re-run the gitmir-model skill to refresh it.`;
    } else if (s.scanned) {
      note += ` No source file has changed since (${s.scanned} scanned).`;
    } else {
      // Nothing to compare against is not the same as "verified current" — say which.
      note += ` No source files found here to compare it against, so freshness is unverified.`;
    }
  } catch {}
  return { ok: true, model: read.model, note };
}

// ---------- shaping answers ----------

const KIND_WORD: Record<string, string> = {
  entity: 'business object', function: 'server function', route: 'API endpoint',
  frontend: 'screen', event: 'event', process: 'business process',
  statusFlow: 'lifecycle', reaction: 'rule', serverUnit: 'server unit', module: 'area', field: 'field',
};

function describe(id: string, m: any): string {
  const o = objById(id, m);
  if (!o) return `${id} (not in the model)`;
  const mod = moduleOf(id, m);
  const bits = [KIND_WORD[kindOf(id) || ''] || kindOf(id)];
  if (mod) bits.push('in ' + labelOf(mod, m));
  return `${labelOf(id, m)} [${id}] — ${bits.join(', ')}` + (o.description ? `\n    ${String(o.description).slice(0, 220)}` : '');
}

function riskText(risk: any): string {
  const L = [`Business risk: ${risk.level.toUpperCase()} — reaches ${Math.round(risk.share * 100)}% of the product (${risk.score} of ${risk.max} points)`];
  for (const p of risk.parts) L.push(`  ${p.n} x ${p.w} = ${p.n * p.w}  ${p.l} — ${p.why}`);
  L.push(`  (share of product, not a raw score: the same points mean "most of it" in a small product and "a corner" in a large one)`);
  return L.join('\n');
}

function impactText(ids: string[], m: any, heading: string): string {
  const named = ids.filter((id) => objById(id, m));
  if (!named.length) return `${heading}\n\nNone of the ids given are in this model: ${ids.join(', ') || '(none)'}`;
  const br = blastRadius(named, m);
  const risk = riskOf(br, m);
  const byKind = br.byKind as Record<string, { id: string; d: number }[]>;
  const got = (k: string) => byKind[k] || [];
  const procs = got('process').map((x) => objById(x.id, m)).filter(Boolean);
  const journeys = procs.filter((p: any) => isJourney(p));

  const L = [heading, ''];
  L.push('Changes directly:');
  for (const id of named) L.push('  - ' + describe(id, m));
  L.push('');
  L.push(`Within ${br.hops} hops of that:`);
  for (const [k, label] of [['entity', 'business objects'], ['function', 'server functions'],
    ['route', 'API endpoints'], ['frontend', 'screens'], ['event', 'events'], ['statusFlow', 'lifecycles']] as const) {
    const a = got(k).filter((x) => x.d > 0);
    if (a.length) L.push(`  ${a.length} ${label}: ` + a.slice(0, 25).map((x) => labelOf(x.id, m)).join(', ') + (a.length > 25 ? `, +${a.length - 25} more` : ''));
  }
  L.push('');
  L.push('Areas affected: ' + (br.modules.map((id: string) => {
    const md: any = objById(id, m);
    return labelOf(id, m) + (md && md.owner ? ` (owner: ${md.owner})` : '');
  }).join(', ') || 'none recorded'));
  if (journeys.length) {
    L.push('');
    L.push('User journeys that run through it — breaking one is visible to a person:');
    for (const j of journeys as any[]) L.push(`  - ${j.name || j.id} (${(j.steps || []).length} steps)`);
  }
  L.push('');
  L.push(riskText(risk));
  return L.join('\n');
}

// ---------- tools ----------

type Tool = {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: ToolAnnotations;
  run: (args: Record<string, unknown>, project: string) => { text: string; isError?: boolean };
};

// The spec's optional behaviour hints. Clients are told to treat annotations from an
// untrusted server as untrusted, which is exactly why the ones here are literal: a
// hint that shades the truth is worse than no hint, because a client may skip its
// confirmation prompt on the strength of it.
//
// Defaults, per the schema: readOnlyHint false, destructiveHint true, idempotentHint
// false, openWorldHint true. Every field below is stated rather than left to default,
// since the defaults are wrong for most of these tools.
type ToolAnnotations = {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
};

// Reading the model: no writes, and the world is closed — the only thing touched is
// this machine's own .gitmir/ folder. Repeating a read changes nothing.
const READS: ToolAnnotations = {
  readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
};

const PROJECT_ARG = {
  project: { type: 'string', description: 'Absolute path to the project. Omit to use the one this server was started in.' },
};

const TOOLS: Tool[] = [
  {
    name: 'gitmir_model',
    annotations: READS,
    title: 'Product model',
    description:
      'Read the product model of a codebase: its areas, business objects, server functions, ' +
      'API endpoints, screens, events, business processes and lifecycles, linked by stable ids. ' +
      'Call this when you need to know what the product DOES rather than what a file contains — ' +
      'before answering an architectural question, before planning a change, or when the user ' +
      'asks how some part of the product works. Returns a summary by default; pass a dimension ' +
      'or a search term for detail. Built from the code by the gitmir-model skill, not inferred.',
    inputSchema: {
      type: 'object',
      properties: {
        ...PROJECT_ARG,
        dimension: {
          type: 'string',
          enum: ['modules', 'entities', 'serverUnits', 'serverFunctions', 'apiRoutes',
            'frontendUnits', 'events', 'processes', 'statusFlows', 'reactions'],
          description: 'List one dimension in full instead of the summary.',
        },
        q: { type: 'string', description: 'Return only objects whose name, id or description matches this text.' },
      },
    },
    run(args, project) {
      const l = load(project);
      if (!l.ok) return { text: l.text, isError: true };
      const m = l.model;
      const q = typeof args.q === 'string' ? args.q.trim().toLowerCase() : '';
      const dim = typeof args.dimension === 'string' ? args.dimension : '';

      if (!dim && !q) {
        const L = [l.note, '', 'Product model — counts by dimension:'];
        for (const k of Object.keys(m)) L.push(`  ${String((m[k] || []).length).padStart(4)}  ${k}`);
        const mods = m.modules || [];
        if (mods.length) {
          L.push('', 'Areas:');
          for (const mm of mods) L.push(`  - ${mm.name || mm.id} [${mm.id}]` + (mm.owner ? ` (owner: ${mm.owner})` : '') + (mm.description ? `\n      ${String(mm.description).slice(0, 200)}` : ''));
        }
        L.push('', 'Pass `dimension` for a full list, or `q` to search across everything.');
        return { text: L.join('\n') };
      }

      const pools = dim ? [[dim, m[dim] || []]] : Object.entries(m);
      const hits: string[] = [];
      for (const [k, arr] of pools as [string, any[]][]) {
        for (const o of arr) {
          if (!o || !o.id) continue;
          if (q) {
            const hay = `${o.id} ${o.name || ''} ${o.description || ''} ${o.path || ''}`.toLowerCase();
            if (!hay.includes(q)) continue;
          }
          hits.push(`  [${k}] ` + describe(o.id, m).replace(/\n {4}/, '\n      '));
          if (hits.length >= 200) break;
        }
        if (hits.length >= 200) break;
      }
      const head = dim ? `${dim}${q ? ` matching "${q}"` : ''}` : `objects matching "${q}"`;
      return { text: [l.note, '', `${hits.length}${hits.length >= 200 ? '+ (truncated)' : ''} ${head}:`, ...hits].join('\n') };
    },
  },

  {
    name: 'gitmir_impact',
    annotations: READS,
    title: 'What a change would touch',
    description:
      'Given the model objects a change would modify, report what it reaches and score the risk. ' +
      'Call this BEFORE writing code that changes existing behaviour, and whenever the user asks ' +
      '"what will this break", "what does this touch", or how risky a change is. Pass either ' +
      '`ids` (model object ids you are about to change) or `task` (a file name from the project ' +
      'queue). Returns the downstream objects, the areas affected, the user journeys that run ' +
      'through it, and a risk level with the arithmetic behind it.',
    inputSchema: {
      type: 'object',
      properties: {
        ...PROJECT_ARG,
        ids: { type: 'array', items: { type: 'string' }, description: 'Model object ids the change would modify, e.g. ["ent-order","sf-refund-order"].' },
        task: { type: 'string', description: 'A task file name from tasks/*/ — its declared or mentioned ids are used.' },
      },
    },
    run(args, project) {
      const l = load(project);
      if (!l.ok) return { text: l.text, isError: true };
      const m = l.model;

      if (typeof args.task === 'string' && args.task.trim()) {
        const want = path.basename(args.task.trim());
        const tasks = readTasks(project, modelIdSet(path.join(project, '.gitmir', 'model')));
        const t = tasks.find((x) => x.file === want);
        if (!t) {
          return {
            text: `No task file named ${want}. Tasks in this project:\n` +
              (tasks.map((x) => `  ${x.col}/${x.file}  ${x.title}`).join('\n') || '  (none)'),
            isError: true,
          };
        }
        if (!t.ids.length) {
          return {
            text: `${l.note}\n\nTask "${t.title}" (${t.col}/${t.file}) names no object from the model, so there is nothing to trace.\n\n` +
              `The task-planner skill writes a "Touches:" line listing the ids a task will change — that line is what this reads.`,
            isError: true,
          };
        }
        const src = t.declared
          ? 'DECLARED — the task named these on its Touches: line'
          : 'INFERRED — taken from every model id the task mentions; add a Touches: line for a deliberate scope';
        return {
          text: [l.note, '', impactText(t.ids, m, `Impact of "${t.title}" (${t.col}/${t.file})`),
            '', `Source of the ids: ${src}`,
            t.approved ? `Approved: ${t.approved}` : 'Not approved.'].join('\n'),
        };
      }

      const ids = Array.isArray(args.ids) ? args.ids.map((x) => String(x)) : [];
      if (!ids.length) {
        return { text: 'Give either `ids` (model object ids) or `task` (a task file name). Use gitmir_model to find ids.', isError: true };
      }
      return { text: [l.note, '', impactText(ids, m, 'Impact of changing the objects given')].join('\n') };
    },
  },

  {
    name: 'gitmir_navigate',
    annotations: READS,
    title: 'What breaks if this changes',
    description:
      'Explain one object in the product model and what depends on it. Call this when the user ' +
      'asks what something is, what uses it, or what would break if it were changed or removed — ' +
      'it walks the id links in both directions, which is what tells you about the callers you ' +
      'would otherwise miss. Answers from the model, not by reading the repository.',
    inputSchema: {
      type: 'object',
      properties: {
        ...PROJECT_ARG,
        id: { type: 'string', description: 'A model object id, e.g. ent-order, sf-refund-order, rt-order-refund.' },
      },
      required: ['id'],
    },
    run(args, project) {
      const l = load(project);
      if (!l.ok) return { text: l.text, isError: true };
      const m = l.model;
      const id = String(args.id || '').trim();
      const o = objById(id, m);
      if (!o) {
        return { text: `No object with id "${id}" in this model. Use gitmir_model with \`q\` to search by name.`, isError: true };
      }

      const L = [l.note, '', describe(id, m), ''];
      const roles: string[] = [];
      if (Array.isArray(o.roles) && o.roles.length) roles.push(o.roles.join(', '));
      if (kindOf(id) === 'route' && o.auth) roles.push('signed in');
      if (roles.length) L.push('Who may use it: ' + roles.join(' · '));
      if (o.sensitivity === 'high') L.push('CARE: marked sensitive in the model — money, credentials or personal data.');
      if (Array.isArray(o.paths) && o.paths.length) L.push('Lives in: ' + o.paths.join(', '));
      if (roles.length || o.sensitivity === 'high' || (o.paths || []).length) L.push('');

      L.push(impactText([id], m, 'If this changes:'));
      return { text: L.join('\n') };
    },
  },

  {
    name: 'gitmir_queue',
    annotations: READS,
    title: 'Planned work and its risk',
    description:
      'List the work planned for this project — the task files under tasks/ — with the model ' +
      'objects each one touches, its risk level, and whether it has been approved. Call this when ' +
      'the user asks what is queued, what is being worked on, what is risky, or what still needs ' +
      'approval before it runs.',
    inputSchema: {
      type: 'object',
      properties: {
        ...PROJECT_ARG,
        column: { type: 'string', enum: ['todo', 'inprogress', 'verify', 'done'], description: 'Only this column.' },
      },
    },
    run(args, project) {
      const l = load(project);
      const known = l.ok ? modelIdSet(path.join(project, '.gitmir', 'model')) : new Set<string>();
      let tasks = readTasks(project, known);
      if (typeof args.column === 'string') tasks = tasks.filter((t) => t.col === args.column);
      if (!tasks.length) {
        return { text: `No task files under ${path.join(project, 'tasks')}. The task-planner skill writes them.`, isError: true };
      }
      const L = l.ok ? [l.note, ''] : ['(no model in this project — risk cannot be scored)', ''];
      for (const t of tasks) {
        let tail = '';
        if (l.ok && t.ids.length) {
          const r = riskOf(blastRadius(t.ids, l.model), l.model);
          tail = `  ${r.level.toUpperCase()} (${Math.round(r.share * 100)}% of the product), ${t.ids.length} object(s), ${t.declared ? 'declared' : 'inferred'}`;
        } else if (l.ok) {
          tail = '  names no model object';
        }
        L.push(`[${t.col}] ${t.file}\n  ${t.title}${tail ? '\n' + tail : ''}${t.approved ? `\n  approved: ${t.approved}` : ''}`);
      }
      return { text: L.join('\n') };
    },
  },

  {
    name: 'gitmir_create_task',
    // Writes, but only ever adds: a new file under tasks/todo/, never a replacement.
    // Not idempotent — calling it twice queues the work twice.
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    title: 'Queue a task',
    description:
      'Write a task into this project\'s queue (tasks/todo/) so it can be run and checked ' +
      'later. Call this when the user asks to note something down, plan work, or turn a ' +
      'finding into work rather than doing it now. A task must carry the checks that prove ' +
      'it worked — write them as numbered steps a person could follow. Naming the model ids ' +
      'it will change is what lets its impact and risk be scored before it runs.',
    inputSchema: {
      type: 'object',
      properties: {
        ...PROJECT_ARG,
        title: { type: 'string', description: 'One line naming the task.' },
        task: { type: 'string', description: 'What to do — precise enough to finish in one pass.' },
        verify: {
          type: 'array', items: { type: 'string' },
          description: 'Numbered steps that prove it works. A task with no way to check it is not ready to run.',
        },
        touches: {
          type: 'array', items: { type: 'string' },
          description: 'Model object ids this task will CHANGE (not the ones it reads), e.g. ["ent-order","sf-refund-order"].',
        },
        context: { type: 'string', description: 'Optional: the slice of the product the runner needs.' },
      },
      required: ['title', 'task', 'verify'],
    },
    run(args, project) {
      const title = String(args.title || '').trim();
      const task = String(args.task || '').trim();
      const verify = Array.isArray(args.verify) ? args.verify.map((x) => String(x).trim()).filter(Boolean) : [];
      if (!title || !task) return { text: 'Both `title` and `task` are required.', isError: true };
      // A task nobody can check is a wish. The dashboard enforces this by convention;
      // here it is enforced by refusing to write the file.
      if (!verify.length) {
        return {
          text: 'Refusing to write a task with no `verify` steps. A requirement you cannot check is a wish, ' +
                'not a task — give the numbered steps that would prove it works, and mark any that only a person can judge.',
          isError: true,
        };
      }

      const l = load(project);
      const touches = Array.isArray(args.touches) ? args.touches.map((x) => String(x).trim()).filter(Boolean) : [];
      let warn = '';
      if (l.ok && touches.length) {
        const unknown = touches.filter((id) => !objById(id, l.model));
        if (unknown.length) warn = `\n\nNote: these ids are not in the model and were still written down — check them: ${unknown.join(', ')}`;
      }

      const body = [
        `# ${title}`, '', 'Type: build',
        ...(touches.length ? [`Touches: ${touches.join(', ')}`] : []),
        '',
        ...(typeof args.context === 'string' && args.context.trim() ? ['## Context', '', args.context.trim(), ''] : []),
        '## Task', '', task, '',
        '## Verify', '', ...verify.map((s, i) => `${i + 1}. ${s}`), '',
      ].join('\n');

      const file = createTask(project, title, body);
      const L = [`Wrote tasks/todo/${file}`];
      if (l.ok && touches.length) {
        L.push('');
        L.push(impactText(touches, l.model, 'What it would touch, before anyone runs it:'));
      } else if (l.ok) {
        L.push('', 'No `touches` given, so its impact cannot be scored until someone adds a Touches: line.');
      }
      return { text: L.join('\n') + warn };
    },
  },

  {
    name: 'gitmir_approve',
    // Edits a file that already exists, and with `withdraw` removes a line from it —
    // so destructive is the honest answer even though the common path only adds one.
    // Not idempotent either: approving an approved task rewrites the timestamp.
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    title: 'Approve or withdraw approval',
    description:
      'Record that a queued task has been approved to run — or withdraw that approval. Call ' +
      'this only when the user explicitly says to approve something; it writes an "Approved:" ' +
      'line into the task file that travels with the task and is read by whoever runs it. ' +
      'Show the task\'s impact and risk first if they have not seen it.',
    inputSchema: {
      type: 'object',
      properties: {
        ...PROJECT_ARG,
        file: { type: 'string', description: 'The task file name, e.g. 010-partial-refund.md.' },
        column: { type: 'string', enum: ['todo', 'inprogress', 'verify', 'done'], description: 'Which queue folder it is in. Defaults to searching for it.' },
        by: { type: 'string', description: 'Who approved it — recorded in the line.' },
        withdraw: { type: 'boolean', description: 'Remove the approval instead of adding one.' },
      },
      required: ['file'],
    },
    run(args, project) {
      const want = path.basename(String(args.file || '').trim());
      if (!want) return { text: '`file` is required.', isError: true };
      const known = modelIdSet(path.join(project, '.gitmir', 'model'));
      const tasks = readTasks(project, known);
      const col = typeof args.column === 'string' && COLUMNS.includes(args.column)
        ? args.column
        : (tasks.find((x) => x.file === want) || {}).col;
      if (!col) {
        return {
          text: `No task file named ${want}. Tasks in this project:\n` +
            (tasks.map((x) => `  ${x.col}/${x.file}  ${x.title}`).join('\n') || '  (none)'),
          isError: true,
        };
      }
      try {
        const approved = setApproval(project, col, want, {
          by: String(args.by || '').trim().slice(0, 60), undo: !!args.withdraw,
        });
        return {
          text: approved
            ? `Approved ${col}/${want} — wrote "Approved: ${approved}" into the task file. It travels with the task and whoever runs it will see it.`
            : `Withdrew approval on ${col}/${want} — the Approved: line is gone and the file is as it was.`,
        };
      } catch (e) {
        return { text: `Could not write to ${col}/${want}: ${e instanceof Error ? e.message : String(e)}`, isError: true };
      }
    },
  },
];


// ---------- prompts: the skills, without copy-paste ----------
//
// The tools answer from a model. Building that model is a skill — instructions an
// agent follows — and until now the only way to get one into a session was to copy
// text out of the dashboard. MCP prompts remove that step: the same server that
// answers questions also carries the skill that makes answering possible, so a
// project with no model is one command away from having one instead of being a
// dead end.
//
// Prompts are user-controlled by design — clients usually surface them as slash
// commands — which is the right shape for these: nobody wants an agent deciding on
// its own to re-model the repository.

type SkillDef = { name: string; title: string; description: string; file: string };

function skillDefs(): SkillDef[] {
  const dir = path.join(import.meta.dirname, 'skills');
  let files: string[] = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort(); } catch { return []; }
  const out: SkillDef[] = [];
  for (const f of files) {
    const name = f.replace(/\.md$/, '');
    let head = '';
    try { head = fs.readFileSync(path.join(dir, f), 'utf8').slice(0, 4000); } catch { continue; }
    // The description is what a client shows in its command list, so take the skill's
    // own words: the frontmatter description where there is one, else the opening line.
    let desc = '';
    const fm = /^---\n([\s\S]*?)\n---/.exec(head);
    if (fm) {
      const d = /^description:\s*(?:>-?\s*\n([\s\S]*?)(?=\n\S|$)|(.*))/m.exec(fm[1]);
      if (d) desc = (d[1] || d[2] || '').split('\n').map((s) => s.trim()).join(' ').trim();
    }
    if (!desc) {
      const body = fm ? head.slice(fm[0].length) : head;
      desc = body.split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 2).join(' ');
    }
    out.push({
      name, file: f, title: name,
      description: desc.replace(/\s+/g, ' ').slice(0, 300),
    });
  }
  return out;
}

function skillText(def: SkillDef): string {
  return fs.readFileSync(path.join(import.meta.dirname, 'skills', def.file), 'utf8');
}

// ---------- JSON-RPC over stdio ----------

function write(msg: unknown): void {
  // One message per line, and never a newline inside one — the framing is the
  // protocol here.
  process.stdout.write(JSON.stringify(msg) + '\n');
}
function log(...a: unknown[]): void { process.stderr.write(a.map(String).join(' ') + '\n'); }

function result(id: unknown, res: unknown) { write({ jsonrpc: '2.0', id, result: res }); }
function fail(id: unknown, code: number, message: string) { write({ jsonrpc: '2.0', id, error: { code, message } }); }

function handle(msg: any): void {
  const { id, method, params } = msg || {};
  const isRequest = id !== undefined && id !== null;

  switch (method) {
    case 'initialize': {
      const asked = params && typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      // Answer with the client's version when we speak it, otherwise our latest —
      // the client decides whether it can live with that.
      const agreed = SUPPORTED.has(asked) ? asked : PROTOCOL;
      return result(id, {
        protocolVersion: agreed,
        capabilities: { tools: {}, prompts: {} },
        serverInfo: { name: NAME, title: 'GITMIR Claude Control', version: VERSION },
        instructions:
          'This project may carry a GitMir model — a map of what the product does, built from ' +
          'its own code and linked by stable ids. Prefer these tools over reading files when the ' +
          'question is about the product rather than a specific line: what something is, what ' +
          'depends on it, what a change would reach, and how risky it is. Every answer states how ' +
          'fresh the model is; if it says STALE, say so rather than presenting it as current.',
      });
    }
    case 'notifications/initialized':
      return;                                   // nothing to gate on it — every method here is stateless
    case 'ping':
      return isRequest ? result(id, {}) : undefined;
    case 'prompts/list':
      return result(id, {
        prompts: skillDefs().map((s) => ({
          name: s.name, title: s.title, description: s.description,
          arguments: [{ name: 'note', description: 'Anything to add for this run — a target folder, a constraint, what to focus on.', required: false }],
        })),
      });
    case 'prompts/get': {
      const want = params && params.name;
      const def = skillDefs().find((s) => s.name === want);
      if (!def) return fail(id, -32602, `Unknown prompt: ${want}`);
      let body: string;
      try { body = skillText(def); } catch (e) {
        return fail(id, -32603, `Could not read skill ${def.file}: ${e instanceof Error ? e.message : String(e)}`);
      }
      const note = params && params.arguments && typeof params.arguments.note === 'string' ? params.arguments.note.trim() : '';
      const text = `Follow these instructions for the project at ${DEFAULT_PROJECT}.\n\n` +
        body + (note ? `\n\n---\n\nFor this run specifically: ${note}\n` : '');
      return result(id, {
        description: def.description,
        messages: [{ role: 'user', content: { type: 'text', text } }],
      });
    }
    case 'tools/list':
      return result(id, {
        tools: TOOLS.map((t) => ({
          name: t.name, title: t.title, description: t.description,
          inputSchema: t.inputSchema, annotations: t.annotations,
        })),
      });
    case 'tools/call': {
      const name = params && params.name;
      const tool = TOOLS.find((t) => t.name === name);
      // An unknown tool is a protocol error; a tool that ran and could not answer
      // reports isError in its result. The spec draws that line and clients rely on it.
      if (!tool) return fail(id, -32602, `Unknown tool: ${name}`);
      const args: Record<string, unknown> = (params && params.arguments) || {};
      try {
        const project = projectOf(args);
        let st;
        try { st = fs.statSync(project); } catch { st = null; }
        if (!st || !st.isDirectory()) {
          return result(id, { content: [{ type: 'text', text: `Not a directory: ${project}` }], isError: true });
        }
        const out = tool.run(args, project);
        return result(id, { content: [{ type: 'text', text: out.text }], isError: !!out.isError });
      } catch (e: unknown) {
        log('tool failed:', name, e instanceof Error ? e.stack : String(e));
        return result(id, {
          content: [{ type: 'text', text: `${name} failed: ${e instanceof Error ? e.message : String(e)}` }],
          isError: true,
        });
      }
    }
    default:
      if (isRequest) return fail(id, -32601, `Method not found: ${method}`);
      return;                                   // unknown notification — ignore, per JSON-RPC
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  buf += chunk;
  let nl: number;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      continue;
    }
    try { handle(msg); } catch (e) {
      log('handler crashed:', e instanceof Error ? e.stack : String(e));
      if (msg && msg.id !== undefined && msg.id !== null) fail(msg.id, -32603, 'Internal error');
    }
  }
});
// The client closes stdin to shut us down; exiting keeps it from having to SIGTERM.
process.stdin.on('end', () => process.exit(0));

log(`${NAME} ${VERSION} on stdio — project: ${DEFAULT_PROJECT}`);
