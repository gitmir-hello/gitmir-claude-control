#!/usr/bin/env node
// The `gitmir` command.
//
// Written in Node rather than shell because Node is already the one hard
// requirement, and a launcher written twice — once in bash, once in PowerShell —
// is a launcher fixed twice and fixed differently. This file is the whole
// implementation; the shims beside it just call into it.
//
// It starts nothing you could not start yourself: `node server.ts` in the
// install directory is the program. This exists so nobody has to remember where
// that directory is.

import { spawn, execFileSync } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// realpath, because on POSIX this is reached through a symlink on the PATH and
// the launcher has to find the checkout it belongs to, not the bin directory.
const DIR = path.dirname(fs.realpathSync(HERE));
const STATE = process.env.GITMIR_STATE || path.join(os.homedir(), '.gitmir');
const PORT = Number(process.env.GITMIR_PORT || 4599);
const LOG = path.join(STATE, 'server.log');
const PIDF = path.join(STATE, 'server.pid');

const tty = process.stdout.isTTY;
const c = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const say = (...a) => console.log('  ' + a.join(' '));
const die = (msg) => { console.error(`\n  ${c('1;31', '✕')} ${msg}\n`); process.exit(1); };

fs.mkdirSync(STATE, { recursive: true });

// --- is it up ----------------------------------------------------------------
// The port is the honest test. A pid file survives a crash and would claim a
// server that is not there; a server someone started by hand has no pid file.
function listening(port = PORT, ms = 350) {
  return new Promise((res) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    const done = (v) => { s.destroy(); res(v); };
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
    setTimeout(() => done(false), ms);
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function nodeOk() {
  const [maj, min] = process.versions.node.split('.').map(Number);
  return maj > 22 || (maj === 22 && min >= 18);
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : ['xdg-open', [url]];
  try { spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true }).unref(); } catch {}
}

/**
 * Run the Claude CLI.
 *
 * On Windows it is a .cmd shim, and execFileSync cannot execute those — it fails
 * with ENOENT, which the caller would report as "claude is not on your PATH"
 * while `gitmir status` says it is, using `where`. Two of our own screens
 * contradicting each other is a worse failure than the one being reported.
 *
 * Candidates rather than a shell, so a path with a space in it stays one argument.
 */
function runClaude(args, opts = {}) {
  const names = process.platform === 'win32' ? ['claude.cmd', 'claude.exe', 'claude'] : ['claude'];
  let last;
  for (const name of names) {
    try { return execFileSync(name, args, opts); }
    catch (e) { last = e; if (e.code !== 'ENOENT') throw e; }
  }
  throw last;
}

function git(args, opts = {}) {
  // stderr silenced: `status` asks git for a version it may not have, and
  // "fatal: not a git repository" printed above a clean report reads as a crash.
  return execFileSync('git', ['-C', DIR, ...args],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], ...opts });
}

// --- commands ----------------------------------------------------------------

// Node refuses to strip TypeScript types for anything under node_modules, so a
// global npm install cannot host the runtime — the server dies on the first
// import with a stack trace nobody should have to read. Say the actual thing.
const IN_NODE_MODULES = DIR.includes(`${path.sep}node_modules${path.sep}`);
function refuseNodeModules() {
  if (!IN_NODE_MODULES) return;
  die(`This copy lives under node_modules, and Node will not run TypeScript from there
    (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING) — which is what lets this project
    have no build step at all.

    Install it the way it expects instead:
      curl -fsSL https://ide.gitmir.com/install.sh | sh

    Then: npm rm -g gitmir-local`);
}

async function start() {
  refuseNodeModules();
  if (!nodeOk()) {
    die(`Node ${process.versions.node} is too old — this runs TypeScript with no build step, which needs 22.18 or newer.`);
  }
  if (await listening()) {
    say(c('0;36', 'Already running') + ` — http://localhost:${PORT}`);
    openBrowser(`http://localhost:${PORT}`);
    return;
  }
  const out = fs.openSync(LOG, 'a');
  const child = spawn(process.execPath, ['server.ts'], {
    cwd: DIR, detached: true, stdio: ['ignore', out, out],
    env: { ...process.env, GITMIR_PORT: String(PORT) },
  });
  child.unref();
  fs.writeFileSync(PIDF, String(child.pid));

  for (let i = 0; i < 60; i++) {
    if (await listening()) break;
    await wait(250);
  }
  if (!(await listening())) {
    console.error(`\n  ${c('1;31', '✕')} the server did not come up. Its log:\n`);
    try { console.error(fs.readFileSync(LOG, 'utf8').split('\n').slice(-20).map((l) => '    ' + l).join('\n')); } catch {}
    console.error('');
    process.exit(1);
  }
  console.log(`\n  ${c('1;36', 'GitMir Local')}  http://localhost:${PORT}`);
  say(`log: ${LOG}   ·   stop with: gitmir stop`);
  console.log('');
  openBrowser(`http://localhost:${PORT}`);
}

async function stop({ quiet = false } = {}) {
  if (!(await listening())) { if (!quiet) say('Not running.'); return; }
  let pid = 0;
  try { pid = Number(fs.readFileSync(PIDF, 'utf8').trim()); } catch {}
  if (!pid) {
    // Started by hand, or the pid file is gone. Find whoever holds the port.
    try {
      const out = process.platform === 'win32'
        ? execFileSync('cmd', ['/c', `netstat -ano | findstr :${PORT}`], { encoding: 'utf8' })
        : execFileSync('lsof', ['-nP', `-iTCP:${PORT}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' });
      pid = Number(String(out).trim().split(/\s+/).filter(Boolean).pop());
    } catch {}
  }
  if (!pid) die(`Something is serving port ${PORT} and I cannot tell what. Stop it yourself, or set GITMIR_PORT.`);
  try { process.kill(pid); } catch {}
  try { fs.unlinkSync(PIDF); } catch {}
  say('Stopped.');
}

async function update() {
  if (!fs.existsSync(path.join(DIR, '.git'))) {
    // Installed by npm, or from a tarball: there is no history to pull. Point at
    // whichever route actually put it here rather than at the one we prefer.
    const viaNpm = DIR.includes(`${path.sep}node_modules${path.sep}`);
    die(viaNpm
      ? `Installed through npm, so there is no git history here to pull.\n    Update with:  npm i -g github:gitmir-hello/gitmir-local`
      : `${DIR} is not a git checkout — there is no history here to pull.\n    Update by running the installer again:\n      curl -fsSL https://ide.gitmir.com/install.sh | sh`);
  }
  say(`Updating ${DIR}`);
  const before = git(['rev-parse', '--short', 'HEAD']).trim();
  try { console.log(git(['pull', '--ff-only']).split('\n').map((l) => '  ' + l).join('\n')); }
  catch (e) { die(`git pull failed:\n    ${String(e.message || e).split('\n')[0]}`); }
  const after = git(['rev-parse', '--short', 'HEAD']).trim();
  if (before === after) { say('Already current.'); return; }
  if (await listening()) {
    say('Restarting the running server so it picks this up.');
    await stop({ quiet: true });
    await wait(800);
    await start();
  }
}

function mcpConfig() {
  return JSON.stringify({
    mcpServers: { gitmir: { command: 'node', args: [path.join(DIR, 'mcp.ts')] } },
  }, null, 2);
}

function mcp(sub) {
  // Registering with the agent is where people got stuck: an MCP server has no
  // screen, so a config that never took looks exactly like one that did.
  if (sub === 'add' || sub === 'add-here') {
    // `claude mcp add` defaults to local scope — the registration lives in the
    // directory you happened to run it from. Somebody who runs this once, from
    // anywhere, and then opens their editor in a project finds nothing there and
    // reasonably concludes it did not work.
    //
    //   add       -> user scope: every project, answering about whichever one the
    //               editor was opened in, because the server falls back to its cwd.
    //   add-here  -> project scope: writes .mcp.json into this folder, which is
    //               committed and therefore arrives for teammates too.
    const scope = sub === 'add-here' ? 'project' : 'user';
    const args = ['mcp', 'add', '-s', scope, 'gitmir', '--', 'node', path.join(DIR, 'mcp.ts')];
    try {
      console.log(runClaude(args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim());
    } catch (e) {
      // Every failure used to report the same cause — "claude is not on your PATH" —
      // including the common one where it is on the PATH and the server is simply
      // already registered. Being told the wrong reason is worse than being told
      // nothing: it sends somebody to fix a thing that is not broken.
      const said = `${e.stdout || ''}${e.stderr || ''}`.trim();
      if (e.code === 'ENOENT') {
        die("The 'claude' CLI is not on your PATH.\n    Run `gitmir mcp` and paste the config into your editor's MCP settings instead.");
      }
      if (/already exists/i.test(said)) {
        say(`${c('0;36', 'Already registered')} — gitmir is in your ${scope} config.`);
        say(`Pointing at: ${path.join(DIR, 'mcp.ts')}`);
        say(`To repoint it at this checkout:  claude mcp remove -s ${scope} gitmir && gitmir mcp${sub === 'add-here' ? ' add-here' : ' add'}`);
        console.log('');
        say('Check what it resolves to now:  claude mcp list');
        console.log('');
        return;
      }
      die(`claude could not register it:\n    ${said.split('\n')[0] || String(e.message || e)}`);
    }
    console.log('');
    if (scope === 'user') {
      say('Added for every project. The server answers about whichever folder your editor is open in.');
      say(`To pin it to one repository instead — and commit it for teammates: ${c('0;36', 'gitmir mcp add-here')}`);
    } else {
      say(`Added to .mcp.json in ${process.cwd()} — commit it and your teammates get it too.`);
    }
    console.log('');
    say(`${c('1;37', 'Restart your editor')} — a client reads its MCP config once, at startup.`);
    say(`Then say: ${c('0;36', 'set this project up with GitMir')}`);
    say(`All twelve skills arrive as slash commands; nothing has to be pasted.`);
    console.log('');
    return;
  }
  console.log("\n  Point your editor's MCP settings at this:\n");
  console.log(mcpConfig().split('\n').map((l) => '    ' + l).join('\n'));
  console.log(`\n  Or, with the Claude Code CLI:  ${c('0;36', 'gitmir mcp add')}\n`);
}

/**
 * Ask the MCP server a question and print what it said.
 *
 * The long form of this is `cd <checkout> && node mcp-check.ts <project> model`,
 * which is three things to get right in a line somebody is copying while already
 * unsure whether anything works. This is the same call with the paths filled in.
 */
function check(arg) {
  const project = path.resolve(arg || process.cwd());
  if (!fs.existsSync(project)) die(`No such folder: ${project}`);
  say(`Asking the server about ${project}`);
  console.log('');
  try {
    execFileSync(process.execPath, ['mcp-check.ts', project, 'model'], { cwd: DIR, stdio: 'inherit' });
  } catch {
    die('The check did not run. `gitmir status` will say whether Node is new enough.');
  }
}

async function doctor() {
  const has = (cmd) => {
    try { execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' }); return true; }
    catch { return false; }
  };
  let deps = '?';
  try { deps = String(Object.keys(JSON.parse(fs.readFileSync(path.join(DIR, 'package.json'), 'utf8')).dependencies || {}).length); } catch {}
  let ver = '(not a git checkout)';
  try { ver = git(['log', '--oneline', '-1']).trim(); } catch {}

  const row = (k, v) => console.log('  ' + k.padEnd(16) + v);
  console.log(`\n  ${c('1;36', 'GitMir Local')}\n`);
  row('install', DIR);
  row('state', STATE);
  row('node', 'v' + process.versions.node + (nodeOk() ? '' : c('1;31', '  TOO OLD — needs 22.18+')));
  row('claude CLI', has('claude') ? 'on PATH' : c('1;33', 'missing — the Run Claude button needs it'));
  row(`port ${PORT}`, (await listening()) ? 'serving' : 'not running');
  row('version', ver);
  row('runtime deps', deps);
  if (IN_NODE_MODULES) {
    console.log('');
    say(c('1;31', '✕') + ' Installed under node_modules — Node will not run TypeScript from there.');
    say('  Use the installer instead:  curl -fsSL https://ide.gitmir.com/install.sh | sh');
  }
  console.log('');
}

const HELP = `
  ${c('1;36', 'gitmir')} — the local dashboard for running Claude Code across projects

    gitmir              start it and open the browser
    gitmir stop         stop the server
    gitmir restart      stop, then start
    gitmir status       node, port, version, what is missing
    gitmir update       git pull, and restart if it was running
    gitmir mcp          the MCP config for your editor
    gitmir mcp add      register it for every project (Claude Code CLI)
    gitmir mcp add-here pin it to this folder, in a committed .mcp.json
    gitmir check [dir]  ask the server what it knows, and print the answer
    gitmir log [n]      the last n lines the server printed
    gitmir path         where the checkout lives

  Port ${PORT}, or set GITMIR_PORT.
`;

const [cmd = 'start', arg] = process.argv.slice(2);
switch (cmd) {
  case 'start': await start(); break;
  case 'stop': await stop(); break;
  case 'restart': await stop({ quiet: true }); await wait(800); await start(); break;
  case 'status': case 'doctor': await doctor(); break;
  case 'update': await update(); break;
  case 'mcp': mcp(arg); break;
  case 'check': check(arg); break;
  case 'path': console.log(DIR); break;
  case 'log':
    try { console.log(fs.readFileSync(LOG, 'utf8').split('\n').slice(-(Number(arg) || 40)).join('\n')); }
    catch { say('Nothing logged yet.'); }
    break;
  case 'help': case '-h': case '--help': console.log(HELP); break;
  default: die(`No such command: ${cmd}   (try: gitmir help)`);
}
