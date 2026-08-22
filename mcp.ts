#!/usr/bin/env node
/**
 * GitMir Local — MCP server.
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
import { report as reportProgress, clear as clearProgress } from './lib/progress.js';
import path from 'node:path';
import { readModel, modelStaleness, modelIdSet, readTasks, MODEL_ID } from './lib/read.js';
import { createTask, setApproval, COLUMNS } from './lib/write.js';
import { blastRadius, riskOf, kindOf, labelOf, moduleOf, objById, isJourney } from './lib/impact.js';
import { modelVersions, modelAt, diffModels } from './lib/history.js';
import { record as recordUse, fileBytesFor } from './lib/usage.js';
import { attention, caught, nextSkill } from './lib/attention.js';
import { readDesign, conformance } from './lib/design.js';
import { readFindings, writeFinding, setFindingStatus, findingsByTarget, openOnly, findingsSummary,
  KINDS, SEVERITIES } from './lib/findings.js';

const PROTOCOL = '2025-06-18';           // the version this server implements
const SUPPORTED = new Set([PROTOCOL, '2025-03-26', '2024-11-05']);
const NAME = 'gitmir-local';
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

/**
 * The model objects an answer actually covered.
 *
 * Not the ids in the arguments: `navigate sf-x` answers with everything that
 * breaks if sf-x changes, and counting one object there would understate what
 * the answer did by a factor of ten. Not the ids in the text either — answers
 * name things in words, on purpose. The covered set is the walk itself.
 */
function idsMentioned(args: Record<string, unknown>, text: string, project: string, model?: any): string[] {
  const out = new Set<string>();
  const add = (v: unknown) => { if (typeof v === 'string' && kindOf(v)) out.add(v); };
  add(args.id);
  if (Array.isArray(args.ids)) args.ids.forEach(add);
  if (Array.isArray(args.touches)) args.touches.forEach(add);

  const known = modelIdSet(path.join(project, '.gitmir', 'model'));
  for (const m of String(text || '').matchAll(MODEL_ID)) if (known.has(m[0])) out.add(m[0]);

  // An answer that walked a radius covered the radius.
  if (model && out.size) {
    try {
      const br = blastRadius([...out].filter((id) => objById(id, model)), model);
      for (const id of br.dist.keys()) out.add(id);
    } catch { /* the count is a nicety; the answer is not */ }
  }
  return [...out];
}

/** What was asked, in a line somebody can read back a month later. */
function describeCall(name: string, args: Record<string, unknown>): string {
  const bits = [name.replace(/^gitmir_/, '')];
  for (const k of ['id', 'task', 'dimension', 'q', 'name', 'column', 'status']) {
    const v = args[k];
    if (typeof v === 'string' && v) bits.push(`${k}=${v}`);
  }
  if (Array.isArray(args.ids) && args.ids.length) bits.push(`ids=${args.ids.length}`);
  return bits.join(' ');
}

function impactText(ids: string[], m: any, heading: string, project?: string): string {
  const named = ids.filter((id) => objById(id, m));
  if (!named.length) return `${heading}\n\nNone of the ids given are in this model: ${ids.join(', ') || '(none)'}`;
  const br = blastRadius(named, m);
  const risk = riskOf(br, m);
  const byKind = br.byKind as Record<string, { id: string; d: number }[]>;
  const got = (k: string) => byKind[k] || [];
  const procs = got('process').map((x) => objById(x.id, m)).filter(Boolean);
  const journeys = procs.filter((p: any) => isJourney(p));

  const L = [heading, ''];
  // The moment somebody is about to change a thing is the moment a known deviation
  // in it is cheapest to fix, and the only moment they are certainly looking.
  const warn: string[] = [];
  if (project) {
    const reached = new Set<string>([...named, ...Object.values(byKind).flat().map((x: any) => x.id)]);
    const open = openOnly(readFindings(project).findings)
      .filter((f) => f.touches.some((id: string) => reached.has(id)));
    if (open.length) {
      const direct = open.filter((f) => f.touches.some((id: string) => named.includes(id)));
      warn.push('');
      warn.push(`ALREADY KNOWN TO BE WRONG HERE — ${open.length} finding(s)` +
        (direct.length ? `, ${direct.length} on what you are changing directly` : ', in what this reaches') + ':');
      for (const f of open.slice(0, 8)) {
        warn.push(`  [${f.severity}] should: ${f.rule}${f.source ? ` (${f.source})` : ''}`);
        warn.push(`            does:   ${f.actual}`);
      }
      if (open.length > 8) warn.push(`  …and ${open.length - 8} more — gitmir_findings lists them.`);
      warn.push('  Say this out loud before changing any of it: the product already does not do what it says here.');
    }
  }
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
  return L.concat(warn).join('\n');
}

// ---------- tools ----------

type Tool = {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: ToolAnnotations;
  // Async is allowed: setting a project up asks a running dashboard to add it,
  // and that is a network call.
  run: (args: Record<string, unknown>, project: string) =>
    { text: string; isError?: boolean } | Promise<{ text: string; isError?: boolean }>;
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
// The words the product is described in — the same ones the dashboard prints, so
// an answer read in the editor and an answer read on screen name things alike.
const DIM_WORD: Record<string, string> = {
  modules: 'areas', entities: 'business objects', serverUnits: 'server units',
  serverFunctions: 'functions', apiRoutes: 'endpoints', frontendUnits: 'screens',
  events: 'events', processes: 'journeys', statusFlows: 'lifecycles', reactions: 'reactions',
};

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
          text: [l.note, '', impactText(t.ids, m, `Impact of "${t.title}" (${t.col}/${t.file})`, project),
            '', `Source of the ids: ${src}`,
            t.approved ? `Approved: ${t.approved}` : 'Not approved.'].join('\n'),
        };
      }

      const ids = Array.isArray(args.ids) ? args.ids.map((x) => String(x)) : [];
      if (!ids.length) {
        return { text: 'Give either `ids` (model object ids) or `task` (a task file name). Use gitmir_model to find ids.', isError: true };
      }
      return { text: [l.note, '', impactText(ids, m, 'Impact of changing the objects given', project)].join('\n') };
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

      L.push(impactText([id], m, 'If this changes:', project));
      return { text: L.join('\n') };
    },
  },

  {
    // The person watching the dashboard cannot see a chat window. Without this they
    // watch a folder and guess — and the case that strands them is the one where the
    // agent stopped to ask them something, which a folder can never show.
    name: 'gitmir_progress',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    title: 'Say what you are doing right now',
    description:
      'Tell the dashboard what you are currently doing on this project, so the person watching it ' +
      'sees progress instead of a blank wait. Call it when you START building or refreshing the ' +
      'model, when you move on to WRITING files, when you are BLOCKED waiting for an answer from ' +
      'the person (put the question in `note` — this is the one that matters most), and when you ' +
      'are DONE. Cheap, safe, and it writes nothing but a one-line status file.',
    inputSchema: {
      type: 'object',
      properties: {
        ...PROJECT_ARG,
        stage: { type: 'string', enum: ['started', 'reading', 'writing', 'blocked', 'done', 'failed'],
          description: 'started · reading the code or the brief · writing the model files · blocked on a question for the person · done · failed' },
        note: { type: 'string', description: 'One short line for a human. If blocked, the exact question you are waiting on.' },
      },
      required: ['stage'],
    },
    async run(args: Record<string, unknown>, project: string) {
      const stage = String(args.stage || '');
      const note = String(args.note || '');
      const ok = reportProgress(project, stage, note);
      if (!ok) return { text: `Could not record "${stage}" — carry on, this is only a status line.` };
      return { text: stage === 'blocked'
        ? `Recorded: waiting on the person${note ? ` — "${note}"` : ''}. The dashboard now shows them the question. Ask it in the chat too.`
        : `Recorded: ${stage}${note ? ` — ${note}` : ''}. The dashboard is showing it.` };
    },
  },
  {
    // Setting a project up is what everyone hits first, and every step of it was
    // something the person had to know to ask for: add the folder to the
    // dashboard, make the queue, build the model. An agent can do all of it — it
    // just needed a tool to call, since prompts only fire when a person types a
    // slash command.
    name: 'gitmir_setup',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    title: 'Set this project up for GitMir',
    description:
      'Prepare a project to be worked on with GitMir: put it on the dashboard, create the task ' +
      'queue folders, and report what is still missing — above all whether the product model ' +
      'exists. Call this the first time you touch a project, or whenever another tool answers ' +
      '"there is no model here". Creates only folders and a list entry; it never edits code.',
    inputSchema: { type: 'object', properties: { ...PROJECT_ARG }, required: [] },
    async run(_args: Record<string, unknown>, project: string) {
      const lines: string[] = [];
      lines.push(`Project: ${project}`);
      lines.push('');

      lines.push(`Dashboard: ${await registerWithDashboard(project)}`);

      const made: string[] = [];
      for (const col of COLUMNS) {
        const d = path.join(project, 'tasks', col);
        if (!fs.existsSync(d)) { try { fs.mkdirSync(d, { recursive: true }); made.push(col); } catch {} }
      }
      lines.push(made.length ? `Task queue: created tasks/${made.join(', tasks/')}` : 'Task queue: already there');

      const { exists } = readModel(project);
      lines.push('');
      if (exists) {
        lines.push('Model: built. Every other tool here will answer from it.');
        lines.push('');
        lines.push('Next, if you want the rest of the workflow: gitmir_skill("task-planner") writes tasks that');
        lines.push('carry their own checks, and gitmir_skill("task-log") keeps the record of what was done.');
      } else {
        lines.push('Model: MISSING — this is the one thing that has to happen before anything else works.');
        lines.push('');
        lines.push('Do it now: call gitmir_skill("gitmir-model") and follow what it returns against this');
        lines.push('project. It reads the repository once and writes .gitmir/model/. After that the');
        lines.push('dashboard draws it and every tool here can answer from it.');
      }
      return { text: lines.join('\n') };
    },
  },
  {
    name: 'gitmir_skills',
    annotations: READS,
    title: 'The GitMir skills and when to use one',
    description:
      'List the GitMir skills — the written procedures for building the model, planning work that ' +
      'carries its own checks, running the queue, auditing a running app, and working on inherited ' +
      'code. Call this when you are about to do one of those things, then fetch the one you need ' +
      'with gitmir_skill and follow it. Returns names and what each is for, not the text.',
    inputSchema: { type: 'object', properties: { ...PROJECT_ARG }, required: [] },
    run(_args: Record<string, unknown>, _project: string) {
      const defs = skillDefs();
      if (!defs.length) return { text: 'No skills found in this installation.', isError: true };
      const out = ['GitMir skills. Fetch one with gitmir_skill("<name>") and follow it.', ''];
      for (const d of defs) out.push(`${d.name}\n    ${d.description}`);
      out.push('');
      out.push('Start with gitmir-model if this project has no model yet — nothing else here works without it.');
      return { text: out.join('\n') };
    },
  },
  {
    name: 'gitmir_skill',
    annotations: READS,
    title: 'The full text of one skill',
    description:
      'Return one GitMir skill in full, so you can follow it yourself. Use it after gitmir_skills, ' +
      'or straight away when you already know which one you need — gitmir-model to build the model, ' +
      'task-planner to plan, task-runner to work the queue. The text is the instruction: read it and ' +
      'carry it out against this project.',
    inputSchema: {
      type: 'object',
      properties: {
        ...PROJECT_ARG,
        name: { type: 'string', description: 'Skill name, e.g. "gitmir-model".' },
      },
      required: ['name'],
    },
    run(args: Record<string, unknown>, project: string) {
      const want = String(args.name || '').trim().replace(/\.md$/, '');
      const def = skillDefs().find((d) => d.name === want);
      if (!def) {
        return { text: `No skill called "${want}". Call gitmir_skills for the list.`, isError: true };
      }
      return { text: `Follow these instructions for the project at ${project}.\n\n---\n\n${skillText(def)}` };
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
    name: 'gitmir_history',
    annotations: READS,
    title: 'How the product changed',
    description:
      'What the product gained, lost and renamed over a period. Call this when the user asks ' +
      'what changed in the last week or month, what a rebuild of the model did, whether ' +
      'something was lost, or how the business logic has drifted. Reads the versions of ' +
      '.gitmir/model that the project\'s own git history already holds — nothing is stored for ' +
      'it, so a repository that ran for a year before it ever saw GitMir still has them. With ' +
      'no arguments it compares the newest version against the one closest to 30 days back.',
    inputSchema: {
      type: 'object',
      properties: {
        ...PROJECT_ARG,
        days: { type: 'number', description: 'How far back to compare, in days. Default 30.' },
        from: { type: 'string', description: 'Compare from this commit sha instead of a period.' },
        to: { type: 'string', description: 'Compare to this commit sha instead of the newest version.' },
        list: { type: 'boolean', description: 'Just list the versions, with their dates and what each commit was doing.' },
      },
    },
    async run(args: Record<string, unknown>, project: string) {
      const h = await modelVersions(project, 80);
      if (!h.ok || !h.versions.length) {
        // Each reason is a different thing to go and do, so name the real one.
        const why = h.why === 'not-a-repo'
          ? `${project} is not a git repository, so the model has no versions. History comes from the repository, not from GitMir.`
          : h.why === 'ignored'
            ? '.gitmir/model is ignored by git. Commit it and every rebuild becomes a version that can be compared — that is the whole mechanism.'
            : 'The model has never been committed. Commit .gitmir/model and each rebuild lands as a version, dated, next to the work that caused it.';
        return { text: why, isError: true };
      }
      const vs = h.versions;
      if (args.list === true) {
        return { text: [`${vs.length} versions of the model, newest first:`, '',
          ...vs.map((v) => `${v.date}  ${v.short}  ${v.author}\n  ${v.subject}`)].join('\n') };
      }
      if (vs.length < 2) {
        return { text: 'The model has been committed once. A second commit is what makes a comparison possible.', isError: true };
      }
      const hex = /^[0-9a-f]{7,40}$/;
      const to = typeof args.to === 'string' && hex.test(args.to) ? args.to : vs[0].sha;
      const days = typeof args.days === 'number' && args.days > 0 ? args.days : 30;
      const cut = Date.parse(vs[0].date) - days * 864e5;
      // A project whose whole history is shorter than the period gets all of it, rather
      // than an arbitrary version in the middle and a comparison of nothing.
      const from = typeof args.from === 'string' && hex.test(args.from)
        ? args.from
        : (vs.find((v) => Date.parse(v.date) <= cut) || vs[vs.length - 1]).sha;
      if (from === to) return { text: 'Both sides are the same version — there is nothing to compare.', isError: true };

      const [a, b] = await Promise.all([modelAt(project, from), modelAt(project, to)]);
      const d = diffModels(a, b);
      const vFrom = vs.find((v) => v.sha === from), vTo = vs.find((v) => v.sha === to);
      const T = d.totals;
      const L: string[] = [];
      L.push(`The product between ${vFrom ? vFrom.date : from.slice(0, 7)} and ${vTo ? vTo.date : to.slice(0, 7)}:`);
      L.push('');
      L.push(`  ${T.added} object(s) gained, ${T.removed} no longer in the model, ${T.renamed} renamed`);
      L.push(`  ${T.linksAdded} connection(s) added, ${T.linksRemoved} removed`);
      if (d.lost.length) {
        L.push('');
        L.push(`THINGS THE PRODUCT USED TO HAVE AND NO LONGER DOES (${d.lost.length}):`);
        for (const o of d.lost) L.push(`  ${o.name} — ${DIM_WORD[o.dim] || o.dim}`);
        L.push('  Either the work finished, or a rebuild lost them. Making that call is the point.');
      }
      // A count with nothing under it cannot be checked. Everything removed gets
      // named, whether or not it was one of the kinds worth raising an alarm over.
      const lostIds = new Set(d.lost.map((o) => o.id));
      const goneRest = d.objects.removed.filter((o) => !lostIds.has(o.id));
      if (goneRest.length) {
        L.push('');
        L.push(`ALSO NO LONGER IN THE MODEL (${goneRest.length}):`);
        for (const o of goneRest.slice(0, 40)) L.push(`  ${o.name} — ${DIM_WORD[o.dim] || o.dim}`);
        if (goneRest.length > 40) L.push(`  …and ${goneRest.length - 40} more`);
      }
      if (d.lifecycles.length) {
        L.push('');
        L.push('RULES THAT CHANGED:');
        for (const l of d.lifecycles) {
          const bits: string[] = [];
          if (l.statesAdded.length) bits.push(`states added: ${l.statesAdded.join(', ')}`);
          if (l.statesRemoved.length) bits.push(`states gone: ${l.statesRemoved.join(', ')}`);
          if (l.transAdded.length) bits.push(`transitions added: ${l.transAdded.join(', ')}`);
          if (l.transRemoved.length) bits.push(`transitions gone: ${l.transRemoved.join(', ')}`);
          L.push(`  ${l.name}: ${bits.join(' · ')}`);
        }
      }
      const dims = d.perDimension.filter((x) => x.added || x.removed || x.renamed);
      if (dims.length) {
        L.push('');
        L.push('WHERE IT MOVED:');
        for (const x of dims) L.push(`  ${DIM_WORD[x.dim] || x.dim}: ${x.was} -> ${x.now}` +
          ` (${[x.added ? `+${x.added}` : '', x.removed ? `-${x.removed}` : '', x.renamed ? `${x.renamed} renamed` : ''].filter(Boolean).join(' ')})`);
      }
      if (d.objects.renamed.length) {
        L.push('');
        L.push('RENAMED — same object, new words:');
        for (const o of d.objects.renamed.slice(0, 30)) L.push(`  ${o.from} -> ${o.to}`);
      }
      if (!T.added && !T.removed && !T.renamed && !T.linksAdded && !T.linksRemoved) {
        L.push('');
        L.push('Nothing changed in the model between those two versions.');
      }
      L.push('');
      L.push(`Compared ${from.slice(0, 7)} against ${to.slice(0, 7)}; ${vs.length} versions exist, oldest ${vs[vs.length - 1].date}.`);
      return { text: L.join('\n') };
    },
  },

  {
    name: 'gitmir_design',
    annotations: READS,
    title: 'What the product is supposed to become',
    description:
      'What somebody declared on the product map that the code does not have yet, and how much ' +
      'of it exists. Call this before starting work — it says what you are supposed to build and ' +
      'what each element has to end up doing — and again after finishing, once the model has been ' +
      'rebuilt, to check that what you built is what was drawn. An element counts as done only ' +
      'when the model records every relationship the design declared for it; code appearing is ' +
      'not the same thing.',
    inputSchema: { type: 'object', properties: { ...PROJECT_ARG } },
    run(_args: Record<string, unknown>, project: string) {
      const items = readDesign(project).items;
      if (!items.length) {
        return { text: 'Nothing is declared for this project. The Design view on the dashboard is where somebody draws what the product should become; until then there is nothing to build against.' };
      }
      const l = load(project);
      const model = l.ok ? l.model : {};
      const c = conformance(items, model);
      const L: string[] = [];
      L.push(`${c.total} element(s) declared: ${c.present} built and doing what was declared, ` +
             `${c.differs} built but not doing all of it, ${c.missing} not built yet.`);
      if (!l.ok) L.push('(No model here yet, so nothing can be counted as built.)');
      L.push('');
      for (const r of c.rows) {
        const word = { present: 'DONE', differs: 'PARTLY DONE', missing: 'NOT BUILT' }[r.state];
        L.push(`[${word}] ${r.name}  (${r.id}, ${r.dim.replace(/s$/, '')})`);
        if (r.note) L.push(`  why: ${r.note}`);
        for (const link of r.links) {
          L.push(`  must ${link.label} ${link.to}${link.held ? '   — the model records this' : '   — NOT in the model'}`);
        }
        L.push('');
      }
      if (c.present < c.total) {
        L.push('When you have written the code: rebuild the model with the gitmir-model skill, then call this');
        L.push('again. These states are read from the model, so they only move when the model does.');
      }
      return { text: L.join('\n') };
    },
  },

  {
    name: 'gitmir_attention',
    annotations: READS,
    title: 'What needs a person, derived from the model',
    description:
      'What this project needs attention on right now, worked out from the model itself: the code ' +
      'having moved past it, recorded deviations whose files have since changed, planned work that ' +
      'reaches further than its ticket says, tasks queued without approval, parts of the product ' +
      'nobody owns. Call this at the start of a session instead of asking what to do, and after ' +
      'finishing work to see what it left behind. Each item says what it is, why it costs something ' +
      'to ignore, and what closes it.',
    inputSchema: { type: 'object', properties: { ...PROJECT_ARG } },
    run(_args: Record<string, unknown>, project: string) {
      const l = load(project);
      const known = l.ok ? modelIdSet(path.join(project, '.gitmir', 'model')) : new Set<string>();
      const tasks = l.ok ? readTasks(project, known) : [];
      // load() keeps the freshness note, not the timestamp; read it once more here
      // rather than widen that type for one caller.
      let st: { stale: boolean; newestFile: string } = { stale: false, newestFile: '' };
      if (l.ok) {
        try { const r = readModel(project); const s = modelStaleness(project, r.writtenMs);
              st = { stale: !!s.stale, newestFile: s.newestFile || '' }; } catch {}
      }
      const items = attention({
        projectPath: project, model: l.ok ? l.model : {}, exists: !!l.ok,
        stale: st.stale, staleFile: st.newestFile, tasks,
      });
      const L: string[] = [];
      if (!items.length) {
        L.push('Nothing needs a person here. The model matches the code, every recorded deviation has been decided, and no planned task reaches further than its ticket says.');
      } else {
        const word = { act: 'DO', check: 'CHECK', note: 'NOTE' } as Record<string, string>;
        L.push(`${items.length} thing(s) need a person, worst first:`);
        L.push('');
        for (const i of items) {
          L.push(`[${word[i.level] || i.level}] ${i.title}`);
          L.push(`  why: ${i.why}`);
          L.push(`  closes it: ${i.action.label}${i.action.arg ? ` (${i.action.arg})` : ''}`);
          L.push('');
        }
      }
      if (l.ok) {
        const c = caught({ model: l.model, tasks });
        if (c.tasks) {
          L.push(`Across ${c.tasks} task(s) that name part of the model: tickets named ${c.named} objects, ` +
            `the model shows they reach ${c.reached} — ${c.unnamed} nobody mentioned.`);
        }
        const n = nextSkill({ exists: true, stale: st.stale, model: l.model, tasks,
                              findings: readFindings(project).findings.length });
        L.push('');
        L.push(`If you are looking for what to do next: the ${n.name} procedure fits where this project is — ${n.why}`);
        L.push(`Fetch it in full with gitmir_skill("${n.name}").`);
      }
      return { text: L.join('\n') };
    },
  },

  {
    name: 'gitmir_flag',
    // Writes one file under .gitmir/findings/. Safe to repeat: the same rule on the
    // same object updates the record in place rather than queueing a second copy.
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    title: 'Record where the code disagrees with the product',
    description:
      'Record that the code does not do what the product is supposed to do. Call this the ' +
      'moment you find one — reading a spec against the code, reviewing, or answering a ' +
      'question — instead of only describing it in the conversation. A finding written here ' +
      'is attached to the objects it sits on, shows on every diagram that draws them, warns ' +
      'anyone planning a change that reaches them, and is still there next week; a finding ' +
      'described in a reply is gone when the conversation ends. This is not a task: a task is ' +
      'work someone intends to do, a finding is a fact about the product that stays true until ' +
      'it is fixed or somebody decides to live with it.',
    inputSchema: {
      type: 'object',
      required: ['rule', 'actual'],
      properties: {
        ...PROJECT_ARG,
        rule: { type: 'string', description: 'What the product is supposed to do, in the product\'s own words. Not "should validate input" — the actual rule.' },
        actual: { type: 'string', description: 'What the code does instead, naming the function or route you read it from.' },
        consequence: { type: 'string', description: 'What goes wrong for a person because of the gap. This is what makes it arguable.' },
        source: { type: 'string', description: 'Where the rule is written: a spec section, a ticket, a decision. "ТЗ 5.2", "docs/spec.md#pricing".' },
        touches: { type: 'array', items: { type: 'string' }, description: 'Model ids this sits on — the functions, endpoints or screens involved. This is what makes it visible on the diagrams.' },
        kind: { type: 'string', enum: [...KINDS], description: 'contradicts-spec: does something else. not-implemented: does nothing. undefined: the spec never said. risk: works, will not survive production.' },
        severity: { type: 'string', enum: [...SEVERITIES] },
        readFrom: { type: 'array', items: { type: 'string' }, description: 'Repo-relative files you read this from. When one of them changes, the finding asks to be re-checked instead of quietly going stale.' },
        id: { type: 'string', description: 'Only to update a specific finding you already know the id of.' },
      },
    },
    run(args: Record<string, unknown>, project: string) {
      const r = writeFinding(project, args as any);
      if (!r.ok) return { text: r.why || 'Could not record it.', isError: true };
      const f = r.finding;
      const L = [
        `${r.updated ? 'Updated' : 'Recorded'} finding ${f.id}.`,
        '',
        `  rule    ${f.rule}`,
        `  actual  ${f.actual}`,
      ];
      if (f.consequence) L.push(`  costs   ${f.consequence}`);
      if (f.source) L.push(`  source  ${f.source}`);
      L.push(`  on      ${f.touches.length ? f.touches.join(', ') : '(no model ids — it will not show on any diagram until it has some)'}`);
      L.push('');
      L.push('It is on the dashboard now, marked on every object it touches, and anyone planning a change that reaches them will be warned.');
      if (!f.touches.length) L.push('Add `touches` with the ids from gitmir_navigate to make it visible where it matters.');
      if (!f.readFrom.length) L.push('Add `readFrom` with the files you read, so the finding asks to be re-checked when they change.');
      return { text: L.join('\n') };
    },
  },

  {
    name: 'gitmir_findings',
    annotations: READS,
    title: 'Where the code disagrees with the product',
    description:
      'Everything recorded about where this product does not do what it is supposed to. Call ' +
      'this before changing anything, when asked what is wrong with the product, when picking ' +
      'what to work on, or to check whether something you just noticed is already known. Says ' +
      'which findings are open, which were accepted deliberately and by whom, and which need ' +
      're-checking because the code they describe has moved since.',
    inputSchema: {
      type: 'object',
      properties: {
        ...PROJECT_ARG,
        id: { type: 'string', description: 'One model id — only findings sitting on that object.' },
        status: { type: 'string', enum: ['open', 'accepted', 'fixed', 'all'], description: 'Default open.' },
      },
    },
    run(args: Record<string, unknown>, project: string) {
      const all = readFindings(project).findings;
      if (!all.length) {
        return { text: 'Nothing recorded for this project yet. Use gitmir_flag when you find a place where the code does not do what the product says — reading a spec against the code is the usual way to find them.' };
      }
      const want = typeof args.status === 'string' ? args.status : 'open';
      let list = want === 'all' ? all : all.filter((f: any) => f.status === want);
      if (typeof args.id === 'string' && args.id) {
        const by = findingsByTarget(all);
        list = (by.get(args.id) || []).filter((f: any) => want === 'all' || f.status === want);
        if (!list.length) return { text: `Nothing recorded on ${args.id}.` };
      }
      const s = findingsSummary(all);
      const L = [`${s.open} open, ${s.accepted} accepted, ${s.fixed} fixed` +
        (s.stale ? ` — ${s.stale} need re-checking, the code they describe has moved.` : '.'), ''];
      for (const f of list) {
        L.push(`[${f.severity}] ${f.id}${f.stale ? '  (RE-CHECK: ' + f.movedFile + ' has changed)' : ''}`);
        L.push(`  should  ${f.rule}${f.source ? `   (${f.source})` : ''}`);
        L.push(`  does    ${f.actual}`);
        if (f.consequence) L.push(`  costs   ${f.consequence}`);
        if (f.touches.length) L.push(`  on      ${f.touches.join(', ')}`);
        if (f.status === 'accepted' && f.decision) L.push(`  ACCEPTED by ${f.decision.by} on ${f.decision.at}: ${f.decision.why}`);
        L.push('');
      }
      return { text: L.join('\n') };
    },
  },

  {
    name: 'gitmir_accept_finding',
    // Records a decision. Destructive because it can also reopen one, which drops
    // the signature off a decision somebody made.
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    title: 'Decide what to do about a finding',
    description:
      'Record that a known deviation is accepted — the product will keep behaving this way on ' +
      'purpose — or that it has been fixed, or reopen one. Accepting needs a name and a reason: ' +
      'the whole point of the record is that somebody can be asked about it later. Call this ' +
      'when the user decides to live with something, or after work that closes one.',
    inputSchema: {
      type: 'object',
      required: ['id', 'status'],
      properties: {
        ...PROJECT_ARG,
        id: { type: 'string', description: 'The finding id, from gitmir_findings.' },
        status: { type: 'string', enum: ['accepted', 'fixed', 'open'] },
        by: { type: 'string', description: 'Who decided. Required to accept.' },
        why: { type: 'string', description: 'Why it is acceptable. Required to accept.' },
      },
    },
    run(args: Record<string, unknown>, project: string) {
      const r = setFindingStatus(project, String(args.id || ''), String(args.status || ''),
        { by: args.by, why: args.why });
      if (!r.ok) return { text: r.why || 'Could not record the decision.', isError: true };
      const f = r.finding;
      if (f.status === 'accepted' && f.decision) {
        return { text: `${f.id} is accepted: ${f.decision.why}\n  decided by ${f.decision.by} on ${f.decision.at}\n\nIt still shows on the diagrams, marked as a decision rather than a defect — which is the difference between a product that has known limits and one that has surprises.` };
      }
      if (f.status === 'fixed') return { text: `${f.id} is marked fixed. It stays in the record: what the product used to get wrong is part of its history.` };
      return { text: `${f.id} is open again.` };
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
        L.push(impactText(touches, l.model, 'What it would touch, before anyone runs it:', project));
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

/**
 * Put this project on the dashboard's list. The dashboard owns projects.json,
 * so if it is running we ask it rather than writing under it; only when nothing
 * answers do we edit the file ourselves. Either way it is idempotent — a project
 * already on the list is left exactly as it is.
 */
async function registerWithDashboard(projectPath: string): Promise<string> {
  const port = Number(process.env.GITMIR_PORT || 4599) || 4599;
  const body = JSON.stringify({ path: projectPath });
  try {
    const res = await fetch(`http://localhost:${port}/api/add`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: `http://localhost:${port}` },
      body,
      signal: AbortSignal.timeout(1200),
    });
    if (res.ok) return `added to the running dashboard on port ${port}`;
    return `the dashboard answered ${res.status}; it may already be on the list`;
  } catch {
    // Nothing listening: write the list ourselves so it is there when it starts.
    const file = path.join(import.meta.dirname, 'projects.json');
    let list: { name: string; path: string; description: string }[] = [];
    try { const raw = JSON.parse(fs.readFileSync(file, 'utf8')); if (Array.isArray(raw)) list = raw; } catch {}
    if (list.some((p) => p && p.path === projectPath)) return 'already on the dashboard list';
    list.push({ name: path.basename(projectPath), path: projectPath, description: '' });
    try {
      fs.writeFileSync(file, JSON.stringify(list, null, 2));
      return 'written to the dashboard list — it will be there when you start it';
    } catch (e) {
      return `could not write the dashboard list: ${(e as Error).message}`;
    }
  }
}

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
      // A folded block runs until a line that starts back at column 0. The old
      // pattern ended it at `$`, which with /m is the end of the FIRST line — so
      // every multi-line description was cut to its opening clause.
      const d = /^description:\s*(?:>-?[^\n]*\n((?:[ \t]+[^\n]*\n?)+)|([^\n]*))/m.exec(fm[1]);
      if (d) desc = (d[1] || d[2] || '').split(/\r?\n/).map((s) => s.trim()).join(' ').trim();
    }
    if (!desc) {
      const body = fm ? head.slice(fm[0].length) : head;
      desc = body.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).slice(0, 2).join(' ');
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

// Async because one tool asks a running dashboard to add the project, and that
// is a network call. Replies still go out in whatever order they finish — every
// reply carries its request's id, which is what the protocol matches on.
async function handle(msg: any): Promise<void> {
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
        serverInfo: { name: NAME, title: 'GitMir Local', version: VERSION },
        instructions:
          'This project may carry a GitMir model — a map of what the product does, built from ' +
          'its own code and linked by stable ids. Prefer these tools over reading files when the ' +
          'question is about the product rather than a specific line: what something is, what ' +
          'depends on it, what a change would reach, and how risky it is. Every answer states how ' +
          'fresh the model is; if it says STALE, say so rather than presenting it as current. ' +
          'If a tool answers that there is no model here, call gitmir_setup: it puts the project on ' +
          'the dashboard, makes the task queue, and tells you what is missing. The written procedures ' +
          'are gitmir_skills and gitmir_skill — fetch one and follow it yourself rather than asking ' +
          'the user to paste anything. ' +
          // Two procedures answer a request rather than a question, and an agent walks
          // straight past both: asked to plan, it starts editing. Say so here, where every
          // client reads it once at startup.
          'Two of those procedures answer a request rather than a question. When the user asks you to ' +
          'PLAN work — "plan this", "break this down", "what needs doing for X" — fetch ' +
          'gitmir_skill("task-planner") and follow it instead of starting to edit code: they asked for ' +
          'the work written down with its own checks, not for the work done. When they ask you to RUN ' +
          'the queue, fetch gitmir_skill("task-runner"). ' +
          'While you build or refresh the model, report each stage with gitmir_progress — and if you have ' +
          'to stop and ask the user something, report `blocked` with the question in it, because they are ' +
          'watching a dashboard and cannot see this conversation.',
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
        const out = await tool.run(args, project);
        // One line per answer served. The comparison it records is a fact about
        // this repository — these objects live in these files, the files are this
        // big — not a claim about what an agent would otherwise have done.
        if (!out.isError) {
          try {
            const l = load(project);
            const ids = idsMentioned(args, out.text, project, l.ok ? l.model : null);
            const reach = (ids.length && l.ok) ? fileBytesFor(project, ids, l.model) : { files: 0, bytes: 0 };
            recordUse(project, {
              tool: name,
              q: describeCall(name, args),
              served: Buffer.byteLength(out.text || '', 'utf8'),
              ids,
              wouldFiles: reach.files,
              wouldBytes: reach.bytes,
              by: 'agent',
            });
          } catch { /* the diary never blocks the answer */ }
        }
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
    try { handle(msg).catch((e) => log('handler failed:', e)); } catch (e) {
      log('handler crashed:', e instanceof Error ? e.stack : String(e));
      if (msg && msg.id !== undefined && msg.id !== null) fail(msg.id, -32603, 'Internal error');
    }
  }
});
// The client closes stdin to shut us down; exiting keeps it from having to SIGTERM.
process.stdin.on('end', () => process.exit(0));

log(`${NAME} ${VERSION} on stdio — project: ${DEFAULT_PROJECT}`);
