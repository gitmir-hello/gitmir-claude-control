// Ask the MCP server a question and print what it said.
//
// An MCP server has no screen. It exchanges JSON-RPC messages over stdin and
// stdout, and one answer arrives as a single line of several thousand characters
// with the newlines escaped — technically readable, practically not. This file
// speaks the protocol and prints the result for a person, so you can see what your
// editor will see before you wire one up.
//
//   node mcp-check.ts <project> <command> [argument]
//   node mcp-check.ts                                  (this help)
//
// It starts mcp.ts as a subprocess and stops it again. Nothing listens on a port,
// nothing is uploaded. The only commands that write anything are `new`, `approve`
// and `withdraw` — and they write into the project you name, exactly as the editor
// would.

import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const HELP = `
Check the GitMir MCP server

  node mcp-check.ts <project> <command> [argument]

The first argument is always the project being asked about — try
examples/refund-shop, which ships with this repository.

  init              handshake: protocol version, server name, what it offers
  tools             the tools, and what each admits about its own behaviour
  prompts           the skills, served as prompts
  prompt <name>     fetch one skill's text
  setup             prepare a project: dashboard entry, task queue, what is missing
  skills            the written procedures and when to use one
  skill <name>      one procedure in full
  model [dimension] what is this product
  nav <id>          what is this object, and what breaks if it changes
  impact <what>     what a change reaches: ids separated by commas, OR a task file name
  queue             the planned work
  flag              record a finding (writes into the project)
  findings          where the code disagrees with the product
  attention         what needs a person, worked out from the model
  accept <id>       record a decision to live with one
  history           how the product changed over the last 30 days
  versions          every version of the model this project has
  new <title>       write a task (with proper verify steps)
  newbad <title>    try to write a task with NO verify steps — the server must refuse
  approve <column> <file>     approve a task
  withdraw <column> <file>    take the approval back
  junk              send broken JSON — the server must survive it
  badmethod         call a method that does not exist
  badtool           call a tool that does not exist
  oldversion        introduce yourself with an unknown protocol version
  raw <json>        send one message verbatim

Run it from the folder holding mcp.ts.
`;

const argv = process.argv.slice(2);
if (argv.length < 2) { console.log(HELP); process.exit(0); }

const project = argv[0];
const cmd = argv[1];
const arg = argv.slice(2).join(' ');

if (!fs.existsSync('mcp.ts')) {
  console.error('\n  No mcp.ts next to me. Run this from the folder that holds it.\n');
  process.exit(1);
}
if (!fs.existsSync(project)) {
  console.error(`\n  No such folder: ${project}\n`);
  process.exit(1);
}

// ── talking to the server ────────────────────────────────────────────────────

const srv = spawn('node', ['mcp.ts', '--project', path.resolve(project)], { stdio: ['pipe', 'pipe', 'pipe'] });
let buf = '';
const waiting = new Map<number, (m: any) => void>();
const uninvited: any[] = [];
let log = '';
let n = 0;

srv.stderr.setEncoding('utf8');
srv.stderr.on('data', (c: string) => { log += c; });
srv.stdout.setEncoding('utf8');
srv.stdout.on('data', (chunk: string) => {
  buf += chunk;
  let nl: number;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let msg: any;
    try { msg = JSON.parse(line); }
    catch {
      // Anything here is a protocol violation: stdout carries messages and nothing else.
      console.log('\n  !! the server put something in stdout that is not a message:\n   ', line.slice(0, 200), '\n');
      continue;
    }
    if (msg.id != null && waiting.has(msg.id)) { waiting.get(msg.id)!(msg); waiting.delete(msg.id); }
    else uninvited.push(msg);
  }
});
srv.on('error', (e: Error) => { console.error('\n  The server did not start:', e.message, '\n'); process.exit(1); });

const ask = (method: string, params?: any) => new Promise<any>((res) => {
  const id = ++n;
  waiting.set(id, res);
  srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
});
const shout = (text: string) => srv.stdin.write(text + '\n');
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

const rule = () => console.log('  ' + '-'.repeat(72));
const head = (t: string) => { console.log(''); rule(); console.log('  ' + t); rule(); };

// A tool's answer is text. Print it as it came: this is exactly what an agent reads.
function show(r: any) {
  if (r.error) { console.log(`\n  PROTOCOL ERROR: ${r.error.code} ${r.error.message}\n`); return; }
  for (const part of (r.result?.content || [])) {
    if (part.type === 'text') console.log('\n' + part.text.split('\n').map((l: string) => '  ' + l).join('\n'));
  }
  if (r.result?.isError) console.log('\n  [the server marked this an error — expected when it refuses something]');
  console.log('');
}

// ── handshake, required before anything else ─────────────────────────────────

const hello = await ask('initialize', {
  protocolVersion: cmd === 'oldversion' ? '1999-01-01' : '2025-06-18',
  capabilities: {}, clientInfo: { name: 'mcp-check', version: '1' },
});
shout(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));

const call = (name: string, args: any) => ask('tools/call', { name, arguments: args });

// A whole task: what to do, what proves it worked, what it changes. The verify
// steps are required — which is what `newbad` exists to demonstrate.
const GOOD = (title: string) => ({
  title,
  task: 'Written by mcp-check to prove the write path works. Delete this task afterwards.',
  verify: ['The task file appeared in tasks/todo', 'The dashboard shows it in the queue'],
  touches: ['sf-refund-order'],
  context: 'Refunds live in the Orders area.',
});
const BAD = (title: string) => ({ title, task: 'No verify steps, on purpose — the server must refuse this.' });

switch (cmd) {
  case 'init':
  case 'oldversion': {
    head(cmd === 'oldversion' ? 'Introduced an unknown protocol version' : 'Handshake');
    const r = hello.result;
    console.log('  protocol version in reply :', r.protocolVersion);
    console.log('  server                    :', r.serverInfo.name, r.serverInfo.version);
    console.log('  offers                    :', Object.keys(r.capabilities).join(', '));
    console.log('\n  what it tells the editor about itself:\n');
    console.log((r.instructions || '(none)').split('\n').map((l: string) => '    ' + l).join('\n'));
    console.log('');
    break;
  }
  case 'tools': {
    head('Tools, and what each admits about its own behaviour');
    const r = await ask('tools/list', {});
    for (const t of r.result.tools) {
      const a = t.annotations;
      console.log('');
      console.log('  ' + t.name);
      console.log('    ' + (t.description || '').split('\n')[0].slice(0, 100));
      if (!a) { console.log('    !! NO BEHAVIOUR HINTS — every tool should carry them'); continue; }
      console.log(`    read-only: ${a.readOnlyHint ? 'yes' : 'NO'}`
        + `   destructive: ${a.destructiveHint ? 'YES' : 'no'}`
        + `   safe to repeat: ${a.idempotentHint ? 'yes' : 'NO'}`
        + `   reaches outside: ${a.openWorldHint ? 'YES' : 'no'}`);
    }
    console.log(`\n  ${r.result.tools.length} tools\n`);
    break;
  }
  case 'prompts': {
    head('Skills, served as prompts');
    const r = await ask('prompts/list', {});
    for (const p of r.result.prompts) console.log('  ' + p.name.padEnd(24) + (p.description || '').slice(0, 60));
    console.log(`\n  ${r.result.prompts.length} prompts\n`);
    break;
  }
  case 'prompt': {
    head('Skill text: ' + arg);
    const r = await ask('prompts/get', { name: arg, arguments: {} });
    if (r.error) { console.log(`\n  ERROR: ${r.error.code} ${r.error.message}\n`); break; }
    const text = r.result.messages[0].content.text;
    console.log('\n  role:', r.result.messages[0].role, '| length:', text.length, 'characters');
    console.log('\n  first 20 lines:\n');
    console.log(text.split('\n').slice(0, 20).map((l: string) => '    ' + l).join('\n'));
    console.log('\n  ...\n');
    break;
  }
  case 'setup':  head('Setting the project up');    show(await call('gitmir_setup', {})); break;
  case 'skills': head('The procedures on offer');   show(await call('gitmir_skills', {})); break;
  case 'skill':  head('Procedure: ' + arg);         show(await call('gitmir_skill', { name: arg })); break;
  case 'model':  head('The product model');        show(await call('gitmir_model', arg ? { dimension: arg } : {})); break;
  case 'nav':    head('Object: ' + arg);           show(await call('gitmir_navigate', { id: arg })); break;
  case 'impact': head('What it would reach: ' + arg);
    show(await call('gitmir_impact', arg.endsWith('.md') ? { task: arg } : { ids: arg.split(/[,\s]+/).filter(Boolean) }));
    break;
  case 'queue':    head('The queue');                       show(await call('gitmir_queue', {})); break;
  case 'flag':     head('Recording a finding');
    show(await call('gitmir_flag', {
      rule: 'A refund must never exceed what was actually paid for the order.',
      actual: 'refundOrder subtracts the requested amount without checking it against the order total.',
      consequence: 'A partial refund larger than the payment leaves the shop owing money.',
      source: 'mcp-check, to prove the write path works — delete it afterwards',
      touches: ['sf-refund-order'], kind: 'contradicts-spec', severity: 'high', readFrom: ['src/refund.ts'],
    })); break;
  case 'findings': head('Where the code disagrees with the product'); show(await call('gitmir_findings', { status: arg || 'open' })); break;
  case 'attention': head('What needs a person');                    show(await call('gitmir_attention', {})); break;
  case 'accept':   head('Deciding to live with one');
    show(await call('gitmir_accept_finding', { id: argv[2], status: 'accepted', by: 'mcp-check', why: 'Proving the decision path records a name and a reason.' })); break;
  case 'history':  head('How the product changed');           show(await call('gitmir_history', arg ? { days: Number(arg) } : {})); break;
  case 'versions': head('Versions of the model');             show(await call('gitmir_history', { list: true })); break;
  case 'new':      head('Writing a task: ' + arg);          show(await call('gitmir_create_task', GOOD(arg))); break;
  case 'newbad':   head('A task with no checks (expect a refusal)'); show(await call('gitmir_create_task', BAD(arg))); break;
  case 'approve':  head('Approving');                       show(await call('gitmir_approve', { column: argv[2], file: argv[3] })); break;
  case 'withdraw': head('Withdrawing an approval');         show(await call('gitmir_approve', { column: argv[2], file: argv[3], withdraw: true })); break;

  case 'junk': {
    head('Broken JSON');
    shout('{ this is not json at all');
    await pause(300);
    const answer = uninvited.find((m) => m.error);
    console.log('\n  the server replied :', answer ? `${answer.error.code} ${answer.error.message}` : '(nothing)');
    const still = await ask('ping', {});
    console.log('  still alive after it :', still.result ? 'yes, answers ping' : 'NO');
    console.log('');
    break;
  }
  case 'badmethod': {
    head('A method that does not exist');
    const r = await ask('resources/list', {});
    console.log('\n  reply :', r.error ? `${r.error.code} ${r.error.message}` : 'no error, which is suspicious');
    console.log('');
    break;
  }
  case 'badtool': {
    head('A tool that does not exist');
    const r = await call('gitmir_no_such_tool', {});
    console.log('\n  reply :', r.error ? `${r.error.code} ${r.error.message}` : 'no error, which is suspicious');
    console.log('');
    break;
  }
  case 'raw': {
    head('One message, verbatim');
    shout(arg);
    await pause(400);
    console.log('\n' + JSON.stringify(uninvited, null, 2).split('\n').map((l) => '  ' + l).join('\n') + '\n');
    break;
  }
  default:
    console.log(HELP);
}

// The server's log belongs on stderr; stdout is for messages and nothing else.
if (log.trim()) console.log('  server log (stderr, this is where it belongs):\n' + log.trim().split('\n').map((l) => '    ' + l).join('\n') + '\n');
if (uninvited.length && !['junk', 'raw'].includes(cmd)) {
  console.log('  !! the server sent something nobody asked for:\n' + uninvited.map((m) => '    ' + JSON.stringify(m).slice(0, 120)).join('\n') + '\n');
}

srv.stdin.end();
process.exit(0);
