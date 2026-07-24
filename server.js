'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile, spawn } = require('child_process');

// The native folder picker is reliable on macOS, Linux and Windows 10, but on
// Windows 11 a dialog spawned by a background process gets suppressed — so we hide
// the "Browse…" button there and let the user paste the path instead.
function nativePickerAvailable() {
  if (process.platform === 'darwin' || process.platform === 'linux') return true;
  if (process.platform === 'win32') {
    const m = /^10\.0\.(\d+)/.exec(os.release() || '');
    return (m ? parseInt(m[1], 10) : 0) < 22000; // Win11 is build >= 22000
  }
  return false;
}

const relay = require('./relay');

const PORT = 4599;
const DATA_FILE = path.join(__dirname, 'projects.json');
const SKILLS_FILE = path.join(__dirname, 'skills.json');

// ---------- storage ----------
function loadProjects() {
  try {
    const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}
function saveProjects(list) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(list, null, 2));
}

// ---------- skills registry ----------
function loadSkills() {
  try {
    const data = JSON.parse(fs.readFileSync(SKILLS_FILE, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}
function resolveSkillFile(f) {
  return path.isAbsolute(f) ? f : path.join(__dirname, f);
}
function stripFrontmatter(text) {
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
function osascript(script, args = []) {
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', script, ...args], { timeout: 120000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message || '').trim()));
      resolve(stdout.trim());
    });
  });
}

// Native macOS folder picker -> POSIX path (no trailing slash), or null if cancelled.
// Native folder picker -> selected path, or null if cancelled. Detects the OS.
async function chooseFolder() {
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
      const p = await new Promise((resolve, reject) => {
        execFile(bin, args, { timeout: 180000 }, (err, stdout) => {
          if (err && err.code === 'ENOENT') return reject(err);   // tool not installed -> try next
          resolve((stdout || '').trim());                          // empty = cancelled
        });
      });
      return p ? p.replace(/\/+$/, '') : null;
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }
  throw new Error('no folder picker found (install zenity or kdialog)');
}

// Open a terminal in the folder and run `claude` — detects the OS.
function openInTerminal(projectPath) {
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
        const [bin, args] = candidates[i++];
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
function revealInFinder(projectPath) {
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
function sendJSON(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
  });
}

// ---------- routes ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(HTML);
    }
    if (req.method === 'GET' && url.pathname.startsWith('/vendor/')) {
      const rel = url.pathname.replace(/^\/vendor\//, '');
      if (rel.includes('..')) { res.writeHead(400); return res.end('bad'); }
      try {
        const body = fs.readFileSync(path.join(__dirname, 'vendor', rel));
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
    if (req.method === 'GET' && url.pathname === '/api/env') {
      return sendJSON(res, 200, { platform: process.platform, pickerAvailable: nativePickerAvailable(), relayUrl: relay.status().url });
    }
    if (req.method === 'GET' && url.pathname === '/api/projects') {
      const list = loadProjects().map((p) => ({
        name: p.name || '',
        path: p.path,
        description: p.description || '',
        exists: fs.existsSync(p.path),
      }));
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
    // ---- file-based task queue: tasks/{todo,inprogress,done}/*.md ----
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
      const cols = ['todo', 'inprogress', 'done'];
      const out = {};
      for (const c of cols) {
        const dir = path.join(p, 'tasks', c);
        let items = [];
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
        out[c] = items;
      }
      return sendJSON(res, 200, out);
    }
    if (req.method === 'GET' && url.pathname === '/api/model') {
      const p = url.searchParams.get('path') || '';
      const dir = path.join(p, '.gitmir', 'model');
      const dims = ['modules','entities','serverUnits','serverFunctions','apiRoutes','frontendUnits','events','processes','statusFlows','reactions'];
      const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
      const index = readJson(path.join(dir, 'index.json'));
      const model = {};
      let exists = !!index;
      for (const d of dims) {
        const arr = readJson(path.join(dir, d + '.json'));
        model[d] = Array.isArray(arr) ? arr : [];
        if (model[d].length) exists = true;
      }
      const brief = readJson(path.join(p, '.gitmir', 'brief.json'));
      return sendJSON(res, 200, { exists, index, model, brief });
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
        let text = fs.readFileSync(resolveSkillFile(s.file), 'utf8');
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
        return sendJSON(res, 200, { pickerFailed: true, error: String(e.message || e) });
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
          return sendJSON(res, 200, { added: false, pickerFailed: true, error: String(e.message || e) });
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
        const next = paths.map((p) => byPath.get(p)).filter(Boolean);
        for (const x of list) if (!paths.includes(x.path)) next.push(x);
        saveProjects(next);
      }
      return sendJSON(res, 200, { ok: true });
    }
    // ---- team bridge (connect local machines through the GitMir relay) ----
    if (req.method === 'POST' && url.pathname === '/api/team/connect') {
      const { key, name, path: projectPath, url: relayUrl } = await readBody(req);
      if (!key) return sendJSON(res, 400, { error: 'no key' });
      relay.connect({ key, name, projectPath, url: relayUrl });
      return sendJSON(res, 200, { ok: true, status: relay.status() });
    }
    if (req.method === 'GET' && url.pathname === '/api/team/status') {
      return sendJSON(res, 200, relay.status());
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
    sendJSON(res, 500, { error: String(e.message || e) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  const addr = `http://localhost:${PORT}`;
  console.log(`\n  GITMIR Claude Control  ->  ${addr}\n  (Ctrl+C to stop)\n`);
  const opener = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', addr]]
    : process.platform === 'darwin' ? ['open', [addr]]
    : ['xdg-open', [addr]];
  execFile(opener[0], opener[1], () => {});
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
  html,body{margin:0;height:100%}
  body{
    background:#04060a; color:var(--ink-1); height:100vh; display:flex;
    font:14px/1.5 var(--font-ui); -webkit-font-smoothing:antialiased; overflow:hidden; position:relative;
  }
  body::before{ content:""; position:fixed; inset:0; z-index:-2; pointer-events:none;
    background:
      radial-gradient(1100px 760px at 12% -8%, rgba(47,216,255,.12), transparent 60%),
      radial-gradient(1000px 900px at 100% 2%, rgba(78,168,255,.10), transparent 58%),
      radial-gradient(1200px 820px at 50% 118%, rgba(52,240,166,.06), transparent 60%),
      linear-gradient(180deg,#03060f,#04081a 45%,#02040c);
  }
  body::after{ content:""; position:fixed; inset:0; z-index:-1; pointer-events:none; opacity:.5;
    background-image:
      linear-gradient(rgba(47,216,255,.045) 1px, transparent 1px),
      linear-gradient(90deg, rgba(47,216,255,.045) 1px, transparent 1px);
    background-size:34px 34px;
    -webkit-mask-image:radial-gradient(130% 100% at 50% -10%, #000 35%, transparent 88%);
    mask-image:radial-gradient(130% 100% at 50% -10%, #000 35%, transparent 88%);
  }
  button{font-family:inherit}

  /* ---------- sidebar ---------- */
  .side{
    width:330px; min-width:330px; height:100%; display:flex; flex-direction:column;
    background:#111319; border-right:1px solid var(--line);
  }
  .side-top{padding:16px 16px 12px; border-bottom:1px solid var(--line)}
  .brand{display:flex;align-items:center;gap:9px;font-weight:650;letter-spacing:.2px;margin-bottom:14px}
  .dot{width:9px;height:9px;border-radius:50%;background:var(--accent);box-shadow:0 0 10px var(--accent)}
  .brand .c{color:var(--dim);font-weight:500;font-size:13px;margin-left:auto}
  .add{
    width:100%; display:inline-flex; align-items:center; justify-content:center; gap:8px;
    background:var(--accent); color:#1a0f0a; border:none; font-weight:650;
    padding:11px; border-radius:10px; cursor:pointer; font-size:14px;
    transition:filter .15s ease, transform .06s ease;
  }
  .add:hover{filter:brightness(1.06)} .add:active{transform:translateY(1px)}
  .search{
    width:100%; margin-top:10px; background:var(--panel2); border:1px solid var(--line);
    color:var(--txt); padding:9px 11px; border-radius:9px; outline:none; font-size:14px;
  }
  .search:focus{border-color:var(--accent)}
  .list{flex:1; overflow-y:auto; padding:8px}
  .item{
    display:flex; align-items:center; gap:10px; padding:10px 11px; border-radius:10px;
    cursor:pointer; border:1px solid transparent; margin-bottom:2px;
  }
  .item:hover{background:var(--panel)}
  .item.active{background:var(--panel2); border-color:var(--line2)}
  .item .bar{width:4px; align-self:stretch; border-radius:3px; flex:0 0 auto}
  .item .txt{min-width:0; flex:1}
  .item .nm{font-weight:600; font-size:14px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis}
  .item .pa{color:var(--dim2); font-size:11.5px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; margin-top:2px}
  .item.missing .nm{color:var(--dim)}
  .item .miss{color:var(--danger); font-size:11px; display:none}
  .item.missing .miss{display:inline}
  .item.drag{opacity:.4} .item.dragover{border-color:var(--accent)}
  .list-empty{color:var(--dim2); text-align:center; padding:40px 16px; font-size:13px}

  /* ---------- detail ---------- */
  .main{flex:1; height:100%; overflow-y:auto; display:flex; flex-direction:column}
  .placeholder{margin:auto; text-align:center; color:var(--dim2); padding:40px}
  .placeholder .big{font-size:44px; margin-bottom:14px; opacity:.5}
  .detail-wrap{width:100%}
  .tabs{position:sticky; top:0; z-index:3; background:var(--bg); border-bottom:1px solid var(--line)}
  .tabs-inner{max-width:none; margin:0; padding:0 17px; display:flex; gap:2px}
  .tab-btn{background:none; border:none; color:var(--dim); font-size:14px; font-weight:600; padding:16px 15px 14px; cursor:pointer; border-bottom:2px solid transparent; margin-bottom:-1px}
  .tab-btn:hover{color:var(--txt)}
  .tab-btn.active{color:var(--txt); border-bottom-color:var(--accent)}
  .tab-btn .badge{margin-left:7px; background:var(--panel2); color:var(--dim); font-size:11px; padding:1px 7px; border-radius:10px; font-weight:600}
  .tab-btn.active .badge{background:var(--accent); color:#1a0f0a}
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
  .model-head{display:flex; align-items:center; gap:10px; margin-bottom:18px}
  .model-subnav{display:flex; flex-wrap:wrap; gap:6px}
  .mpill{background:var(--panel2); border:1px solid var(--line2); color:var(--dim); font-size:13px; padding:6px 12px; border-radius:8px; cursor:pointer}
  .mpill:hover{color:var(--txt)}
  .mpill.active{background:var(--accent); color:#1a0f0a; border-color:var(--accent)}
  .model-head .upd{margin-left:auto; color:var(--dim2); font-size:11.5px}
  .mrefresh{background:var(--panel2); border:1px solid var(--line2); color:var(--dim); width:32px; height:32px; border-radius:8px; cursor:pointer; font-size:15px}
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
  .q-cols{display:grid; grid-template-columns:repeat(3,1fr); gap:14px}
  .q-col{background:rgba(10,18,36,.5); border:1px solid var(--line); min-height:120px}
  .q-col-h{font-family:var(--font-mono); text-transform:uppercase; letter-spacing:.12em; font-size:12px; padding:12px 14px; border-bottom:1px solid var(--line)}
  .q-col-h .q-n{color:var(--ink-3)}
  .q-list{padding:10px; display:flex; flex-direction:column; gap:8px}
  .q-empty{color:var(--ink-3); font-size:13px; text-align:center; padding:10px}
  .q-card{background:rgba(14,30,58,.5); border:1px solid var(--line); border-left:3px solid; padding:10px 12px}
  .q-t{font-size:13px; color:var(--ink-0); word-break:break-word}
  .q-f{font-family:var(--font-mono); font-size:10.5px; color:var(--ink-3); margin-top:5px; word-break:break-all}

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
  .team-status-row{display:flex; align-items:center; gap:14px; flex-wrap:wrap; font-family:var(--font-mono); font-size:12px; letter-spacing:.03em}
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
  .tab-btn .badge.on{background:rgba(52,240,166,.14); color:var(--ok); border-color:rgba(52,240,166,.4)}

  .toast{
    position:fixed;bottom:22px;left:50%;transform:translateX(-50%) translateY(30px);
    background:var(--panel2);border:1px solid var(--line2);color:var(--txt);
    padding:12px 18px;border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.5);
    opacity:0;transition:all .22s ease;pointer-events:none;font-size:14px;z-index:20;
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
  .side{ background:linear-gradient(180deg,rgba(8,16,32,.72),rgba(5,10,22,.84)); border-right:1px solid var(--glass-brd); backdrop-filter:blur(8px) }
  .side-top{ border-bottom:1px solid var(--glass-brd); position:relative }
  .side-top::after{ content:""; position:absolute; left:16px; right:16px; bottom:-1px; height:1px; background:linear-gradient(90deg,transparent,rgba(95,222,255,.5),transparent) }
  .brand{ font-family:var(--font-ui); text-transform:uppercase; letter-spacing:.16em; font-size:13px; font-weight:600; color:#fff; gap:10px }
  .brand .c{ font-family:var(--font-mono); letter-spacing:.04em; text-transform:none }
  .brand-logo{ height:19px; width:auto; display:block; filter:drop-shadow(0 0 8px rgba(47,216,255,.45)); -webkit-user-select:none; user-select:none }
  .brand-sub{ font-family:var(--font-mono); font-size:11px; letter-spacing:.14em; color:var(--ink-2); text-transform:uppercase; padding-left:10px; border-left:1px solid var(--glass-brd) }
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
  .item.active{ background:linear-gradient(100deg,rgba(47,216,255,.14),rgba(47,216,255,.04)); border-color:rgba(47,216,255,.28); box-shadow:inset 0 0 0 1px rgba(47,216,255,.06), 0 0 18px rgba(47,216,255,.08); position:relative }
  .item.active::after{ content:""; position:absolute; left:-8px; top:50%; transform:translateY(-50%); width:3px; height:18px; background:var(--cyan); box-shadow:0 0 12px var(--cyan) }
  .item .pa{ font-family:var(--font-mono) }
  .item.dragover{ border-color:var(--cyan) }

  /* tabs */
  .tabs{ background:rgba(4,7,15,.85); border-bottom:1px solid var(--glass-brd); backdrop-filter:blur(8px) }
  .tab-btn{ font-family:var(--font-mono); text-transform:uppercase; letter-spacing:.12em; font-size:12px }
  .tab-btn.active{ color:var(--cyan); border-bottom-color:var(--cyan); text-shadow:0 0 12px rgba(47,216,255,.5) }
  .tab-btn .badge{ background:rgba(47,216,255,.1); color:var(--cyan-soft); border:1px solid rgba(47,216,255,.3); font-family:var(--font-mono) }
  .tab-btn.active .badge{ background:var(--cyan); color:#05070c; border-color:var(--cyan) }

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
  .dgm::before{ content:""; position:absolute; inset:-1px; pointer-events:none; z-index:3;
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
  @media (prefers-reduced-motion: reduce){ *{ animation-duration:.01ms !important } }
</style>
</head>
<body>
  <aside class="side">
    <div class="side-top">
      <div class="brand"><img class="brand-logo" src="/vendor/gitmir-wordmark.svg" alt="GitMir" draggable="false"><span class="brand-sub">Claude Control</span><span class="c" id="count"></span></div>
      <button class="add" id="addBtn">＋ Add project</button>
      <input class="search" id="search" placeholder="Search…" autocomplete="off">
    </div>
    <div class="list" id="list"></div>
  </aside>

  <main class="main" id="main">
    <div class="placeholder" id="placeholder">
      <div class="big">◧</div>
      <div>Select a project on the left<br>or add one with the button above.</div>
    </div>
  </main>

  <div class="toast" id="toast"></div>

<script>
const listEl = document.getElementById('list');
const mainEl = document.getElementById('main');
const countEl = document.getElementById('count');
const searchEl = document.getElementById('search');
let projects = [];
let selected = null; // path

function toast(msg, isErr){
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = 'toast show' + (isErr ? ' err' : '');
  clearTimeout(toast._t); toast._t = setTimeout(()=>{ t.className='toast'; }, 2200);
}
function hue(str){ let h=0; for(let i=0;i<str.length;i++) h=(h*31+str.charCodeAt(i))%360; return h; }
function basename(p){ return p.replace(/\\/+$/,'').split('/').pop(); }
function displayName(p){ return (p.name && p.name.trim()) || basename(p.path); }
function byPath(p){ return projects.find(x=>x.path===p); }

async function load(keepSelection){
  const r = await fetch('/api/projects'); const d = await r.json();
  projects = d.projects || [];
  if (keepSelection && !byPath(selected)) selected = null;
  renderList(); renderDetail();
}

function renderList(){
  const q = searchEl.value.trim().toLowerCase();
  const list = projects.filter(p => !q || displayName(p).toLowerCase().includes(q) || p.path.toLowerCase().includes(q));
  countEl.textContent = projects.length || '';
  listEl.innerHTML = '';
  if (!list.length){
    const e = document.createElement('div'); e.className='list-empty';
    e.textContent = projects.length ? 'Nothing found' : 'No projects yet';
    listEl.appendChild(e); return;
  }
  for (const p of list){
    const el = document.createElement('div');
    el.className = 'item' + (p.exists ? '' : ' missing') + (p.path===selected ? ' active' : '');
    el.draggable = true; el.dataset.path = p.path;
    const h = hue(displayName(p));
    el.innerHTML =
      '<div class="bar" style="background:hsl('+h+',55%,58%)"></div>' +
      '<div class="txt"><div class="nm"></div><div class="pa"></div></div>' +
      '<span class="miss" title="folder not found">⚠</span>';
    el.querySelector('.nm').textContent = displayName(p);
    el.querySelector('.pa').textContent = p.path;
    el.addEventListener('click', ()=>{ selected = p.path; renderList(); renderDetail(); });
    wireDrag(el);
    listEl.appendChild(el);
  }
}

let taskTimer = null;
let queueTimer = null;
let activeTab = 'settings';
function setTab(tab){
  activeTab = tab;
  document.querySelectorAll('.tab-btn').forEach(b=>b.classList.toggle('active', b.dataset.tab===tab));
  document.querySelectorAll('.pane').forEach(p=>p.classList.toggle('active', p.dataset.pane===tab));
  clearInterval(queueTimer);
  if(tab==='model' && selected) loadModel(selected);
  if(tab==='queue' && selected){ loadQueue(selected); queueTimer=setInterval(()=>{ if(selected && activeTab==='queue') loadQueue(selected); }, 4000); }
  if(tab==='team'){ renderTeam(); teamPoll(); }
}
function renderDetail(){
  const p = byPath(selected);
  clearInterval(taskTimer);
  if (!p){
    mainEl.innerHTML =
      '<div class="placeholder"><div class="big">◧</div>' +
      '<div>Select a project on the left<br>or add one with the button above.</div></div>';
    return;
  }
  const wrap = document.createElement('div'); wrap.className='detail-wrap';
  wrap.innerHTML =
    '<div class="tabs"><div class="tabs-inner">' +
      '<button class="tab-btn" data-tab="settings">Settings</button>' +
      '<button class="tab-btn" data-tab="tasks">Tasks <span class="badge" id="taskBadge"></span></button>' +
      '<button class="tab-btn" data-tab="model">Model</button>' +
      '<button class="tab-btn" data-tab="queue">Queue <span class="badge" id="queueBadge"></span></button>' +
      '<button class="tab-btn" data-tab="team">Team <span class="badge" id="teamBadge"></span></button>' +
    '</div></div>' +
    '<div class="pane" data-pane="settings">' +
      '<div class="field"><div class="row-lbl"><label>Name</label><span class="saved" id="savedN">saved ✓</span></div>' +
        '<input class="f-name" id="fName"></div>' +
      '<div class="d-path"><span id="dPath"></span>' +
        '<button class="rev" id="revBtn" title="Reveal in Finder">🗂</button></div>' +
      '<div class="d-missing" id="dMiss">⚠ Folder not found on disk — it may have been moved or the drive disconnected.</div>' +
      '<div class="field"><div class="row-lbl"><label>Description</label><span class="saved" id="savedD">saved ✓</span></div>' +
        '<textarea class="f-desc" id="fDesc" placeholder="What this project is about, notes, TODO…"></textarea></div>' +
      '<div class="actions">' +
        '<button class="run" id="runBtn">▶ Run Claude</button>' +
        '<button class="ghost" id="finderBtn">🗂 Finder</button>' +
        '<button class="del" id="delBtn">🗑 Remove</button>' +
      '</div>' +
      '<div class="skills-box">' +
        '<div class="skills-label">Skills — copy and paste into claude (⌘V + Enter)</div>' +
        '<div class="skills-btns" id="skillsBtns"></div>' +
      '</div>' +
    '</div>' +
    '<div class="pane" data-pane="tasks">' +
      '<div class="tasks-head"><span class="t">What Claude did</span><span class="upd" id="taskUpd"></span></div>' +
      '<div id="taskList"></div>' +
    '</div>' +
    '<div class="pane" data-pane="model">' +
      '<div class="model-head">' +
        '<div class="model-subnav" id="modelNav"></div>' +
        '<span class="upd" id="modelUpd"></span>' +
        '<button class="mrefresh" id="modelRefresh" title="Refresh model">⟳</button>' +
      '</div>' +
      '<div id="modelView"><div class="model-empty">Opening model…</div></div>' +
    '</div>' +
    '<div class="pane" data-pane="queue">' +
      '<div class="tasks-head"><span class="t">Task queue — tasks/todo · inprogress · done</span></div>' +
      '<div id="queueView"><div class="model-empty">Loading…</div></div>' +
    '</div>' +
    '<div class="pane" data-pane="team">' +
      '<div class="tasks-head"><span class="t">Team Bridge — route model &amp; tasks between your machines</span><span class="upd" id="teamUpd"></span></div>' +
      '<div id="teamView"><div class="model-empty">Loading…</div></div>' +
    '</div>';
  mainEl.innerHTML = ''; mainEl.appendChild(wrap);

  const nameEl = wrap.querySelector('#fName');
  const descEl = wrap.querySelector('#fDesc');
  nameEl.value = p.name || '';
  nameEl.placeholder = basename(p.path);
  descEl.value = p.description || '';
  wrap.querySelector('#dPath').textContent = p.path;
  wrap.querySelector('#dMiss').style.display = p.exists ? 'none' : 'block';

  // autosave (debounced) + on blur
  const saveName = debounce(()=>update(p.path, {name:nameEl.value}, '#savedN'), 500);
  const saveDesc = debounce(()=>update(p.path, {description:descEl.value}, '#savedD'), 600);
  nameEl.addEventListener('input', ()=>{ saveName(); });
  nameEl.addEventListener('blur', ()=>update(p.path, {name:nameEl.value}, '#savedN'));
  descEl.addEventListener('input', ()=>{ saveDesc(); });
  descEl.addEventListener('blur', ()=>update(p.path, {description:descEl.value}, '#savedD'));

  wrap.querySelector('#runBtn').addEventListener('click', ()=>open(p));
  wrap.querySelector('#finderBtn').addEventListener('click', ()=>reveal(p));
  wrap.querySelector('#revBtn').addEventListener('click', ()=>reveal(p));
  wrap.querySelector('#delBtn').addEventListener('click', ()=>remove(p));
  wrap.querySelectorAll('.tab-btn').forEach(b=> b.addEventListener('click', ()=> setTab(b.dataset.tab)));
  wrap.querySelector('#modelRefresh').addEventListener('click', ()=>{ if(selected) loadModel(selected); });
  setTab(activeTab);
  renderSkillButtons();

  refreshTasks(p.path);
  taskTimer = setInterval(()=>{ if(selected) refreshTasks(selected); }, 4000);
}

let PICKER_OK = true;
let SKILLS = [];
async function loadSkillsList(){
  try{ SKILLS = (await (await fetch('/api/skills')).json()).skills || []; }catch{ SKILLS = []; }
  renderSkillButtons();
}
function renderSkillButtons(){
  const box = document.getElementById('skillsBtns');
  if(!box) return;
  box.innerHTML = '';
  if(!SKILLS.length){ box.innerHTML = '<div class="skills-empty">no skills in skills.json</div>'; return; }
  for(const s of SKILLS){
    const it = document.createElement('div');
    it.className = 'skill-item'; it.title = 'Copy — paste into Claude';
    it.innerHTML =
      '<div class="skill-info">'+
        '<div class="skill-name">'+esc(s.title || s.name)+'</div>'+
        (s.desc ? '<div class="skill-desc">'+esc(s.desc)+'</div>' : '')+
      '</div>'+
      '<span class="skill-copy">📋 Copy</span>';
    it.addEventListener('click', ()=> copySkill(s.name, s.title || s.name));
    box.appendChild(it);
  }
}
async function copySkill(name, title){
  try{
    const d = await (await fetch('/api/skill?name='+encodeURIComponent(name))).json();
    if(!d.text) throw new Error(d.error || 'no text');
    await copyToClipboard(d.text);
    toast('Copied: '+(title||name)+' ✓  Paste into claude (⌘V) and Enter');
  }catch(e){ toast('Copy failed: '+(e.message||e), true); }
}

/* ---------- model (.gitmir) visualization ---------- */
let modelData = null;
let modelView = 'logic';
let logicEntityId = null;
let mermaidReady = null;
const MODEL_VIEWS = [
  {key:'logic', label:'Business logic'},
  {key:'overview', label:'Overview'},
  {key:'er', label:'Data (ER)'},
  {key:'flow', label:'Data flow'},
  {key:'processes', label:'Processes'},
];
const EFF_RU={create:'create',update:'update',recalculate:'recalculate',sync:'sync',notify:'notify',link:'link',delete:'delete'};

let elkReady=null;
function ensureElk(){
  if(elkReady) return elkReady;
  elkReady=new Promise((resolve,reject)=>{
    const s=document.createElement('script'); s.src='/vendor/elk.bundled.js';
    s.onload=()=>{ try{ const C=window.ELK&&(window.ELK.default||window.ELK); resolve(new C()); }catch(e){ reject(e); } };
    s.onerror=()=>reject(new Error('failed to load elk'));
    document.head.appendChild(s);
  });
  return elkReady;
}

// holo style (as in your IDE): accent color per node type, glyphs, dark-navy bg + grid
const ACCENTS={ state:'#ffb86b', status:'#ffb86b', trigger:'#7e8cff', effect:'#34f0a6', start:'#9b8aff',
  entity:'#34f0a6', field:'#2fd8ff', event:'#9b8aff', function:'#2fd8ff', route:'#2fd8ff',
  frontend:'#8aa0ff', module:'#7e8cff', process:'#8aa0ff', reaction:'#7e8cff' };
const GLYPHS={ state:'◷', status:'◷', trigger:'⚡', effect:'✦', start:'●',
  entity:'◆', field:'ƒ', event:'✦', function:'❯', route:'↗', frontend:'▢', module:'▣', process:'❯', reaction:'⚙' };
function trunc(s,n){ s=String(s==null?'':s); return s.length>n ? s.slice(0,n-1)+'…' : s; }

const HOLO_DEFS='<defs>'+
  '<marker id="ha" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="rgba(138,236,255,.7)"/></marker>'+
  '<pattern id="hgrid" width="28" height="28" patternUnits="userSpaceOnUse"><path d="M28 0 H0 V28" fill="none" stroke="rgba(120,210,255,.06)" stroke-width="1"/></pattern>'+
  '</defs>'+
  '<style>'+
  '.he{fill:none;stroke:rgba(120,210,255,.32);stroke-width:1.6}'+
  '.he-spine{stroke:#2fd8ff;stroke-width:2;opacity:.95}'+
  '.he-branch{stroke:#ffb86b;stroke-width:1.8}'+
  '.he-effect{stroke:#34f0a6;stroke-dasharray:5 3}'+
  '.he-data{stroke:#2fd8ff;stroke-dasharray:2 3;opacity:.85}'+
  '.he-trigger{stroke:#7e8cff}'+
  '.hchip rect{fill:rgba(6,16,30,.96);stroke:rgba(52,240,166,.5)}'+
  '.hchip text{fill:#7dffce;font:600 11px "JetBrains Mono",ui-monospace,monospace}'+
  '.hcard{fill:rgba(10,18,36,.94);stroke-width:1.5}'+
  '.hnode:hover .hcard{filter:brightness(1.3)}'+
  '.hclk{cursor:pointer}.hnode.hclk:hover .hcard{filter:brightness(1.55)}'+
  '.hname{fill:#dceaff;font:600 13px "Onest",-apple-system,BlinkMacSystemFont,sans-serif}'+
  '.hsub{fill:#7286a6;font:500 11px "JetBrains Mono",ui-monospace,monospace}'+
  '.hfield{fill:#9fb2d0;font:500 11px "JetBrains Mono",ui-monospace,monospace}'+
  '</style>';

function nodeSvg(n){
  const x=n.x||0,y=n.y||0,w=n.width,h=n.height,md=n.meta||{};
  const acc=ACCENTS[md.kind]||ACCENTS.entity, gl=GLYPHS[md.kind]||'•';
  let inner='<rect x="0" y="0" width="'+w+'" height="'+h+'" rx="8" class="hcard" stroke="'+acc+'"/>'+
            '<rect x="0" y="0" width="3" height="'+h+'" rx="1.5" fill="'+acc+'"/>';
  if(md.fields && md.fields.length){
    inner+='<text x="14" y="22" class="hname"><tspan fill="'+acc+'">'+gl+'</tspan> '+esc(trunc(md.label,24))+'</text>';
    let fy=42;
    if(md.sub){ inner+='<text x="15" y="38" class="hsub">'+esc(trunc(md.sub,32))+'</text>'; fy=58; }
    for(const f of md.fields){ inner+='<text x="15" y="'+fy+'" class="hfield">'+esc(trunc(f,26))+'</text>'; fy+=18; }
  } else {
    const ny = md.sub ? 21 : Math.round(h/2+4);
    inner+='<text x="14" y="'+ny+'" class="hname"><tspan fill="'+acc+'">'+gl+'</tspan> '+esc(trunc(md.label,26))+'</text>';
    if(md.sub) inner+='<text x="15" y="'+(ny+17)+'" class="hsub">'+esc(trunc(md.sub,32))+'</text>';
  }
  const ref = md.ref && md.ref.id ? ' data-ck="'+esc(md.ref.k)+'" data-cid="'+esc(md.ref.id)+'"' : '';
  return '<g class="hnode'+(ref?' hclk':'')+'"'+ref+' transform="translate('+x+','+y+')">'+inner+'</g>';
}

function svgFromElk(g){
  const W=Math.ceil(g.width||800)+2, H=Math.ceil(g.height||600)+2;
  const eL=[], nL=[];
  for(const e of (g.edges||[])){
    const sec=e.sections&&e.sections[0]; if(!sec) continue;
    const pts=[sec.startPoint,...(sec.bendPoints||[]),sec.endPoint];
    let d='M '+pts[0].x+' '+pts[0].y; for(let i=1;i<pts.length;i++) d+=' L '+pts[i].x+' '+pts[i].y;
    eL.push('<path d="'+d+'" class="he he-'+(e.ekind||'spine')+'" marker-end="url(#ha)"/>');
    const lab=e.labels&&e.labels[0];
    if(lab&&lab.text){ const lx=lab.x||0,ly=lab.y||0,lw=lab.width||40,lh=lab.height||20;
      eL.push('<g class="hchip"><rect x="'+lx+'" y="'+ly+'" width="'+lw+'" height="'+lh+'" rx="10"/><text x="'+(lx+lw/2)+'" y="'+(ly+lh/2+4)+'" text-anchor="middle">'+esc(trunc(lab.text,30))+'</text></g>');
    }
  }
  for(const n of (g.children||[])) nL.push(nodeSvg(n));
  return '<svg width="'+W+'" height="'+H+'" viewBox="0 0 '+W+' '+H+'" xmlns="http://www.w3.org/2000/svg" class="holo-svg">'+
    HOLO_DEFS+eL.join('')+nL.join('')+'</svg>';
}

async function renderElk(container, spec){
  if(!spec || !spec.nodes || !spec.nodes.length){ container.innerHTML='<div class="model-empty">No data for this diagram.</div>'; return; }
  container.innerHTML='<div class="model-empty">ELK layout…</div>';
  let elk; try{ elk=await ensureElk(); }catch(e){ container.innerHTML='<div class="model-empty">ELK failed to load: '+esc(e.message||e)+'</div>'; return; }
  const dir=spec.direction||'DOWN';
  const graph={ id:'root', layoutOptions:{
      'elk.algorithm':'layered', 'elk.direction':dir,
      'elk.spacing.nodeNode':'44',
      'elk.layered.spacing.nodeNodeBetweenLayers': dir==='RIGHT'?'96':'62',
      'elk.layered.spacing.edgeNodeBetweenLayers':'22',
      'elk.layered.nodePlacement.strategy':'NETWORK_SIMPLEX',
      'elk.layered.considerModelOrder.strategy':'NODES_AND_EDGES',
      'elk.edgeLabels.inline':'true' },
    children: spec.nodes.map(n=>({ id:n.id, width:n.w, height:n.h, meta:n.meta })),
    edges: spec.edges.map((e,i)=>({ id:'e'+i, sources:[e.from], targets:[e.to], ekind:e.kind||'spine',
      labels: e.label ? [{ text:e.label, width: Math.min(220, String(e.label).length*6.6+26), height:20 }] : [] })) };
  let laid; try{ laid=await elk.layout(graph); }catch(e){ container.innerHTML='<div class="model-empty">Layout error: '+esc(e.message||e)+'</div>'; return; }
  const metaById=new Map(spec.nodes.map(n=>[n.id,n.meta]));
  for(const c of (laid.children||[])) if(!c.meta) c.meta=metaById.get(c.id);
  const ekById=new Map(graph.edges.map(e=>[e.id,e.ekind]));
  for(const e of (laid.edges||[])) if(!e.ekind) e.ekind=ekById.get(e.id);
  const svg=svgFromElk(laid);
  container.innerHTML=
    '<div class="dgm">'+
      '<div class="dgm-bar">'+
        '<button class="dgm-b" data-a="out" title="Zoom out">−</button>'+
        '<button class="dgm-b" data-a="in" title="Zoom in">+</button>'+
        '<button class="dgm-b" data-a="fit" title="Fit to view">Fit</button>'+
        '<button class="dgm-b" data-a="reset" title="100%">100%</button>'+
        '<span class="dgm-hint">drag to pan · wheel to zoom · click a node for context</span>'+
        '<button class="dgm-b dgm-full" data-a="full" title="Fullscreen">⛶</button>'+
      '</div>'+
      '<div class="dgm-canvas"><div class="dgm-stage">'+svg+'</div></div>'+
    '</div>';
  const canvas=container.querySelector('.dgm-canvas');
  const stage=container.querySelector('.dgm-stage');
  const svgEl=stage.querySelector('svg');
  const pz=attachPanZoom(canvas, stage, svgEl, (ck,cid)=>openContextPopup(ck,cid));
  container.querySelector('.dgm-bar').addEventListener('click',(e)=>{ const a=e.target&&e.target.dataset&&e.target.dataset.a; if(!a) return;
    if(a==='in') pz.zoomCenter(1.2); else if(a==='out') pz.zoomCenter(0.83);
    else if(a==='fit') pz.fit(); else if(a==='reset') pz.reset();
    else if(a==='full') openDiagramFullscreen(svgEl.outerHTML);
  });
}

// Pan/zoom canvas like ide.gitmir.com's VisualBuilder: drag to pan, wheel zooms to
// the cursor, click (not drag) a node fires onNodeClick.
function attachPanZoom(canvas, stage, svgEl, onNodeClick){
  let k=1, x=0, y=0;
  if(svgEl){ svgEl.style.maxWidth='none'; svgEl.style.maxHeight='none'; }
  const apply=()=>{ stage.style.transform='translate('+x+'px,'+y+'px) scale('+k+')'; const gs=28*k; canvas.style.backgroundSize=gs+'px '+gs+'px'; canvas.style.backgroundPosition=x+'px '+y+'px'; };
  const nat=()=>{ if(svgEl && svgEl.viewBox && svgEl.viewBox.baseVal && svgEl.viewBox.baseVal.width) return {w:svgEl.viewBox.baseVal.width, h:svgEl.viewBox.baseVal.height}; return {w:800,h:600}; };
  const fit=()=>{ const cw=canvas.clientWidth, ch=canvas.clientHeight, n=nat(); const s=Math.min(cw/n.w, ch/n.h)*0.94; k=Math.min(1.4, Math.max(0.08, (isFinite(s)&&s>0)?s:1)); x=(cw-n.w*k)/2; y=(ch-n.h*k)/2; apply(); };
  const reset=()=>{ k=1; x=18; y=18; apply(); };
  const zoomAt=(f,px,py)=>{ const nk=Math.min(2.6, Math.max(0.1, k*f)); const wx=(px-x)/k, wy=(py-y)/k; k=nk; x=px-wx*k; y=py-wy*k; apply(); };
  const zoomCenter=f=> zoomAt(f, canvas.clientWidth/2, canvas.clientHeight/2);
  canvas.addEventListener('wheel',(e)=>{ e.preventDefault(); const r=canvas.getBoundingClientRect(); zoomAt(e.deltaY<0?1.12:0.89, e.clientX-r.left, e.clientY-r.top); }, {passive:false});
  let drag=false, moved=false, lx=0, ly=0;
  canvas.addEventListener('mousedown',(e)=>{ if(e.button!==0) return; drag=true; moved=false; lx=e.clientX; ly=e.clientY; canvas.classList.add('grab'); });
  canvas.addEventListener('mousemove',(e)=>{ if(!drag) return; const dx=e.clientX-lx, dy=e.clientY-ly; if(Math.abs(dx)+Math.abs(dy)>4) moved=true; x+=dx; y+=dy; lx=e.clientX; ly=e.clientY; apply(); });
  const end=()=>{ drag=false; canvas.classList.remove('grab'); };
  canvas.addEventListener('mouseup', end); canvas.addEventListener('mouseleave', end);
  canvas.addEventListener('click',(e)=>{ if(moved){ moved=false; return; } const node=e.target.closest('[data-cid]'); if(node && node.dataset.cid && onNodeClick) onNodeClick(node.dataset.ck, node.dataset.cid); });
  setTimeout(fit, 30);
  return { fit, reset, zoomCenter };
}

async function loadModel(pathStr){
  const view=document.getElementById('modelView'); if(!view) return;
  view.innerHTML='<div class="model-empty">Loading model…</div>';
  let d; try{ d=await (await fetch('/api/model?path='+encodeURIComponent(pathStr))).json(); }
  catch{ view.innerHTML='<div class="model-empty">Failed to load model.</div>'; return; }
  if(selected!==pathStr) return;
  modelData=d;
  const upd=document.getElementById('modelUpd');
  if(upd) upd.textContent = (d.index && d.index.at) ? ('updated '+fmtTime(d.index.at)) : '';
  const nav=document.getElementById('modelNav');
  if(!d.exists){
    if(nav) nav.innerHTML='';
    view.innerHTML='<div class="model-empty"><b>No model yet.</b><br>In the <b>Settings</b> tab click <b>📋 gitmir-model</b>, paste into claude (⌘V + Enter) — it will build <code>.gitmir/model/</code>, and diagrams of data, processes and flows will appear here.</div>';
    return;
  }
  renderModelNav(); renderModelView();
}

function renderModelNav(){
  const nav=document.getElementById('modelNav'); if(!nav) return;
  nav.innerHTML='';
  for(const v of MODEL_VIEWS){
    const b=document.createElement('button');
    b.className='mpill'+(modelView===v.key?' active':''); b.textContent=v.label;
    b.addEventListener('click', ()=>{ modelView=v.key; renderModelNav(); renderModelView(); });
    nav.appendChild(b);
  }
}

async function renderModelView(){
  const view=document.getElementById('modelView'); if(!view||!modelData) return;
  const m=modelData.model;
  if(modelView==='logic') return renderLogic(view, m);
  if(modelView==='overview') return renderOverview(view, modelData);
  if(modelView==='processes') return renderProcesses(view, m);
  view.innerHTML='';
  const box=document.createElement('div'); view.appendChild(box);
  if(modelView==='er') return renderElk(box, graphER(m));
  if(modelView==='flow') return renderElk(box, graphFlow(m));
  view.innerHTML='<div class="model-empty">No data for this diagram.</div>';
}

function fsClose(){ const ov=document.getElementById('fsOverlay'); if(ov){ ov.classList.remove('show'); ov.innerHTML=''; } }
function openDiagramFullscreen(svg){
  let ov=document.getElementById('fsOverlay');
  if(!ov){ ov=document.createElement('div'); ov.id='fsOverlay'; ov.className='fs-overlay'; document.body.appendChild(ov); }
  ov.innerHTML=
    '<div class="fs-bar">'+
      '<button class="fs-btn" data-a="out">−</button>'+
      '<button class="fs-btn" data-a="in">+</button>'+
      '<button class="fs-btn" data-a="fit">Fit</button>'+
      '<button class="fs-btn" data-a="reset">100%</button>'+
      '<span class="fs-hint">drag to pan · wheel to zoom · click a node for context</span>'+
      '<button class="fs-btn fs-close" data-a="close">✕ Esc</button>'+
    '</div>'+
    '<div class="fs-canvas" id="fsCanvas"><div class="fs-stage" id="fsStage">'+svg+'</div></div>';
  ov.classList.add('show');
  const canvas=ov.querySelector('#fsCanvas');
  const stage=ov.querySelector('#fsStage');
  const svgEl=stage.querySelector('svg');
  const pz=attachPanZoom(canvas, stage, svgEl, (ck,cid)=>openContextPopup(ck,cid));
  ov.querySelector('.fs-bar').addEventListener('click',(e)=>{ const a=e.target&&e.target.dataset&&e.target.dataset.a; if(!a) return;
    if(a==='in') pz.zoomCenter(1.2); else if(a==='out') pz.zoomCenter(0.83);
    else if(a==='fit') pz.fit(); else if(a==='reset') pz.reset();
    else if(a==='close') fsClose();
  });
}

// ----- helpers -----
function mSafe(s){ return String(s==null?'':s).replace(/[^A-Za-z0-9_]/g,'_'); }
function mLabel(s){ return String(s==null?'':s).replace(/"/g,"'").replace(/[\\[\\]{}<>|]/g,' ').slice(0,44); }
function rtLabel(r){ return ((r.method||'')+' '+(r.path||r.name||'')).trim(); }
function fieldEntity(fieldId, ents){ for(const e of ents){ for(const f of (e.fields||[])){ if(f.id===fieldId) return e.id; } } return null; }
function resolveRef(kind, id, m){
  const maps={function:m.serverFunctions, route:m.apiRoutes, event:m.events, entity:m.entities, frontend:m.frontendUnits};
  const o=(maps[kind]||[]).find(x=>x.id===id); return o ? (o.name||o.id) : id;
}
function refDesc(kind, id, m){
  const maps={function:m.serverFunctions, route:m.apiRoutes, event:m.events, entity:m.entities, frontend:m.frontendUnits};
  const o=(maps[kind]||[]).find(x=>x.id===id); return o && o.description ? String(o.description) : '';
}

/* ---------- deterministic context from a clicked schema element ---------- */
function ctxIx(m){
  return {
    ent:new Map((m.entities||[]).map(e=>[e.id,e])),
    su:new Map((m.serverUnits||[]).map(x=>[x.id,x])),
    sf:new Map((m.serverFunctions||[]).map(x=>[x.id,x])),
    rt:new Map((m.apiRoutes||[]).map(x=>[x.id,x])),
    fe:new Map((m.frontendUnits||[]).map(x=>[x.id,x])),
    ev:new Map((m.events||[]).map(x=>[x.id,x])),
    mod:new Map((m.modules||[]).map(x=>[x.id,x])),
    owner:fieldOwner(m),
  };
}
function objName(kind,id,m){
  const map={entity:'entities',function:'serverFunctions',route:'apiRoutes',event:'events',frontend:'frontendUnits',module:'modules'}[kind];
  const o=(m[map]||[]).find(x=>x.id===id); return o?(o.name||o.id):id;
}
function ctxTitle(kind,id,m){ return objName(kind,id,m)+' ('+kind+')'; }

function gatherContext(kind,id,m){
  const ix=ctxIx(m); const nm=(mp,i)=> (mp.get(i)||{}).name || i; const L=[];
  if(kind==='entity'){
    const e=ix.ent.get(id); if(!e) return 'Entity not found: '+id;
    L.push('# Entity: '+e.name+' ('+e.id+')'); if(e.description) L.push(e.description);
    L.push('- module: '+(e.moduleId?nm(ix.mod,e.moduleId):'—')+'  ·  storage: '+(e.storage||'table')+(e.tableName?'  ·  table: '+e.tableName:''));
    if(e.fields&&e.fields.length){ L.push(''); L.push('## Fields'); for(const f of e.fields){ const tag=f.isPrimary?' [PK]':(f.type==='ref'&&f.refEntityId?' [FK → '+nm(ix.ent,f.refEntityId)+']':''); L.push('- '+f.name+' : '+(f.type||'')+tag+(f.note?'  — '+f.note:'')); } }
    const flows=(m.statusFlows||[]).filter(f=>f.entityId===id);
    if(flows.length){ L.push(''); L.push('## Lifecycle (status flows)'); for(const fl of flows){ L.push('### '+(fl.name||fl.id)+(fl.fieldName?'  — field '+fl.fieldName:'')); L.push('states: '+(fl.states||[]).map(s=>s.key).join(' → ')); for(const t of (fl.transitions||[])){ const trig=[t.byRole,t.condition].filter(Boolean).join(' · '); const eff=(t.effects||[]).map(ef=>effLabel(ef,m)).join('; '); L.push('- '+t.from+' → '+t.to+(trig?'  ['+trig+']':'')+(eff?'  ⇒ '+eff:'')); } } }
    const ops=(m.serverFunctions||[]).filter(f=>(f.readsFieldIds||[]).some(x=>ix.owner.get(x)===id)||(f.writesFieldIds||[]).some(x=>ix.owner.get(x)===id));
    if(ops.length){ L.push(''); L.push('## Operations (server functions)'); for(const f of ops){ const rw=((f.readsFieldIds||[]).some(x=>ix.owner.get(x)===id)?'R':'')+((f.writesFieldIds||[]).some(x=>ix.owner.get(x)===id)?'W':''); const rt=f.routeId&&ix.rt.get(f.routeId); const evs=(f.emitsEventIds||[]).map(x=>nm(ix.ev,x)).join(', '); L.push('- '+f.name+' ('+(f.operation||'')+')  ['+rw+']'+(rt?'  · '+rt.method+' '+rt.path:'')+(evs?'  · emits '+evs:'')); } }
    const procs=(m.processes||[]).filter(p=>(p.steps||[]).some(s=>s.refId===id||(s.refKind==='function'&&ops.some(o=>o.id===s.refId))));
    if(procs.length){ L.push(''); L.push('## Processes'); for(const p of procs) L.push('- '+(p.name||p.id)+': '+(p.steps||[]).map(s=>resolveRef(s.refKind,s.refId,m)).join(' → ')); }
    const rx=(m.reactions||[]).filter(r=>(r.trigger&&r.trigger.entityId===id)||(r.effects||[]).some(ef=>ef.entityId===id));
    if(rx.length){ L.push(''); L.push('## Reactions'); for(const r of rx) L.push('- '+(r.name||r.id)+': on change of '+nm(ix.ent,r.trigger&&r.trigger.entityId)+((r.trigger&&r.trigger.fieldName)?'.'+r.trigger.fieldName:'')+' ⇒ '+(r.effects||[]).map(ef=>effLabel(ef,m)).join('; ')); }
    const rel=[];
    for(const f of (e.fields||[])) if(f.type==='ref'&&f.refEntityId) rel.push(nm(ix.ent,f.refEntityId)+' (via '+f.name+')');
    for(const src of (e.derivedFrom||[])) rel.push(nm(ix.ent,src)+' (derivedFrom)');
    for(const oe of (m.entities||[])) for(const f of (oe.fields||[])) if(f.type==='ref'&&f.refEntityId===id) rel.push(oe.name+' → '+e.name+' (via '+f.name+')');
    if(rel.length){ L.push(''); L.push('## Related entities'); for(const r of rel) L.push('- '+r); }
    return L.join('\\n');
  }
  if(kind==='function'){ const f=ix.sf.get(id); if(!f) return 'Function not found'; L.push('# Server function: '+f.name+' ('+f.id+')'); if(f.description) L.push(f.description); L.push('- unit: '+(f.serverUnitId?nm(ix.su,f.serverUnitId):'—')+'  ·  operation: '+(f.operation||'')); const rt=f.routeId&&ix.rt.get(f.routeId); if(rt) L.push('- route: '+rt.method+' '+rt.path+(rt.auth?' (auth)':'')); const rd=[...new Set((f.readsFieldIds||[]).map(x=>ix.owner.get(x)).filter(Boolean))].map(x=>nm(ix.ent,x)); const wr=[...new Set((f.writesFieldIds||[]).map(x=>ix.owner.get(x)).filter(Boolean))].map(x=>nm(ix.ent,x)); if(rd.length) L.push('- reads: '+rd.join(', ')); if(wr.length) L.push('- writes: '+wr.join(', ')); const cl=(f.callsFunctionIds||[]).map(x=>nm(ix.sf,x)); if(cl.length) L.push('- calls: '+cl.join(', ')); const em=(f.emitsEventIds||[]).map(x=>nm(ix.ev,x)); if(em.length) L.push('- emits: '+em.join(', ')); const sb=(f.subscribesEventIds||[]).map(x=>nm(ix.ev,x)); if(sb.length) L.push('- subscribes: '+sb.join(', ')); const procs=(m.processes||[]).filter(p=>(p.steps||[]).some(s=>s.refId===id)); if(procs.length){ L.push(''); L.push('## Processes'); for(const p of procs) L.push('- '+(p.name||p.id)); } return L.join('\\n'); }
  if(kind==='route'){ const r=ix.rt.get(id); if(!r) return 'Route not found'; L.push('# API route: '+r.method+' '+r.path+' ('+r.id+')'); if(r.description) L.push(r.description); L.push('- unit: '+(r.serverUnitId?nm(ix.su,r.serverUnitId):'—')+'  ·  auth: '+(!!r.auth)); const fns=(m.serverFunctions||[]).filter(f=>f.routeId===id); if(fns.length){ L.push(''); L.push('## Handlers'); for(const f of fns) L.push('- '+f.name+' ('+(f.operation||'')+')'); } const fes=(m.frontendUnits||[]).filter(fe=>(fe.consumesRouteIds||[]).includes(id)); if(fes.length){ L.push(''); L.push('## Called from (frontend)'); for(const fe of fes) L.push('- '+fe.name); } return L.join('\\n'); }
  if(kind==='event'){ const ev=ix.ev.get(id); if(!ev) return 'Event not found'; L.push('# Domain event: '+ev.name+' ('+ev.id+')'); if(ev.description) L.push(ev.description); const prod=(m.serverFunctions||[]).filter(f=>(f.emitsEventIds||[]).includes(id)); const cons=(m.serverFunctions||[]).filter(f=>(f.subscribesEventIds||[]).includes(id)); if(prod.length){ L.push(''); L.push('## Emitted by'); for(const f of prod) L.push('- '+f.name); } if(cons.length){ L.push(''); L.push('## Handled by'); for(const f of cons) L.push('- '+f.name); } return L.join('\\n'); }
  if(kind==='frontend'){ const fe=ix.fe.get(id); if(!fe) return 'Frontend unit not found'; L.push('# Frontend unit: '+fe.name+' ('+fe.id+', '+(fe.kind||'')+')'); if(fe.description) L.push(fe.description); const routes=(fe.consumesRouteIds||[]).map(rid=>ix.rt.get(rid)).filter(Boolean); if(routes.length){ L.push(''); L.push('## Consumes routes'); for(const r of routes){ const fns=(m.serverFunctions||[]).filter(f=>f.routeId===r.id).map(f=>f.name); L.push('- '+r.method+' '+r.path+(fns.length?'  → '+fns.join(', '):'')); } } return L.join('\\n'); }
  if(kind==='process'){ const p=(m.processes||[]).find(x=>x.id===id); if(!p) return 'Process not found'; L.push('# Business process: '+p.name+' ('+p.id+')'); if(p.description) L.push(p.description); L.push('- trigger: '+(p.triggerKind||'')+(p.triggerRefId?' → '+resolveRef({ui:'frontend',api:'route',event:'event',schedule:'route'}[p.triggerKind]||'frontend',p.triggerRefId,m):'')); L.push(''); L.push('## Steps'); (p.steps||[]).forEach((s,i)=> L.push((i+1)+'. '+resolveRef(s.refKind,s.refId,m)+'  ('+s.refKind+')'+(s.note?' — '+s.note:''))); return L.join('\\n'); }
  return objName(kind,id,m)+' ('+kind+')';
}

function openContextPopup(kind,id){
  if(!modelData) return; const m=modelData.model;
  const ctx=gatherContext(kind,id,m); const title=ctxTitle(kind,id,m);
  let ov=document.getElementById('ctxOverlay');
  if(!ov){ ov=document.createElement('div'); ov.id='ctxOverlay'; ov.className='ctx-overlay'; document.body.appendChild(ov); }
  ov.innerHTML=
    '<div class="ctx-modal">'+
      '<div class="ctx-head"><div class="ctx-title">'+esc(title)+'</div><button class="ctx-x" title="Close (Esc)">✕</button></div>'+
      '<div class="ctx-note">Deterministic context — assembled from the model by walking id-links. Paste into Claude, or turn it into a queued task.</div>'+
      '<pre class="ctx-pre">'+esc(ctx)+'</pre>'+
      '<div class="ctx-taskl">Task for this element (optional):</div>'+
      '<textarea class="ctx-task" placeholder="e.g. Add a partial-refund transition from paid, updating Payment and Inventory…"></textarea>'+
      '<div class="ctx-actions">'+
        '<button class="run ctx-create">＋ Create task</button>'+
        '<button class="ghost ctx-copy">📋 Copy context</button>'+
        '<button class="ghost ctx-copyt">📋 Copy context + task</button>'+
        '<button class="del ctx-close">Close</button>'+
      '</div>'+
    '</div>';
  ov.classList.add('show');
  const ta=ov.querySelector('.ctx-task');
  const CTXPRE='This is deterministic context extracted from the product information model — the GitMir multidimensional object model that lives in the .gitmir/ folder of this project. It maps how this element connects to the rest of the product (data, server logic, API, frontend, events, business processes, status flows, reactions) by stable ids. Use it to fully understand the context, so the task is carried out accurately and completely.';
  const withTask=()=> CTXPRE+'\\n\\n'+ctx + (ta.value.trim()? '\\n\\n---\\n## Task\\n'+ta.value.trim() : '');
  const close=()=>{ ov.classList.remove('show'); ov.innerHTML=''; };
  ov.querySelector('.ctx-x').addEventListener('click', close);
  ov.querySelector('.ctx-close').addEventListener('click', close);
  ov.addEventListener('click', e=>{ if(e.target===ov) close(); });
  ov.querySelector('.ctx-copy').addEventListener('click', async ()=>{ await copyToClipboard(CTXPRE+'\\n\\n'+ctx); toast('Context copied ✓  paste into claude'); });
  ov.querySelector('.ctx-copyt').addEventListener('click', async ()=>{ await copyToClipboard(withTask()); toast('Context + task copied ✓'); });
  ov.querySelector('.ctx-create').addEventListener('click', async ()=>{
    const t=ta.value.trim(); if(!t){ toast('Type the task first', true); ta.focus(); return; }
    const content='# '+title+' — '+t.split('\\n')[0].slice(0,80)+'\\n\\n> '+CTXPRE+'\\n\\n## Task\\n'+t+'\\n\\n## Context (from the .gitmir model)\\n'+ctx+'\\n';
    const r=await fetch('/api/task',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:selected, title:title+' — '+t.slice(0,40), content})});
    const d=await r.json();
    if(d.ok){ toast('Task created in tasks/todo ✓'); close(); if(activeTab==='queue') loadQueue(selected); }
    else toast('Failed: '+(d.error||'error'), true);
  });
}

/* ---------- task queue view ---------- */
async function loadQueue(pathStr){
  const view=document.getElementById('queueView'); if(!view) return;
  let q; try{ q=await (await fetch('/api/queue?path='+encodeURIComponent(pathStr))).json(); }catch{ return; }
  if(selected!==pathStr) return;
  const total=(q.todo||[]).length+(q.inprogress||[]).length+(q.done||[]).length;
  const badge=document.getElementById('queueBadge'); if(badge) badge.textContent = (q.todo||[]).length ? String((q.todo||[]).length) : '';
  if(!total){ view.innerHTML='<div class="model-empty">No tasks yet.<br>Open <b>Model</b>, click any element in a diagram → <b>＋ Create task</b> (or copy the <b>task-planner</b> skill). Then run <b>📋 task-runner</b> in Claude — it executes them one by one, moving each file todo → inprogress → done.</div>'; return; }
  const cols=[['todo','To do','#8aa0ff'],['inprogress','In progress','#ffb86b'],['done','Done','#34f0a6']];
  let html='<div class="q-cols">';
  for(const [k,label,acc] of cols){ const items=q[k]||[];
    html+='<div class="q-col"><div class="q-col-h" style="color:'+acc+'">'+label+' <span class="q-n">'+items.length+'</span></div><div class="q-list">';
    if(!items.length) html+='<div class="q-empty">—</div>';
    for(const it of items) html+='<div class="q-card" style="border-left-color:'+acc+'"><div class="q-t">'+esc(it.title)+'</div><div class="q-f">'+esc(it.file)+'</div></div>';
    html+='</div></div>';
  }
  view.innerHTML=html+'</div>';
}

// ----- overview -----
function renderOverview(view, d){
  const m=d.model;
  const dims=[['modules','Modules'],['entities','Entities'],['serverUnits','Server units'],
    ['serverFunctions','Functions'],['apiRoutes','API routes'],['frontendUnits','Frontend'],
    ['events','Events'],['processes','Processes'],['statusFlows','Status flows'],['reactions','Reactions']];
  let html='<div class="ov-grid">';
  for(const [k,label] of dims){ html+='<div class="ov-card"><div class="ov-n">'+((m[k]||[]).length)+'</div><div class="ov-l">'+label+'</div></div>'; }
  html+='</div>';
  const mods=m.modules||[];
  if(mods.length){
    html+='<div class="ov-sec">Modules</div><div class="ov-mods">';
    for(const mm of mods){ html+='<div class="ov-mod"><b>'+esc(mm.name||mm.id)+'</b>'+(mm.description?'<span>'+esc(mm.description)+'</span>':'')+'</div>'; }
    html+='</div>';
  }
  if(d.brief && d.brief.summary){ html+='<div class="ov-sec">Brief</div><div class="ov-brief">'+esc(d.brief.summary)+'</div>'; }
  view.innerHTML=html;
}

// ----- ER diagram -----
function graphER(m){
  const ents=m.entities||[]; const nodes=[], edges=[]; const byId=new Map(ents.map(e=>[e.id,e]));
  if(!ents.length) return {nodes,edges};
  for(const e of ents){
    const fs=(e.fields||[]).slice(0,8).map(f=> (f.isPrimary?'● ':(f.type==='ref'?'◇ ':'  '))+f.name+' : '+(f.type||''));
    const sub=e.description?String(e.description):'';
    const h=32+(sub?16:0)+Math.max(1,fs.length)*18+8;
    nodes.push({id:e.id, w:224, h, meta:{kind:'entity', label:e.name||e.id, sub, fields:fs, ref:{k:'entity',id:e.id}}});
  }
  for(const e of ents){
    for(const f of (e.fields||[])) if(f.type==='ref'&&f.refEntityId&&byId.has(f.refEntityId)) edges.push({from:f.refEntityId, to:e.id, kind:'data', label:f.name});
    for(const src of (e.derivedFrom||[])) if(byId.has(src)) edges.push({from:src, to:e.id, kind:'effect', label:'derive'});
  }
  return {direction:'RIGHT', nodes, edges};
}

function graphFlow(m){
  const fe=m.frontendUnits||[], rt=m.apiRoutes||[], sf=m.serverFunctions||[], ent=m.entities||[], ev=m.events||[];
  const nodes=[], edges=[], have=new Set(); const owner=fieldOwner(m);
  const rtById=new Map(rt.map(r=>[r.id,r])), fnById=new Map(sf.map(f=>[f.id,f])), evById=new Map(ev.map(e=>[e.id,e])), entById=new Map(ent.map(e=>[e.id,e]));
  const D=o=>o&&o.description?String(o.description):'';
  const add=(id,kind,label,sub)=>{ if(!have.has(id)){ have.add(id); nodes.push({id, w:190, h: sub?56:44, meta:{kind,label,sub:sub||'', ref:{k:kind,id}}}); } };
  for(const f of fe){ add(f.id,'frontend',f.name,D(f)); for(const rid of (f.consumesRouteIds||[])) if(rtById.has(rid)){ add(rid,'route', rtLabel(rtById.get(rid)), D(rtById.get(rid))); edges.push({from:f.id,to:rid,kind:'spine'}); } }
  for(const f of sf){ if(f.routeId&&rtById.has(f.routeId)){ add(f.routeId,'route', rtLabel(rtById.get(f.routeId)), D(rtById.get(f.routeId))); add(f.id,'function',f.name,D(f)); edges.push({from:f.routeId,to:f.id,kind:'spine'}); } }
  for(const f of sf){ if(!have.has(f.id)) continue;
    const wr=new Set((f.writesFieldIds||[]).map(x=>owner.get(x)).filter(Boolean));
    for(const eid of wr){ add(eid,'entity', entById.has(eid)?entById.get(eid).name:eid, D(entById.get(eid))); edges.push({from:f.id,to:eid,kind:'data',label:'writes'}); }
    for(const evid of (f.emitsEventIds||[])) if(evById.has(evid)){ add(evid,'event',evById.get(evid).name, D(evById.get(evid))); edges.push({from:f.id,to:evid,kind:'effect',label:'emit'}); }
    for(const evid of (f.subscribesEventIds||[])) if(evById.has(evid)){ add(evid,'event',evById.get(evid).name, D(evById.get(evid))); edges.push({from:evid,to:f.id,kind:'effect',label:'sub'}); }
    for(const cid of (f.callsFunctionIds||[])) if(fnById.has(cid)){ add(cid,'function',fnById.get(cid).name, D(fnById.get(cid))); edges.push({from:f.id,to:cid,kind:'spine'}); }
  }
  return {direction:'RIGHT', nodes, edges};
}

// ----- processes -----
async function renderProcesses(view, m){
  const procs=m.processes||[];
  if(!procs.length){ view.innerHTML='<div class="model-empty">No business processes in the model.</div>'; return; }
  view.innerHTML='';
  for(const p of procs){
    const block=document.createElement('div'); block.className='proc-block';
    block.innerHTML='<div class="proc-title">'+esc(p.name||p.id)+'</div>'+
      (p.description?'<div class="proc-desc">'+esc(p.description)+'</div>':'')+
      '<div class="proc-diagram"></div>';
    view.appendChild(block);
    await renderElk(block.querySelector('.proc-diagram'), graphProcess(p, m));
  }
}

// ----- business logic (entity-centric) -----
function effLabel(ef, m){
  const en=ef.entityId ? (((m.entities||[]).find(x=>x.id===ef.entityId)||{}).name||'') : '';
  const tgt=[en, ef.fieldName].filter(Boolean).join('.');
  return (EFF_RU[ef.kind]||ef.kind)+(tgt?' '+tgt:'')+(ef.description?' — '+ef.description:'');
}
function entName(id, m){ const x=(m.entities||[]).find(y=>y.id===id); return x?x.name:id; }
function fieldOwner(m){ const map=new Map(); for(const e of (m.entities||[])) for(const f of (e.fields||[])) map.set(f.id, e.id); return map; }

async function renderLogic(view, m){
  const ents=m.entities||[];
  if(!ents.length){ view.innerHTML='<div class="model-empty">No entities in the model.</div>'; return; }
  const hasFlow=id=>(m.statusFlows||[]).some(f=>f.entityId===id);
  if(!logicEntityId || !ents.some(e=>e.id===logicEntityId)){
    const wf=ents.find(e=>hasFlow(e.id)); logicEntityId=(wf||ents[0]).id;
  }
  view.innerHTML='';
  const picker=document.createElement('div'); picker.className='ent-picker';
  for(const e of ents){
    const b=document.createElement('button');
    b.className='epill'+(e.id===logicEntityId?' active':''); b.title=e.description||'';
    b.innerHTML=esc(e.name)+(hasFlow(e.id)?' <span class="lc" title="has a lifecycle">⟳</span>':'');
    b.addEventListener('click', ()=>{ logicEntityId=e.id; renderLogic(view, m); });
    picker.appendChild(b);
  }
  view.appendChild(picker);
  const body=document.createElement('div'); view.appendChild(body);
  await renderEntityLogic(body, logicEntityId, m);
}

async function renderEntityLogic(container, entId, m){
  const e=(m.entities||[]).find(x=>x.id===entId); if(!e){ container.innerHTML=''; return; }
  const owner=fieldOwner(m);
  const fnTouches=f=> (f.readsFieldIds||[]).some(fid=>owner.get(fid)===entId) || (f.writesFieldIds||[]).some(fid=>owner.get(fid)===entId);
  container.innerHTML='';

  const h=document.createElement('div'); h.className='logic-h';
  h.innerHTML='<div class="logic-title">'+esc(e.name)+'</div>'+(e.description?'<div class="logic-desc">'+esc(e.description)+'</div>':'');
  container.appendChild(h);

  // 1) lifecycle
  const flows=(m.statusFlows||[]).filter(f=>f.entityId===entId);
  const secL=document.createElement('div'); secL.className='logic-sec';
  secL.innerHTML='<div class="logic-sec-t">🔄 Lifecycle — how and when status changes</div>';
  container.appendChild(secL);
  if(!flows.length){ const d=document.createElement('div'); d.className='model-empty'; d.style.padding='6px 0'; d.textContent='This entity has no status flow in the model.'; secL.appendChild(d); }
  else for(const fl of flows){
    if(fl.fieldName){ const cap=document.createElement('div'); cap.className='logic-cap'; cap.textContent='field: '+e.name+'.'+fl.fieldName; secL.appendChild(cap); }
    const w=document.createElement('div'); w.className='proc-diagram'; secL.appendChild(w);
    await renderElk(w, graphLifecycle(fl, m));
  }

  // 2) processes involving the entity
  const relProcs=(m.processes||[]).filter(p=>(p.steps||[]).some(st=>{
    if(st.refId===entId) return true;
    if(st.refKind==='function'){ const fn=(m.serverFunctions||[]).find(x=>x.id===st.refId); return fn&&fnTouches(fn); }
    return false;
  }));
  const secP=document.createElement('div'); secP.className='logic-sec';
  secP.innerHTML='<div class="logic-sec-t">▶ Processes involving this entity</div>';
  container.appendChild(secP);
  if(!relProcs.length){ const d=document.createElement('div'); d.className='model-empty'; d.style.padding='6px 0'; d.textContent='No processes involve this entity.'; secP.appendChild(d); }
  else for(const p of relProcs){
    const b=document.createElement('div'); b.className='proc-block';
    b.innerHTML='<div class="proc-title">'+esc(p.name)+'</div>'+(p.description?'<div class="proc-desc">'+esc(p.description)+'</div>':'')+'<div class="proc-diagram"></div>';
    secP.appendChild(b);
    await renderElk(b.querySelector('.proc-diagram'), graphProcess(p, m, entId));
  }

  // 3) operations
  const ops=(m.serverFunctions||[]).filter(fnTouches);
  const secO=document.createElement('div'); secO.className='logic-sec';
  let ot='<div class="logic-sec-t">⚙ Operations on this entity</div>';
  if(!ops.length) ot+='<div class="model-empty" style="padding:6px 0">No functions read/write this entity.</div>';
  else{
    const rtById=new Map((m.apiRoutes||[]).map(r=>[r.id,r]));
    const evById=new Map((m.events||[]).map(ev=>[ev.id,ev]));
    ot+='<table class="op-table"><thead><tr><th>Function</th><th>Type</th><th>R/W</th><th>Route</th><th>Events</th></tr></thead><tbody>';
    for(const f of ops){
      const reads=(f.readsFieldIds||[]).some(fid=>owner.get(fid)===entId);
      const writes=(f.writesFieldIds||[]).some(fid=>owner.get(fid)===entId);
      const rw=(reads?'<span class="rw r">R</span>':'')+(writes?'<span class="rw w">W</span>':'');
      const rt=f.routeId&&rtById.get(f.routeId); const rtl=rt?(rt.method+' '+rt.path):'';
      const evs=(f.emitsEventIds||[]).map(id=>evById.get(id)?evById.get(id).name:id).join(', ');
      ot+='<tr><td><b>'+esc(f.name)+'</b></td><td>'+esc(f.operation||'')+'</td><td>'+rw+'</td><td><code>'+esc(rtl)+'</code></td><td>'+esc(evs)+'</td></tr>';
    }
    ot+='</tbody></table>';
  }
  secO.innerHTML=ot; container.appendChild(secO);

  // 4) reactions
  const rx=(m.reactions||[]).filter(r=> (r.trigger&&r.trigger.entityId===entId) || (r.effects||[]).some(ef=>ef.entityId===entId));
  if(rx.length){
    const secR=document.createElement('div'); secR.className='logic-sec';
    let rt='<div class="logic-sec-t">⚡ Reactions (side effects)</div>';
    for(const r of rx){
      const eff=(r.effects||[]).map(ef=>effLabel(ef,m)).join('; ');
      rt+='<div class="rx-row"><b>'+esc(r.name)+'</b>'+
        (r.trigger?'<span class="rx-trig">on change of '+esc(entName(r.trigger.entityId,m))+(r.trigger.fieldName?'.'+esc(r.trigger.fieldName):'')+'</span>':'')+
        (eff?'<div class="rx-eff">→ '+esc(eff)+'</div>':'')+'</div>';
    }
    secR.innerHTML=rt; container.appendChild(secR);
  }
}

function graphLifecycle(fl, m){
  const nodes=[], edges=[]; const states=fl.states||[], trans=fl.transitions||[];
  const sid=k=>'st_'+mSafe(k);
  for(const st of states) nodes.push({id:sid(st.key), w:168, h: (st.description||st.ownerRole)?50:44, meta:{kind:'state', label:st.name||st.key, sub: st.description||st.ownerRole||'', ref:{k:'entity',id:fl.entityId}}});
  const targets=new Set(trans.map(t=>t.to));
  const initials=states.filter(st=>!targets.has(st.key));
  if(initials.length){ nodes.push({id:'START', w:118, h:38, meta:{kind:'start', label:'created', ref:{k:'entity',id:fl.entityId}}}); for(const st of initials) edges.push({from:'START', to:sid(st.key), kind:'spine'}); }
  trans.forEach((t,i)=>{
    // A transition should read as WHAT it does, never a bare "transition".
    const toName=(states.find(s=>s.key===t.to)||{}).name || t.to;
    const guard=t.condition || (t.byRole ? ('by '+t.byRole) : '');
    const named=t.label || t.description || '';
    const trig = named || guard || ('→ '+toName);
    const sub  = named ? [guard, '→ '+toName].filter(Boolean).join(' · ')
                       : (guard ? '→ '+toName : '');
    const wch=Math.max(trig.length, sub.length);
    const tn='tr'+i; nodes.push({id:tn, w:Math.max(132,Math.min(262, wch*7+30)), h: sub?50:40, meta:{kind:'trigger', label:trig, sub, ref:{k:'entity',id:fl.entityId}}});
    edges.push({from:sid(t.from), to:tn, kind:'spine'});
    edges.push({from:tn, to:sid(t.to), kind:'branch'});
    (t.effects||[]).forEach((ef,j)=>{ const en='ef'+i+'_'+j, lbl=effLabel(ef,m); nodes.push({id:en, w:Math.max(150,Math.min(270,lbl.length*6.4+28)), h:40, meta:{kind:'effect', label:lbl, ref: ef.entityId?{k:'entity',id:ef.entityId}:{k:'entity',id:fl.entityId}}}); edges.push({from:tn, to:en, kind:'effect'}); });
  });
  return {direction:'DOWN', nodes, edges};
}

function graphProcess(p, m, hi){
  const nodes=[], edges=[]; const steps=p.steps||[];
  steps.forEach((st,i)=>{
    const kind = st.refKind==='entity'?'entity' : st.refKind==='route'?'route' : st.refKind==='event'?'event' : st.refKind==='frontend'?'frontend' : 'function';
    const desc = st.note || refDesc(st.refKind, st.refId, m) || st.refKind;
    nodes.push({id:'ps'+i, w:194, h:56, meta:{kind, label:resolveRef(st.refKind,st.refId,m), sub: desc+(st.refId===hi?'  ◄':''), ref:{k:st.refKind,id:st.refId}}});
    if(i>0) edges.push({from:'ps'+(i-1), to:'ps'+i, kind:'spine'});
  });
  return {direction:'RIGHT', nodes, edges};
}
function copyToClipboard(text){
  if(navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
  return new Promise((resolve, reject)=>{
    try{
      const ta=document.createElement('textarea');
      ta.value=text; ta.style.position='fixed'; ta.style.opacity='0';
      document.body.appendChild(ta); ta.focus(); ta.select();
      document.execCommand('copy'); document.body.removeChild(ta); resolve();
    }catch(e){ reject(e); }
  });
}
function esc(s){ return String(s).replace(/[&<>]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }
function fmtTime(iso){ try{ const d=new Date(iso); if(isNaN(d)) return iso; return d.toLocaleString('en-GB',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}); }catch{ return iso; } }
async function refreshTasks(pathStr){
  let d; try{ d = await (await fetch('/api/tasks?path='+encodeURIComponent(pathStr))).json(); }catch{ return; }
  if (selected !== pathStr) return;               // switched to another project
  const cont = document.getElementById('taskList'); if(!cont) return;
  const tasks = d.tasks || [];
  const cEl = document.getElementById('taskBadge'); if(cEl) cEl.textContent = tasks.length ? String(tasks.length) : '';
  const uEl = document.getElementById('taskUpd'); if(uEl) uEl.textContent = d.updated ? ('updated '+fmtTime(d.updated)) : '';
  if(!tasks.length){
    cont.innerHTML = '<div class="tasks-empty">No entries yet.<br>1) <b>▶ Run Claude</b> · 2) in Settings click <b>📋 task-log</b> · 3) paste into claude (⌘V) and Enter — it will start logging what it does here.</div>';
    return;
  }
  const icon = s => s==='done'?'✅':s==='in_progress'?'🔧':'⬜';
  cont.innerHTML = tasks.slice().reverse().map(t=>{
    const files = (t.files||[]).map(f=>'<span class="file">'+esc(f)+'</span>').join('');
    return '<div class="task '+(t.status||'')+'">'+
      '<div class="ic">'+icon(t.status)+'</div>'+
      '<div class="body"><div class="tt">'+esc(t.title||'—')+'</div>'+
      (t.detail?'<div class="dd">'+esc(t.detail)+'</div>':'')+
      ((files||t.ts)?'<div class="meta">'+files+(t.ts?'<span class="ts">'+esc(fmtTime(t.ts))+'</span>':'')+'</div>':'')+
      '</div></div>';
  }).join('');
}

function debounce(fn, ms){ let t; return ()=>{ clearTimeout(t); t=setTimeout(fn, ms); }; }

async function update(pathStr, patch, savedSel){
  const item = byPath(pathStr); if(item) Object.assign(item, patch);
  await fetch('/api/update', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({path:pathStr, ...patch})});
  // reflect name change in the sidebar without full reload
  if (patch.name !== undefined){
    const it = [...listEl.children].find(c=>c.dataset && c.dataset.path===pathStr);
    if (it) it.querySelector('.nm').textContent = displayName(item);
  }
  if (savedSel){ const s=document.querySelector(savedSel); if(s){ s.classList.add('show'); clearTimeout(s._t); s._t=setTimeout(()=>s.classList.remove('show'),1200);} }
}

async function open(p){
  toast('Opening “'+displayName(p)+'” in Terminal…');
  const r = await fetch('/api/open', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({path:p.path})});
  if(!r.ok){ const d=await r.json().catch(()=>({})); toast('Error: '+(d.error||r.status), true); }
}
async function reveal(p){
  await fetch('/api/reveal', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({path:p.path})});
}
async function remove(p){
  if(!confirm('Remove “'+displayName(p)+'” from the list?\\n\\nThe folder on disk is NOT deleted — only the card is removed.')) return;
  await fetch('/api/remove', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({path:p.path})});
  if (selected===p.path) selected = null;
  toast('Removed from list'); load();
}

async function addProject(bodyObj){
  const r = await fetch('/api/add', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(bodyObj||{})});
  return r.json();
}
function openAddModal(){
  let ov=document.getElementById('addOverlay');
  if(!ov){ ov=document.createElement('div'); ov.id='addOverlay'; ov.className='ctx-overlay'; document.body.appendChild(ov); }
  ov.innerHTML=
    '<div class="ctx-modal" style="max-width:560px">'+
      '<div class="ctx-head"><div class="ctx-title">Add a project</div><button class="ctx-x" title="Close (Esc)">✕</button></div>'+
      '<div class="ctx-note">Paste the full path to the project folder — open it in your file manager and copy the path from the address bar.'+(PICKER_OK?' Or use <b>Browse…</b> to pick it.':'')+'</div>'+
      '<div class="ctx-taskl" style="margin:14px 18px 0">Folder path</div>'+
      '<input class="ctx-task" id="addPath" style="min-height:0; height:44px; line-height:22px; font-family:var(--font-mono)" placeholder="e.g.  C:&#92;projects&#92;my-app   or   /Users/you/projects/my-app" autocomplete="off" spellcheck="false">'+
      '<div class="ctx-actions">'+
        '<button class="run" id="addGo">＋ Add</button>'+
        (PICKER_OK?'<button class="ghost" id="addBrowse">🗂 Browse…</button>':'')+
        '<button class="del" id="addCancel">Cancel</button>'+
      '</div>'+
    '</div>';
  ov.classList.add('show');
  const inp=ov.querySelector('#addPath');
  const close=()=>{ ov.classList.remove('show'); ov.innerHTML=''; };
  const go=async ()=>{
    const p=(inp.value||'').trim(); if(!p){ toast('Enter a folder path', true); inp.focus(); return; }
    const d=await addProject({path:p});
    if(d.added){ selected=d.project.path; await load(); close(); toast('Added: '+displayName(d.project)); }
    else if(d.duplicate){ selected=d.path; await load(); close(); toast('Already in the list', true); }
    else if(d.error){ toast(d.error, true); inp.focus(); }
    else close();
  };
  ov.querySelector('.ctx-x').addEventListener('click', close);
  ov.querySelector('#addCancel').addEventListener('click', close);
  ov.addEventListener('click', e=>{ if(e.target===ov) close(); });
  ov.querySelector('#addGo').addEventListener('click', go);
  inp.addEventListener('keydown', e=>{ if(e.key==='Enter') go(); });
  const bb=ov.querySelector('#addBrowse');
  if(bb) bb.addEventListener('click', async ()=>{
    toast('Opening folder picker…');
    let d; try{ d=await (await fetch('/api/pick',{method:'POST'})).json(); }catch{ d={}; }
    if(d.path){ inp.value=d.path; toast('Picked ✓'); }
    else if(d.pickerFailed){ toast('Native picker unavailable — paste the path instead', true); }
    else { document.getElementById('toast').className='toast'; }
    inp.focus();
  });
  setTimeout(()=>inp.focus(), 40);
}
document.getElementById('addBtn').addEventListener('click', openAddModal);
searchEl.addEventListener('input', renderList);
window.addEventListener('focus', ()=>load(true)); // refresh folder status on return

// drag & drop reorder
let dragEl = null;
function wireDrag(el){
  el.addEventListener('dragstart', ()=>{ dragEl = el; el.classList.add('drag'); });
  el.addEventListener('dragend', ()=>{ el.classList.remove('drag'); saveOrder(); });
  el.addEventListener('dragover', (e)=>{ e.preventDefault(); if(el!==dragEl) el.classList.add('dragover'); });
  el.addEventListener('dragleave', ()=> el.classList.remove('dragover'));
  el.addEventListener('drop', (e)=>{
    e.preventDefault(); el.classList.remove('dragover');
    if(!dragEl || dragEl===el) return;
    const items = [...listEl.children];
    if(items.indexOf(dragEl) < items.indexOf(el)) el.after(dragEl); else el.before(dragEl);
  });
}
async function saveOrder(){
  const paths = [...listEl.children].map(c=>c.dataset && c.dataset.path).filter(Boolean);
  await fetch('/api/reorder', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({paths})});
  projects.sort((a,b)=> paths.indexOf(a.path)-paths.indexOf(b.path));
}

/* ---------------- team bridge (client) ---------------- */
let teamState=null, teamSeenTaskT=null, RELAY_URL_DEFAULT='ws://localhost:4600';
function loadTeamMem(){ try{ return JSON.parse(localStorage.getItem('gitmir.team')||'{}'); }catch{ return {}; } }
function saveTeamMem(o){ try{ localStorage.setItem('gitmir.team', JSON.stringify(o)); }catch{} }
function taTime(t){ try{ return new Date(t).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}); }catch{ return ''; } }
function activityHtml(activity){
  if(!activity||!activity.length) return '<div class="team-empty">No activity yet.</div>';
  return activity.map(a=> '<div class="team-act"><span class="ta-k">'+esc(a.kind)+'</span><span class="ta-t">'+esc(a.text)+'</span><span class="ta-time">'+taTime(a.t)+'</span></div>').join('');
}
function connectHtml(s){
  return ''
  + '<div class="team-card">'
  +   '<div class="team-lede">Connect this machine to your team through the GitMir relay. The relay only <b>routes</b> — your model and tasks move between your team\\'s machines and nothing is stored on our servers. Requires a paid Team plan.</div>'
  +   '<div class="field"><label>Workspace key</label><input class="ti" id="teamKey" placeholder="wsk_…" autocomplete="off" spellcheck="false"></div>'
  +   '<div class="field"><label>Display name</label><input class="ti" id="teamName" placeholder="Your name"></div>'
  +   '<div class="field"><label>Bind to project</label><select class="ti" id="teamProj"></select></div>'
  +   '<div class="field"><label>Relay URL</label><input class="ti" id="teamUrl" placeholder="ws://localhost:4600" spellcheck="false"></div>'
  +   '<div class="team-actions"><button class="run" id="teamConnectBtn">▚ Connect</button><span class="team-cstate" id="teamCStatus"></span></div>'
  + '</div>'
  + '<div class="team-card"><div class="team-feed-h">Activity</div><div id="teamDyn"></div></div>';
}
function liveHtml(s){
  var bound = s.projectPath ? ('bound: '+esc(basename(s.projectPath))) : 'no project bound';
  return ''
  + '<div class="team-card">'
  +   '<div class="team-status-row">'
  +     '<span class="team-dot on"></span>'
  +     '<span class="team-self">'+esc((s.self&&s.self.name)||s.name||'me')+'</span>'
  +     '<span class="team-plan">plan: '+esc(s.plan||'—')+'</span>'
  +     '<span class="team-bound">'+bound+'</span>'
  +   '</div>'
  +   '<div class="team-members" id="teamMembers"></div>'
  +   '<div class="team-ops"><button class="ghost" id="teamShareBtn">⇪ Share model</button><button class="del" id="teamDiscBtn">Disconnect</button></div>'
  + '</div>'
  + '<div class="team-card">'
  +   '<div class="team-feed-h">Send a task to the team</div>'
  +   '<input class="ti" id="teamTaskTitle" placeholder="Task title">'
  +   '<textarea class="ti" id="teamTaskBody" placeholder="Optional details (markdown)"></textarea>'
  +   '<div class="team-actions"><button class="run" id="teamSendBtn">➤ Send task</button></div>'
  + '</div>'
  + '<div class="team-card"><div class="team-feed-h">Activity</div><div id="teamDyn"></div></div>';
}
function wireConnect(){
  const view=document.getElementById('teamView'); if(!view) return;
  const sel=view.querySelector('#teamProj');
  const mem=loadTeamMem();
  sel.innerHTML = projects.map(p=> '<option value="'+esc(p.path)+'">'+esc(displayName(p))+'</option>').join('') || '<option value="">— add a project first —</option>';
  const wantPath = mem.path || selected || (projects[0] && projects[0].path);
  if(wantPath) sel.value = wantPath;
  view.querySelector('#teamKey').value = mem.key || '';
  view.querySelector('#teamName').value = mem.name || '';
  view.querySelector('#teamUrl').value = mem.url || (teamState && teamState.url) || RELAY_URL_DEFAULT;
  view.querySelector('#teamConnectBtn').addEventListener('click', teamDoConnect);
}
async function teamDoConnect(){
  const view=document.getElementById('teamView'); if(!view) return;
  const key=view.querySelector('#teamKey').value.trim();
  const name=view.querySelector('#teamName').value.trim();
  const path=view.querySelector('#teamProj').value;
  const url=view.querySelector('#teamUrl').value.trim();
  if(!key){ toast('Enter a workspace key', true); return; }
  saveTeamMem({key,name,url,path});
  const cs=view.querySelector('#teamCStatus'); if(cs) cs.innerHTML='<span class="team-connecting">connecting…</span>';
  try{
    const r=await (await fetch('/api/team/connect',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key,name,path,url})})).json();
    teamState=r.status||teamState;
  }catch{ toast('Connect failed', true); }
  teamPoll();
}
function wireLive(){
  const view=document.getElementById('teamView'); if(!view) return;
  view.querySelector('#teamShareBtn').addEventListener('click', async ()=>{
    const r=await (await fetch('/api/team/share-model',{method:'POST'})).json();
    toast(r.ok?'Model shared with the team':(r.error||'No local .gitmir/model to share'), !r.ok);
    teamPoll();
  });
  view.querySelector('#teamDiscBtn').addEventListener('click', async ()=>{
    await fetch('/api/team/disconnect',{method:'POST'});
    toast('Disconnected from the team'); teamState=null; teamPoll();
  });
  view.querySelector('#teamSendBtn').addEventListener('click', async ()=>{
    const t=view.querySelector('#teamTaskTitle'), b=view.querySelector('#teamTaskBody');
    const title=t.value.trim(); if(!title){ toast('Task needs a title', true); return; }
    const r=await (await fetch('/api/team/send-task',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title, body:b.value})})).json();
    if(r.ok){ toast('Task sent to the team'); t.value=''; b.value=''; } else toast(r.error||'Send failed', true);
    teamPoll();
  });
}
function teamUpdateDynamic(s){
  const dyn=document.getElementById('teamDyn'); if(dyn) dyn.innerHTML=activityHtml(s.activity);
  const mem=document.getElementById('teamMembers');
  if(mem) mem.innerHTML=(s.members||[]).map(x=> '<span class="team-chip'+(s.self&&x.id===s.self.id?' me':'')+'">'+esc(x.name)+'</span>').join('') || '<span class="team-empty">just you — waiting for teammates to join…</span>';
  const cs=document.getElementById('teamCStatus'); if(cs) cs.innerHTML = s.connecting?'<span class="team-connecting">connecting…</span>':'';
}
function renderTeam(){
  const view=document.getElementById('teamView'); if(!view) return;
  const s=teamState||{connected:false};
  const mode = s.connected ? 'live' : 'connect';
  if(view.dataset.mode!==mode){
    view.dataset.mode=mode;
    view.innerHTML = mode==='live' ? liveHtml(s) : connectHtml(s);
    if(mode==='live') wireLive(); else wireConnect();
  }
  teamUpdateDynamic(s);
  const upd=document.getElementById('teamUpd');
  if(upd) upd.textContent = s.connected ? ('online · '+((s.members||[]).length)+' member(s)') : (s.connecting?'connecting…':'offline');
}
async function teamPoll(){
  let s; try{ s=await (await fetch('/api/team/status')).json(); }catch{ return; }
  teamState=s;
  const badge=document.getElementById('teamBadge');
  if(badge){ badge.textContent = s.connected ? ('●'+((s.members||[]).length||'')) : (s.connecting?'…':''); badge.className='badge'+(s.connected?' on':''); }
  // notify on a NEW incoming task (activity is newest-first; incoming tasks start with "from ")
  const inc=(s.activity||[]).filter(a=> a.kind==='task' && /^from /.test(a.text));
  const newestT = inc.length ? inc[0].t : null;
  if(teamSeenTaskT===null){ teamSeenTaskT=newestT; }
  else if(newestT && newestT>teamSeenTaskT){
    teamSeenTaskT=newestT;
    const who=(inc[0].text.match(/^from (.+?) →/)||[])[1]||'a teammate';
    toast('📥 New task from '+who);
    if(selected){ refreshTasks(selected); if(activeTab==='queue') loadQueue(selected); }
  }
  if(activeTab==='team') renderTeam();
}

document.addEventListener('keydown', (e)=>{ if(e.key==='Escape'){ fsClose(); for(const id of ['ctxOverlay','addOverlay']){ const o=document.getElementById(id); if(o){ o.classList.remove('show'); o.innerHTML=''; } } } });
fetch('/api/env').then(r=>r.json()).then(d=>{ PICKER_OK = !!d.pickerAvailable; if(d.relayUrl) RELAY_URL_DEFAULT=d.relayUrl; }).catch(()=>{});
loadSkillsList();
load();
teamPoll();
setInterval(teamPoll, 3500);
</script>
</body>
</html>`;
