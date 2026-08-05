// GITMIR Claude Control — local dashboard for running Claude Code across projects.
// Copyright (C) 2026 GITMIR
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify it under the
// terms of the GNU Affero General Public License as published by the Free Software
// Foundation, either version 3 of the License, or (at your option) any later version.
// It is distributed WITHOUT ANY WARRANTY; see the LICENSE file for the full text.
// A commercial license is also available — see LICENSING.md.

import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile, spawn } from 'node:child_process';

// ---------- the shapes this dashboard actually moves around ----------
/** A folder the user added, as stored in projects.json. */
interface Project { name: string; path: string; color?: string; description?: string }
/** An entry in skills.json — a prompt kept in its own .md file. */
interface Skill { name: string; title?: string; desc?: string; file: string; stripFrontmatter?: boolean; prepend?: string }
type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

// The native folder picker is reliable on macOS, Linux and Windows 10, but on
// Windows 11 a dialog spawned by a background process gets suppressed — so we hide
// the "Browse…" button there and let the user paste the path instead.
function nativePickerAvailable(): boolean {
  if (process.platform === 'darwin' || process.platform === 'linux') return true;
  if (process.platform === 'win32') {
    const m = /^10\.0\.(\d+)/.exec(os.release() || '');
    return (m ? parseInt(m[1], 10) : 0) < 22000; // Win11 is build >= 22000
  }
  return false;
}

import * as relay from './relay.ts';

// Fixed by default so the URL is memorable, but overridable: 4599 may be taken, and
// two people on one machine need different ports.
const PORT = Number(process.env.GITMIR_PORT || 4599) || 4599;
const DATA_FILE = path.join(import.meta.dirname, 'projects.json');
const SKILLS_FILE = path.join(import.meta.dirname, 'skills.json');

// ---------- storage ----------
function loadProjects(): Project[] {
  try {
    const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}
function saveProjects(list: Project[]): void {
  fs.writeFileSync(DATA_FILE, JSON.stringify(list, null, 2));
}

// ---------- skills registry ----------
function loadSkills(): Skill[] {
  try {
    const data = JSON.parse(fs.readFileSync(SKILLS_FILE, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}
function resolveSkillFile(f: string): string | null {
  return path.isAbsolute(f) ? f : path.join(import.meta.dirname, f);
}
function stripFrontmatter(text: string): string {
  if (text.startsWith('---')) {
    const end = text.indexOf('\n---', 3);
    if (end !== -1) {
      const after = text.indexOf('\n', end + 1);
      if (after !== -1) return text.slice(after + 1).replace(/^\s+/, '');
    }
  }
  return text;
}

// ---------- osascript helpers ----------
function osascript(script: string, args: string[] = []): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', script, ...args], { timeout: 120000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message || '').trim()));
      resolve(stdout.trim());
    });
  });
}

// Native macOS folder picker -> POSIX path (no trailing slash), or null if cancelled.
// Native folder picker -> selected path, or null if cancelled. Detects the OS.
async function chooseFolder(): Promise<string | null> {
  const plat = process.platform;

  // macOS — osascript "choose folder"
  if (plat === 'darwin') {
    const script =
      'try\n' +
      '  set f to choose folder with prompt "Choose a project folder for Claude"\n' +
      '  return POSIX path of f\n' +
      'on error number -128\n' +
      '  return ""\n' +
      'end try';
    const out = await osascript(script);
    return out ? out.replace(/\/+$/, '') : null;
  }

  // Windows — Shell COM folder browser (more tolerant of foreground rules on Win11
  // than WinForms FolderBrowserDialog). If it still can't show, the UI offers a
  // manual path field.
  if (plat === 'win32') {
    const ps =
      '$ErrorActionPreference="Stop"; ' +
      '$a = New-Object -ComObject Shell.Application; ' +
      "$f = $a.BrowseForFolder(0, 'Choose a project folder for Claude', 0x51, 0); " +   // BIF_RETURNONLYFSDIRS|BIF_EDITBOX|BIF_NEWDIALOGSTYLE
      'if ($f -ne $null -and $f.Self -ne $null) { [Console]::Out.Write($f.Self.Path) }';
    return new Promise((resolve, reject) => {
      execFile('powershell.exe', ['-NoProfile', '-STA', '-Command', ps], { timeout: 300000 }, (err, stdout, stderr) => {
        if (err && !stdout) return reject(new Error((stderr || err.message || '').trim() || 'folder picker failed'));
        const p = (stdout || '').trim();
        resolve(p ? p.replace(/[\\/]+$/, '') : null);
      });
    });
  }

  // Linux — zenity, then kdialog (best-effort)
  const home = process.env.HOME || '.';
  const tools = [
    ['zenity', ['--file-selection', '--directory', '--title=Choose a project folder for Claude']],
    ['kdialog', ['--getexistingdirectory', home]],
  ];
  for (const [bin, args] of tools) {
    try {
      const p = await new Promise<string>((resolve, reject) => {
        execFile(bin as string, args as string[], { timeout: 180000 }, (err: any, stdout: string) => {
          if (err && err.code === 'ENOENT') return reject(err);   // tool not installed -> try next
          resolve((stdout || '').trim());                          // empty = cancelled
        });
      });
      return p ? p.replace(/\/+$/, '') : null;
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') throw e;
    }
  }
  throw new Error('no folder picker found (install zenity or kdialog)');
}

// Open a terminal in the folder and run `claude` — detects the OS.
function openInTerminal(projectPath: string) {
  const plat = process.platform;

  // macOS — Terminal.app via osascript (path passed as argv -> no injection).
  if (plat === 'darwin') {
    const script =
      'on run argv\n' +
      '  set p to item 1 of argv\n' +
      '  tell application "Terminal"\n' +
      '    activate\n' +
      '    do script "cd " & quoted form of p & " && claude"\n' +
      '  end tell\n' +
      'end run';
    return osascript(script, [projectPath]);
  }

  // Windows — new console window in the project dir running claude, kept open (/k).
  // `start "" /D <dir> cmd /k claude` avoids cd/quoting issues; Node quotes the path.
  if (plat === 'win32') {
    return new Promise((resolve, reject) => {
      const child = spawn('cmd.exe',
        ['/c', 'start', 'GITMIR Claude', '/D', projectPath, 'cmd', '/k', 'claude'],
        { detached: true, stdio: 'ignore', windowsHide: false });
      child.on('error', reject);
      child.unref();
      resolve('');
    });
  }

  // Linux — best-effort across common terminal emulators.
  if (plat === 'linux') {
    return new Promise((resolve, reject) => {
      const inner = 'cd ' + JSON.stringify(projectPath) + ' && claude; exec bash';
      const candidates = [
        ['x-terminal-emulator', ['-e', 'bash', '-lc', inner]],
        ['gnome-terminal', ['--', 'bash', '-lc', inner]],
        ['konsole', ['-e', 'bash', '-lc', inner]],
        ['xfce4-terminal', ['-e', 'bash -lc ' + JSON.stringify(inner)]],
        ['xterm', ['-e', 'bash', '-lc', inner]],
      ];
      let i = 0;
      const tryNext = () => {
        if (i >= candidates.length) return reject(new Error('no terminal emulator found'));
        const [bin, args] = candidates[i++] as [string, string[]];
        const c = spawn(bin, args, { detached: true, stdio: 'ignore' });
        c.on('error', tryNext);
        c.on('spawn', () => { c.unref(); resolve(''); });
      };
      tryNext();
    });
  }

  return Promise.reject(new Error('unsupported OS: ' + plat));
}

// Reveal a folder in the OS file manager. Detects the OS.
function revealInFinder(projectPath: string) {
  const plat = process.platform;
  if (plat === 'darwin') {
    const script =
      'on run argv\n' +
      '  tell application "Finder"\n' +
      '    activate\n' +
      '    open (POSIX file (item 1 of argv) as alias)\n' +
      '  end tell\n' +
      'end run';
    return osascript(script, [projectPath]);
  }
  if (plat === 'win32') {
    // explorer.exe returns a non-zero exit code even on success -> fire and forget
    return new Promise((resolve) => {
      const c = spawn('explorer.exe', [projectPath], { detached: true, stdio: 'ignore' });
      c.on('error', () => resolve('')); c.unref(); resolve('');
    });
  }
  return new Promise((resolve, reject) => {
    const c = spawn('xdg-open', [projectPath], { detached: true, stdio: 'ignore' });
    c.on('error', reject); c.on('spawn', () => { c.unref(); resolve(''); });
  });
}

// ---------- http helpers ----------
function sendJSON(res: ServerResponse, code: number, obj: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
// The parsed JSON body of a request. It is untrusted input, so the type says only
// "some object with some fields" — every handler validates the fields it uses before
// touching them, which is where the real checking lives.
function readBody(req: IncomingMessage): Promise<Record<string, any>> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
  });
}

// The dashboard listens on loopback, which stops the network but NOT the user's own
// browser: any page they visit could POST to localhost:4599 and drive this tool
// (open a terminal, repoint the team bridge at a hostile relay, read project paths).
// Accept API calls only from the dashboard's own origin, and reject a Host header
// that isn't localhost — that is what closes DNS rebinding.
function sameOrigin(req: IncomingMessage): boolean {
  const host = String(req.headers.host || '');
  if (!/^(localhost|127\.0\.0\.1|\[::1\]):?/.test(host)) return false;
  // Anything arriving on the preview origin is the framed site talking, not the
  // dashboard. It may use the preview endpoints and nothing else.
  if (host === PREVIEW_HOST + ':' + PORT) return false;
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return false;
  const origin = req.headers.origin;
  if (origin) {
    try {
      const o = new URL(origin);
      if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(o.hostname) || o.port !== String(PORT)) return false;
    } catch { return false; }
  }
  return true;
}

/* ------------------------------ preview & pick ------------------------------
 * Fetch any URL, serve it from here with the picker injected, and let the user
 * click an element to describe it. The frame is sandboxed WITHOUT
 * allow-same-origin, so the proxied site gets an opaque origin: it can run the
 * injected picker and postMessage back, but it cannot touch this dashboard's DOM
 * or call these APIs (its Origin is "null", which sameOrigin() refuses).
 */
// The dashboard is served on localhost; the preview is served on 127.0.0.1. Same
// server, same port, DIFFERENT ORIGIN — which is the whole trick. The framed site
// gets a real origin (so cookies, storage and ES modules all behave normally) while
// the same-origin policy still keeps it away from the dashboard's DOM and its APIs.
const PREVIEW_ON = process.env.GITMIR_PREVIEW !== '0';
const PREVIEW_HOST = '127.0.0.1';
const PREVIEW_ORIGIN = 'http://' + PREVIEW_HOST + ':' + PORT;
// Server-side escape. esc() in public/app.js is the browser's copy; this one is for
// the few strings the server itself puts into HTML.
const HESC_MAP: Record<string, string> = { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' };
const hesc = (s: unknown): string => String(s == null ? '' : s).replace(/[&<>"']/g, (c: string) => HESC_MAP[c] || c);
const PREVIEW_MAX = 2 * 1024 * 1024;   // documents only; this is not a CDN
const PREVIEW_TIMEOUT = 15000;

// The machine's own network is not ours to reach. Loopback IS allowed: pointing
// the preview at your own dev server (or at this dashboard) is the main use.
/** The reason this host is refused, or null when it is allowed. The reason is shown to the user. */
function blockedHost(hostname: string): string | null {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (/^169\.254\./.test(h)) return 'link-local addresses (cloud metadata lives there)';
  if (/^10\./.test(h)) return 'private network addresses';
  if (/^192\.168\./.test(h)) return 'private network addresses';
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return 'private network addresses';
  if (/^(fc|fd)[0-9a-f]{2}:/.test(h)) return 'private network addresses';
  if (h === 'fe80::' || /^fe80:/.test(h)) return 'link-local addresses';
  if (/\.internal$|\.local$/.test(h)) return 'internal network names';
  return null;
}
const isLoopback = (h: unknown): boolean => /^(localhost|127\.|::1$|0\.0\.0\.0$)/.test(String(h || '').toLowerCase().replace(/^\[|\]$/g, ''));

// The picker. Injected into the proxied document; namespaced so it cannot collide
// with the page it lands in, and it removes everything it added when it turns off.
const PREVIEW_BRIDGE = `(function(){
  if (window.__gitmirPick) return;
  var box=null, label=null, on=false, last=null;
  function mk(){
    box=document.createElement('div'); label=document.createElement('div');
    box.setAttribute('data-gitmir','ui'); label.setAttribute('data-gitmir','ui');
    box.style.cssText='position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #2fd8ff;background:rgba(47,216,255,.10);box-shadow:0 0 0 1px rgba(0,0,0,.4);transition:all .04s linear';
    label.style.cssText='position:fixed;z-index:2147483647;pointer-events:none;background:#04060a;color:#2fd8ff;font:11px/1.6 ui-monospace,monospace;padding:2px 7px;border:1px solid #2fd8ff;white-space:nowrap;max-width:90vw;overflow:hidden;text-overflow:ellipsis';
    document.documentElement.appendChild(box); document.documentElement.appendChild(label);
  }
  function rm(){ if(box&&box.parentNode)box.parentNode.removeChild(box); if(label&&label.parentNode)label.parentNode.removeChild(label); box=label=null; }
  function desc(el){
    var t=el.tagName.toLowerCase();
    if(el.id) return t+'#'+el.id;
    var c=(el.className&&el.className.baseVal!==undefined?el.className.baseVal:el.className)||'';
    c=String(c).trim().split(/\\s+/).filter(Boolean).slice(0,2).join('.');
    return c? t+'.'+c : t;
  }
  function paint(el){
    if(!box) mk();
    var r=el.getBoundingClientRect();
    box.style.left=r.left+'px'; box.style.top=r.top+'px'; box.style.width=r.width+'px'; box.style.height=r.height+'px';
    label.textContent=desc(el)+'  '+Math.round(r.width)+'×'+Math.round(r.height);
    var ly=r.top>22?r.top-22:r.bottom+2;
    label.style.left=r.left+'px'; label.style.top=ly+'px';
  }
  function over(e){ if(!on) return; var el=e.target; if(!el||el===last) return; last=el; paint(el); }
  // Build the shortest selector that still matches exactly one element. An
  // nth-child chain from <body> is what a naive version produces and it breaks the
  // moment anything above it moves.
  function uniq(sel){ try{ return document.querySelectorAll(sel).length===1; }catch(e){ return false; } }
  function cssEsc(s){ return (window.CSS&&CSS.escape)?CSS.escape(s):String(s).replace(/[^a-zA-Z0-9_-]/g,'\\\\$&'); }
  function selectorFor(el){
    var tid=el.getAttribute('data-testid')||el.getAttribute('data-test')||el.getAttribute('data-cy');
    if(tid){ var s='[data-testid="'+tid+'"]'; if(uniq(s)) return s;
             s='[data-test="'+tid+'"]'; if(uniq(s)) return s; }
    if(el.id){ var si='#'+cssEsc(el.id); if(uniq(si)) return si; }
    var t=el.tagName.toLowerCase();
    var cls=String((el.className&&el.className.baseVal!==undefined?el.className.baseVal:el.className)||'').trim().split(/\\s+/).filter(Boolean);
    for(var n=1;n<=Math.min(3,cls.length);n++){
      var s2=t+'.'+cls.slice(0,n).map(cssEsc).join('.');
      if(uniq(s2)) return s2;
    }
    var parts=[], cur=el, depth=0;
    while(cur&&cur.nodeType===1&&depth<5){
      var p=cur.tagName.toLowerCase();
      if(cur.id){ parts.unshift('#'+cssEsc(cur.id)); break; }
      var par=cur.parentElement;
      if(par){ var same=Array.prototype.filter.call(par.children,function(x){return x.tagName===cur.tagName;});
        if(same.length>1) p+=':nth-of-type('+(same.indexOf(cur)+1)+')'; }
      parts.unshift(p); cur=par; depth++;
      var joined=parts.join(' > ');
      if(uniq(joined)) return joined;
    }
    return parts.join(' > ');
  }
  // Never hand back our own scaffolding: the shim, the <base>, the picker script and
  // the highlight boxes are ours, not the page's, and they would only mislead.
  function clean(el){
    var c;
    try{ c=el.cloneNode(true); }catch(e){ return null; }
    try{
      var kill=c.querySelectorAll?c.querySelectorAll('[data-gitmir]'):[];
      for(var i=kill.length-1;i>=0;i--) if(kill[i].parentNode) kill[i].parentNode.removeChild(kill[i]);
      if(c.style && c.style.cursor==='crosshair'){ c.style.cursor=''; if(!c.getAttribute('style')) c.removeAttribute('style'); }
    }catch(e){}
    return c;
  }
  // Text the user can actually see — style and script contents are not that.
  function visibleText(node){
    try{
      var c=node.cloneNode(true);
      var junk=c.querySelectorAll?c.querySelectorAll('script,style,noscript,template'):[];
      for(var i=junk.length-1;i>=0;i--) if(junk[i].parentNode) junk[i].parentNode.removeChild(junk[i]);
      return (c.textContent||'').trim().replace(/\\s+/g,' ');
    }catch(e){ return (node.textContent||'').trim().replace(/\\s+/g,' '); }
  }
  function payload(el){
    var cl=clean(el);
    var cls=String((el.className&&el.className.baseVal!==undefined?el.className.baseVal:el.className)||'').trim().split(/\\s+/).filter(Boolean);
    var r=el.getBoundingClientRect();
    var anc=[], cur=el.parentElement, d=0;
    while(cur&&cur.nodeType===1&&d<3){ anc.unshift(desc(cur)); cur=cur.parentElement; d++; }
    return { type:'gitmir:picked', url:(window.__gitmirUrl||location.href),
      selector:selectorFor(el), tag:el.tagName.toLowerCase(),
      candidates:{ testid:el.getAttribute('data-testid')||el.getAttribute('data-test')||el.getAttribute('data-cy')||null,
        id:el.id||null, classes:cls.slice(0,8),
        text:visibleText(cl||el).slice(0,200)||null,
        aria:el.getAttribute('aria-label')||null },
      attrs:{ type:el.getAttribute('type')||null, href:el.getAttribute('href')||null, name:el.getAttribute('name')||null },
      rect:{ x:Math.round(r.left), y:Math.round(r.top), w:Math.round(r.width), h:Math.round(r.height) },
      html:((cl&&cl.outerHTML)||el.outerHTML||'').slice(0,16384), ancestors:anc };   // the element WITH its subtree
  }
  function click(e){
    if(!on) return;
    e.preventDefault(); e.stopPropagation();
    if(e.stopImmediatePropagation) e.stopImmediatePropagation();
    var data; try{ data=payload(e.target); }catch(err){ data={type:'gitmir:picked',error:String(err&&err.message||err)}; }
    off(); parent.postMessage(data,'*');
  }
  function key(e){ if(on&&e.key==='Escape'){ off(); parent.postMessage({type:'gitmir:pick-cancelled'},'*'); } }
  function tell(){ try{ parent.postMessage({type:'gitmir:pick-state', on:on}, '*'); }catch(e){} }
  function onMode(){ on=true; last=null; document.documentElement.style.cursor='crosshair'; tell(); }
  function off(){ on=false; last=null; rm(); document.documentElement.style.cursor=''; tell(); }
  document.addEventListener('mouseover',over,true);
  document.addEventListener('click',click,true);
  document.addEventListener('keydown',key,true);
  window.addEventListener('message',function(e){
    var t=e.data&&e.data.type;
    if(t==='gitmir:pick-on') onMode(); else if(t==='gitmir:pick-off') off();
  });
  window.__gitmirPick=true;
  parent.postMessage({type:'gitmir:bridge-ready',url:(window.__gitmirUrl||location.href)},'*');
})();`;

// Loopback is the machine itself: previewing your own dev server is the main use, but
// a framed page must not be able to aim the proxy at localhost and read this
// dashboard's API through it. So it is allowed only for URLs the user opened, and the
// mirror then serves that page's own assets.
const loopbackOk = new Set();
// Only one preview runs at a time, so the preview origin can act as a transparent
// mirror of that one site: every path on it maps to the same path upstream. This is
// what makes ROOT-RELATIVE urls work — /css/style.css resolves against the origin
// and ignores <base> entirely, which is why prefixing paths could never be enough.
let previewSite: string | null = null;   // e.g. 'https://example.com'
/**
 * Either a fetched document or the reason it was refused — as a discriminated union, so
 * `if (got.error) return ...` narrows the rest of the function to the success shape and
 * body/status/finalUrl are known to be there. No assertions, no runtime change.
 */
type PreviewResult =
  | { error: string }
  | { status: number; contentType: string; body: Buffer; finalUrl: string };
async function previewFetch(rawUrl: string, allowLoopback: boolean): Promise<PreviewResult> {
  let u;
  try { u = new URL(rawUrl); } catch { return { error: 'That is not a valid URL.' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { error: 'Only http:// and https:// can be previewed.' };
  const firstIsLoopback = isLoopback(u.hostname);
  if (firstIsLoopback && !allowLoopback && !loopbackOk.has(u.host)) {
    return { error: `Refused ${u.host} — a page inside the preview cannot point it at this machine.` };
  }
  let hops = 0;
  for (;;) {
    const why = blockedHost(u.hostname);
    if (why) return { error: `Refused ${u.hostname} — ${why} are not fetched, to keep this from being pointed at your own network.` };
    // A public page must not be able to redirect us onto the loopback interface.
    if (!firstIsLoopback && isLoopback(u.hostname) && hops > 0) return { error: `Refused a redirect to ${u.hostname} — a public page cannot send the preview to your local machine.` };
    let r;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), PREVIEW_TIMEOUT);
    try {
      r = await fetch(u.href, { redirect: 'manual', signal: ctl.signal, headers: { 'user-agent': 'GitMirClaudeControl/preview', accept: 'text/html,*/*' } });
    } catch (e) {
      clearTimeout(timer);
      return { error: `Could not reach ${u.hostname}: ${(e as Error)?.message || e}` };
    }
    clearTimeout(timer);
    if ([301, 302, 303, 307, 308].includes(r.status)) {
      const loc = r.headers.get('location');
      if (!loc || ++hops > 5) return { error: 'Too many redirects.' };
      try { u = new URL(loc, u.href); } catch { return { error: 'Bad redirect target.' }; }
      continue;
    }
    const ct = r.headers.get('content-type') || '';
    const buf = Buffer.from(await r.arrayBuffer());
    return { status: r.status, contentType: ct, body: buf.slice(0, PREVIEW_MAX), finalUrl: u.href };
  }
}

// Everything served as HTML on the preview origin goes through here, so the picker
// survives a redirect or a click on a link inside the site. Serving a second document
// without the bridge is exactly how "Select" stopped doing anything.
/**
 * Replace `from` with `to` everywhere EXCEPT inside <script> element contents.
 *
 * Rewriting a script's body is what broke the preview on any Next.js App Router site: the
 * React Server Components payload is a stream of rows prefixed with a hex length, so
 * shortening a URL inside it makes every later offset wrong and the client decoder throws.
 */
function rewriteOutsideScripts(html: string, from: string, to: string): string {
  const re = /<script\b[^>]*>[\s\S]*?<\/script\s*>/gi;
  let out = '', last = 0, m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    out += html.slice(last, m.index).split(from).join(to);   // markup — rewrite
    out += m[0];                                             // script — byte-exact
    last = m.index + m[0].length;
  }
  return out + html.slice(last).split(from).join(to);
}

function preparePreviewHtml(buf: Buffer, finalUrl: string): string {
  let html = buf.toString('utf8');
  const fu = new URL(finalUrl);
  // <base> plus rewriting absolute same-site urls keeps every asset on the mirror,
  // which is the same origin as this document — no CORS anywhere.
  const base = `<base data-gitmir="base" href="${hesc(PREVIEW_ORIGIN + fu.pathname)}">`;
  html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => m + base) : base + html;
  // ...but ONLY in the markup, never inside a <script>. A framework can embed its own
  // state there in a length-prefixed format — Next.js streams React Server Components as
  // rows that begin with a hex character count — and this origin is one character shorter
  // than a real one, so rewriting a URL inside that payload desynchronises the decoder.
  // The page then renders, hydrates, throws "enqueueModel is not a function" and dies,
  // which looks like a network failure and is not. Script contents are left byte-exact;
  // any absolute URL in there simply resolves to the real site, which is harmless.
  html = rewriteOutsideScripts(html, fu.origin + '/', PREVIEW_ORIGIN + '/');
  html = html.replace(/\scrossorigin(=("[^"]*"|'[^']*'|[^\s>]+))?/gi, '');
  const shim = 'try{localStorage.getItem("x")}catch(e){var __m={};var __s={getItem:function(k){return __m[k]===undefined?null:__m[k]},setItem:function(k,v){__m[k]=String(v)},removeItem:function(k){delete __m[k]},clear:function(){__m={}},key:function(i){return Object.keys(__m)[i]||null}};Object.defineProperty(__s,"length",{get:function(){return Object.keys(__m).length}});try{Object.defineProperty(window,"localStorage",{value:__s,configurable:true});Object.defineProperty(window,"sessionStorage",{value:__s,configurable:true})}catch(e2){}}try{document.cookie}catch(e){var __ck="";try{Object.defineProperty(document,"cookie",{get:function(){return __ck},set:function(v){var one=String(v).split(";")[0];if(one.indexOf("=")<0)return;var k=one.split("=")[0];var kept=__ck?__ck.split("; ").filter(function(x){return x.split("=")[0]!==k}):[];kept.push(one);__ck=kept.join("; ")},configurable:true})}catch(e2){}}';
  html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => m + `<script data-gitmir="shim">${shim}</script>`) : `<script data-gitmir="shim">${shim}</script>` + html;
  const inject = `<script data-gitmir="picker">window.__gitmirUrl=${JSON.stringify(finalUrl)};${PREVIEW_BRIDGE}</script>`;
  html = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, inject + '</body>') : html + inject;
  return html;
}

// ---------- routes ----------
/**
 * Build a shared view of a project's model as one self-contained HTML file.
 *
 * The renderer is not reimplemented here and nothing is cut out of the dashboard to make
 * this work: the file embeds a COPY of `public/app.js` and of the dashboard's own
 * stylesheet, so the shared diagrams are drawn by the same code that draws the local ones
 * and cannot drift from them. `app.js` renders in read-only mode when `__GITMIR_SHARE__`
 * is present — no project to queue into, no bridge to send over.
 */
function buildShareBundle(projectPath: string, displayName: string): { html: string; filename: string } | { error: string } {
  if (!projectPath) return { error: 'no project path' };
  const dir = path.join(projectPath, '.gitmir', 'model');
  const dims = ['modules','entities','serverUnits','serverFunctions','apiRoutes','frontendUnits','events','processes','statusFlows','reactions'];
  const readJson = (f: string): any => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
  const index = readJson(path.join(dir, 'index.json'));
  const model: Record<string, unknown[]> = {};
  let any = !!index;
  for (const d of dims) {
    const arr = readJson(path.join(dir, d + '.json'));
    model[d] = Array.isArray(arr) ? arr : [];
    if (model[d].length) any = true;
  }
  if (!any) return { error: 'This project has no .gitmir/model/ yet — build it with the gitmir-model skill first.' };

  const name = (displayName || (index && index.project) || path.basename(projectPath) || 'Product model').toString().slice(0, 120);
  const payload = { name, index, model, brief: readJson(path.join(projectPath, '.gitmir', 'brief.json')) };
  // </script> inside the data would end the tag early; escaping < is enough and is exact.
  const json = JSON.stringify(payload).replace(/</g, '\\u003c');

  const css = (HTML.match(/<style>([\s\S]*?)<\/style>/) || ['', ''])[1] || '';
  const V = (f: string) => path.join(import.meta.dirname, 'vendor', f);
  // fonts.css points at /vendor/fonts/*.woff2 — inline them, or the file only looks right
  // on a machine that happens to have the dashboard running.
  let fonts = '';
  try {
    fonts = fs.readFileSync(V('fonts.css'), 'utf8').replace(/url\(([^)]+)\)/g, (m, raw) => {
      const rel = String(raw).replace(/['"]/g, '').trim();
      if (!rel.startsWith('/vendor/fonts/')) return m;
      try {
        const b = fs.readFileSync(path.join(import.meta.dirname, rel.replace(/^\//, '')));
        return 'url(data:font/woff2;base64,' + b.toString('base64') + ')';
      } catch { return m; }
    });
  } catch {}
  const elk = fs.readFileSync(V('elk.bundled.js'), 'utf8');
  const app = fs.readFileSync(path.join(import.meta.dirname, 'public', 'app.js'), 'utf8');

  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${hesc(name)} — product model</title>
<style>${fonts}</style>
<style>${css}</style>
<style>
  .share-top{display:flex; align-items:baseline; gap:14px; flex-wrap:wrap; padding:16px 22px; border-bottom:1px solid var(--line)}
  .share-nm{font-size:17px; font-weight:650; color:var(--txt)}
  .share-at{font-family:var(--font-mono); font-size:11px; color:var(--dim2)}
  .share-ro{margin-left:auto; font-family:var(--font-mono); font-size:10.5px; text-transform:uppercase; letter-spacing:.14em; color:var(--cyan-soft); border:1px solid rgba(47,216,255,.35); padding:3px 10px}
  .share-main{padding:18px 22px 60px}
</style>
</head><body>
<div class="share-top">
  <span class="share-nm" id="shareName"></span>
  <span class="share-at" id="shareAt"></span>
  <span class="share-ro">read only</span>
</div>
<main class="main share-main" id="main">
  <div class="model-head"><div class="model-subnav" id="modelNav"></div></div>
  <div id="modelView"><div class="model-empty">Loading…</div></div>
</main>
<div class="toast" id="toast"></div>
<script id="gitmir-share" type="application/json">${json}</script>
<script>window.__GITMIR_SHARE__ = JSON.parse(document.getElementById('gitmir-share').textContent);</script>
<script>${elk}</script>
<script>${app}</script>
</body></html>`;

  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'model';
  return { html, filename: slug + '-model.html' };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);
  try {
    // 127.0.0.1 is reserved for the framed site, so the origin guard refuses every /api/
    // call carrying that Host. Correct for the frame, and disastrous for a person who typed
    // the address by hand: the shell loads and then every request 403s, so there are no
    // projects, no skills and no explanation. Send them to the name that works.
    // Only for a TOP-LEVEL navigation. The framed site's own home link is a request for
    // `/` on this very host, and redirecting that would send the frame to the dashboard.
    if (req.method === 'GET' && url.pathname === '/'
        && String(req.headers.host || '') === PREVIEW_HOST + ':' + PORT
        && !['iframe', 'frame', 'embed', 'object'].includes(String(req.headers['sec-fetch-dest'] || ''))) {
      res.writeHead(302, { Location: 'http://localhost:' + PORT + '/' });
      return res.end();
    }
    // The injected picker is fetched by the sandboxed preview frame, whose origin is
    // opaque — it carries no secrets and must stay reachable from there.
    if (url.pathname.startsWith('/api/') && url.pathname !== '/api/ping'
        && url.pathname !== '/api/preview-bridge.js' && url.pathname !== '/api/preview'
        && !url.pathname.startsWith('/api/px/') && !sameOrigin(req)) {
      return sendJSON(res, 403, { error: 'cross-origin request refused' });
    }
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(HTML);
    }
    // The dashboard client. It used to live inside the HTML template literal, where every
    // backslash was collapsed once before the browser ever saw it — \s became s, \/ turned
    // the rest of the line into a comment and killed the whole UI. As an ordinary file a
    // backslash means what it says. no-store because a stale copy after an update is a
    // broken dashboard, and 110 KB over loopback costs nothing.
    if (req.method === 'GET' && url.pathname === '/app.js') {
      try {
        const body = fs.readFileSync(path.join(import.meta.dirname, 'public', 'app.js'));
        res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(body);
      } catch {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('public/app.js is missing — the dashboard cannot run without it.');
      }
    }
    // A shared view of the model, as one self-contained HTML file: the model, the same
    // renderer the dashboard runs, the stylesheet, the layout engine and the fonts, all
    // inlined. It opens from a file:// URL with no server and no network, which is the
    // point — the recipient installs nothing and there is nothing for them to change.
    if (req.method === 'GET' && url.pathname === '/api/share/export') {
      const p = url.searchParams.get('path') || '';
      try {
        const built = buildShareBundle(p, url.searchParams.get('name') || '');
        if ('error' in built) return sendJSON(res, 400, { error: built.error });
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Disposition': 'attachment; filename="' + built.filename + '"',
          'Cache-Control': 'no-store',
        });
        return res.end(built.html);
      } catch (e) {
        return sendJSON(res, 500, { error: String((e as Error)?.message || e) });
      }
    }
    if (req.method === 'GET' && url.pathname.startsWith('/vendor/')) {
      const rel = url.pathname.replace(/^\/vendor\//, '');
      if (rel.includes('..')) { res.writeHead(400); return res.end('bad'); }
      try {
        const body = fs.readFileSync(path.join(import.meta.dirname, 'vendor', rel));
        const type = rel.endsWith('.js') ? 'application/javascript; charset=utf-8'
          : rel.endsWith('.css') ? 'text/css; charset=utf-8'
          : rel.endsWith('.woff2') ? 'font/woff2'
          : rel.endsWith('.svg') ? 'image/svg+xml; charset=utf-8'
          : rel.endsWith('.png') ? 'image/png'
          : 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'max-age=604800' });
        return res.end(body);
      } catch { res.writeHead(404); return res.end('not found'); }
    }
    if (req.method === 'GET' && url.pathname === '/api/ping') {
      return sendJSON(res, 200, { ok: true });
    }
    // Transparent mirror: on the preview origin, any non-API path is the same path on
    // the site being previewed. Served with ACAO so module scripts load.
    if (req.method === 'GET' && req.headers.host === PREVIEW_HOST + ':' + PORT
        && !url.pathname.startsWith('/api/')) {
      if (!PREVIEW_ON || !previewSite) { res.writeHead(404); return res.end('no preview'); }
      const got = await previewFetch(previewSite + url.pathname + (url.search || ''), true);
      if ('error' in got) { res.writeHead(502, { 'Access-Control-Allow-Origin': '*' }); return res.end(got.error); }
      let body = got.body;
      const ct = got.contentType || 'application/octet-stream';
      if (/text\/html|application\/xhtml/i.test(ct)) {
        // A navigation inside the site lands here — it must get the picker too.
        res.writeHead(got.status, { 'Content-Type': 'text/html; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
        return res.end(preparePreviewHtml(body, got.finalUrl));
      }
      if (/text\/css|javascript/i.test(ct)) {
        try { body = Buffer.from(body.toString('utf8').split(previewSite + '/').join(PREVIEW_ORIGIN + '/'), 'utf8'); } catch {}
      }
      res.writeHead(got.status, { 'Content-Type': ct, 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
      return res.end(body);
    }
    // Subresource mirror: /api/px/<scheme>/<host>/<path>. Serving the site's own
    // assets from here — with Access-Control-Allow-Origin — is what lets a module
    // script load into a sandboxed frame whose origin is null.
    if (req.method === 'GET' && url.pathname.startsWith('/api/px/')) {
      if (!PREVIEW_ON) { res.writeHead(404); return res.end('preview disabled'); }
      const rest = url.pathname.slice('/api/px/'.length);
      const slash = rest.indexOf('/');
      const scheme = slash < 0 ? '' : rest.slice(0, slash);
      if (scheme !== 'http' && scheme !== 'https') { res.writeHead(400); return res.end('bad target'); }
      const upstream = scheme + '://' + rest.slice(slash + 1) + (url.search || '');
      const got = await previewFetch(upstream, false);
      if ('error' in got) { res.writeHead(502, { 'Access-Control-Allow-Origin': '*' }); return res.end(got.error); }
      const ct = got.contentType || 'application/octet-stream';
      // Rewrite same-site absolute URLs inside CSS so its @imports and url()s keep
      // flowing through the mirror as well.
      let body = got.body;
      if (/text\/css/i.test(ct)) {
        try {
          const fu2 = new URL(got.finalUrl);
          body = Buffer.from(body.toString('utf8').split(fu2.origin + '/').join(`${PREVIEW_ORIGIN}/api/px/${fu2.protocol.replace(':', '')}/${fu2.host}/`), 'utf8');
        } catch {}
      }
      res.writeHead(got.status, {
        'Content-Type': ct,
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
      });
      return res.end(body);
    }
    if (req.method === 'GET' && url.pathname === '/api/preview-bridge.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
      return res.end(PREVIEW_BRIDGE);
    }
    if (req.method === 'GET' && url.pathname === '/api/preview') {
      if (!PREVIEW_ON) { res.writeHead(404); return res.end('preview disabled'); }
      const target = url.searchParams.get('url') || '';
      // Only a real frame navigation counts as "the user opened this". A fetch from
      // inside the framed page carries a different Sec-Fetch-Dest and cannot forge it.
      const dest = req.headers['sec-fetch-dest'];
      const userOpened = dest === 'iframe' || dest === 'document' || dest === undefined;
      const got = await previewFetch(target, userOpened);
      if (userOpened && !('error' in got)) { try { const f = new URL(got.finalUrl); loopbackOk.add(f.host); previewSite = f.origin; } catch {} }
      if ('error' in got) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(`<!doctype html><meta charset="utf-8"><body style="margin:0;font:14px/1.6 -apple-system,sans-serif;background:#04060a;color:#8497b8;display:flex;align-items:center;justify-content:center;height:100vh;padding:30px;text-align:center">${hesc(got.error)}</body>`);
      }
      const isHtml = /text\/html|application\/xhtml/i.test(got.contentType);
      if (!isHtml) {
        res.writeHead(got.status, { 'Content-Type': got.contentType || 'application/octet-stream' });
        return res.end(got.body);
      }
      const html = preparePreviewHtml(got.body, got.finalUrl);
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        // The upstream's framing and script policy is for its own origin; this copy is
        // served here for local inspection only.
        'X-GitMir-Preview-Of': got.finalUrl,
      });
      return res.end(html);
    }
    // The part that turns a DOM selector into something actionable: find where the
    // element's distinctive strings actually appear in the project's source.
    if (req.method === 'POST' && url.pathname === '/api/preview-find') {
      const { path: p, needles } = await readBody(req);
      if (!p || !Array.isArray(needles)) return sendJSON(res, 400, { error: 'bad request' });
      const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'out', 'vendor', 'coverage', '.cache', '.venv', '__pycache__', '.gitmir']);
      const EXT = /\.(js|jsx|ts|tsx|vue|svelte|astro|html|htm|php|erb|hbs|ejs|pug|jade|css|scss|sass|less|styl|json|md|py|rb|go|java|kt|cs|swift|dart|elm|twig|liquid)$/i;
      const wanted = needles.map((n) => String(n || '').trim()).filter((n) => n.length >= 3).slice(0, 12);
      if (!wanted.length) return sendJSON(res, 200, { hits: [], searched: 0 });
      const hits: { file: string; line: number; needle: string; text: string }[] = []; let searched = 0;
      const walk = (dir: string, depth: number) => {
        if (depth > 8 || searched > 4000 || hits.length >= 60) return;
        let ents = [];
        try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of ents) {
          if (hits.length >= 60 || searched > 4000) return;
          if (e.name.startsWith('.') && e.name !== '.gitmir') { if (e.isDirectory()) continue; }
          if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(path.join(dir, e.name), depth + 1); continue; }
          if (!EXT.test(e.name)) continue;
          const full = path.join(dir, e.name);
          let st; try { st = fs.statSync(full); } catch { continue; }
          if (st.size > 1024 * 1024) continue;
          searched++;
          let text; try { text = fs.readFileSync(full, 'utf8'); } catch { continue; }
          const lines = text.split('\n');
          for (const n of wanted) {
            if (!text.includes(n)) continue;
            for (let i = 0; i < lines.length; i++) {
              if (!lines[i].includes(n)) continue;
              hits.push({ file: path.relative(p, full), line: i + 1, needle: n, text: lines[i].trim().slice(0, 200) });
              break;                       // one line per needle per file is enough
            }
            if (hits.length >= 60) break;
          }
        }
      };
      walk(p, 0);
      // If the project has a model, name the frontend units that consume this route
      // — that is a stronger signal than a text match.
      let fromModel: { name: string; kind?: string; description?: string }[] = [];
      try {
        const fe = JSON.parse(fs.readFileSync(path.join(p, '.gitmir', 'model', 'frontendUnits.json'), 'utf8'));
        const route = String(url.searchParams.get('route') || '');
        if (Array.isArray(fe)) {
          fromModel = fe.filter((f: any) => f && f.name && (!route || String(f.name).toLowerCase().includes(route.toLowerCase())))
            .slice(0, 8).map((f) => ({ name: f.name, kind: f.kind || '', description: f.description || '' }));
        }
      } catch {}
      return sendJSON(res, 200, { hits, searched, fromModel });
    }
    if (req.method === 'GET' && url.pathname === '/api/env') {
      return sendJSON(res, 200, { platform: process.platform, pickerAvailable: nativePickerAvailable(), relayUrl: relay.status().url, preview: PREVIEW_ON, previewOrigin: PREVIEW_ORIGIN });
    }
    if (req.method === 'GET' && url.pathname === '/api/projects') {
      // A tile that only says its own name is a folder shortcut. These three counts are
      // what makes the home screen worth looking at: whether the product has been mapped,
      // whether work is waiting, and whether anything has happened here at all. All three
      // are a directory listing, so this stays cheap enough to run on every refresh.
      const countIn = (dir: string): number => {
        try { return fs.readdirSync(dir).filter((f) => f.endsWith('.md')).length; } catch { return 0; }
      };
      const list = loadProjects().map((p) => {
        const exists = fs.existsSync(p.path);
        let hasModel = false, todo = 0, verify = 0, done = 0, tasks = 0;
        if (exists) {
          try { hasModel = fs.existsSync(path.join(p.path, '.gitmir', 'model', 'index.json')); } catch {}
          todo = countIn(path.join(p.path, 'tasks', 'todo'));
          verify = countIn(path.join(p.path, 'tasks', 'verify'));
          done = countIn(path.join(p.path, 'tasks', 'done'));
          try {
            const log = JSON.parse(fs.readFileSync(path.join(p.path, '.claude', 'tasks.json'), 'utf8'));
            tasks = Array.isArray(log) ? log.length : Array.isArray(log && log.tasks) ? log.tasks.length : 0;
          } catch {}
        }
        return {
          name: p.name || '', path: p.path, description: p.description || '', exists,
          hasModel, tasks,
          // Unproven work is still open work — the same rule the Queue badge uses.
          queue: { pending: todo + verify, done },
        };
      });
      return sendJSON(res, 200, { projects: list });
    }
    if (req.method === 'GET' && url.pathname === '/api/tasks') {
      const p = url.searchParams.get('path') || '';
      const file = path.join(p, '.claude', 'tasks.json');
      try {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        const tasks = Array.isArray(data) ? data : (Array.isArray(data.tasks) ? data.tasks : []);
        return sendJSON(res, 200, { tasks, updated: (data && data.updated) || null });
      } catch {
        return sendJSON(res, 200, { tasks: [], updated: null });
      }
    }
    // ---- file-based task queue: tasks/{todo,inprogress,verify,done}/*.md ----
    if (req.method === 'POST' && url.pathname === '/api/task') {
      const { path: p, title, content } = await readBody(req);
      if (!p || !content) return sendJSON(res, 400, { error: 'no path/content' });
      const dir = path.join(p, 'tasks', 'todo');
      fs.mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const slug = String(title || 'task').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'task';
      const file = path.join(dir, stamp + '-' + slug + '.md');
      fs.writeFileSync(file, content);
      return sendJSON(res, 200, { ok: true, file: path.basename(file) });
    }
    if (req.method === 'GET' && url.pathname === '/api/queue') {
      const p = url.searchParams.get('path') || '';
      const cols = ['todo', 'inprogress', 'verify', 'done'];
      const out: Record<string, unknown> = {};
      for (const c of cols) {
        const dir = path.join(p, 'tasks', c);
        let items: { file: string; title: string; mtime: number }[] = [];
        try {
          items = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => {
            let title = f.replace(/\.md$/, '');
            try {
              const first = fs.readFileSync(path.join(dir, f), 'utf8').split('\n').find((l) => l.trim());
              if (first) title = first.replace(/^#+\s*/, '').trim().slice(0, 120);
            } catch {}
            let mtime = 0; try { mtime = fs.statSync(path.join(dir, f)).mtimeMs; } catch {}
            return { file: f, title, mtime };
          }).sort((a, b) => a.file.localeCompare(b.file));
        } catch {}
        out[c] = items as any;
      }
      // The audit walks the whole app and its result is mostly about what it did NOT reach.
      // That is unreadable as a pile of task files, so it is summarised for the Queue tab.
      // Both files are written by an agent mid-run: clamp everything, assume nothing.
      let audit = null;
      try {
        const adir = path.join(p, '.gitmir', 'audit');
        const rd = (f: string): any => { try { return JSON.parse(fs.readFileSync(path.join(adir, f), 'utf8')); } catch { return null; } };
        const inv = rd('inventory.json');
        if (inv && Array.isArray(inv.pages) && inv.pages.length) {
          const S = { passed: 0, failed: 0, pending: 0, unreachable: 0, skipped: 0 };
          const pages = [];
          let notExercised = 0;
          for (const g of inv.pages.slice(0, 600)) {
            if (!g || typeof g !== 'object') continue;
            const status = S.hasOwnProperty(g.status) ? g.status : 'pending';
            S[status as keyof typeof S]++;
            const ne = Array.isArray(g.notExercised) ? g.notExercised.slice(0, 10).map((x: unknown) => String(x).slice(0, 160)) : [];
            notExercised += ne.length;
            pages.push({
              n: Number(g.n) || pages.length + 1,
              url: String(g.url == null ? '' : g.url).slice(0, 300),
              title: String(g.title == null ? '' : g.title).slice(0, 160),
              foundBy: Array.isArray(g.foundBy) ? g.foundBy.slice(0, 5).map((x: unknown) => String(x).slice(0, 20)) : [],
              auth: String(g.auth == null ? '' : g.auth).slice(0, 40),
              interactive: Number(g.elements && g.elements.interactive) || 0,
              dataEls: Number(g.elements && g.elements.data) || 0,
              useCases: Number(g.useCases) || 0,
              status, notExercised: ne,
              task: String(g.task == null ? '' : g.task).slice(0, 120),
              note: String(g.note == null ? '' : g.note).slice(0, 300),
            });
          }
          const SEV = ['critical', 'major', 'minor', 'intermittent'];
          const raw = rd('findings.json');
          const sev = { critical: 0, major: 0, minor: 0, intermittent: 0 };
          const findings = (Array.isArray(raw) ? raw : []).slice(0, 400)
            .filter((f) => f && typeof f === 'object')
            .map((f) => {
              const s = SEV.includes(f.severity) ? f.severity : 'minor';
              sev[s as keyof typeof sev]++;
              return {
                id: String(f.id == null ? '' : f.id).slice(0, 40), severity: s,
                title: String(f.title == null ? '' : f.title).slice(0, 200),
                page: String(f.page == null ? '' : f.page).slice(0, 200),
                step: Number(f.step) || null,
                expected: String(f.expected == null ? '' : f.expected).slice(0, 400),
                observed: String(f.observed == null ? '' : f.observed).slice(0, 400),
                evidence: String(f.evidence == null ? '' : f.evidence).slice(0, 300),
                task: String(f.task == null ? '' : f.task).slice(0, 120),
              };
            })
            .sort((a, b) => SEV.indexOf(a.severity) - SEV.indexOf(b.severity));
          audit = {
            target: String(inv.target == null ? '' : inv.target).slice(0, 300),
            env: String(inv.env == null ? '' : inv.env).slice(0, 40),
            driver: String(inv.driver == null ? '' : inv.driver).slice(0, 40),
            at: typeof inv.at === 'string' ? inv.at.slice(0, 40) : null,
            auth: Array.isArray(inv.auth) ? inv.auth.slice(0, 8).map((x: unknown) => String(x).slice(0, 40)) : [],
            caps: inv.caps && typeof inv.caps === 'object' ? inv.caps : null,
            counts: { total: pages.length, passed: S.passed, failed: S.failed, pending: S.pending, unreachable: S.unreachable, skipped: S.skipped },
            notExercised, pages,
            mismatches: (Array.isArray(inv.mismatches) ? inv.mismatches : []).slice(0, 40).map((m: any) => ({
              kind: String((m && m.kind) == null ? '' : m.kind).slice(0, 60),
              what: String((m && m.what) == null ? '' : m.what).slice(0, 200),
              detail: String((m && m.detail) == null ? '' : m.detail).slice(0, 300),
            })),
            sev, findings: findings.slice(0, 60), findingsTotal: findings.length,
          };
        }
      } catch {}
      (out as any).audit = audit;
      return sendJSON(res, 200, out);
    }
    if (req.method === 'GET' && url.pathname === '/api/task-file') {
      const p = url.searchParams.get('path') || '';
      const col = url.searchParams.get('col') || '';
      const file = path.basename(url.searchParams.get('file') || ''); // basename strips any traversal
      if (!p || !['todo', 'inprogress', 'verify', 'done'].includes(col) || !file.endsWith('.md')) {
        return sendJSON(res, 400, { error: 'bad request' });
      }
      const full = path.join(p, 'tasks', col, file);
      try {
        const content = fs.readFileSync(full, 'utf8');
        let mtime = 0; try { mtime = fs.statSync(full).mtimeMs; } catch {}
        return sendJSON(res, 200, { ok: true, content, file, col, mtime });
      } catch {
        return sendJSON(res, 404, { error: 'not found' });
      }
    }
    if (req.method === 'GET' && url.pathname === '/api/model') {
      const p = url.searchParams.get('path') || '';
      // `src` selects whose model to read: the project's own, or a teammate's
      // snapshot relayed into .gitmir/shared/<who>/model by the team bridge.
      const src = url.searchParams.get('src') || '';
      const who = src ? path.basename(src) : '';                 // basename — no traversal
      if (src && (who !== src || !/^[a-z0-9-]{1,40}$/.test(who))) return sendJSON(res, 400, { error: 'bad src' });
      const dir = who
        ? path.join(p, '.gitmir', 'shared', who, 'model')
        : path.join(p, '.gitmir', 'model');
      const dims = ['modules','entities','serverUnits','serverFunctions','apiRoutes','frontendUnits','events','processes','statusFlows','reactions'];
      const readJson = (f: string) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
      const index = readJson(path.join(dir, 'index.json'));
      const model: Record<string, unknown[]> = {};
      let exists = !!index;
      for (const d of dims) {
        const arr = readJson(path.join(dir, d + '.json'));
        model[d] = (Array.isArray(arr) ? arr : []) as any;
        if (model[d].length) exists = true;
      }
      const brief = who ? null : readJson(path.join(p, '.gitmir', 'brief.json'));
      // A model that is older than the code is worse than no model: it looks
      // authoritative and quietly lies. Find that out here rather than trusting that
      // every session remembered to refresh it.
      let stale = null;
      if (!who && exists) {
        try {
          let modelAt = 0;
          for (const f of fs.readdirSync(dir)) if (f.endsWith('.json')) {
            const st = fs.statSync(path.join(dir, f)); if (st.mtimeMs > modelAt) modelAt = st.mtimeMs;
          }
          const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'out', 'vendor',
            'coverage', '.cache', '.venv', '__pycache__', '.gitmir', 'tasks', 'docs', '.claude']);
          const EXT = /\.(js|jsx|ts|tsx|vue|svelte|astro|mjs|cjs|py|rb|go|java|kt|cs|swift|php|rs|sql|prisma)$/i;
          let newest = 0, changed = 0, seen = 0, newestFile = '';
          const walk = (d: string, depth: number) => {
            if (depth > 7 || seen > 6000) return;
            let ents = []; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
            for (const e of ents) {
              if (seen > 6000) return;
              if (e.name.startsWith('.')) continue;
              const full = path.join(d, e.name);
              if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(full, depth + 1); continue; }
              if (!EXT.test(e.name)) continue;
              seen++;
              let st; try { st = fs.statSync(full); } catch { continue; }
              if (st.mtimeMs > newest) { newest = st.mtimeMs; newestFile = path.relative(p, full); }
              if (st.mtimeMs > modelAt + 1000) changed++;
            }
          };
          walk(p, 0);
          stale = { is: changed > 0, changed, scanned: seen, modelAt, newest, newestFile };
        } catch {}
      }
      // A big source is modelled one fragment at a time (the model-ingest skill), which
      // can mean forty tasks over several sessions. Without this the user is watching an
      // opaque queue; with it they see how far along the model is, which fragments are
      // blocked, and — the honest part — which references it still cannot resolve.
      let ingest = null;
      if (!who) {
        const led = readJson(path.join(p, '.gitmir', 'ingest', 'ledger.json'));
        if (led && Array.isArray(led.fragments) && led.fragments.length) {
          const st = { done: 0, pending: 0, blocked: 0, skipped: 0 };
          let linesTotal = 0, linesDone = 0, filesTotal = 0;
          const added: Record<string, number> = {}, frags: any[] = [];
          for (const f of led.fragments.slice(0, 800)) {
            if (!f || typeof f !== 'object') continue;
            const status = st.hasOwnProperty(f.status) ? f.status : 'pending';
            st[status as keyof typeof st]++;
            const lines = Number(f.size && f.size.lines) || 0;
            const files = Number(f.size && f.size.files) || 0;
            linesTotal += lines; filesTotal += files;
            if (status === 'done') linesDone += lines;
            // Per-dimension counts, summed, are the model visibly growing.
            if (f.added && typeof f.added === 'object') for (const k of Object.keys(f.added).slice(0, 20)) {
              const n = Number(f.added[k]);
              if (Number.isFinite(n) && n >= 0) added[String(k).slice(0, 40)] = (added[String(k).slice(0, 40)] || 0) + n;
            }
            frags.push({
              n: Number(f.n) || frags.length + 1,
              id: String(f.id == null ? '' : f.id).slice(0, 80),
              owns: Array.isArray(f.owns) ? f.owns.slice(0, 12).map((o: unknown) => String(o).slice(0, 200)) : [],
              files, lines, status,
              dimensions: Array.isArray(f.dimensions) ? f.dimensions.slice(0, 12).map((x: unknown) => String(x).slice(0, 40)) : [],
              added: f.added && typeof f.added === 'object' ? f.added : null,
              note: String(f.note == null ? '' : f.note).slice(0, 300),
            });
          }
          const un = readJson(path.join(p, '.gitmir', 'ingest', 'unresolved.json'));
          const open = (Array.isArray(un) ? un : []).filter((u) => u && typeof u === 'object' && !u.resolvedTo);
          ingest = {
            source: String(led.source == null ? '' : led.source).slice(0, 300),
            kind: String(led.kind == null ? '' : led.kind).slice(0, 40),
            at: typeof led.at === 'string' ? led.at.slice(0, 40) : null,
            counts: { total: frags.length, done: st.done, pending: st.pending, blocked: st.blocked, skipped: st.skipped },
            files: filesTotal, linesTotal, linesDone, added, fragments: frags,
            unresolved: {
              open: open.length,
              items: open.slice(0, 80).map((u) => ({
                fragment: Number(u.fragment) || null,
                from: String(u.from == null ? '' : u.from).slice(0, 80),
                field: String(u.field == null ? '' : u.field).slice(0, 60),
                wanted: String(u.wanted == null ? '' : u.wanted).slice(0, 160),
                evidence: String(u.evidence == null ? '' : u.evidence).slice(0, 300),
              })),
            },
          };
        }
      }
      // Which teammates' models are on disk for this project (for the source switcher).
      let shared: { name: string; label: string; receivedAt: string | null; at: number }[] = [];
      try {
        const sdir = path.join(p, '.gitmir', 'shared');
        shared = fs.readdirSync(sdir, { withFileTypes: true })
          // Only names the src validator below would accept — otherwise the UI would
          // offer a pill that 400s.
          .filter((e) => e.isDirectory() && /^[a-z0-9-]{1,40}$/.test(e.name) && fs.existsSync(path.join(sdir, e.name, 'model')))
          .map((e) => {
            let at = 0;
            try {
              const md = path.join(sdir, e.name, 'model');
              for (const f of fs.readdirSync(md)) at = Math.max(at, fs.statSync(path.join(md, f)).mtimeMs);
            } catch {}
            // The real display name may be non-latin; the folder name is only a key.
            let label = e.name, receivedAt = null;
            try {
              const meta = readJson(path.join(sdir, e.name, 'meta.json'));
              if (meta && typeof meta.name === 'string' && meta.name.trim()) label = meta.name.trim().slice(0, 80);
              if (meta && meta.receivedAt) receivedAt = meta.receivedAt;
            } catch {}
            return { name: e.name, label, receivedAt, at };
          })
          .sort((a, b) => b.at - a.at);
      } catch {}
      return sendJSON(res, 200, { exists, index, model, brief, shared, stale, ingest, src: who || null });
    }
    if (req.method === 'GET' && url.pathname === '/api/skills') {
      const skills = loadSkills().map((s) => ({ name: s.name, title: s.title || s.name, desc: s.desc || '' }));
      return sendJSON(res, 200, { skills });
    }
    if (req.method === 'GET' && url.pathname === '/api/skill') {
      const name = (url.searchParams.get('name') || '').trim();
      const s = loadSkills().find((x) => x.name === name);
      if (!s) return sendJSON(res, 404, { error: 'unknown skill' });
      try {
        let text: string = fs.readFileSync(resolveSkillFile(s.file) || '', 'utf8');
        if (s.stripFrontmatter) text = stripFrontmatter(text);
        if (s.prepend) text = s.prepend + text;
        return sendJSON(res, 200, { name, title: s.title || s.name, text });
      } catch {
        return sendJSON(res, 404, { error: 'file not found' });
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/pick') {
      // just open the native folder picker and return the path (no add)
      try {
        const folder = await chooseFolder();
        return sendJSON(res, 200, folder ? { path: folder } : { cancelled: true });
      } catch (e) {
        return sendJSON(res, 200, { pickerFailed: true, error: String((e as Error)?.message || e) });
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/add') {
      const body = await readBody(req);
      let folder;
      if (body && body.path) {
        // manual path (typed/pasted fallback) — no native picker
        folder = String(body.path).trim().replace(/[\\/]+$/, '');
        if (!folder) return sendJSON(res, 200, { added: false, cancelled: true });
        if (!fs.existsSync(folder)) return sendJSON(res, 200, { added: false, error: 'Folder not found: ' + folder });
      } else {
        try {
          folder = await chooseFolder();
        } catch (e) {
          // picker unavailable (headless / no GUI / missing tool) -> let the UI offer manual entry
          return sendJSON(res, 200, { added: false, pickerFailed: true, error: String((e as Error)?.message || e) });
        }
        if (!folder) return sendJSON(res, 200, { added: false, cancelled: true });
      }
      const list = loadProjects();
      if (list.some((p) => p.path === folder)) {
        return sendJSON(res, 200, { added: false, duplicate: true, path: folder });
      }
      const project = { name: path.basename(folder), path: folder, description: '' };
      list.push(project);
      saveProjects(list);
      return sendJSON(res, 200, { added: true, project });
    }
    if (req.method === 'POST' && url.pathname === '/api/update') {
      const { path: p, name, description } = await readBody(req);
      const list = loadProjects();
      const item = list.find((x) => x.path === p);
      if (item) {
        if (name !== undefined) item.name = String(name).trim();
        if (description !== undefined) item.description = String(description);
        saveProjects(list);
      }
      return sendJSON(res, 200, { ok: !!item });
    }
    if (req.method === 'POST' && url.pathname === '/api/open') {
      const { path: p } = await readBody(req);
      if (!p) return sendJSON(res, 400, { error: 'no path' });
      await openInTerminal(p);
      return sendJSON(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/reveal') {
      const { path: p } = await readBody(req);
      if (!p) return sendJSON(res, 400, { error: 'no path' });
      await revealInFinder(p);
      return sendJSON(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/remove') {
      const { path: p } = await readBody(req);
      saveProjects(loadProjects().filter((x) => x.path !== p));
      return sendJSON(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/reorder') {
      const { paths } = await readBody(req);
      if (Array.isArray(paths)) {
        const list = loadProjects();
        const byPath = new Map(list.map((x) => [x.path, x]));
        const next = paths.map((p: string) => byPath.get(p)).filter(Boolean) as Project[];
        for (const x of list) if (!paths.includes(x.path)) next.push(x);
        saveProjects(next);
      }
      return sendJSON(res, 200, { ok: true });
    }
    // ---- team bridge (connect local machines through the GitMir relay) ----
    if (req.method === 'POST' && url.pathname === '/api/team/connect') {
      const { key, name, path: projectPath, projectId, url: relayUrl } = await readBody(req);
      if (!key) return sendJSON(res, 400, { error: 'no key' });
      relay.connect({ key, name, projectPath, projectId, url: relayUrl });
      return sendJSON(res, 200, { ok: true, status: relay.status() });
    }
    if (req.method === 'GET' && url.pathname === '/api/team/status') {
      return sendJSON(res, 200, relay.status());
    }
    // Sharing a map needs no bridge connection and no plan — only the workspace key, which
    // a free account can mint. The key comes from the client because that is where the user
    // typed it; it is not stored here between calls.
    if (req.method === 'POST' && url.pathname === '/api/team/share-view') {
      const b = await readBody(req);
      return sendJSON(res, 200, await relay.shareView({
        key: typeof b.key === 'string' ? b.key : '',
        path: typeof b.path === 'string' ? b.path : '',
        title: typeof b.title === 'string' ? b.title : '',
        access: b.access === 'people' ? 'people' : 'link',
        allowed: Array.isArray(b.allowed) ? b.allowed.map((x: unknown) => String(x)) : [],
        expiresInDays: b.expiresInDays === null ? null : Number(b.expiresInDays) || 30,
      }));
    }
    if (req.method === 'POST' && url.pathname === '/api/team/share-model') {
      return sendJSON(res, 200, relay.shareModel());
    }
    if (req.method === 'POST' && url.pathname === '/api/team/send-task') {
      const { title, body } = await readBody(req);
      return sendJSON(res, 200, relay.sendTask({ title, body }));
    }
    if (req.method === 'POST' && url.pathname === '/api/team/disconnect') {
      relay.disconnect();
      return sendJSON(res, 200, { ok: true });
    }
    res.writeHead(404); res.end('not found');
  } catch (e) {
    // A throw AFTER the headers went out used to take the whole dashboard down with
    // ERR_HTTP_HEADERS_SENT. Report what we still can and keep serving.
    console.error('request failed:', ((e as Error)?.stack) || e);
    if (res.headersSent) { try { res.end(); } catch {} return; }
    try { sendJSON(res, 500, { error: String(((e as Error)?.message) || e) }); } catch {}
  }
});

// Nothing in a request handler, a relay frame or a timer should be able to stop the
// dashboard — it is the only process the user has running.
process.on('uncaughtException', (e) => console.error('uncaught:', ((e as Error)?.stack) || e));
process.on('unhandledRejection', (e) => console.error('unhandled rejection:', ((e as Error)?.stack) || e));

server.on('error', (e) => {
  if (e && (e as NodeJS.ErrnoException).code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use.`);
    console.error(`  If the dashboard is already running, just open  http://localhost:${PORT}`);
    console.error(`  Otherwise start it elsewhere:  GITMIR_PORT=4600 node server.js\n`);
  } else if (e && (e as NodeJS.ErrnoException).code === 'EACCES') {
    console.error(`\n  Not allowed to listen on port ${PORT}. Pick one above 1024:  GITMIR_PORT=4599 node server.js\n`);
  } else {
    console.error('\n  Could not start: ' + (((e as Error)?.message) || e) + '\n');
  }
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  // The server can start perfectly while the client script is broken, and then the user
  // sees a blank page with no clue why. Parse it (compile only, never run) and say so.
  try {
    const js = fs.readFileSync(path.join(import.meta.dirname, 'public', 'app.js'), 'utf8');
    new Function(js);
  } catch (e) {
    if (e && (e as NodeJS.ErrnoException).code === 'ENOENT') {
      console.error('\n  *** public/app.js is missing — the dashboard will load an empty page.');
      console.error('  *** Re-clone or restore the file; the server cannot serve the UI without it.\n');
    } else {
      console.error('\n  *** THE DASHBOARD SCRIPT IS BROKEN: ' + (((e as Error)?.message) || e));
      console.error('  *** The UI will not work. Fix public/app.js and restart.\n');
    }
  }
  const addr = `http://localhost:${PORT}`;
  console.log(`\n  GITMIR Claude Control  ->  ${addr}\n  (Ctrl+C to stop)\n`);
  const opener = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', addr]]
    : process.platform === 'darwin' ? ['open', [addr]]
    : ['xdg-open', [addr]];
  execFile(opener[0] as string, opener[1] as string[], () => {});
});

// ---------- frontend ----------
const HTML = /* html */ `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GITMIR Claude Control</title>
<link rel="stylesheet" href="/vendor/fonts.css">
<style>
  :root{
    --bg-0:#04060a; --bg-1:#060b16; --bg-2:#0a1322;
    --ink-0:#e8f0ff; --ink-1:#bcd2ec; --ink-2:#8497b8; --ink-3:#607692;
    --faint:#283448; --ice:#bfe9ff;
    --cyan:#2fd8ff; --cyan-soft:#8aecff; --cyan-deep:#11a9e6; --blue:#4ea8ff;
    --glass-brd:rgba(120,210,255,.22); --glass-brd-strong:rgba(120,220,255,.46);
    --font-ui:"Onest",system-ui,-apple-system,BlinkMacSystemFont,sans-serif;
    --font-mono:"JetBrains Mono",ui-monospace,Menlo,monospace;
    /* aliases: old variable names -> HUD palette so existing rules pick up the colors */
    --bg:#04060a; --panel:rgba(14,30,58,.42); --panel2:rgba(9,18,38,.55);
    --line:rgba(120,210,255,.14); --line2:rgba(120,210,255,.26);
    --txt:#e8f0ff; --dim:#8497b8; --dim2:#607692;
    --accent:#2fd8ff; --accent2:#8aecff; --danger:#ff5566; --ok:#34f0a6;
    color-scheme:dark;
  }
  *{box-sizing:border-box}
    html,body{margin:0}
  body{
      background:var(--bg-0); color:var(--ink-1); min-height:100vh; display:block;
      font:14px/1.5 var(--font-ui); -webkit-font-smoothing:antialiased; position:relative;
  }
  button{font-family:inherit}

  /* ---------- the environment ----------
     This is what makes it read as the IDE and not as a dark page: four nebula radials
     over a vertical gradient, three still blurred blobs, a 7px scanline film, and a
     56px grid floor laid back 70deg on a 420px perspective and masked upward. Copied
     from holo.css value for value. Nothing here animates — a blur(60px) blob repainted
     every frame is one of the most expensive things a GPU can be asked to do. */
  .holo-env{position:fixed; inset:0; z-index:0; overflow:hidden; pointer-events:none;
    background:
      radial-gradient(1100px 760px at 14% -8%, rgba(47,216,255,.16), transparent 60%),
      radial-gradient(1000px 900px at 100% 4%, rgba(78,168,255,.14), transparent 58%),
      radial-gradient(1200px 800px at 50% 116%, rgba(52,240,166,.08), transparent 60%),
      radial-gradient(900px 700px at 88% 90%, rgba(78,168,255,.10), transparent 60%),
      linear-gradient(180deg,#03060f 0%,#04081a 45%,#02040c 100%)}
  .holo-env::after{content:""; position:absolute; inset:0;
    background:linear-gradient(transparent 0%, rgba(47,216,255,.022) 50%, transparent 100%);
    background-size:100% 7px; opacity:.5}
  .holo-blob{position:absolute; border-radius:50%; filter:blur(60px); opacity:.55}
  .holo-blob.b1{width:480px; height:480px; left:-130px; top:-90px;
    background:radial-gradient(circle, rgba(47,216,255,.34), transparent 70%)}
  .holo-blob.b2{width:560px; height:560px; right:-170px; top:6%;
    background:radial-gradient(circle, rgba(78,168,255,.30), transparent 70%)}
  .holo-blob.b3{width:640px; height:640px; left:32%; bottom:-260px;
    background:radial-gradient(circle, rgba(52,240,166,.16), transparent 70%)}
  .holo-floor{position:absolute; left:50%; bottom:-10%; width:220vw; height:70vh;
    transform:translateX(-50%) perspective(420px) rotateX(70deg); transform-origin:bottom center;
    background-image:
      linear-gradient(rgba(47,216,255,.16) 1px, transparent 1px),
      linear-gradient(90deg, rgba(47,216,255,.16) 1px, transparent 1px);
    background-size:56px 56px;
    -webkit-mask-image:linear-gradient(to top,#000 0%,rgba(0,0,0,.5) 30%,transparent 78%);
    mask-image:linear-gradient(to top,#000 0%,rgba(0,0,0,.5) 30%,transparent 78%);
    opacity:.6}

  /* ---------- shell: topbar, rail, grid ---------- */
  .topbar,.shell{position:relative; z-index:1}
  .topbar{position:sticky; top:0; z-index:40; height:var(--topbar-h); display:flex; align-items:center; gap:14px;
    padding:0 18px; border-bottom:1px solid var(--line); background:rgba(4,8,16,.86); backdrop-filter:blur(14px)}
  .brand-link{display:flex; align-items:center; flex-shrink:0}
  .brand-logo{height:19px; display:block}
  .brand-sub{font-family:var(--font-mono); font-size:11px; letter-spacing:.2em; text-transform:uppercase; color:var(--ink-3);
    padding-left:14px; border-left:1px solid var(--line); white-space:nowrap}
  .topbar .c{font-family:var(--font-mono); font-size:11px; color:var(--ink-3)}
  .top-tools{margin-left:auto; display:flex; gap:10px; align-items:center}
  .top-tools .search{width:230px; height:32px; padding:0 11px; background:var(--panel2); border:1px solid var(--line);
    color:var(--ink-0); font-family:var(--font-ui); font-size:13px; outline:none; transition:border-color .16s}
  .top-tools .search:focus{border-color:var(--line2)}
  .top-tools .add{height:32px; padding:0 14px; background:var(--cyan); border:none; color:#05070c; cursor:pointer;
    font-family:var(--font-mono); font-size:11px; letter-spacing:.12em; text-transform:uppercase; font-weight:600; white-space:nowrap}
  .top-tools .add:hover{background:var(--cyan-soft)}
  .top-proj{display:none; align-items:center; gap:12px; min-width:0}
  .top-proj.on{display:flex}
  .tp-back{width:28px; height:28px; flex-shrink:0; background:none; border:1px solid var(--line); color:var(--ink-2);
    cursor:pointer; font-size:14px; line-height:1}
  .tp-back:hover{border-color:var(--line2); color:var(--cyan)}
  .tp-nm{font-size:14px; font-weight:650; color:var(--ink-0); white-space:nowrap}
  .tp-pa{font-family:var(--font-mono); font-size:11px; color:var(--ink-3); overflow:hidden; text-overflow:ellipsis; white-space:nowrap}

  .shell{display:flex; align-items:stretch; min-height:calc(100vh - var(--topbar-h))}
  .main{flex:1; min-width:0; padding:22px 24px 60px}
  .detail{max-width:1600px}

  /* ---------- the holo component layer ----------
     Ported from dev/src/styles/holo.css so a card here is literally the same object as a
     card there: .glass .edge .hoverable .clickable, a .holo-scan sweep, a .badge, a
     .divider and the layout utilities. Values are copied, not approximated. */
  .glass{position:relative; isolation:isolate; border-radius:0; border:1px solid var(--glass-brd);
    background:
      linear-gradient(158deg,rgba(255,255,255,.05) 0%,rgba(255,255,255,0) 42%),
      linear-gradient(165deg,rgba(18,36,66,.62) 0%,rgba(9,18,38,.78) 60%,rgba(5,11,24,.82) 100%);
    box-shadow:0 0 44px rgba(2,8,16,.5), inset 0 0 34px rgba(40,120,180,.06)}
  /* four L-brackets and a lit top edge, all painted as backgrounds on one pseudo-element */
  .glass::before{content:""; position:absolute; inset:-1px; pointer-events:none; z-index:1;
    background:
      linear-gradient(90deg,transparent,rgba(95,222,255,.55),transparent) 50% 0 / calc(100% - 44px) 1px no-repeat,
      linear-gradient(var(--cc),var(--cc)) 0 0 / var(--cb) var(--cw) no-repeat,
      linear-gradient(var(--cc),var(--cc)) 0 0 / var(--cw) var(--cb) no-repeat,
      linear-gradient(var(--cc),var(--cc)) 100% 0 / var(--cb) var(--cw) no-repeat,
      linear-gradient(var(--cc),var(--cc)) 100% 0 / var(--cw) var(--cb) no-repeat,
      linear-gradient(var(--cc),var(--cc)) 0 100% / var(--cb) var(--cw) no-repeat,
      linear-gradient(var(--cc),var(--cc)) 0 100% / var(--cw) var(--cb) no-repeat,
      linear-gradient(var(--cc),var(--cc)) 100% 100% / var(--cb) var(--cw) no-repeat,
      linear-gradient(var(--cc),var(--cc)) 100% 100% / var(--cw) var(--cb) no-repeat;
    filter:drop-shadow(0 0 4px rgba(95,222,255,.7)); opacity:.9}
  .glass.edge::before{opacity:1; filter:drop-shadow(0 0 6px rgba(95,222,255,.95))}
  .glass::after{content:""; position:absolute; z-index:-1; left:10%; right:10%; bottom:-13px; height:46%;
    border-radius:50%; background:radial-gradient(72% 100% at 50% 100%,rgba(47,216,255,.22),transparent 72%);
    filter:blur(18px); opacity:.55; pointer-events:none;
    transition:opacity .25s ease, filter .25s ease, bottom .25s ease}
  .glass.hoverable:hover::after{opacity:.8; filter:blur(22px); bottom:-17px}
  .hoverable{transition:transform .18s ease, border-color .18s ease, box-shadow .18s ease, background .18s ease}
  .hoverable:hover{transform:translateY(-2px); border-color:var(--glass-brd-strong);
    box-shadow:var(--glow-soft), 0 0 0 1px rgba(47,216,255,.25), 0 0 30px rgba(47,216,255,.12)}
  .clickable{cursor:pointer}
  .holo-scan{position:absolute; inset:0; border-radius:inherit; overflow:hidden; pointer-events:none; z-index:2}
  .holo-scan::before{content:""; position:absolute; left:0; right:0; top:-40%; height:40%;
    background:linear-gradient(180deg,transparent,rgba(120,235,255,.35),transparent);
    animation:holo-scan-sweep .6s ease-out calc(var(--enter,0s) + .06s) 1}
  @keyframes holo-scan-sweep{0%{transform:translateY(0); opacity:.9} 100%{transform:translateY(360%); opacity:0}}
  /* hold ONLY opacity at the end: a lingering transform makes the element a backdrop root
     and silently kills backdrop-filter on anything nested. Fill mode is backwards, not both. */
  @keyframes materialize{0%{opacity:0; transform:translateY(10px) scale(.972)} 60%{opacity:1} 100%{opacity:1}}
  .badge{display:inline-flex; align-items:center; gap:6px; height:22px; padding:0 9px; border-radius:0;
    font-family:var(--font-mono); font-size:11px; font-weight:600; letter-spacing:.04em; text-transform:uppercase;
    border:1px solid var(--glass-brd); background:rgba(255,255,255,.03); color:var(--ink-1); white-space:nowrap}
  .badge .dot{width:7px; height:7px; border-radius:50%; background:currentColor; box-shadow:0 0 8px currentColor}
  .badge-cyan{color:var(--cyan-soft); border-color:rgba(47,216,255,.35); background:rgba(47,216,255,.08)}
  .badge-amber{color:#ffd08a; border-color:rgba(255,179,71,.4); background:rgba(255,179,71,.1)}
  .badge-green{color:#8af2bd; border-color:rgba(52,240,166,.4); background:rgba(52,240,166,.1)}
  .badge-danger{color:#ff90a3; border-color:rgba(255,92,122,.4); background:rgba(255,92,122,.1)}
  .badge-ghost{color:var(--ink-2)}
  .row{display:flex; align-items:center} .col{display:flex; flex-direction:column}
  .between{display:flex; align-items:center; justify-content:space-between}
  .gap-1{gap:4px} .gap-2{gap:8px} .gap-3{gap:12px} .gap-4{gap:16px}
  .grow{flex:1; min-width:0; min-height:0}
  .divider{height:1px; background:var(--glass-brd); width:100%}
  .muted{color:var(--ink-2)} .dim{color:var(--ink-3)}
  .text-xs{font-size:12px} .text-sm{font-size:13px}

  /* ---------- home: the project card ---------- */
  .grid{display:grid; gap:18px; grid-template-columns:repeat(auto-fill,minmax(min(290px,100%),1fr))}
  .grid.off{display:none}
  .grid > *{animation:materialize .5s cubic-bezier(.2,.7,.3,1) backwards; animation-delay:var(--enter,0s)}
  .prj-card{display:flex; flex-direction:column; overflow:hidden; padding:0;
    transition:border-color .16s ease, box-shadow .16s ease, transform .16s ease}
  .prj-card:hover{border-color:rgba(47,216,255,.55);
    box-shadow:0 0 0 1px rgba(47,216,255,.4), 0 0 28px rgba(47,216,255,.3), 0 18px 44px rgba(0,0,0,.45);
    transform:translateY(-3px)}
  .prj-strip{position:relative; min-height:98px; padding:16px 16px 14px; overflow:hidden;
    display:flex; flex-direction:column; justify-content:flex-end;
    border-bottom:1px solid var(--glass-brd);
    background:linear-gradient(135deg,rgba(20,40,78,.5),rgba(9,18,38,.62))}
  .prj-strip-status{position:absolute; top:12px; left:14px}
  .prj-strip-name{font-family:var(--font-display); font-weight:700; font-size:21px; line-height:1.16;
    color:#fff; letter-spacing:-.01em; word-break:break-word;
    display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden}
  /* a 22px grid corner-masked into the strip, as the IDE does on its card covers */
  .prj-gridfx{position:absolute; inset:0; pointer-events:none;
    background-image:
      linear-gradient(rgba(255,255,255,.10) 1px, transparent 1px),
      linear-gradient(90deg, rgba(255,255,255,.10) 1px, transparent 1px);
    background-size:22px 22px;
    -webkit-mask-image:radial-gradient(120% 100% at 0% 0%,#000 30%,transparent 85%);
    mask-image:radial-gradient(120% 100% at 0% 0%,#000 30%,transparent 85%)}
  .prj-body{padding:14px 16px 16px}
  .prj-desc{display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden;
    line-height:1.45; min-height:2.9em; word-break:break-word}
  .prj-method{display:inline-flex; align-items:center; gap:6px; font-family:var(--font-mono);
    font-size:12px; color:var(--ink-2)}
  .prj-card.missing{opacity:.6}
  .prj-card.dragover{border-color:var(--cyan)}
  .grid-empty{grid-column:1/-1; padding:70px 24px; color:var(--ink-2); font-size:13.5px; line-height:1.7;
    max-width:640px; margin:0 auto; animation:none}
  .grid-empty b{color:var(--cyan-soft); font-weight:600}
  .ge-h{font-family:var(--font-display); font-size:21px; font-weight:700; letter-spacing:-.02em; color:#fff;
    margin-bottom:16px; text-align:center}
  .ge-steps{margin:0; padding-left:20px; display:flex; flex-direction:column; gap:11px}
  .ge-steps code{font-family:var(--font-mono); font-size:11.5px; color:var(--cyan-soft)}
  .ge-note{margin-top:18px; padding-top:14px; border-top:1px solid var(--glass-brd); font-family:var(--font-mono);
    font-size:11px; letter-spacing:.06em; color:var(--ink-3); text-align:center}


  /* ---------- rail ---------- */
  /* The IDE nav-item active state: a 3px cyan tick outside the item, a faint cyan
     gradient wash, and a cyan border — the tab does not move, the light does. */
  .rail{display:none; width:var(--rail-w); flex-shrink:0; flex-direction:column; gap:3px; padding:12px 8px;
    border-right:1px solid var(--glass-brd);
    background:linear-gradient(180deg,rgba(15,30,58,.97),rgba(10,20,42,.97));
    position:sticky; top:var(--topbar-h); height:calc(100vh - var(--topbar-h))}
  .rail.on{display:flex}
  .rl{position:relative; width:100%; padding:10px 2px 8px; background:none; border:1px solid transparent;
    cursor:pointer; display:flex; flex-direction:column; align-items:center; gap:5px;
    color:#c0c6cd; transition:all .14s ease}
  .rl:hover{color:#fff; background:rgba(255,255,255,.05)}
  .rl .g{font-size:17px; line-height:1}
  .rl .l{font-family:var(--font-mono); font-size:9px; letter-spacing:.1em; text-transform:uppercase}
  .rl.active{color:#fff;
    background:linear-gradient(100deg,rgba(47,216,255,.14),rgba(47,216,255,.04));
    border-color:rgba(47,216,255,.28);
    box-shadow:inset 0 0 0 1px rgba(47,216,255,.08), 0 0 18px rgba(47,216,255,.08)}
  .rl.active .g{color:var(--cyan); filter:drop-shadow(0 0 6px rgba(47,216,255,.6))}
  .rl.active::before{content:""; position:absolute; left:-8px; top:50%; transform:translateY(-50%);
    width:3px; height:20px; background:var(--cyan); box-shadow:0 0 12px var(--cyan)}
  .rl .badge{position:absolute; top:4px; right:6px; min-width:16px; height:16px; padding:0 4px;
    display:inline-flex; align-items:center; justify-content:center; font-family:var(--font-mono);
    font-size:9px; font-weight:600; background:rgba(47,216,255,.08); color:var(--cyan-soft);
    border:1px solid rgba(47,216,255,.35)}
  .rl .badge:empty{display:none}
  .rl .badge.stale{background:rgba(255,179,71,.1); color:#ffd08a; border-color:rgba(255,179,71,.4)}
  .rail-foot{margin-top:auto; padding-top:10px; border-top:1px solid var(--glass-brd);
    display:flex; flex-direction:column; align-items:center; gap:4px}
  .rail-foot a{font-family:var(--font-mono); font-size:9px; letter-spacing:.08em; color:var(--ink-3); text-decoration:none}
  .rail-foot a:hover{color:var(--cyan-soft)}
  .rail-foot span{font-family:var(--font-mono); font-size:8.5px; color:var(--faint)}


  @media (max-width:760px){
    .top-tools .search{width:130px}
    .rail{--rail-w:60px}
    .main{padding:16px 14px 50px}
  }


  /* ---------- detail ---------- */
  .placeholder{margin:auto; text-align:center; color:var(--dim2); padding:40px}
  .placeholder .big{font-size:44px; margin-bottom:14px; opacity:.5}
  .detail-wrap{width:100%}
  .pane{display:none; max-width:none; margin:0; padding:26px 32px 60px}
  .pane.active{display:block}
  .d-path{
    display:flex; align-items:center; gap:8px; color:var(--dim); font-size:13px;
    font-family:ui-monospace,SFMono-Regular,Menlo,monospace; word-break:break-all; margin-bottom:22px;
  }
  .d-path .rev{color:var(--dim); background:none; border:none; cursor:pointer; font-size:15px; padding:2px 4px; border-radius:6px}
  .d-path .rev:hover{color:var(--txt); background:var(--panel2)}
  .d-missing{color:var(--danger); font-size:13px; margin:-14px 0 20px; display:none}
  label{display:block; color:var(--dim); font-size:12px; text-transform:uppercase; letter-spacing:.6px; margin:0 0 7px}
  .f-name{
    width:100%; background:var(--panel); border:1px solid var(--line); color:var(--txt);
    font-size:22px; font-weight:650; padding:12px 14px; border-radius:11px; outline:none;
  }
  .f-name:focus{border-color:var(--accent)}
  .f-desc{
    width:100%; min-height:120px; resize:vertical; background:var(--panel); border:1px solid var(--line);
    color:var(--txt); font-size:14px; line-height:1.5; padding:12px 14px; border-radius:11px; outline:none; margin-top:2px;
  }
  .f-desc:focus{border-color:var(--accent)}
  .field{margin-bottom:22px}
  .saved{color:var(--ok); font-size:12px; opacity:0; transition:opacity .2s ease; margin-left:8px}
  .saved.show{opacity:1}
  .row-lbl{display:flex; align-items:center}

  .actions{display:flex; align-items:center; gap:10px; margin-top:10px; padding-top:24px; border-top:1px solid var(--line)}
  .run{
    display:inline-flex; align-items:center; gap:9px; background:var(--accent); color:#1a0f0a;
    border:none; font-weight:650; font-size:15px; padding:13px 22px; border-radius:11px; cursor:pointer;
    transition:filter .15s ease, transform .06s ease;
  }
  .run:hover{filter:brightness(1.06)} .run:active{transform:translateY(1px)}
  .ghost{
    background:var(--panel2); color:var(--txt); border:1px solid var(--line2);
    padding:12px 16px; border-radius:11px; cursor:pointer; font-size:14px;
  }
  .ghost:hover{border-color:#454b5c}
  .del{
    margin-left:auto; background:none; color:var(--danger); border:1px solid transparent;
    padding:12px 14px; border-radius:11px; cursor:pointer; font-size:14px;
  }
  .del:hover{background:rgba(229,72,77,.12); border-color:rgba(229,72,77,.4)}

  /* ---------- skills ---------- */
  .skills-box{margin-top:22px; padding-top:20px; border-top:1px solid var(--line)}
  .skills-label{color:var(--dim); font-size:12px; text-transform:uppercase; letter-spacing:.6px; margin-bottom:11px}
  .skills-btns{display:flex; flex-direction:column; gap:8px}
  .skill-item{display:flex; align-items:center; gap:14px; padding:11px 14px; cursor:pointer;
    background:linear-gradient(165deg,rgba(18,36,66,.4),rgba(9,18,38,.6)); border:1px solid var(--glass-brd);
    transition:border-color .15s ease, box-shadow .15s ease}
  .skill-item:hover{border-color:var(--glass-brd-strong); box-shadow:0 0 18px rgba(47,216,255,.1)}
  .skill-info{flex:1; min-width:0}
  .skill-name{font-family:var(--font-mono); font-size:13px; font-weight:600; color:var(--cyan-soft); letter-spacing:.02em}
  .skill-desc{color:var(--ink-2); font-size:12.5px; line-height:1.45; margin-top:4px}
  .skill-copy{flex:0 0 auto; font-family:var(--font-mono); font-size:12px; color:var(--ink-2);
    border:1px solid var(--faint); padding:6px 11px; white-space:nowrap}
  .skill-item:hover .skill-copy{border-color:var(--cyan); color:var(--cyan)}
  .skills-empty{color:var(--dim2); font-size:13px}

  /* ---------- task log ---------- */
  .tasks-head{display:flex; align-items:center; gap:9px; margin-bottom:14px}
  .tasks-head .t{font-size:12px; text-transform:uppercase; letter-spacing:.6px; color:var(--dim)}
  .tasks-head .upd{margin-left:auto; color:var(--dim2); font-size:11.5px}
  .task{display:flex; gap:11px; padding:12px 0; border-bottom:1px solid var(--line)}
  .task:last-child{border-bottom:none}
  .task .ic{font-size:15px; line-height:1.5; flex:0 0 auto}
  .task .body{min-width:0; flex:1}
  .task .tt{font-weight:600; font-size:14px; word-break:break-word}
  .task .dd{color:var(--dim); font-size:13px; margin-top:3px; white-space:pre-wrap; word-break:break-word}
  .task .meta{display:flex; flex-wrap:wrap; gap:6px; margin-top:8px; align-items:center}
  .task .file{background:var(--panel2); border:1px solid var(--line); color:var(--dim); font-size:11px; padding:2px 7px; border-radius:6px; font-family:ui-monospace,Menlo,monospace}
  .task .ts{color:var(--dim2); font-size:11px}
  .tasks-empty{color:var(--dim2); font-size:13px; padding:4px 0; line-height:1.6}
  .task.in_progress .ic{animation:pulse 1.2s ease-in-out infinite}
  @keyframes pulse{50%{opacity:.35}}

  /* ---------- model ---------- */
  .model-src{display:none; align-items:center; gap:8px; margin-bottom:14px; padding-bottom:12px; border-bottom:1px solid var(--line)}
  .msrc-l{font-family:var(--font-mono); font-size:11px; letter-spacing:.16em; text-transform:uppercase; color:var(--dim2)}
  .msrc{background:rgba(8,16,36,.5); border:1px solid var(--line2); color:var(--dim); font-family:var(--font-mono); font-size:12px; padding:5px 12px; cursor:pointer}
  .msrc:hover{color:var(--txt); border-color:var(--glass-brd-strong)}
  .msrc.active{background:rgba(47,216,255,.12); border-color:var(--cyan); color:var(--cyan)}
  .msrc-note{font-family:var(--font-mono); font-size:11px; color:var(--dim2); margin-left:4px}
  .model-head{display:flex; align-items:center; gap:10px; margin-bottom:18px}
  .model-subnav{display:flex; flex-wrap:wrap; gap:6px}
  .mpill{background:var(--panel2); border:1px solid var(--line2); color:var(--dim); font-size:13px; padding:6px 12px; border-radius:8px; cursor:pointer}
  .mpill:hover{color:var(--txt)}
  .mpill.active{background:var(--accent); color:#1a0f0a; border-color:var(--accent)}
  .model-head .upd{margin-left:auto; color:var(--dim2); font-size:11.5px}
  .mrefresh{background:var(--panel2); border:1px solid var(--line2); color:var(--dim); width:32px; height:32px; border-radius:8px; cursor:pointer; font-size:15px}
  .mshare{width:auto; padding:0 12px; white-space:nowrap; letter-spacing:.06em}
  .mrefresh:hover{color:var(--txt)}
  .model-empty{color:var(--dim2); font-size:13px; line-height:1.65; padding:20px 0}
  .model-empty code{background:var(--panel2); padding:1px 6px; border-radius:5px; font-size:12px}
  .mermaid-wrap{overflow:auto; background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:16px}
  .mermaid-wrap svg{max-width:none; height:auto}
  .holo-wrap{overflow:auto; border:1px solid var(--line2); border-radius:12px; background:#061021; max-height:74vh; cursor:zoom-in}
  .holo-wrap svg{display:block; max-width:100%; height:auto}
  /* pan/zoom diagram canvas (ide.gitmir.com style) */
  .dgm{position:relative; border:1px solid var(--glass-brd); background:#061021}
  .dgm-bar{display:flex; align-items:center; gap:6px; padding:8px 10px; border-bottom:1px solid var(--line); background:rgba(6,12,24,.72)}
  .dgm-b{background:transparent; border:1px solid var(--faint); color:var(--ink-1); padding:5px 11px; cursor:pointer; font-size:13px; min-width:34px; line-height:1}
  .dgm-b:hover{border-color:var(--cyan); color:var(--cyan)}
  .dgm-hint{flex:1; color:var(--ink-3); font-family:var(--font-mono); font-size:11px; letter-spacing:.02em; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; padding:0 6px}
  .dgm-full{min-width:34px}
  .dgm-canvas{position:relative; height:60vh; overflow:hidden; cursor:grab; touch-action:none;
    background-color:#061021;
    background-image:linear-gradient(rgba(120,210,255,.05) 1px, transparent 1px), linear-gradient(90deg, rgba(120,210,255,.05) 1px, transparent 1px);
    background-size:28px 28px; background-position:0 0}
  .dgm-canvas.grab{cursor:grabbing}
  .dgm-stage{position:absolute; top:0; left:0; transform-origin:0 0}
  .dgm-stage svg{display:block}
  .mmsrc{overflow:auto; max-height:220px; background:#0b0c10; border:1px solid var(--line); border-radius:8px; padding:10px; font-size:11px; color:var(--dim); margin-top:10px}
  .ov-grid{display:grid; grid-template-columns:repeat(auto-fill,minmax(108px,1fr)); gap:10px; margin-bottom:22px}
  .ov-card{background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:14px 12px; text-align:center}
  .ov-n{font-size:26px; font-weight:700; color:var(--txt)}
  .ov-l{color:var(--dim); font-size:12px; margin-top:2px}
  .ov-sec{font-size:12px; text-transform:uppercase; letter-spacing:.6px; color:var(--dim); margin:18px 0 10px}
  .ov-mods{display:flex; flex-direction:column; gap:6px}
  .ov-mod{background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:10px 12px; font-size:14px}
  .ov-mod span{display:block; color:var(--dim); font-size:12px; margin-top:2px}
  .ov-brief{background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:12px; color:var(--dim); font-size:13px; line-height:1.55}
  .proc-block{margin-bottom:24px}
  .proc-title{font-weight:640; font-size:15px; margin-bottom:4px}
  .proc-desc{color:var(--dim); font-size:13px; margin-bottom:10px}
  .proc-diagram{overflow:auto}

  /* business logic view */
  .ent-picker{display:flex; flex-wrap:wrap; gap:7px; margin-bottom:20px; padding-bottom:18px; border-bottom:1px solid var(--line)}
  .epill{background:var(--panel); border:1px solid var(--line2); color:var(--txt); font-size:13px; font-weight:600; padding:8px 13px; border-radius:9px; cursor:pointer}
  .epill:hover{border-color:#454b5c}
  .epill.active{background:var(--accent); color:#1a0f0a; border-color:var(--accent)}
  .epill .lc{opacity:.7; font-size:12px}
  .logic-h{margin-bottom:20px}
  .logic-title{font-size:22px; font-weight:700}
  .logic-desc{color:var(--dim); font-size:14px; margin-top:4px}
  .logic-sec{margin-bottom:28px}
  .logic-sec-t{font-size:13px; font-weight:650; color:var(--txt); margin-bottom:12px; padding-bottom:8px; border-bottom:1px solid var(--line)}
  .logic-cap{color:var(--dim); font-size:12px; margin-bottom:8px; font-family:ui-monospace,Menlo,monospace}
  .op-table{width:100%; border-collapse:collapse; font-size:13px}
  .op-table th{text-align:left; color:var(--dim); font-weight:600; font-size:11px; text-transform:uppercase; letter-spacing:.5px; padding:8px 10px; border-bottom:1px solid var(--line)}
  .op-table td{padding:9px 10px; border-bottom:1px solid var(--line); vertical-align:top}
  .op-table code{background:var(--panel2); padding:1px 6px; border-radius:5px; font-size:11.5px; color:var(--accent2)}
  .rw{display:inline-block; font-size:10px; font-weight:700; padding:1px 5px; border-radius:4px; margin-right:3px}
  .rw.r{background:#12233a; color:#8ec7ff; border:1px solid #2b5a86}
  .rw.w{background:#3a2a12; color:#ffcfa0; border:1px solid #86602b}
  .rx-row{background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:11px 13px; margin-bottom:8px; font-size:14px}
  .rx-trig{color:var(--dim); font-size:12px; margin-left:8px}
  .rx-eff{color:var(--accent2); font-size:13px; margin-top:5px}

  /* fullscreen diagram viewer */
  .mermaid-box{position:relative}
  .fs-open{position:absolute; top:8px; right:8px; z-index:2; background:rgba(20,22,28,.9); border:1px solid var(--line2); color:var(--dim); cursor:pointer; font-size:12px; padding:6px 10px; border-radius:8px}
  .fs-open:hover{color:var(--txt); border-color:var(--accent)}
  .mermaid-wrap{cursor:zoom-in}
  .fs-overlay{position:fixed; inset:0; z-index:1000; background:rgba(8,9,12,.98); display:none; flex-direction:column}
  .fs-overlay.show{display:flex}
  .fs-bar{display:flex; gap:8px; align-items:center; padding:12px 16px; border-bottom:1px solid var(--line); background:var(--panel)}
  .fs-btn{background:var(--panel2); border:1px solid var(--line2); color:var(--txt); padding:8px 13px; border-radius:8px; cursor:pointer; font-size:14px; min-width:42px}
  .fs-btn:hover{border-color:var(--accent)}
  .fs-hint{color:var(--dim2); font-size:12px; margin-left:6px}
  .fs-close{margin-left:auto; color:var(--danger); font-weight:600}
  .fs-canvas{flex:1; overflow:hidden; position:relative; cursor:grab;
    background-color:#061021;
    background-image:linear-gradient(rgba(120,210,255,.05) 1px, transparent 1px), linear-gradient(90deg, rgba(120,210,255,.05) 1px, transparent 1px);
    background-size:28px 28px; background-position:0 0}
  .fs-canvas.drag, .fs-canvas.grab{cursor:grabbing}
  .fs-stage{position:absolute; top:0; left:0; transform-origin:0 0}
  .fs-stage svg{display:block}

  /* context popup (click a schema element) */
  .ctx-overlay{position:fixed; inset:0; z-index:1100; background:rgba(3,6,14,.72); display:none; align-items:center; justify-content:center; padding:30px}
  .ctx-overlay.show{display:flex}
  .ctx-modal{width:100%; max-width:780px; max-height:88vh; display:flex; flex-direction:column; background:linear-gradient(165deg,rgba(16,32,60,.96),rgba(8,17,36,.98)); border:1px solid var(--glass-brd-strong); box-shadow:0 20px 60px rgba(0,0,0,.6), 0 0 30px rgba(47,216,255,.1)}
  .ctx-head{display:flex; align-items:center; gap:10px; padding:16px 18px; border-bottom:1px solid var(--glass-brd)}
  .ctx-title{font-weight:650; font-size:16px; color:#fff}
  .ctx-x{margin-left:auto; background:none; border:none; color:var(--ink-2); cursor:pointer; font-size:16px}
  .ctx-x:hover{color:var(--txt)}
  .ctx-note{padding:11px 18px 0; color:var(--ink-3); font-size:12px; font-family:var(--font-mono); line-height:1.5}
  .ctx-pre{margin:12px 18px; padding:14px; overflow:auto; background:#061021; border:1px solid var(--line); color:#cfe0f5; font:12px/1.55 "JetBrains Mono",ui-monospace,monospace; white-space:pre-wrap; word-break:break-word; flex:1; min-height:120px}
  .ctx-taskl{padding:0 18px; color:var(--cyan-soft); font-family:var(--font-mono); font-size:11px; letter-spacing:.14em; text-transform:uppercase}
  .ctx-task{margin:8px 18px 0; padding:11px 13px; background:rgba(8,16,36,.6); border:1px solid var(--glass-brd); color:var(--ink-0); font-size:14px; min-height:70px; resize:vertical; outline:none; font-family:inherit}
  .ctx-task:focus{border-color:rgba(47,216,255,.55); box-shadow:0 0 0 3px rgba(47,216,255,.12)}
  .ctx-actions{display:flex; gap:10px; align-items:center; padding:14px 18px 18px}
  .ctx-actions .del{margin-left:auto}

  /* task queue */
  .q-cols{display:grid; grid-template-columns:repeat(4,1fr); gap:12px}
  .q-col{background:rgba(10,18,36,.5); border:1px solid var(--line); min-height:120px}
  .q-col-h{font-family:var(--font-mono); text-transform:uppercase; letter-spacing:.12em; font-size:12px; padding:12px 14px; border-bottom:1px solid var(--line)}
  .q-col-h .q-n{color:var(--ink-3)}
  .q-list{padding:10px; display:flex; flex-direction:column; gap:8px}
  .q-empty{color:var(--ink-3); font-size:13px; text-align:center; padding:10px}
  .q-card{background:rgba(14,30,58,.5); border:1px solid var(--line); border-left:3px solid; padding:10px 12px}
  .q-t{font-size:13px; color:var(--ink-0); word-break:break-word}
  .q-f{font-family:var(--font-mono); font-size:10.5px; color:var(--ink-3); margin-top:5px; word-break:break-all}
  .q-clk{cursor:pointer; transition:border-color .15s ease, box-shadow .15s ease, transform .06s ease}
  .q-clk:hover{border-color:var(--glass-brd-strong); box-shadow:0 0 16px rgba(47,216,255,.12)}
  .q-clk:active{transform:translateY(1px)}
  .q-badge{font-family:var(--font-mono); text-transform:uppercase; letter-spacing:.12em; font-size:10px; padding:3px 9px; border:1px solid; border-radius:0; flex-shrink:0}

  .map-cap{margin-bottom:14px; color:var(--dim); font-size:13px; line-height:1.65; max-width:1000px}
  .map-cap b{color:var(--cyan-soft); font-weight:500; font-family:var(--font-mono); font-size:12px}
  .map-cap2{display:block; margin-top:8px; color:var(--dim2); font-size:12.5px}

  .model-stale{display:none; margin-bottom:14px; padding:13px 15px; border:1px solid rgba(255,184,107,.45); background:rgba(255,184,107,.07)}
  .stale-hd{font-size:13.5px; font-weight:650; color:#ffb86b}
  .stale-b{margin-top:5px; color:var(--dim); font-size:12.5px; line-height:1.6}
  .stale-b code{font-family:var(--font-mono); font-size:11.5px; color:var(--cyan-soft)}
  .stale-fix{margin-top:11px; font-size:13px; padding:9px 14px}

  /* share a read-only map */
  .share-modal{max-width:640px}
  /* Every child of .ctx-modal carries its own 18px gutter — the modal itself has none. */
  .sh-body{padding:16px 18px 4px; overflow:auto}
  .sh-key{margin-top:0}
  .sh-key label,.sh-exp label{display:block; font-family:var(--font-mono); text-transform:uppercase; letter-spacing:.14em; font-size:10.5px; color:var(--cyan-soft); margin-bottom:6px}
  .sh-note{margin-top:6px; color:var(--dim2); font-size:12px}
  .sh-modes{margin-top:16px; display:flex; flex-direction:column; gap:10px}
  .sh-radio{display:flex; align-items:center; gap:10px; font-size:13.5px; color:var(--txt); cursor:pointer; flex-wrap:wrap}
  .sh-radio input[type=radio]{accent-color:var(--cyan); width:15px; height:15px}
  .sh-people{flex:1; min-width:240px; margin-left:6px}
  .sh-people:disabled{opacity:.4}
  .sh-exp{margin-top:16px; max-width:200px}
  .sh-what{margin-top:16px; padding:11px 13px; border-left:2px solid var(--line2); background:rgba(0,0,0,.22); color:var(--dim); font-size:12.5px; line-height:1.7}
  .sh-what b{color:var(--txt); font-weight:600}
  .sh-out{margin-top:14px; font-size:12.5px; line-height:1.65; color:var(--dim2)}
  .sh-out.err{color:#ff5c6e}
  .sh-out.ok{color:var(--dim)}
  .sh-url{display:flex; gap:10px; align-items:center; flex-wrap:wrap}
  .sh-url code{font-family:var(--font-mono); font-size:12px; color:var(--cyan); word-break:break-all}
  .sh-warn{margin-top:8px; color:#ffb86b}
  .sh-manage{margin-top:8px; color:var(--dim2); font-size:12px}
  .sh-out a{color:var(--cyan-soft)}

  /* model ingest — a big source being eaten one fragment at a time */
  .ingest{display:none; margin-bottom:14px; padding:13px 15px; border:1px solid rgba(47,216,255,.32); background:linear-gradient(180deg,rgba(47,216,255,.07),rgba(47,216,255,.02))}
  .ingest.ing-done{border-color:var(--line); background:none; padding:10px 13px}
  .ing-hd{display:flex; align-items:baseline; gap:11px; flex-wrap:wrap}
  .ing-t{font-family:var(--font-mono); text-transform:uppercase; letter-spacing:.16em; font-size:11px; color:var(--cyan-soft)}
  .ing-n{font-size:13.5px; font-weight:650; color:var(--txt)}
  .ing-pct{margin-left:auto; font-family:var(--font-mono); font-size:12px; color:var(--cyan)}
  .ing-bar{margin-top:9px; height:5px; background:rgba(255,255,255,.06); overflow:hidden}
  .ing-bar i{display:block; height:100%; background:var(--cyan); box-shadow:0 0 10px rgba(47,216,255,.6); transition:width .35s ease}
  .ing-tape{display:flex; flex-wrap:wrap; gap:2px; margin-top:10px}
  .ic{width:13px; height:13px; flex:0 0 auto; border:1px solid; cursor:pointer; background:none}
  .ic.done{background:var(--cyan); border-color:var(--cyan)}
  .ic.pending{border-color:rgba(255,255,255,.16)}
  .ic.blocked{background:rgba(255,92,110,.5); border-color:#ff5c6e}
  .ic.skipped{border-color:rgba(255,255,255,.16); background:repeating-linear-gradient(45deg,rgba(255,255,255,.12) 0 2px,transparent 2px 4px)}
  .ic.sel{outline:1px solid var(--cyan); outline-offset:2px}
  .ing-meta{margin-top:10px; color:var(--dim); font-size:12.5px; line-height:1.65}
  .ing-meta code,.ing-frag code{font-family:var(--font-mono); font-size:11.5px; color:var(--cyan-soft)}
  .ing-grew{margin-top:7px; display:flex; flex-wrap:wrap; gap:4px 14px; font-family:var(--font-mono); font-size:11px; color:var(--dim2)}
  .ing-grew b{color:var(--cyan-soft); font-weight:500}
  .ing-frag{display:none; margin-top:10px; padding:10px 12px; border:1px solid var(--line); background:rgba(0,0,0,.25); font-size:12.5px; color:var(--dim); line-height:1.6}
  .ing-frag .fh{color:var(--txt); font-weight:600; font-size:13px}
  .ing-un{margin-top:12px; border-top:1px solid var(--line); padding-top:11px}
  .ing-un summary{cursor:pointer; font-size:12.5px; color:#ffb86b; list-style:none}
  .ing-un summary::-webkit-details-marker{display:none}
  .ing-un summary:before{content:"▸ "; font-family:var(--font-mono)}
  .ing-un[open] summary:before{content:"▾ "}
  .ing-un table{width:100%; border-collapse:collapse; margin-top:9px; font-size:12px}
  .ing-un td{padding:5px 9px 5px 0; border-bottom:1px solid var(--line); vertical-align:top; color:var(--dim)}
  .ing-un td.w{font-family:var(--font-mono); color:var(--txt); white-space:nowrap}
  .ing-un td.e{font-family:var(--font-mono); font-size:11px; color:var(--dim2)}
  .ing-note{margin-top:9px; color:var(--dim2); font-size:12px; line-height:1.6}

  /* app audit — coverage first, then what it could not reach, then the defects */
  .audit{display:none; margin-bottom:16px; padding:13px 15px; border:1px solid rgba(47,216,255,.3); background:linear-gradient(180deg,rgba(47,216,255,.06),rgba(47,216,255,.015))}
  .ic.passed{background:var(--ok); border-color:var(--ok)}
  .ic.failed{background:#ff5c6e; border-color:#ff5c6e}
  .ic.unreachable{border-color:#ffb86b; background:rgba(255,184,107,.18)}
  .au-gaps{margin-top:10px; padding:9px 11px; border-left:2px solid #ffb86b; background:rgba(255,184,107,.06); color:var(--dim); font-size:12.5px; line-height:1.7}
  .au-gaps b{color:#ffb86b; font-weight:600}
  .au-run{margin-top:9px; display:flex; flex-wrap:wrap; gap:5px 16px; font-family:var(--font-mono); font-size:11px; color:var(--dim2)}
  .au-run b{color:var(--cyan-soft); font-weight:500}
  .au-sev{margin-top:12px; display:flex; flex-wrap:wrap; gap:7px}
  .sv{font-family:var(--font-mono); font-size:10.5px; text-transform:uppercase; letter-spacing:.1em; padding:3px 9px; border:1px solid}
  .sv.critical{color:#ff5c6e; border-color:#ff5c6e; background:rgba(255,92,110,.1)}
  .sv.major{color:#ffb86b; border-color:#ffb86b; background:rgba(255,184,107,.1)}
  .sv.minor{color:var(--dim); border-color:var(--line)}
  .sv.intermittent{color:#c084fc; border-color:#c084fc; background:rgba(192,132,252,.1)}
  .au-find{margin-top:11px; border-top:1px solid var(--line)}
  .af{padding:10px 0; border-bottom:1px solid var(--line); font-size:12.5px; line-height:1.65}
  .af-h{display:flex; gap:9px; align-items:baseline; flex-wrap:wrap}
  .af-t{color:var(--txt); font-weight:600; font-size:13px}
  .af-p{font-family:var(--font-mono); font-size:11px; color:var(--dim2)}
  .af-r{margin-top:4px; color:var(--dim)}
  .af-r i{font-style:normal; font-family:var(--font-mono); font-size:11px; color:var(--dim2); margin-right:6px}
  .af-x{color:#ff5c6e}
  .au-mm{margin-top:11px; color:var(--dim); font-size:12.5px; line-height:1.7}
  .au-mm code{font-family:var(--font-mono); font-size:11.5px; color:#ffb86b}

  /* preview & pick */
  .pv-bar{display:flex; gap:9px; margin-bottom:12px}
  .pv-url{flex:1}
  .pv-pick.on{background:rgba(47,216,255,.14); border-color:var(--cyan); color:var(--cyan)}
  /* The preview pane fills the window: a fixed vh left dead space below the frame. */
  .detail-wrap{display:flex; flex-direction:column; min-height:100%}
  .pane[data-pane="preview"].active{display:flex; flex-direction:column; flex:1; min-height:0; padding-bottom:26px}
  .pv-frame-wrap{position:relative; flex:1; min-height:280px; border:1px solid var(--glass-brd);
    background-color:#061021;
    background-image:linear-gradient(rgba(120,210,255,.05) 1px, transparent 1px), linear-gradient(90deg, rgba(120,210,255,.05) 1px, transparent 1px);
    background-size:28px 28px}
  /* white only once a real page is in there — an empty canvas should read as ours */
  .pv-frame-wrap.loaded{background-color:#fff; background-image:none}
  .pv-frame{width:100%; height:100%; border:0; display:none; background:#fff}
  .pv-frame.on{display:block}
  .pv-empty{position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center; padding:34px}
  .pv-glyph{font-size:26px; line-height:1; color:var(--cyan); text-shadow:0 0 22px rgba(47,216,255,.55); margin-bottom:16px}
  .pv-lead{font-family:var(--font-mono); font-size:11px; letter-spacing:.2em; text-transform:uppercase; color:var(--cyan-soft); margin-bottom:12px}
  .pv-h{font-size:16.5px; font-weight:650; color:var(--txt); margin-bottom:9px}
  .pv-sub{color:var(--dim); font-size:13px; line-height:1.7; max-width:540px}
  .pv-note{display:block; color:var(--dim2); font-size:12px; margin-top:10px; line-height:1.6}
  .pv-eg{display:flex; gap:8px; margin-top:20px; flex-wrap:wrap; justify-content:center}
  .pv-egb{font-family:var(--font-mono); font-size:11.5px; color:var(--ink-2); background:rgba(8,16,36,.6);
    border:1px solid var(--faint); padding:6px 12px; cursor:pointer}
  .pv-egb:hover{color:var(--cyan); border-color:rgba(47,216,255,.5)}
  .pv-card{margin-top:16px; padding:16px; border:1px solid var(--line); background:linear-gradient(165deg,rgba(18,36,66,.4),rgba(9,18,38,.6))}
  .pv-el{font-family:var(--font-mono); font-size:12.5px; color:var(--cyan-soft); word-break:break-all; line-height:1.7}
  .pv-el b{color:var(--txt)}
  .pv-k{color:var(--dim2)}
  .pv-hits{margin-top:12px; font-family:var(--font-mono); font-size:12px; line-height:1.7}
  .pv-hit{color:var(--dim); word-break:break-all}
  .pv-hit b{color:var(--ok); font-weight:500}
  .pv-none{color:#ffb86b}
  .pv-sec{font-family:var(--font-mono); font-size:11px; letter-spacing:.14em; text-transform:uppercase; color:var(--cyan-soft); margin:14px 0 7px}

  /* team bridge */
  .team-card{background:linear-gradient(165deg,rgba(18,36,66,.4),rgba(9,18,38,.6)); border:1px solid var(--line); padding:18px; margin-bottom:16px}
  .team-lede{color:var(--dim); font-size:13px; line-height:1.55; margin-bottom:16px}
  .team-lede b{color:var(--cyan-soft); font-weight:600}
  .ti{width:100%; background:rgba(8,16,36,.5); border:1px solid var(--line); color:var(--txt); font-size:14px; padding:10px 12px; outline:none; font-family:inherit; border-radius:8px}
  select.ti{cursor:pointer}
  textarea.ti{min-height:74px; resize:vertical; margin-top:8px; line-height:1.5}
  .ti:focus{border-color:var(--accent); box-shadow:0 0 0 3px rgba(47,216,255,.12)}
  .team-actions{display:flex; align-items:center; gap:12px; margin-top:12px}
  .team-cstate,.team-connecting{font-family:var(--font-mono); font-size:12px; color:var(--cyan-soft)}
  .team-err{font-family:var(--font-mono); font-size:12px; color:#ff7080; line-height:1.5; display:block; margin-top:4px}
  .team-status-row{display:flex; align-items:center; gap:14px; flex-wrap:wrap; font-family:var(--font-mono); font-size:12px; letter-spacing:.03em}
  .team-mirror{margin-top:14px; padding:11px 13px; border:1px solid var(--line); background:rgba(8,16,36,.45)}
  .mirror-hd{display:flex; align-items:center; gap:9px; font-size:13px; color:var(--txt)}
  .mirror-dot{width:9px; height:9px; border-radius:50%; flex-shrink:0; background:var(--ok); box-shadow:0 0 9px var(--ok)}
  .mirror-dot.tasks{background:#ffb86b; box-shadow:0 0 9px #ffb86b}
  .mirror-dot.full{background:#ff7080; box-shadow:0 0 9px #ff7080}
  .mirror-lvl{margin-left:auto; font-family:var(--font-mono); font-size:10px; letter-spacing:.14em; text-transform:uppercase; color:var(--dim2); border:1px solid var(--faint); padding:2px 8px}
  .mirror-note{margin-top:6px; font-size:12px; line-height:1.5; color:var(--dim)}
  .lbl-hint{text-transform:none; letter-spacing:0; color:var(--dim2); font-weight:400; margin-left:6px; font-family:var(--font-mono); font-size:10.5px}
  .team-dot{width:9px; height:9px; border-radius:50%; background:var(--dim2); display:inline-block}
  .team-dot.on{background:var(--ok); box-shadow:0 0 10px var(--ok)}
  .team-self{color:var(--txt); font-weight:600}
  .team-plan,.team-bound{color:var(--dim)}
  .team-members{display:flex; flex-wrap:wrap; gap:8px; margin:14px 0}
  .team-chip{font-family:var(--font-mono); font-size:12px; padding:4px 10px; border:1px solid var(--line); color:var(--cyan-soft); background:rgba(47,216,255,.06); border-radius:0}
  .team-chip.me{border-color:rgba(47,216,255,.4); color:var(--cyan)}
  .team-empty{color:var(--dim2); font-size:12.5px; font-style:italic}
  .team-ops{display:flex; gap:10px; margin-top:6px}
  .team-feed-h{font-family:var(--font-mono); text-transform:uppercase; letter-spacing:.14em; font-size:11px; color:var(--cyan-soft); margin-bottom:10px}
  .team-act{display:flex; align-items:baseline; gap:10px; padding:6px 0; border-bottom:1px solid rgba(47,216,255,.06); font-size:12.5px}
  .ta-k{font-family:var(--font-mono); font-size:10px; text-transform:uppercase; letter-spacing:.08em; color:var(--cyan); min-width:62px; flex-shrink:0}
  .ta-t{color:var(--dim); flex:1; word-break:break-word}
  .ta-time{color:var(--dim2); font-size:11px; font-family:var(--font-mono); flex-shrink:0}

  .ph-h{font-size:16px; font-weight:650; color:var(--txt); margin:14px 0 4px}
  .ph-steps{list-style:none; counter-reset:s; padding:0; margin:14px 0 0; max-width:620px; text-align:left}
  .ph-steps li{counter-increment:s; position:relative; padding:9px 0 9px 34px; color:var(--dim); font-size:13.5px; line-height:1.6}
  .ph-steps li::before{content:counter(s); position:absolute; left:0; top:9px; width:22px; height:22px;
    display:flex; align-items:center; justify-content:center; font-family:var(--font-mono); font-size:11px;
    color:var(--cyan); border:1px solid rgba(47,216,255,.4); background:rgba(47,216,255,.07)}
  .ph-steps b{color:var(--txt); font-weight:600}
  .ph-steps code{font-family:var(--font-mono); font-size:12px; color:var(--cyan-soft)}
  .ph-note{margin-top:18px; font-family:var(--font-mono); font-size:11.5px; color:var(--dim2)}

  .toast{
    position:fixed;bottom:22px;left:50%;transform:translateX(-50%) translateY(30px);
    background:var(--panel2);border:1px solid var(--line2);color:var(--txt);
    padding:12px 18px;border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.5);
    opacity:0;transition:all .22s ease;pointer-events:none;font-size:14px;z-index:1200;
  }
  .toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
  .toast.err{border-color:var(--danger)}

  /* ==================== gitmir HUD ==================== */
  ::selection{ background:rgba(47,216,255,.3); color:#fff }
  *::-webkit-scrollbar{ width:10px; height:10px }
  *::-webkit-scrollbar-track{ background:transparent }
  *::-webkit-scrollbar-thumb{ background:rgba(86,198,255,.16); border:2px solid transparent; background-clip:content-box }
  *::-webkit-scrollbar-thumb:hover{ background:rgba(86,198,255,.32); background-clip:content-box }

  /* sharp corners (HUD): everything square except circles */
  .add,.search,.item,.f-name,.f-desc,.run,.ghost,.del,.skill-btn,.mrefresh,.fs-btn,.fs-open,
  .mpill,.epill,.ov-card,.ov-mod,.ov-brief,.rx-row,.task .file,.holo-wrap,.mermaid-wrap,
  .toast,.tab-btn .badge,.rw,.op-table code,.model-empty code,.mmsrc,.d-path .rev{ border-radius:0 !important }

  /* sidebar → glass */
  .brand{ font-family:var(--font-ui); text-transform:uppercase; letter-spacing:.16em; font-size:13px; font-weight:600; color:#fff; gap:10px }
  .brand .c{ font-family:var(--font-mono); letter-spacing:.04em; text-transform:none }
  .brand-logo{ height:19px; width:auto; display:block; filter:drop-shadow(0 0 8px rgba(47,216,255,.45)); -webkit-user-select:none; user-select:none }
  .brand-link{ display:block; line-height:0; cursor:pointer; transition:filter .15s ease, opacity .15s ease }
  .brand-link:hover .brand-logo{ filter:drop-shadow(0 0 12px rgba(47,216,255,.85)) }
  .brand-link:active{ opacity:.75 }
  .brand-sub{ font-family:var(--font-mono); font-size:11px; letter-spacing:.14em; color:var(--ink-2); text-transform:uppercase; padding-left:10px; border-left:1px solid var(--glass-brd) }
  /* AGPL-3.0 section 13: anyone using this over a network must be able to get the source. */
  .brand-src{ font-family:var(--font-mono); font-size:10.5px; letter-spacing:.1em; text-transform:uppercase; color:var(--ink-3); text-decoration:none; border:1px solid var(--faint); padding:3px 8px }
  .brand-src:hover{ color:var(--cyan); border-color:rgba(47,216,255,.45) }
  .foot-lic{ font-family:var(--font-mono); font-size:10.5px; letter-spacing:.1em; color:var(--ink-3) }
  .dot{ background:var(--cyan); box-shadow:0 0 10px var(--cyan) }

  /* buttons */
  .add{ background:var(--ink-0); color:#05070c; font-weight:700; box-shadow:0 0 22px rgba(47,216,255,.12); border:1px solid transparent }
  .add:hover{ background:var(--cyan); color:#05070c; filter:none; box-shadow:0 0 30px rgba(47,216,255,.5) }
  .run{ background:linear-gradient(100deg,var(--ice) 0%,var(--cyan) 60%,var(--cyan-deep) 100%); color:#05070c; box-shadow:0 0 26px rgba(47,216,255,.32); border:none }
  .run:hover{ filter:brightness(1.08); box-shadow:0 0 34px rgba(47,216,255,.55) }
  .ghost,.skill-btn,.mrefresh,.fs-btn{ background:transparent; border:1px solid var(--faint); color:var(--ink-1) }
  .ghost:hover,.skill-btn:hover,.mrefresh:hover,.fs-btn:hover{ border-color:var(--cyan); color:var(--cyan); background:rgba(47,216,255,.05) }
  .del{ border:1px solid rgba(255,85,102,.4); color:#ff7080; background:rgba(255,85,102,.06) }
  .del:hover{ background:rgba(255,85,102,.16); border-color:rgba(255,85,102,.7); color:#ff7080 }
  .fs-open{ background:rgba(6,16,30,.82); border:1px solid var(--glass-brd); color:var(--cyan-soft) }
  .fs-open:hover{ border-color:var(--cyan); color:var(--cyan) }

  /* inputs */
  .search,.f-name,.f-desc{ background:rgba(8,16,36,.5); border:1px solid var(--glass-brd); color:var(--ink-0) }
  .search:focus,.f-name:focus,.f-desc:focus{ border-color:rgba(47,216,255,.55); box-shadow:0 0 0 3px rgba(47,216,255,.12); background:rgba(8,16,36,.78) }
  .search::placeholder,.f-desc::placeholder{ color:var(--ink-3) }

  /* project list → nav */

  /* tabs */

  /* labels → HUD eyebrow (mono, uppercase, cyan) */
  label,.skills-label,.ov-sec,.tasks-head .t{ font-family:var(--font-mono); letter-spacing:.18em; color:var(--cyan-soft); font-size:11px }
  .logic-sec-t,.op-table th{ font-family:var(--font-mono); text-transform:uppercase; letter-spacing:.12em; color:#dfeeff }

  /* pills (model views, entity picker) */
  .mpill,.epill{ background:rgba(8,16,34,.5); border:1px solid var(--glass-brd); color:var(--ink-2); font-family:var(--font-mono); letter-spacing:.03em }
  .mpill:hover,.epill:hover{ color:var(--ice); border-color:rgba(47,216,255,.4); background:rgba(47,216,255,.06) }
  .mpill.active,.epill.active{ background:var(--cyan); color:#05070c; border-color:var(--cyan); box-shadow:0 0 16px rgba(47,216,255,.4) }

  /* cards / surfaces */
  .ov-card,.ov-mod,.ov-brief,.rx-row{ background:linear-gradient(165deg,rgba(18,36,66,.4),rgba(9,18,38,.6)); border:1px solid var(--glass-brd) }
  .ov-n{ color:#fff; font-family:var(--font-mono) }
  .ov-card:hover{ border-color:var(--glass-brd-strong); box-shadow:0 0 20px rgba(47,216,255,.1) }
  .task .file{ background:rgba(47,216,255,.06); border:1px solid var(--glass-brd); color:var(--cyan-soft); font-family:var(--font-mono) }
  .rw.r{ background:rgba(47,216,255,.1); color:#8ec7ff; border:1px solid rgba(47,216,255,.35) }
  .rw.w{ background:rgba(255,179,71,.12); color:#ffd08a; border:1px solid rgba(255,179,71,.4) }
  .op-table code,.model-empty code,.logic-cap,.d-path{ font-family:var(--font-mono); color:var(--cyan-soft) }
  .rx-eff{ color:var(--cyan-soft) }

  /* diagram frame + corner brackets (HUD signature) */
  .holo-wrap{ border:1px solid var(--glass-brd) }
  .mermaid-box{ position:relative }
  .dgm::before, .pv-frame-wrap::before{ content:""; position:absolute; inset:-1px; pointer-events:none; z-index:3;
    --cb:14px; --cw:2px; --cc:var(--cyan);
    background:
      linear-gradient(90deg,transparent,rgba(95,222,255,.5),transparent) 50% 0/calc(100% - 48px) 1px no-repeat,
      linear-gradient(var(--cc),var(--cc)) 0 0/var(--cb) var(--cw) no-repeat,
      linear-gradient(var(--cc),var(--cc)) 0 0/var(--cw) var(--cb) no-repeat,
      linear-gradient(var(--cc),var(--cc)) 100% 0/var(--cb) var(--cw) no-repeat,
      linear-gradient(var(--cc),var(--cc)) 100% 0/var(--cw) var(--cb) no-repeat,
      linear-gradient(var(--cc),var(--cc)) 0 100%/var(--cb) var(--cw) no-repeat,
      linear-gradient(var(--cc),var(--cc)) 0 100%/var(--cw) var(--cb) no-repeat,
      linear-gradient(var(--cc),var(--cc)) 100% 100%/var(--cb) var(--cw) no-repeat,
      linear-gradient(var(--cc),var(--cc)) 100% 100%/var(--cw) var(--cb) no-repeat;
    filter:drop-shadow(0 0 4px rgba(95,222,255,.7)); opacity:.85;
  }

  /* fullscreen viewer */
  .fs-overlay{ background:rgba(3,6,14,.97) }
  .fs-bar{ background:rgba(6,12,24,.9); border-bottom:1px solid var(--glass-brd); backdrop-filter:blur(8px) }
  .fs-hint{ font-family:var(--font-mono); letter-spacing:.04em }

  /* toast → HUD */
  .toast{ background:linear-gradient(165deg,rgba(16,32,60,.92),rgba(8,17,36,.95)); border:1px solid var(--glass-brd-strong); box-shadow:0 12px 40px rgba(0,0,0,.5), 0 0 24px rgba(47,216,255,.12); font-family:var(--font-mono); font-size:13px; letter-spacing:.02em }
  .toast.err{ border-color:rgba(255,85,102,.6) }

  /* entrance */
  @keyframes materialize{ 0%{opacity:0; transform:translateY(8px) scale(.985)} 60%{opacity:1} 100%{opacity:1} }
  .pane.active{ animation:materialize .38s cubic-bezier(.2,.7,.3,1) }
  /* Never animate a live page: re-compositing the frame reads as a flash. */
  .pane[data-pane="preview"].active{ animation:none }
  @media (prefers-reduced-motion: reduce){ *{ animation-duration:.01ms !important } }
</style>
</head>
<body>
  <div class="holo-env" aria-hidden="true">
    <i class="holo-blob b1"></i><i class="holo-blob b2"></i><i class="holo-blob b3"></i>
    <div class="holo-floor"></div>
  </div>

  <header class="topbar">
    <a class="brand-link" href="https://ide.gitmir.com" target="_blank" rel="noopener" title="Open ide.gitmir.com"><img class="brand-logo" src="/vendor/gitmir-wordmark.svg" alt="GitMir IDE" draggable="false"></a>
    <span class="brand-sub">Claude Control</span>
    <span class="c" id="count"></span>
    <div class="top-proj" id="topProj"></div>
    <div class="top-tools" id="topTools">
      <input class="search" id="search" placeholder="Search projects…" autocomplete="off">
      <button class="add" id="addBtn">＋ Add project</button>
    </div>
  </header>

  <div class="shell" id="shell">
    <nav class="rail" id="rail" aria-label="Project sections"></nav>
    <main class="main" id="main">
      <div class="grid" id="list"></div>
      <div class="detail" id="detail"></div>
    </main>
  </div>

  <div class="toast" id="toast"></div>

<script src="/app.js"></script>
</body>
</html>`;
