// ---------- share a read-only map ----------
// Path 1 of SHARE_THE_MAP.md: one snapshot the author deliberately sends. It needs the
// workspace key and nothing else — no plan, no bridge connection, no socket. Never call
// this on a timer; one press, one snapshot.
const SHARE_SEES = 'the areas, what a user can do, how things move between states, the screens and the kinds of record';
const SHARE_HIDES = 'field names, endpoints, the steps inside a flow, or a single line of code';

function openSharePopup(){
  if(!selected){ toast('Pick a project first', true); return; }
  if(!modelData || !modelData.exists){ toast('This project has no model yet — run gitmir-model first', true); return; }
  if(modelSrc){ toast('You can only share your own model, not a teammate snapshot', true); return; }
  const mem=loadTeamMem();
  const title=(modelData.index && modelData.index.project) || (selected.split('/').pop()) || 'Product map';
  let ov=document.getElementById('shareOverlay');
  if(!ov){ ov=document.createElement('div'); ov.id='shareOverlay'; ov.className='ctx-overlay'; overlayHost().appendChild(ov); }
  ov.innerHTML=
    '<div class="ctx-modal share-modal">'+
      '<div class="ctx-head"><div class="ctx-title">Share this map</div><button class="ctx-x" title="Close (Esc)">✕</button></div>'+

      '<div class="sh-body">'+
      '<div class="sh-key'+(mem.key?' has':'')+'">'+
        '<label>Workspace key</label>'+
        '<input class="ti" id="shKey" type="password" autocomplete="off" spellcheck="false" placeholder="paste the key from ide.gitmir.com" value="'+esc(mem.key||'')+'">'+
        '<div class="sh-note">Free on any plan. This does not connect the bridge and does not need one.</div>'+
      '</div>'+

      '<div class="sh-modes">'+
        '<label class="sh-radio"><input type="radio" name="shAccess" value="link" checked><span>Anyone with the link</span></label>'+
        '<label class="sh-radio"><input type="radio" name="shAccess" value="people"><span>Only these people</span>'+
          '<input class="ti sh-people" id="shPeople" placeholder="client@company.com, pm@company.com" disabled></label>'+
      '</div>'+

      '<div class="sh-exp"><label>Expires in</label>'+
        '<select class="ti" id="shExp">'+
          '<option value="7">7 days</option>'+
          '<option value="30" selected>30 days</option>'+
          '<option value="90">90 days</option>'+
          '<option value="">never</option>'+
        '</select></div>'+

      '<div class="sh-what">'+
        '<div><b>They see</b> '+SHARE_SEES+'.</div>'+
        '<div><b>They do not see</b> '+SHARE_HIDES+'.</div>'+
      '</div>'+

      '<div class="sh-out" id="shOut"></div>'+
      '</div>'+

      '<div class="ctx-actions">'+
        '<button class="run sh-go">Create link</button>'+
        '<button class="ghost sh-file">⬇ Or save a self-contained file</button>'+
        '<button class="del sh-close">Close</button>'+
      '</div>'+
    '</div>';
  mountOverlay(ov).classList.add('show');
  const close=()=>{ ov.classList.remove('show'); ov.innerHTML=''; };
  ov.querySelector('.ctx-x').addEventListener('click', close);
  ov.querySelector('.sh-close').addEventListener('click', close);
  ov.addEventListener('click', e=>{ if(e.target===ov) close(); });

  const people=ov.querySelector('#shPeople');
  ov.querySelectorAll('input[name=shAccess]').forEach(r=> r.addEventListener('change', ()=>{
    people.disabled = ov.querySelector('input[name=shAccess]:checked').value!=='people';
    if(!people.disabled) people.focus();
  }));

  // Path 3 — nothing is uploaded, for an NDA where nothing may be.
  ov.querySelector('.sh-file').addEventListener('click', ()=>{
    const a=document.createElement('a');
    a.href='/api/share/export?path='+encodeURIComponent(selected)+'&name='+encodeURIComponent(title);
    a.download=''; document.body.appendChild(a); a.click(); a.remove();
    toast('Building the file — check your downloads');
  });

  ov.querySelector('.sh-go').addEventListener('click', async (e)=>{
    const btn=e.currentTarget, out=document.getElementById('shOut');
    const key=(document.getElementById('shKey').value||'').trim();
    const access=ov.querySelector('input[name=shAccess]:checked').value;
    const allowed=access==='people'
      ? (people.value||'').split(/[,;\s]+/).map(x=>x.trim()).filter(Boolean)
      : [];
    if(access==='people' && !allowed.length){ out.className='sh-out err'; out.textContent='Add at least one address, or choose "Anyone with the link".'; return; }
    const expRaw=document.getElementById('shExp').value;
    btn.disabled=true; out.className='sh-out'; out.textContent='Creating…';
    let r; try{
      r=await (await fetch('/api/team/share-view',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({ key, path:selected, title, access, allowed, expiresInDays: expRaw===''?null:Number(expRaw) })})).json();
    }catch{ r={ok:false,error:'could not reach the local server'}; }
    btn.disabled=false;
    if(r && r.ok && r.url){
      // The key worked, so keep it for next time — same place the Team tab keeps it.
      if(key){ const m=loadTeamMem(); m.key=key; saveTeamMem(m); }
      out.className='sh-out ok';
      out.innerHTML=
        '<div class="sh-url"><code>'+esc(r.url)+'</code><button class="ghost sh-copy">📋 Copy</button></div>'+
        (access==='people'
          ? '<div class="sh-warn">Only the addresses you listed can open it, and they must sign in.</div>'
          : '<div class="sh-warn">Anybody holding this link can open it, so pass it on the way you would a password.</div>')+
        '<div class="sh-manage"><a href="https://ide.gitmir.com/settings#shared" target="_blank" rel="noopener">Manage or revoke your links ↗</a> — Settings → Shared links on ide.gitmir.com</div>';
      out.querySelector('.sh-copy').addEventListener('click', async ()=>{ await copyToClipboard(r.url); toast('Link copied ✓'); });
      copyToClipboard(r.url).then(()=>toast('Link copied ✓')).catch(()=>{});
    } else {
      out.className='sh-out err';
      out.innerHTML=esc((r && r.error) || 'Share failed')+
        ((r && /25 live links/.test(r.error||'')) ? ' <a href="https://ide.gitmir.com/settings#shared" target="_blank" rel="noopener">Open Settings ↗</a>' : '');
    }
  });
}

// A shared view runs this exact file with the model handed to it instead of fetched, and
// with everything that writes disabled. Same renderer as the dashboard, by construction —
// there is no second implementation to drift.
const SHARE = window.__GITMIR_SHARE__ || null;

const listEl = document.getElementById('list');      // the project tile grid
const mainEl = document.getElementById('main');
const detailEl = document.getElementById('detail');  // one project, once opened
const railEl = document.getElementById('rail');
const topProjEl = document.getElementById('topProj');
const topToolsEl = document.getElementById('topTools');
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
function basename(p){ return p.replace(/\/+$/,'').split('/').pop(); }
function displayName(p){ return (p.name && p.name.trim()) || basename(p.path); }
function byPath(p){ return projects.find(x=>x.path===p); }

// What the detail panel actually renders from. If none of this changed there is
// nothing to rebuild.
function projSig(p){ return p ? [p.path, p.name||'', p.description||'', p.exists?1:0].join('\u0000') : ''; }
// The only thing a background refresh can change about the open project is whether
// its folder is still there — update that in place.
function refreshDetailBits(){
  const p = byPath(selected); if(!p) return;
  const miss = document.getElementById('dMiss'); if(miss) miss.style.display = p.exists ? 'none' : 'block';
}
async function load(keepSelection){
  const r = await fetch('/api/projects'); const d = await r.json();
  const before = projSig(byPath(selected));
  projects = d.projects || [];
  if (keepSelection && !byPath(selected)) selected = null;
  renderList();
  // Rebuilding the detail panel throws away scroll position, a half-typed field, the
  // open preview page and the copy you were about to make — and replays the panel
  // animation, which is the flash. This runs on every window focus, so it must only
  // rebuild when the selected project really changed.
  if (before !== projSig(byPath(selected)) || (selected && !detailEl.firstChild)) renderDetail();
  else refreshDetailBits();
}

// The IDE icon set, verbatim: viewBox 24, no fill, currentColor stroke at 1.7 with round
// caps and joins. Same geometry as every glyph in ide.gitmir.com, so nothing looks foreign.
const IPATH = {
  settings: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 0 1-4 0v-.1A1.6 1.6 0 0 0 7 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7H1a2 2 0 0 1 0-4h.1A1.6 1.6 0 0 0 2.6 7a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H7a1.6 1.6 0 0 0 1-1.5V1a2 2 0 0 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V7a1.6 1.6 0 0 0 1.5 1H23a2 2 0 0 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z",
  tasks:    "M9 11l3 3 8-8M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11",
  schema:   "M5 4h5v4H5zM14 4h5v4h-5zM9 16h6v4H9zM7 8v4h10V8M12 12v4",
  columns:  "M4 4h7v16H4zM13 4h7v16h-7z",
  user:     "M20 21a8 8 0 0 0-16 0M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
  eye:      "M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  refresh:  "M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5",
  code:     "M16 18l6-6-6-6M8 6l-6 6 6 6",
  layers:   "M12 2 2 7l10 5 10-5-10-5zM2 12l10 5 10-5M2 17l10 5 10-5",
  compass:  "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM16 8l-2 6-6 2 2-6 6-2z",
  table:    "M3 4h18v16H3zM3 9h18M3 14h18M9 4v16M15 4v16",
  filter:   "M3 4h18l-7 8v6l-4 2v-8L3 4z",
  list:     "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
  play:     "M5 3l14 9-14 9V3z",
  shield:   "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z",
  check:    "M20 6 9 17l-5-5",
  scales:   "M12 3v18M7 21h10M12 6 4 9m8-3 8 3M4 9l-2.5 5a2.5 2.5 0 0 0 5 0L4 9zm16 0-2.5 5a2.5 2.5 0 0 0 5 0L20 9z",
  branch:   "M6 3v12M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 6a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 6v3a6 6 0 0 1-6 6H6",
  external: "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14 21 3",
  copy:     "M9 9h11v11H9zM5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1",
  spark:    "M12 2v6M12 16v6M2 12h6M16 12h6M5 5l4 4M15 15l4 4M19 5l-4 4M9 15l-4 4",
  github:   "M9 19c-5 1.5-5-2.5-7-3m14 6v-3.9a3.4 3.4 0 0 0-1-2.6c3-.3 6.2-1.5 6.2-6.7A5.2 5.2 0 0 0 19.9 5 4.9 4.9 0 0 0 19.8 1.4S18.7 1 16 2.9a13.4 13.4 0 0 0-7 0C6.3 1 5.2 1.4 5.2 1.4A4.9 4.9 0 0 0 5.1 5 5.2 5.2 0 0 0 3.8 8.6c0 5.2 3.2 6.4 6.2 6.7a3.4 3.4 0 0 0-1 2.6V22",
};
function svgIcon(name, size, style){
  return '<svg width="' + (size||18) + '" height="' + (size||18) + '" viewBox="0 0 24 24" fill="none" '
    + 'stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"'
    + (style ? ' style="' + style + '"' : '') + '><path d="' + IPATH[name] + '"/></svg>';
}
const ICON = {
  clock: svgIcon('refresh', 13),
  code:  svgIcon('code', 13, 'color:var(--cyan)'),
};

// The home screen. Projects are the whole surface here rather than a column beside
// something else, because until you have opened one there is nothing else to look at.
function renderList(){
  const q = searchEl.value.trim().toLowerCase();
  const list = projects.filter(p => !q || displayName(p).toLowerCase().includes(q) || p.path.toLowerCase().includes(q));
  countEl.textContent = projects.length ? projects.length + (projects.length === 1 ? ' project' : ' projects') : '';
  listEl.innerHTML = '';
  if (!list.length){
    const e = document.createElement('div'); e.className='grid-empty';
    e.innerHTML = projects.length
      ? 'Nothing matches <b>' + esc(searchEl.value.trim()) + '</b>.'
      : 'No projects yet. <b>＋ Add project</b> and point it at any folder on any disk — '
        + 'then open it, run Claude in it, and the model, the queue and the log fill up as it works.';
    listEl.appendChild(e); return;
  }
  list.forEach((p, i) => {
    const el = document.createElement('div');
    // The same object the IDE renders: a glass plate with the lit rim, the entrance sweep,
    // a header strip carrying the status badge and the name, then body / divider / footer.
    el.className = 'glass edge hoverable clickable prj-card' + (p.exists ? '' : ' missing');
    el.draggable = true; el.dataset.path = p.path; el.tabIndex = 0;
    el.style.setProperty('--enter', Math.min(i * 70, 840) + 'ms');

    const q = p.queue || {};
    const status = !p.exists ? ['badge-danger', 'Missing']
      : q.pending ? ['badge-amber', q.pending + ' open']
      : p.hasModel ? ['badge-cyan', 'Mapped']
      : ['badge-ghost', 'Not mapped'];

    el.innerHTML =
      '<span class="holo-scan" aria-hidden="true"></span>' +
      '<div class="prj-strip">' +
        '<span class="prj-gridfx" aria-hidden="true"></span>' +
        '<span class="prj-strip-status"><span class="badge ' + status[0] + '">'
          + '<span class="dot"></span>' + esc(status[1]) + '</span></span>' +
        '<span class="prj-strip-name"></span>' +
      '</div>' +
      '<div class="col gap-3 grow prj-body">' +
        '<div class="prj-desc muted text-sm"></div>' +
        '<div class="divider" style="margin:auto 0 0"></div>' +
        '<div class="between gap-2">' +
          '<span class="row gap-2 dim text-xs">' + ICON.clock + '<span class="pj-log"></span></span>' +
          '<span class="prj-method">' + ICON.code + '<span class="pj-model"></span></span>' +
        '</div>' +
      '</div>';
    el.querySelector('.prj-strip-name').textContent = displayName(p);
    // The description is what a person wrote about this project; the path is the fallback,
    // because a card with an empty paragraph looks broken rather than empty.
    el.querySelector('.prj-desc').textContent = p.description || p.path;
    el.querySelector('.pj-log').textContent = p.tasks ? p.tasks + ' done' : 'nothing logged';
    el.querySelector('.pj-model').textContent = p.hasModel ? 'Modelled' : 'No model';

    const open = () => {
      // Everything below belongs to the project being left: a hand-picked what-if, a
      // selected task, a layer showing that task. Carrying them into another project
      // would show one product's answer on another product's map.
      if(selected!==p.path){ modelSrc=null; logicEntityId=null;
        changesData=null; changesFor=null; impactPick=null; adhocIds=[]; mapLayer='none'; }
      selected = p.path; renderDetail();
    };
    el.addEventListener('click', open);
    el.addEventListener('keydown', e => { if(e.key==='Enter' || e.key===' '){ e.preventDefault(); open(); } });
    wireDrag(el);
    listEl.appendChild(el);
  });
}

// Home and project are two different screens, not two states of one. The rail and the
// project header only exist once something is open; the search and Add only when nothing is.
function setShell(open){
  listEl.classList.toggle('off', !!open);
  railEl.classList.toggle('on', !!open);
  topProjEl.classList.toggle('on', !!open);
  topToolsEl.style.display = open ? 'none' : 'flex';
  countEl.style.display = open ? 'none' : '';
}

const RAIL = [
  { tab:'home',     ic:'compass',  l:'Overview' },
  { tab:'settings', ic:'settings', l:'Setup' },
  { tab:'tasks',    ic:'tasks',    l:'Tasks' },
  { tab:'model',    ic:'schema',   l:'Model',   badge:'modelBadge' },
  { tab:'queue',    ic:'columns',  l:'Queue',   badge:'queueBadge' },
  { tab:'team',     ic:'user',     l:'Team',    badge:'teamBadge' },
  { tab:'preview',  ic:'eye',      l:'Preview', only:'preview' },
];
function renderRail(){
  railEl.innerHTML = RAIL
    .filter(r => r.only !== 'preview' || PREVIEW_OK)
    .map(r => '<button class="rl" data-tab="' + r.tab + '" title="' + r.l + '">'
      + svgIcon(r.ic, 20) + '<span class="l">' + r.l + '</span>'
      + (r.badge ? '<span class="badge" id="' + r.badge + '"></span>' : '') + '</button>').join('')
    + '<div class="rail-foot">'
    + '<a href="https://github.com/gitmir-hello/gitmir-local" target="_blank" rel="noopener" title="Source on GitHub">'
    + svgIcon('github', 16) + '</a><span>AGPL</span></div>';
  railEl.querySelectorAll('.rl').forEach(b => b.addEventListener('click', () => setTab(b.dataset.tab)));
}

let taskTimer = null;
let queueTimer = null;
// The first screen inside a project used to be a settings form — a name field and
// a description box, in a tool bought for what it knows about the product.
let activeTab = 'home';
// Which page of Setup is open — kept across re-renders, so it does not snap back.
let setupSub = 'skills';
function setTab(tab){
  activeTab = tab;
  document.querySelectorAll('.rl').forEach(b=>b.classList.toggle('active', b.dataset.tab===tab));
  document.querySelectorAll('.pane').forEach(p=>p.classList.toggle('active', p.dataset.pane===tab));
  clearInterval(queueTimer);
  if(tab==='home' && selected) renderHome(selected);
  if(tab==='model' && selected) loadModel(selected);
  if(tab==='queue' && selected){ loadQueue(selected); queueTimer=setInterval(()=>{ if(selected && activeTab==='queue') loadQueue(selected); }, 4000); }
  if(tab==='team'){ renderTeam(); teamPoll(); }
  if(tab==='preview') pvInit();
}
function renderDetail(){
  const p = byPath(selected);
  clearInterval(taskTimer);
  if (!p){
    setShell(false);
    detailEl.innerHTML = '';
    renderList();
    return;
  }
  const wrap = document.createElement('div'); wrap.className='detail-wrap';
  wrap.innerHTML =
    '<div class="pane" data-pane="home"><div id="homeView"></div></div>' +
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
      // Two ways of working, each with enough to say to need its own page: the
      // procedures you hand Claude, and wiring your editor to this model. Stacked
      // on one screen the second was a footnote under the first.
      '<div class="setup-sub">' +
        '<button class="mpill sub-pill active" data-sub="skills">Skills</button>' +
        '<button class="mpill sub-pill" data-sub="mcp">Connect Local MCP</button>' +
      '</div>' +
      '<div class="sub-pane" data-sub="skills">' +
        '<div class="skills-box">' +
          '<div class="skills-label">Copy one and paste it into claude (⌘V + Enter)</div>' +
          '<div class="skills-btns" id="skillsBtns"></div>' +
        '</div>' +
      '</div>' +
      '<div class="sub-pane" data-sub="mcp" style="display:none">' +
        '<div class="mcp-box" id="mcpBox"></div>' +
      '</div>' +
    '</div>' +
    '<div class="pane" data-pane="tasks">' +
      '<div class="tasks-head"><span class="t">What Claude did</span><span class="upd" id="taskUpd"></span></div>' +
      '<div id="taskList"></div>' +
    '</div>' +
    '<div class="pane" data-pane="model">' +
      '<div class="ingest" id="ingestBox"></div>' +
      '<div class="model-stale" id="modelStale"></div>' +
      '<div class="model-src" id="modelSrc"></div>' +
      '<div class="model-head">' +
        '<div class="model-subnav" id="modelNav"></div>' +
        '<span class="upd" id="modelUpd"></span>' +
        '<button class="mrefresh mshare" id="modelShare" title="Share this model — read only">⇪ Share</button>' +
        '<button class="mrefresh" id="modelRefresh" title="Refresh model">⟳</button>' +
      '</div>' +
      '<div id="modelView"><div class="model-empty">Opening model…</div></div>' +
    '</div>' +
    '<div class="pane" data-pane="queue">' +
      '<div class="tasks-head"><span class="t">Task queue — todo · in progress · verify · done</span></div>' +
      '<div class="audit" id="auditBox"></div>' +
      '<div id="queueView"><div class="model-empty">Loading…</div></div>' +
    '</div>' +
    '<div class="pane" data-pane="preview">'+
      '<div class="tasks-head"><span class="t">Preview &amp; pick — open a page, click an element, get a task</span><span class="upd" id="pvUrlNow"></span></div>'+
      '<div class="pv-bar">'+
        '<input class="ti pv-url" id="pvUrl" placeholder="https://example.com/pricing" autocomplete="off" spellcheck="false">'+
        '<button class="ghost" id="pvGo">Go</button>'+
        '<button class="ghost pv-pick" id="pvPick" disabled>◎ Select</button>'+
      '</div>'+
      '<div class="pv-frame-wrap"><iframe class="pv-frame" id="pvFrame" sandbox="allow-scripts allow-same-origin allow-forms allow-popups"></iframe>'+
        '<div class="pv-empty" id="pvEmpty">'+
          '<div class="pv-glyph">⌖</div>'+
          '<div class="pv-lead">nothing loaded</div>'+
          '<div class="pv-h">Open a page, then click the thing you want changed</div>'+
          '<div class="pv-sub">The page is fetched by this machine and shown from here, so a site that refuses to be framed still opens. Press <b>◎ Select</b>, click an element, and you get a task that names it — and the files it probably lives in.'+
          '<span class="pv-note">Sandboxed: the site runs the picker but cannot reach this dashboard. Pages behind a login render logged out.</span></div>'+
          '<div class="pv-eg" id="pvEg"></div>'+
        '</div>'+
      '</div>'+
      '</div>'+
    '<div class="pane" data-pane="team">' +
      '<div class="tasks-head"><span class="t">Team Bridge — route model &amp; tasks between your machines</span><span class="upd" id="teamUpd"></span></div>' +
      '<div id="teamView"><div class="model-empty">Loading…</div></div>' +
    '</div>';
  setShell(true);
  renderRail();
  // Fill it from the project list we already have, so the count is there on arrival
  // instead of appearing only once someone opens the Queue tab.
  const qb=document.getElementById('queueBadge');
  if(qb && p.queue && p.queue.todo) qb.textContent = String(p.queue.todo);
  topProjEl.innerHTML =
    '<button class="tp-back" title="All projects">←</button>' +
    '<span class="tp-nm"></span><span class="tp-pa"></span>';
  topProjEl.querySelector('.tp-nm').textContent = displayName(p);
  topProjEl.querySelector('.tp-pa').textContent = p.path;
  topProjEl.querySelector('.tp-back').addEventListener('click', ()=>{ selected=null; renderDetail(); });
  detailEl.innerHTML = ''; detailEl.appendChild(wrap);

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
  wrap.querySelector('#modelShare').addEventListener('click', openSharePopup);
  if(selected) loadNextStep(selected).then(()=>{ if(selected===p.path) renderSkillButtons(); });
  setTab(activeTab);
  wrap.querySelectorAll('.sub-pill').forEach(b=>b.addEventListener('click',()=>{
    setupSub = b.dataset.sub;
    wrap.querySelectorAll('.sub-pill').forEach(x=>x.classList.toggle('active', x.dataset.sub===setupSub));
    wrap.querySelectorAll('.sub-pane').forEach(x=>{ x.style.display = x.dataset.sub===setupSub ? '' : 'none'; });
  }));
  if(setupSub!=='skills'){
    const b=wrap.querySelector('.sub-pill[data-sub="'+setupSub+'"]');
    if(b) b.click();
  }
  renderSkillButtons();
  renderMcpBox();

  refreshTasks(p.path);
  taskTimer = setInterval(()=>{ if(selected) refreshTasks(selected); }, 4000);
}

let PICKER_OK = true;
let SKILLS = [];
async function loadSkillsList(){
  try{ SKILLS = (await (await fetch('/api/skills')).json()).skills || []; }catch{ SKILLS = []; }
  renderSkillButtons();
  renderMcpBox();
}
// Skills grouped by WHEN you reach for them, not alphabetically. Eleven flat buttons is a
// list to read; four small groups is a decision you can make at a glance.
const SKILL_GROUPS = [
  { title:'Understand what exists', tone:'api',
    hint:'Build a model of the product from the real code, then read it instead of the repo.',
    items:{ 'gitmir-model':'schema', 'model-ingest':'layers', 'model-navigate':'compass' } },
  { title:'Decide what to build', tone:'event',
    hint:'Turn raw input into something precise enough to build from, before any code.',
    items:{ 'product-docs-spec':'table', 'context-distillation':'filter' } },
  { title:'Build and prove it', tone:'module',
    hint:'Plan with checks, run the queue, audit the result, keep the record.',
    items:{ 'task-planner':'list', 'task-runner':'play', 'app-audit':'shield',
            'spec-audit':'scales', 'task-log':'check' } },
  { title:'Work on code you inherited', tone:'server',
    hint:'Change an old system without breaking it, or move it to a new stack at parity.',
    items:{ 'legacy-maintenance':'branch', 'stack-port':'external' } },
];

// Which skill this project actually needs next, from /api/overview. Twelve cards
// shown at once is an inventory; a person needs the one that fits where they are.
let nextStep = null, nextStepFor = null, showAllSkills = false;
async function loadNextStep(pathStr){
  if(nextStepFor===pathStr) return nextStep;
  try{
    const o=await fetch('/api/overview?path='+encodeURIComponent(pathStr)).then(r=>r.json());
    nextStep = o && o.ok ? o.next : null; nextStepFor = pathStr;
  }catch{ nextStep=null; }
  return nextStep;
}

// One card: what it is for, its name, and the copy it does when clicked.
function skillCard(s, why, eyebrow){
  const w=document.createElement('div'); w.className='sk-one';
  w.innerHTML='<div class="sk-next-h">'+esc(eyebrow)+'</div>'+
    '<div class="sk-next-w">'+esc(why||'')+'</div>'+
    '<button class="sk-next-b" type="button">'+
      '<span class="sk-next-t">'+esc(s.pain||s.title||s.name)+'</span>'+
      '<span class="sk-next-n">'+esc(s.name)+'</span>'+
      '<span class="sk-next-c">Copy it — then paste into Claude (⌘V + Enter)</span>'+
    '</button>';
  w.querySelector('.sk-next-b').addEventListener('click', ()=>copySkill(s.name, s.title||s.name));
  return w;
}

function renderSkillButtons(){
  const box = document.getElementById('skillsBtns');
  if(!box) return;
  box.innerHTML = '';
  if(!SKILLS.length){ box.innerHTML = '<div class="skills-empty">no skills in skills.json</div>'; return; }

  // Building the object context comes first and stays first. It is what every
  // other skill answers from, and it is re-run whenever the code moves — hiding
  // it behind a suggestion means the one thing somebody came here to do is the
  // one thing they cannot find. The derived next step sits under it, when it is
  // something else.
  const byNameAll = {}; for(const s of SKILLS) byNameAll[s.name]=s;
  const builder = byNameAll[(nextStep && nextStep.name==='model-ingest') ? 'model-ingest' : 'gitmir-model'];
  const step = nextStep && byNameAll[nextStep.name] ? byNameAll[nextStep.name] : null;
  const stepIsBuilder = !step || step.name===builder.name;

  if(builder && !showAllSkills){
    const w=document.createElement('div'); w.className='sk-next';
    w.appendChild(skillCard(builder,
      stepIsBuilder && nextStep ? nextStep.why
        : 'Reads this repository and writes what the product is into .gitmir/model/. Run it again whenever the code moves on.',
      'Start here'));
    if(!stepIsBuilder){
      w.appendChild(skillCard(step, nextStep.why, 'Then'));
    }
    const all=document.createElement('button'); all.className='sk-all'; all.type='button';
    all.textContent='All twelve skills →';
    all.addEventListener('click', ()=>{ showAllSkills=true; renderSkillButtons(); });
    w.appendChild(all);
    box.appendChild(w);
    return;
  }
  if(builder && showAllSkills){

    const back=document.createElement('button'); back.className='sk-all back'; back.type='button';
    back.textContent='← Just the next step';
    back.addEventListener('click', ()=>{ showAllSkills=false; renderSkillButtons(); });
    box.appendChild(back);
  }

  const byName = {};
  for(const s of SKILLS) byName[s.name] = s;
  const placed = {};
  const groups = SKILL_GROUPS.map(g => ({
    title: g.title, hint: g.hint, tone: g.tone,
    list: Object.keys(g.items).filter(n => byName[n]).map(n => { placed[n]=1; return [byName[n], g.items[n]]; }),
  })).filter(g => g.list.length);
  // A skill added to skills.json that this file has never heard of still shows up, rather
  // than silently vanishing because it is not in a group.
  const rest = SKILLS.filter(s => !placed[s.name]).map(s => [s, 'spark']);
  if(rest.length) groups.push({ title:'Other', hint:'', tone:'api', list:rest });

  for(const g of groups){
    const sec = document.createElement('div');
    sec.className = 'sk-group';
    sec.innerHTML =
      '<div class="sk-head"><span class="eyebrow">' + esc(g.title) + '</span><span class="hud-rule"></span></div>' +
      (g.hint ? '<div class="sk-hint">' + esc(g.hint) + '</div>' : '') +
      '<div class="sk-grid"></div>';
    const grid = sec.querySelector('.sk-grid');
    for(const [s, icon] of g.list){
      const it = document.createElement('button');
      it.className = 'sk-tile'; it.type = 'button';
      it.title = 'Copy ' + (s.title || s.name) + ' — paste into Claude';
      it.style.setProperty('--tone', 'var(--c-' + (g.tone || 'api') + ')');
      it.innerHTML =
        '<span class="sk-cover">' +
          '<span class="sk-gridfx" aria-hidden="true"></span>' +
          '<span class="sk-art">' + svgIcon(icon, 46) + '</span>' +
          '<span class="sk-go">' + svgIcon('copy', 15) + '</span>' +
        '</span>' +
        '<span class="sk-body">' +
          // The pain first, in the words someone arrives with. The name means
          // nothing until you know which problem it is for, and the description
          // is mechanics — useful once you have decided to read on.
          (s.pain ? '<span class="sk-pain">' + esc(s.pain) + '</span>' : '') +
          '<span class="sk-name">' + esc(s.title || s.name) + '</span>' +
          (s.desc ? '<span class="sk-desc">' + esc(s.desc) + '</span>' : '') +
        '</span>';
      it.addEventListener('click', async () => {
        it.classList.add('done');
        setTimeout(() => it.classList.remove('done'), 1400);
        await copySkill(s.name, s.title || s.name);
      });
      grid.appendChild(it);
    }
    box.appendChild(sec);
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
// ---- what every view has to say about itself --------------------------------
// A diagram nobody can name is a shop window. Each view states three things in
// the same place, in the same order: what it is, what it lets you decide, and
// how to work it. Written once here so no view can quietly ship without them.
const VIEW_HEAD = {
  map:        ['The product as its parts',
               'Start any conversation here: what the product is made of, and what crosses between the parts.',
               'Hover a card for its controls. OPEN goes inside an area, CONTEXT gives you its context and a task.'],
  journeys:   ['One path a person walks',
               'What a user actually does, step by step, and what runs under each step. Breaking one of these is what someone notices.',
               'Pick a journey above. Each step names the screen, endpoint or function behind it.'],
  er:         ['Business objects and what links them',
               'The nouns your product is about, and which of them reference which. Where a change to one object lands.',
               'Click an object for its fields, who writes it and who reads it.'],
  flow:       ['Where data moves between areas',
               'Which area sends data to which, and what moves — an object written, an event raised, an endpoint answered.',
               'Open an area to see the chain it runs: screen, endpoint, function, object.'],
  events:     ['What raises a signal and what reacts',
               'The places where one part of the product sets another in motion without calling it directly. The links that surprise people.',
               'Click an event to see everything that raises it and everything that handles it.'],
  logic:      ['When an object changes state',
               'The rules the product enforces on one object over its life, and what fires on each transition.',
               'Pick an object above. Open a transition to see the effects it triggers.'],
  decisions:  ['Every branch and the condition on it',
               'The points where the product decides, written as the condition it actually checks. Where a policy lives.',
               'Pick a lifecycle. Each branch shows its condition and who may take it.'],
  impact:     ['What a planned change reaches',
               'Before anyone writes code: what a task touches, how much of the product that is, and whether anything sensitive is in reach.',
               'Pick a task, or estimate a change by hand. Every number shows the arithmetic under it.'],
  ownership:  ['Who answers for each part',
               'The team to route work to, the person to ask before changing it, and the parts nobody has claimed.',
               'Owners come from the model. A blank owner is a finding, not a formatting problem.'],
  confidence: ['Where this model is guessing',
               'Which parts of every other view to trust, and which to doubt. Read it before quoting a number.',
               'Each gap is work: something the model does not know about your product yet.'],
  mismatch:   ['What was approved against what was done',
               'Whether finished work stayed inside the scope it declared. Work outside that scope is the thing worth catching.',
               'Click any object to open it. "Touched, never declared" is where to look first.'],
  spec:       ['Where the code does not do what the product says',
               'Every known deviation between the written rules and the running code, on the objects it sits on — so a change that touches one cannot be planned in ignorance of it.',
               'Accepting one records who decided and why. That is the difference between a product with known limits and a product with surprises.'],
  changed:    ['How the product changed between two dates',
               'What the product gained, lost and renamed over a period — read from the versions of the model your repository already has.',
               'Pick two versions. Anything under "no longer in the model" is either finished work or a rebuild that lost its grip.'],
  timeline:   ['The product changing, in order',
               'What has been done and when, with what each piece of work touched.',
               'Click a chip to open that object and see everything else that has touched it.'],
  overview:   ['The model at a glance',
               'How much of the product is recorded, dimension by dimension.',
               'Thin numbers here mean the model has not learned that part yet.'],
};
function viewHead(key){
  const h=VIEW_HEAD[key]; if(!h) return '';
  return '<div class="vhead">'+
    '<div class="vh-t">'+esc(h[0])+'</div>'+
    '<div class="vh-g"><span>What it gives you</span>'+esc(h[1])+'</div>'+
    '<div class="vh-h"><span>How to use it</span>'+esc(h[2])+'</div>'+
  '</div>';
}

// One subject at a time. Twelve journeys stacked down a 17,000-pixel page is a
// shop window: nothing can be compared, nothing can be found, and twelve canvases
// animate at once. Pick one.
function subjectPicker(items, currentId, onPick){
  const box=document.createElement('div'); box.className='ent-picker';
  for(const it of items){
    const b=document.createElement('button');
    b.className='epill'+(it.id===currentId?' active':'');
    b.textContent=it.label; if(it.title) b.title=it.title;
    b.addEventListener('click', ()=>onPick(it.id));
    box.appendChild(b);
  }
  return box;
}

let modelData = null;
// Where the code does not do what the product says. Held next to the model rather
// than inside it: the model is rebuilt from code and would throw these away.
let findingsData = { findings: [], summary: null };
async function loadFindings(pathStr){
  if(!pathStr){ findingsData={findings:[],summary:null}; if(window.hudSetFindings) window.hudSetFindings([]); return; }
  try{
    const r=await fetch('/api/findings?path='+encodeURIComponent(pathStr));
    findingsData=await r.json();
  }catch{ findingsData={findings:[],summary:null}; }
  if(!Array.isArray(findingsData.findings)) findingsData.findings=[];
  // Every diagram reads the same registry, so a mark cannot appear on one and not another.
  if(window.hudSetFindings) window.hudSetFindings(findingsData.findings);
}
const findingsOnId = (id)=> (findingsData.findings||[]).filter(f=>(f.touches||[]).includes(id));
let modelFor=null;   // which project modelData belongs to
let modelView = 'map';
let journeyPick = null;   // one journey on screen at a time, not all twelve
let decisionPick = null;
// Every view switch bumps this. Laying a diagram out is async, so without it a slow
// view keeps appending into the pane after someone has already moved to another one —
// which reads as "the new view is broken" when it was overwritten a second later.
let modelViewSeq = 0;
// A render started by the view dispatcher carries its generation and is cancelled when
// the view moves on. A render triggered by an action inside the view — approving a task,
// removing a what-if chip — carries none, and must not be mistaken for a stale one.
const viewAlive = (s) => s == null || s === modelViewSeq;
let logicEntityId = null;
let modelSrc = null;   // null = this project's own model; otherwise a teammate's name
let mermaidReady = null;
// Six questions, in the order someone asks them. Ten pills in a row is a list of
// features; these are the things an enterprise reader actually arrives wanting to
// settle, and the views underneath each one are how it gets settled.
const MODEL_GROUPS = [
  { key:'what',  label:'What it does',        hint:'The product in the words of the business, and what moves between its parts.',
    views:[{key:'map',label:'Product map'},{key:'journeys',label:'Journeys'},{key:'er',label:'Data'},{key:'flow',label:'Data flow'},{key:'events',label:'Events'}] },
  { key:'why',   label:'Why it works this way', hint:'The rules the product enforces, and the conditions behind each branch.',
    views:[{key:'logic',label:'Lifecycles'},{key:'decisions',label:'Decisions'}] },
  { key:'cost',  label:'What a change costs',  hint:'What a planned change reaches, and how much of the product that is.',
    views:[{key:'impact',label:'Impact'}] },
  { key:'who',   label:'Who answers for it',   hint:'Owning teams, who may change what, and the parts nobody has claimed.',
    views:[{key:'ownership',label:'Ownership'}] },
  { key:'trust', label:'How much to trust it', hint:'Where each answer came from, and which parts of the model to doubt.',
    views:[{key:'confidence',label:'Confidence'}] },
  { key:'done',  label:'What actually happened', hint:'The product changing, in the order it changed.',
    views:[{key:'spec',label:'Spec vs code'},{key:'changed',label:'What changed'},{key:'mismatch',label:'Intended vs done'},{key:'timeline',label:'Timeline'},{key:'overview',label:'Overview'}] },
];
// The words the product is described in. One list, because the same dimension
// under two names in two tabs reads as two different things.
const DIM_LABEL = { modules:'Areas', entities:'Business objects', serverUnits:'Server units',
  serverFunctions:'Functions', apiRoutes:'Endpoints', frontendUnits:'Screens', events:'Events',
  processes:'Journeys', statusFlows:'Lifecycles', reactions:'Reactions' };
const DIM_ORDER = Object.keys(DIM_LABEL);
// The singular of each, for labelling one object rather than a group of them.
const DIM_ONE = { modules:'area', entities:'object', serverUnits:'unit', serverFunctions:'function',
  apiRoutes:'endpoint', frontendUnits:'screen', events:'event', processes:'journey',
  statusFlows:'lifecycle', reactions:'reaction' };
const MODEL_VIEWS = MODEL_GROUPS.flatMap(g=>g.views);
const groupOfView = (k)=> (MODEL_GROUPS.find(g=>g.views.some(v=>v.key===k))||MODEL_GROUPS[0]).key;
// Layers paint the product map with something other than its own structure: how much
// each area has been changing, what a change there would cost, who to ask first.
const MAP_LAYERS = [
  {key:'none',  label:'Structure', hint:'The product as it is wired.'},
  {key:'heat',  label:'Heat',      hint:'How often work has touched each area.'},
  {key:'risk',  label:'Risk',      hint:'What a change in each area would reach.'},
  {key:'owner', label:'Ownership', hint:'Who is accountable for each area.'},
  {key:'change',label:'This change', hint:'Where the task picked in Impact lands.'},
];
let mapLayer='none';
const EFF_RU={create:'create',update:'update',recalculate:'recalculate',sync:'sync',notify:'notify',link:'link',delete:'delete'};


// holo style (as in your IDE): accent color per node type, glyphs, dark-navy bg + grid
function trunc(s,n){ s=String(s==null?'':s); return s.length>n ? s.slice(0,n-1)+'…' : s; }

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

// Text must be clipped to the CARD's pixel width, not to a fixed character count —
// a 32-char description in 11px mono is ~211px and spilled far outside a 168px node.
// Advance widths: JetBrains Mono 11px is monospace at 0.6em = 6.6px; Onest 600 13px is
// proportional, ~7.3px on average (rounded up so wide glyphs still fit).
const CW_NAME = 7.3, CW_MONO = 6.6;
const SUB_LH = 15;                 // line height of a description line
function fitPx(s, px, cw){
  const max = Math.floor(px / cw);
  if (max < 2) return '';
  return trunc(s, max);
}
// Wrap a description across as many lines as it needs, so nothing is lost to an
// ellipsis. Words that are longer than a line (a long id, a path) are hard-split.
function wrapPx(s, px, cw){
  const max = Math.max(6, Math.floor(px / cw));
  // NOTE: this whole script is emitted from a template literal, so the backslash
  // must be doubled here — a bare \s would reach the browser as /s+/ and split
  // the text on the letter "s" ("workspace" -> "work pace").
  const words = String(s == null ? '' : s).trim().split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  const pushLong = (w) => { let r = w; while (r.length > max) { lines.push(r.slice(0, max)); r = r.slice(max); } return r; };
  for (const w of words) {
    if (!cur) { cur = w.length > max ? pushLong(w) : w; continue; }
    if ((cur + ' ' + w).length <= max) { cur += ' ' + w; continue; }
    lines.push(cur);
    cur = w.length > max ? pushLong(w) : w;
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [];
}
// Card height for a node that shows a title plus N description lines.
const subH = (n) => 50 + Math.max(0, n - 1) * SUB_LH;


// ---- MCP: what it is, and the exact line that connects it -------------------
// The command carries this install's own path and the selected project's path,
// because the two things people get wrong are where mcp.ts lives and which
// folder they are asking about.
function renderMcpBox(){
  const box=document.getElementById('mcpBox'); if(!box) return;
  const home=window.__GITMIR_HOME__||'/path/to/gitmir-local';
  const proj=selected||'/path/to/your/project';
  const q=s=>'"'+String(s).replace(/"/g,'\\"')+'"';
  // `claude mcp add` defaults to local scope — the registration lives in the folder
  // the command was run from. Somebody who runs it once and then opens their editor
  // in a project finds nothing and concludes it did not work. -s user covers every
  // project; the server answers about whichever one the editor was opened in.
  // Show the command that exists on THIS machine. `gitmir` arrives with the
  // installer, not with a clone, and printing it to somebody who cloned sends them
  // looking for something that is not there.
  const hasCli = !!window.__GITMIR_CLI__;
  const rawAdd='claude mcp add -s user gitmir -- node '+q(home+'/mcp.ts');
  const add = hasCli ? 'gitmir mcp add' : rawAdd;
  const addHere = hasCli ? 'gitmir mcp add-here'
    : 'claude mcp add -s project gitmir -- node '+q(home+'/mcp.ts');
  const check='cd '+q(home)+' && node mcp-check.ts '+q(proj)+' model';

  // Four steps, each answering the same three questions in the same order: what
  // you do, what it buys, and how you know it worked. The page before this put
  // that last one in grey small print at the bottom — which is where somebody
  // looks only after they have already decided the thing is broken.
  const step=(n, title, why, cmd, cmdNote, proof)=>
    '<div class="ms">'+
      '<div class="ms-n">'+n+'</div>'+
      '<div class="ms-b">'+
        '<div class="ms-t">'+title+'</div>'+
        '<div class="ms-w">'+why+'</div>'+
        (cmd? '<button class="ms-cmd" data-copy="'+esc(cmd)+'" title="Copy">'+
                '<span class="ms-cmd-c">'+esc(cmd)+'</span><span class="ms-cmd-a">Copy</span></button>'+
              (cmdNote? '<div class="ms-cmd-n">'+cmdNote+'</div>':'') : '')+
        // The proof line is a flex row of exactly two things: the label and the
        // sentence. Without the wrapper every <b> and <code> inside becomes a flex
        // item of its own and the gap prises the words apart.
        '<div class="ms-p"><span>You know it worked when</span><div>'+proof+'</div></div>'+
      '</div>'+
    '</div>';

  box.innerHTML=
    '<div class="mcp-lead">'+
      '<div class="mcp-lead-t">The same model, inside the editor you already work in</div>'+
      '<p>The dashboard is where <b>you</b> look at the object context. MCP is how <b>your agent</b> reads it '+
      'while it works — what an object is, what breaks if it changes, what a task would touch, where the code '+
      'already disagrees with the spec — instead of re-reading your repository at the start of every session.</p>'+
      '<p class="mcp-lead-n">It has no screen of its own and it moves nothing out of here. The diagrams, the change '+
      'radius and the record stay in this dashboard; MCP answers in text, to the agent, in your editor.</p>'+
    '</div>'+

    '<div class="mcp-steps">'+
    step(1,
      'Register this project with your agent',
      'One command, once. It writes a line into your Claude config and nothing else — no service, no port, no '+
      'account. Registered for every project: the server answers about whichever folder your editor is open in.',
      add,
      (hasCli
        ? 'To pin it to one repository instead — in a <code>.mcp.json</code> you commit, so teammates get it without '+
          'being told — run <b>'+esc(addHere)+'</b> in that folder.'
        : 'This is the long form because <b>gitmir</b> is not on your PATH — you are running a clone rather than an '+
          'install. <code>curl -fsSL https://ide.gitmir.com/install.sh | sh</code> gives you the short one. To pin it '+
          'to one repository instead, run <code>'+esc(addHere)+'</code> in that folder — <code>.mcp.json</code> is '+
          'committed, so teammates get it too.'),
      '<code>claude mcp list</code> shows <b>gitmir</b> as connected, from any directory.') +
    step(2,
      'Restart the editor',
      'An MCP client reads its config once, at startup. Skipping this is the most common reason people conclude the '+
      'connection failed — the command worked, the editor simply had not looked yet.',
      '', '',
      'Your agent lists tools whose names start with <b>gitmir_</b>.') +
    step(3,
      'Say: <i>set this project up with GitMir</i>',
      'All twelve procedures arrive with the server — as slash commands, and as tools the agent can call on its own. '+
      'Nothing is pasted. This one adds the folder to this dashboard, creates the task queue, and says what is still '+
      'missing, including the model if there is none yet.',
      '', '',
      'The project appears here with a queue, the agent reports what it did, and typing <b>/</b> lists the skills.') +
    step(4,
      'Ask it something only the model knows',
      '<i>What breaks if I change the order status?</i> The point is not that it answers — it is where the answer comes '+
      'from: the object context, walked from real links, with a line stating how fresh it is.',
      '', '',
      'The answer names objects and areas from your model, and opens with how fresh that model is.') +
    '</div>'+

    '<div class="mcp-card check">'+
      '<div class="mcp-card-t">Check it without an editor</div>'+
      '<p>An MCP server has no screen, which makes a broken setup hard to tell from a working one. This starts the '+
      'server exactly as your editor would, asks it one question, and prints the answer for a person.</p>'+
      '<button class="ms-cmd" data-copy="'+esc(check)+'" title="Copy"><span class="ms-cmd-c">'+esc(check)+
      '</span><span class="ms-cmd-a">Copy</span></button>'+
    '</div>'+

    '<div class="mcp-card warn">'+
      '<div class="mcp-card-t">If the answers are not what you expected</div>'+
      '<div class="mcp-q"><b>Everything comes back "there is no model here yet".</b> Not a broken connection — the '+
      'model is missing. Build it from the <b>Skills</b> page, or ask the agent to.</div>'+
      '<div class="mcp-q"><b>No gitmir_ tools are listed.</b> The editor has not re-read its config. Restart it, then '+
      'check <code>claude mcp list</code>.</div>'+
      '<div class="mcp-q"><b>It answers about the wrong project.</b> The <code>--project</code> in step 1 pins it; '+
      'without it the server answers about whatever directory the agent started in.</div>'+
    '</div>'+

    '<div class="mcp-foot">MCP changes who does the typing, not what gets done. All of it can be done by hand from the '+
    '<b>Skills</b> page — <b>gitmir-model</b> builds the context, <b>task-planner</b> writes work that carries its own '+
    'checks.</div>';

  box.querySelectorAll('[data-copy]').forEach(b=>b.addEventListener('click', async ()=>{
    try{ await copyToClipboard(b.dataset.copy); toast('Copied ✓  Paste it into a terminal'); }
    catch(e){ toast('Copy failed — select the line and press ⌘C', true); }
  }));
}

// ---- the HUD renderer, mounted into the same frame the other diagrams use ----
// Only one lives at a time: the canvas runs an animation loop, and a superseded
// view that keeps drawing is both a leak and a liar.
// A view may hold several diagrams at once — Journeys lists one per process — so
// this is a list, not a single handle. Keeping one killed every diagram but the last.
let hudLive=[];
function hudDrop(){ for(const h of hudLive.splice(0)){ try{h.destroy();}catch(e){} } window.__HUD_API__=null; }
function renderHud(container, scene, seq){
  // Deliberately does NOT drop the others: a view may mount several. Switching
  // views calls hudDrop(), and a canvas replaced inside its own container is
  // detached, which the engine notices and shuts itself down for.
  if(!scene || !scene.nodes || !scene.nodes.length){
    container.innerHTML='<div class="model-empty">Nothing to draw here yet.</div>'; return; }
  container.innerHTML=
    '<div class="dgm">'+
      '<div class="dgm-bar">'+
        '<button class="dgm-b" data-a="fit" title="Fit to view">Fit</button>'+
        '<button class="dgm-b" data-a="back" title="One level up (Esc)">Back</button>'+
        '<button class="dgm-b" data-a="labels" title="Edge labels (L)">Labels</button>'+
        '<button class="dgm-b" data-a="bloom" title="Glow (B)">Glow</button>'+
        '<span class="dgm-hint">hover a card for its OPEN and CONTEXT controls · Esc goes back · drag to pan · wheel to zoom</span>'+
        '<button class="dgm-b dgm-full" data-a="full" title="Fullscreen">⛶</button>'+
      '</div>'+
      '<div class="dgm-canvas hud-canvas"><canvas></canvas></div>'+
    '</div>';
  const cv=container.querySelector('canvas');
  let h;
  try{ h=window.HUD_MOUNT(cv, scene, { onDestroy:()=>{ hudLive=hudLive.filter(x=>x!==h); } }); }
  catch(e){ container.innerHTML='<div class="model-empty">Renderer failed: '+esc(e.message||e)+'</div>'; return; }
  hudLive.push(h);
  window.__HUD_API__=h;                 // the most recent one, for probing
  // A scene can ask to arrive already open — the radius view lands inside the
  // area holding the object it was taken from, so the answer is on screen.
  if(scene.autoOpen) setTimeout(()=>{ try{ h.open(scene.autoOpen); }catch(e){} }, 260);
  window.__HUD_ALL__=hudLive;           // all of them: a view may hold several
  container.querySelector('.dgm-bar').addEventListener('click',(ev)=>{
    const b=ev.target.closest('.dgm-b'); if(!b||!h) return;
    const a=b.dataset.a;
    if(a==='fit') h.fit();
    else if(a==='back') h.back();
    else if(a==='labels') h.flags.labels=!h.flags.labels;
    else if(a==='bloom') h.flags.bloom=!h.flags.bloom;
    // Native fullscreen rather than an overlay: the canvas is one element, and the
    // ResizeObserver already redraws it at whatever box it is given.
    else if(a==='full'){
      const frame=container.querySelector('.dgm');
      if(document.fullscreenElement) document.exitFullscreen();
      else if(frame && frame.requestFullscreen) frame.requestFullscreen();
    }
  });
  if(seq!=null && !viewAlive(seq)) hudDrop();
}


// Pan/zoom canvas like ide.gitmir.com's VisualBuilder: drag to pan, wheel zooms to
// the cursor, click (not drag) a node fires onNodeClick.

let modelReq = 0;
async function loadModel(pathStr){
  const view=document.getElementById('modelView'); if(!view) return;
  const req = ++modelReq, wantSrc = modelSrc;   // this call's identity
  view.innerHTML='<div class="model-empty">Loading model…</div>';
  const q='/api/model?path='+encodeURIComponent(pathStr)+(wantSrc?('&src='+encodeURIComponent(wantSrc)):'');
  let d; try{ d=await (await fetch(q)).json(); }
  catch{ if(req===modelReq) view.innerHTML='<div class="model-empty">Failed to load model.</div>'; return; }
  // Drop a superseded response: the user may have switched project OR source while
  // this was in flight, and a late answer must not overwrite the current model.
  if(req!==modelReq || selected!==pathStr || wantSrc!==modelSrc) return;
  // A teammate's snapshot can disappear (project rebound, folder cleaned) — fall
  // back to our own model rather than showing an empty pane for a missing source.
  if(modelSrc && !(d.shared||[]).some(s=>s.name===modelSrc)){ modelSrc=null; return loadModel(pathStr); }
  modelData=d; modelFor=pathStr;
  // A shared model is somebody else's snapshot; their findings are about their
  // copy of the code and would be claims about a repository we cannot see.
  await loadFindings(modelSrc ? null : pathStr);
  renderModelSrc(d);
  renderModelStale(d);
  renderIngest(d);   // after stale: a running ingest owns the tab badge
  const upd=document.getElementById('modelUpd');
  if(upd) upd.textContent = (d.index && d.index.at) ? ('updated '+fmtTime(d.index.at)) : '';
  const nav=document.getElementById('modelNav');
  if(!d.exists){
    if(nav) nav.innerHTML='';
    const shared=(d.shared||[]).map(s=>s.name);
    const ing=d.ingest&&d.ingest.counts;
    view.innerHTML = modelSrc
      ? '<div class="model-empty"><b>'+esc(modelSrc)+' has not shared a model yet.</b><br>Their snapshot arrives when they press <b>⇪ Share model</b> in their own dashboard — it lands in <code>.gitmir/shared/'+esc(modelSrc)+'/model/</code> on this machine.</div>'
      // An ingest is under way: the model is empty because the first fragments have not
      // landed, not because nobody started. Saying "run gitmir-model" here would be wrong.
      : ing && ing.done < ing.total
      ? '<div class="model-empty"><b>The ingest has not written anything yet.</b><br>'+
        ing.total+' fragments are planned and '+ing.done+' are done — diagrams appear here as soon as the first fragment lands entities in <code>.gitmir/model/</code>. Progress is above; the fragments themselves are tasks in the <b>Queue</b> tab.</div>'
      : '<div class="model-empty"><b>This project has no model of its own yet.</b><br>'+
        (shared.length
          ? 'Switch to <b>⇪ '+esc(shared[0])+'</b> above to explore the model your teammate shared — it is on this machine, under <code>.gitmir/shared/</code>.'
          : 'In the <b>Settings</b> tab click <b>📋 gitmir-model</b>, paste into claude (⌘V + Enter) — it will build <code>.gitmir/model/</code>, and diagrams of data, processes and flows will appear here.')+'</div>';
    return;
  }
  renderModelNav(); renderModelView();
}

// A model older than the code is the one failure mode that makes the whole thing
// untrustworthy, so it is stated at the top of the view, not hidden in a corner.
function renderModelStale(d){
  const box=document.getElementById('modelStale'); if(!box) return;
  const t=d.stale;
  const badge=document.getElementById('modelBadge');
  if(!t || !t.is || modelSrc){
    box.innerHTML=''; box.style.display='none';
    if(badge){ badge.textContent=''; badge.className='badge'; }
    return;
  }
  box.style.display='block';
  box.innerHTML='<div class="stale-hd">⚠ This model is older than the code</div>'+
    '<div class="stale-b">'+t.changed+' file'+(t.changed>1?'s':'')+' changed since it was built'+
      (t.newestFile?' — most recently <code>'+esc(t.newestFile)+'</code>':'')+
      '. Everything below still describes the product as it was on '+esc(fmtTime(new Date(t.modelAt).toISOString()))+'.</div>'+
    '<button class="run stale-fix">📋 Copy gitmir-model — paste into Claude to refresh</button>';
  box.querySelector('.stale-fix').addEventListener('click', ()=>copySkill('gitmir-model','gitmir-model'));
  if(badge){ badge.textContent='!'; badge.className='badge stale'; }
}

// Thousands separator without a regex: in this file every backslash escape inside the
// client script is collapsed by the template literal, so \d and \B are not safe here.
function ingNum(n){
  n = Math.round(Number(n)||0);
  const s = String(n); let out = '', c = 0;
  for(let i=s.length-1; i>=0; i--){ out = s[i]+out; if(++c%3===0 && i>0) out = ' '+out; }
  return out;
}
let ingSel = null;   // which fragment cell is expanded
// Ingesting a big source is dozens of tasks over several sessions. Shown as a queue it is
// opaque; shown as a tape it is one glance — how far along, what is blocked, and what the
// model still cannot resolve. The last of those is the honest part and it stays visible.
function renderIngest(d){
  const box=document.getElementById('ingestBox'); if(!box) return;
  const g=d.ingest;
  if(!g || !g.counts || !g.counts.total || modelSrc){ box.innerHTML=''; box.style.display='none'; return; }
  const c=g.counts, total=c.total, done=c.done||0, blocked=c.blocked||0, skipped=c.skipped||0;
  const openRefs=(g.unresolved&&g.unresolved.open)||0;
  const pct = total ? Math.round(done*100/total) : 0;
  const running = done+blocked+skipped < total;
  const finished = !running && !blocked;
  box.style.display='block';
  box.className = 'ingest' + (finished && !openRefs ? ' ing-done' : '');

  // Finished cleanly: one quiet line. It stays because how a model was built is
  // provenance — worth knowing when you later wonder how complete it is.
  if(finished && !openRefs){
    box.innerHTML='<div class="ing-hd"><span class="ing-t">Model ingest</span>'+
      '<span class="ing-n">complete</span></div>'+
      '<div class="ing-meta">Built from '+ingNum(total)+' fragments'+
      (g.linesTotal?(' covering '+ingNum(g.linesTotal)+' lines'):'')+
      ', every reference resolved.'+(g.source?(' Source: <code>'+esc(g.source)+'</code>'):'')+'</div>';
    return;
  }

  let head = running ? (ingNum(done)+' of '+ingNum(total)+' fragments') : (ingNum(total)+' fragments read');
  let html='<div class="ing-hd"><span class="ing-t">Model ingest</span>'+
    '<span class="ing-n">'+head+'</span><span class="ing-pct">'+pct+'%</span></div>'+
    '<div class="ing-bar"><i style="width:'+pct+'%"></i></div>';

  html+='<div class="ing-tape">';
  for(const f of (g.fragments||[])){
    const t = '#'+f.n+(f.id?(' '+f.id):'')+' — '+f.status+
      (f.lines?(', '+ingNum(f.lines)+' lines'):'')+(f.files?(', '+f.files+' files'):'');
    html+='<i class="ic '+f.status+(ingSel===f.n?' sel':'')+'" data-frag="'+f.n+'" title="'+esc(t)+'"></i>';
  }
  html+='</div>';

  html+='<div class="ing-frag" id="ingFrag"></div>';

  const bits=[];
  if(g.linesTotal) bits.push(ingNum(g.linesDone)+' of '+ingNum(g.linesTotal)+' lines read');
  if(blocked) bits.push('<b style="color:#ff5c6e">'+blocked+' blocked</b>');
  if(skipped) bits.push(skipped+' skipped');
  if(g.kind) bits.push('kind: '+esc(g.kind));
  html+='<div class="ing-meta">'+bits.join(' · ')+
    (g.source?('<br>Reading <code>'+esc(g.source)+'</code>'):'')+'</div>';

  const dims=Object.keys(g.added||{});
  if(dims.length){
    html+='<div class="ing-grew">';
    for(const k of dims) html+='<span>'+esc(k)+' <b>'+ingNum(g.added[k])+'</b></span>';
    html+='</div>';
  }

  if(openRefs){
    html+='<details class="ing-un"><summary>'+ingNum(openRefs)+' reference'+(openRefs>1?'s':'')+
      ' seen but not yet resolvable — recorded, not invented</summary>'+
      '<table><tbody>';
    for(const u of (g.unresolved.items||[])){
      html+='<tr><td class="w">'+esc(u.from||'?')+(u.field?(' <span style="color:var(--dim2)">'+esc(u.field)+'</span>'):'')+
        '</td><td class="w">→ '+esc(u.wanted||'?')+'</td><td class="e">'+esc(u.evidence||'')+'</td></tr>';
    }
    html+='</tbody></table>';
    if(openRefs>(g.unresolved.items||[]).length)
      html+='<div class="ing-note">Showing '+(g.unresolved.items||[]).length+' of '+ingNum(openRefs)+
        ' — the rest are in <code>.gitmir/ingest/unresolved.json</code>.</div>';
    html+='<div class="ing-note">Each is a link a fragment saw before its target existed. Later fragments '+
      'resolve what they can and the final stitch pass closes the rest. Whatever stays here is a known gap, '+
      'which is the point: an invented link would look exactly like a real one.</div>';
    html+='</details>';
  }

  // Both notes can apply at once — a blocked fragment does not stop the run, so saying
  // only one of the two would drop the half the user needs.
  if(blocked) html+='<div class="ing-note">A blocked fragment failed three times and was left alone so the '+
    'rest could continue — click its red cell for the reason.</div>';
  if(running) html+='<div class="ing-note">Each fragment is a task in the <b>Queue</b>, run with a fresh '+
    'context holding only its own slice. Progress lives in <code>.gitmir/ingest/ledger.json</code>, so a '+
    'session that ends halfway continues rather than restarts.</div>';

  box.innerHTML=html;

  const tape=box.querySelector('.ing-tape');
  if(tape) tape.addEventListener('click', (e)=>{
    const cell=e.target.closest('.ic'); if(!cell) return;
    const n=Number(cell.dataset.frag);
    ingSel = (ingSel===n) ? null : n;
    box.querySelectorAll('.ic').forEach(x=> x.classList.toggle('sel', Number(x.dataset.frag)===ingSel));
    paintIngFrag(g);
  });
  paintIngFrag(g);

  // While an ingest is running that is the most useful thing the tab can say.
  const badge=document.getElementById('modelBadge');
  if(badge && running){ badge.textContent = done+'/'+total; badge.className='badge'; }
}
function paintIngFrag(g){
  const el=document.getElementById('ingFrag'); if(!el) return;
  const f=(g.fragments||[]).find(x=>x.n===ingSel);
  if(!f){ el.style.display='none'; el.innerHTML=''; return; }
  el.style.display='block';
  let h='<div class="fh">#'+f.n+(f.id?(' · '+esc(f.id)):'')+' — '+esc(f.status)+'</div>';
  if(f.owns&&f.owns.length) h+='<div>owns <code>'+f.owns.map(esc).join('</code>, <code>')+'</code>'+
    (f.files||f.lines?(' &nbsp;('+(f.files?f.files+' files':'')+(f.files&&f.lines?', ':'')+(f.lines?ingNum(f.lines)+' lines':'')+')'):'')+'</div>';
  if(f.dimensions&&f.dimensions.length) h+='<div>fills '+f.dimensions.map(esc).join(' · ')+'</div>';
  if(f.added){
    const parts=Object.keys(f.added).map(k=>esc(k)+' '+esc(String(f.added[k])));
    if(parts.length) h+='<div>added '+parts.join(' · ')+'</div>';
  }
  if(f.note) h+='<div style="color:#ffb86b">'+esc(f.note)+'</div>';
  el.innerHTML=h;
}

// Source switcher: our own model, plus any teammate model the bridge delivered.
function renderModelSrc(d){
  const box=document.getElementById('modelSrc'); if(!box) return;
  const shared=d.shared||[];
  if(!shared.length){ box.innerHTML=''; box.style.display='none'; return; }
  box.style.display='flex';
  let html='<span class="msrc-l">model:</span>'+
    '<button class="msrc'+(modelSrc?'':' active')+'" data-src="">mine</button>';
  for(const s of shared) html+='<button class="msrc'+(modelSrc===s.name?' active':'')+'" data-src="'+esc(s.name)+'" title="shared by '+esc(s.label||s.name)+' via the team bridge">⇪ '+esc(s.label||s.name)+'</button>';
  // A shared model is a point-in-time copy, not a live view — say so, and when it arrived.
  const cur = modelSrc && shared.find(s=>s.name===modelSrc);
  if(cur) html+='<span class="msrc-note">snapshot received '+esc(cur.receivedAt?fmtTime(cur.receivedAt):fmtTime(new Date(cur.at).toISOString()))+' — a copy on this machine, not live</span>';
  box.innerHTML=html;
  box.querySelectorAll('.msrc').forEach(b=> b.addEventListener('click', ()=>{
    const v=b.dataset.src||null;
    if(v===modelSrc) return;
    modelSrc=v; logicEntityId=null;   // entity picker belongs to the old model
    if(selected) loadModel(selected);
  }));
}

function renderModelNav(){
  const nav=document.getElementById('modelNav'); if(!nav) return;
  const g=groupOfView(modelView);
  const grp=MODEL_GROUPS.find(x=>x.key===g)||MODEL_GROUPS[0];
  nav.innerHTML='';
  const top=document.createElement('div'); top.className='mgroups';
  for(const x of MODEL_GROUPS){
    const b=document.createElement('button');
    b.className='mgroup'+(x.key===g?' active':''); b.textContent=x.label; b.title=x.hint;
    b.addEventListener('click', ()=>{ modelView=x.views[0].key; renderModelNav(); renderModelView(); });
    top.appendChild(b);
  }
  nav.appendChild(top);
  const hint=document.createElement('div'); hint.className='mghint'; hint.textContent=grp.hint;
  nav.appendChild(hint);
  // One view in a group needs no tab bar — a single tab is a label pretending to be a choice.
  if(grp.views.length>1){
    const row=document.createElement('div'); row.className='mtabs';
    for(const v of grp.views){
      const b=document.createElement('button');
      b.className='mpill'+(modelView===v.key?' active':''); b.textContent=v.label;
      b.addEventListener('click', ()=>{ modelView=v.key; renderModelNav(); renderModelView(); });
      row.appendChild(b);
    }
    nav.appendChild(row);
  }
}

// ---- Ownership: who answers for each part, and what nobody has claimed --------
// Every fact here is already in the model and none of it was ever on screen: the
// owner of an area, who may perform a transition, which role holds a state. The
// blanks are the point — an area with no owner is the most expensive thing in an
// enterprise codebase, and it currently looks exactly like every other area.
function renderOwnership(view, m, seq){
  const mods=m.modules||[];
  if(!mods.length){ view.innerHTML='<div class="model-empty">No areas in the model.</div>'; return; }
  const owned=mods.filter(x=>x.owner), orphan=mods.filter(x=>!x.owner);
  const count=(id)=>['entities','serverFunctions','apiRoutes','frontendUnits','events','statusFlows']
    .reduce((n,k)=>n+(m[k]||[]).filter(o=>moduleOf(o.id,m)===id).length,0);
  let h=viewHead('ownership')+'<div class="map-cap">'+
    '<span class="map-cap2">Owners are read from the model. The model reads them from CODEOWNERS, a team table, or an <code>@owner</code> tag; '+
    'where none of those exist the area comes back blank, and a blank owner is not a small thing.</span></div>';
  if(orphan.length){
    h+='<div class="own-warn"><b>'+orphan.length+' of '+mods.length+' areas have no owner recorded.</b> '+
      'Nobody is named for '+orphan.reduce((n,x)=>n+count(x.id),0)+' objects. These are the parts where a question has nowhere to go.</div>';
  }
  h+='<div class="own-grid">';
  for(const x of owned.concat(orphan)){
    const roles=new Set();
    for(const fl of (m.statusFlows||[])) if(fl.moduleId===x.id||moduleOf(fl.id,m)===x.id){
      for(const tr of (fl.transitions||[])) if(tr.byRole) roles.add(tr.byRole);
      for(const st of (fl.states||[])) if(st.ownerRole) roles.add(st.ownerRole);
    }
    h+='<div class="own-card'+(x.owner?'':' none')+'">'+
      '<div class="own-area">'+esc(x.name||x.id)+'</div>'+
      '<div class="own-row"><span>Team</span><b>'+(x.owner?esc(x.owner):'— not recorded —')+'</b></div>'+
      '<div class="own-row"><span>Objects</span><b>'+count(x.id)+'</b></div>'+
      (roles.size?'<div class="own-row"><span>May change state</span><b>'+esc([...roles].join(' · '))+'</b></div>':'')+
      '</div>';
  }
  h+='</div>';
  if(seq!=null && !viewAlive(seq)) return;
  view.innerHTML=h;
}

// ---- Confidence: which parts of this answer to doubt --------------------------
// An enterprise will work with an imperfect model. It will not work with one that
// cannot say which parts are imperfect.
async function renderConfidence(view, m, seq){
  const dims=DIM_ORDER.filter(k=>k!=='serverUnits').map(k=>[k,DIM_LABEL[k]]);
  const ch=await loadChanges(false);
  const tasks=(ch&&ch.tasks)||[];
  const declared=tasks.filter(t=>t.declared).length;
  const gaps=[];
  const noDesc=[].concat(...dims.map(([k])=>(m[k]||[]).filter(o=>!o.description).map(o=>o.id)));
  const entNoFlow=(m.entities||[]).filter(e=>!(m.statusFlows||[]).some(f=>f.entityId===e.id));
  const rtNoFn=(m.apiRoutes||[]).filter(r=>!(m.serverFunctions||[]).some(f=>f.routeId===r.id));
  const noOwner=(m.modules||[]).filter(x=>!x.owner);
  if(noOwner.length) gaps.push([noOwner.length+' areas with no owner','Work and questions have nowhere to go']);
  if(rtNoFn.length) gaps.push([rtNoFn.length+' endpoints with no function behind them','Either dead, or the model missed the handler']);
  if(entNoFlow.length) gaps.push([entNoFlow.length+' objects with no lifecycle','Their state changes are invisible to impact and risk']);
  if(noDesc.length) gaps.push([noDesc.length+' objects with no description','A name alone does not survive being read by someone new']);
  if(tasks.length&&declared<tasks.length) gaps.push([(tasks.length-declared)+' of '+tasks.length+' tasks with inferred scope','Their risk was computed from mentions, not from a declared Touches: line']);

  let h=viewHead('confidence')+'<div class="map-cap">'+
    '<span class="map-cap2">Every object here was extracted from the code by the <b>gitmir-model</b> skill. Freshness is checked against the files on disk; '+
    'scope is marked declared or inferred per task. Everything else on this page is an absence — something the model does not know, stated as such.</span></div>';
  h+='<div class="own-grid">';
  for(const [k,label] of dims){ const n=(m[k]||[]).length; if(!n) continue;
    h+='<div class="own-card"><div class="own-area">'+esc(label)+'</div><div class="own-row"><span>Recorded</span><b>'+n+'</b></div></div>'; }
  h+='</div>';
  h+=gaps.length
    ? '<div class="own-warn"><b>What the model does not know</b></div><div class="conf-gaps">'+
      gaps.map(([what,why])=>'<div class="conf-gap"><b>'+esc(what)+'</b><span>'+esc(why)+'</span></div>').join('')+'</div>'
    : '<div class="own-warn">No gaps found by these checks. That is not the same as complete.</div>';
  if(seq!=null && !viewAlive(seq)) return;
  view.innerHTML=h;
}

// ---- Intended vs done: did the work stay inside what was approved -------------
// The task file says what it set out to change; the log says what it actually
// touched. Both were already being collected and nobody was putting them side by
// side — which is the difference between a diagram and change governance.
// One line in the project's record whenever somebody takes an answer from the
// model. Reaching for the model instead of the files is the thing being measured,
// and it is the same act whether an agent does it or a person does.
function recordAnswer(entry){
  if(!selected || modelSrc) return;              // a shared snapshot is not this project's record
  const m=modelData&&modelData.model;
  let ids=entry.ids||[];
  if(m && ids.length){
    try{ const br=blastRadius(ids.filter(id=>objById(id,m)), m); ids=[...new Set(ids.concat([...br.dist.keys()]))]; }catch{}
  }
  fetch('/api/usage',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({ path:selected, ...entry, ids })}).catch(()=>{});
}

// The first screen of a project: what the object context is, what it replaced,
// what it caught, and the one thing to do next.
//
// Everything here is measured. The product is sold on spending less — on agents
// answering from a model instead of crawling a repository, and on people
// deciding from evidence instead of instinct — and until this screen existed
// nothing in the product counted either. A tool that asks to be believed is in a
// weaker position than one that shows the number, especially in a room where
// somebody has to justify the spend.
const KB = (b) => b >= 1048576 ? (b/1048576).toFixed(1)+' MB' : Math.round((b||0)/1024)+' KB';
async function renderHome(pathStr){
  const view=document.getElementById('homeView'); if(!view) return;
  const p=byPath(pathStr)||{};
  view.innerHTML='<div class="model-empty">Reading the project…</div>';

  const o = await fetch('/api/overview?path='+encodeURIComponent(pathStr)).then(r=>r.json()).catch(()=>null);
  if(selected!==pathStr) return;
  if(!o || !o.ok){ view.innerHTML='<div class="model-empty">Could not read this project.</div>'; return; }

  const s=o.usage.summary, C=o.caught;
  const objects=Object.values(o.model.counts||{}).reduce((a,b)=>a+b,0);

  let h='<div class="hm">';
  h+='<div class="hm-top"><div class="hm-name">'+esc(p.name||pathStr.split('/').pop())+'</div>'+
     '<div class="hm-path">'+esc(pathStr)+'</div></div>';

  if(!o.exists){
    h+='<div class="hm-hero empty"><div class="hm-hero-h">No object context yet</div>'+
       '<p>GitMir reads this repository once and writes what the product is — areas, business objects, '+
       'functions, endpoints, screens, events, journeys, lifecycles — into <code>.gitmir/model/</code>, '+
       'linked by stable ids. After that both you and your agent answer from it instead of from the files.</p>'+
       '<div class="hm-next"><button class="run" data-go="build-model">▶ Build it with Claude</button>'+
       '<span>Runs the <b>'+esc(o.next.name)+'</b> skill in this folder. '+esc(o.next.why)+'</span></div></div></div>';
    view.innerHTML=h; wire(); return;
  }

  // --- what the context replaced -------------------------------------------
  h+='<div class="hm-hero">';
  if(s.answers){
    h+='<div class="hm-big">'+s.ratio.toFixed(1)+'×</div><div class="hm-big-l">less read to answer</div>'+
       '<p><b>'+s.answers+' answer'+(s.answers===1?'':'s')+'</b> served from the model, '+KB(s.served)+' in total. '+
       'The objects they covered live in <b>'+s.wouldFiles+' file'+(s.wouldFiles===1?'':'s')+'</b> — '+KB(s.wouldBytes)+
       ' of source. A fact about this repository, not a claim about what an agent would otherwise have done with it.</p>';
  } else {
    // The shorthand reads well and registers against whatever directory the agent
    // happens to be in. On a screen about one project that is the wrong command,
    // so this offers the explicit one — pinned to this folder — and it is a button
    // that copies it, not a box that looks like a button and does nothing.
    const q=s=>'"'+String(s).replace(/"/g,'\\"')+'"';
    const addCmd = window.__GITMIR_CLI__ ? 'gitmir mcp add'
      : 'claude mcp add -s user gitmir -- node '+q((window.__GITMIR_HOME__||'.')+'/mcp.ts');
    h+='<div class="hm-hero-h">The context is built. Nothing has asked it anything yet.</div>'+
       '<p>Point your agent at it and every answer it takes is counted here, against the size of the files '+
       'those objects live in.</p>'+
       '<button class="hm-cmd" data-copy="'+esc(addCmd)+'" title="Copy this command">'+
         '<span class="hm-cmd-c">'+esc(addCmd)+'</span><span class="hm-cmd-a">Copy</span></button>'+
       '<div class="hm-cmd-w">Once, in a terminal, for every project — then restart your editor, because a client '+
       'reads its MCP config only at startup. All twelve skills arrive with it. '+
       '<button class="hm-link" data-go="mcp">The rest of the steps →</button></div>';
  }
  h+='</div>';

  // --- what needs a person --------------------------------------------------
  if(o.attention && o.attention.length){
    h+='<div class="hm-sec">What needs you</div><div class="hm-att">';
    for(const a of o.attention){
      h+='<div class="hm-a '+esc(a.level)+'">'+
         '<div class="hm-a-t">'+esc(a.title)+'</div>'+
         '<div class="hm-a-w">'+esc(a.why)+'</div>'+
         '<button class="hm-a-b" data-go="'+esc(a.action.go)+'"'+(a.action.arg?' data-arg="'+esc(a.action.arg)+'"':'')+'>'+
         esc(a.action.label)+'</button></div>';
    }
    h+='</div>';
  } else {
    h+='<div class="hm-sec">What needs you</div>'+
       '<div class="hm-clear">Nothing. The model matches the code, every recorded deviation has been decided, '+
       'and no planned task reaches further than its ticket says.</div>';
  }

  // --- what it caught before anyone wrote code ------------------------------
  if(C && C.tasks){
    h+='<div class="hm-sec">Caught before the code was written</div><div class="hm-row">'+
       card('Tickets named', C.named+' objects', 'across '+C.tasks+' task'+(C.tasks===1?'':'s')+' that name part of the model', 'queue')+
       card('The model showed', C.reached+' of '+objects, 'what those tasks actually reach, walked from real links', 'impact')+
       card('Nobody had mentioned', C.unnamed+' of them', C.unnamed? 'found before anyone opened an editor' : 'the tickets named everything they touch', 'impact', C.unnamed?'warn':'')+
       (C.high? card('At high risk', C.high+' task'+(C.high===1?'':'s'), 'reaching a quarter of the product or more', 'impact', 'bad') : '')+
       '</div>';
  }

  // --- what you have --------------------------------------------------------
  h+='<div class="hm-sec">What you have</div><div class="hm-row">'+
     card('Object context', objects+' objects', countLinks(modelData&&modelData.model||{})+' relationships · '+KB(o.model.bytes), 'model')+
     card('Read from', o.source.files+' source files', KB(o.source.bytes)+' of code in this repository', null)+
     card('Freshness', o.stale?'Code has moved':'Matches the code',
          o.stale? esc(o.staleFile||'')+' changed since' : 'Nothing changed since the model was built', 'model', o.stale?'warn':'')+
     '</div>';

  // --- the record -----------------------------------------------------------
  if(o.usage.entries.length){
    h+='<div class="hm-sec">What was asked, and what it served</div><div class="hm-log">';
    for(const e of o.usage.entries){
      h+='<div class="hm-e"><span class="hm-e-w">'+esc(e.by||'agent')+'</span>'+
         '<span class="hm-e-q">'+esc(e.q||e.tool)+'</span>'+
         '<span class="hm-e-n">'+KB(e.served)+'</span>'+
         '<span class="hm-e-v">'+(e.wouldBytes? 'covered '+e.ids+' objects living in '+KB(e.wouldBytes) : e.ids+' objects')+'</span>'+
         '<span class="hm-e-t">'+esc(String(e.at||'').slice(0,16).replace('T',' '))+'</span></div>';
    }
    h+='</div><div class="hm-note">Kept in <code>.gitmir/usage.jsonl</code>, in this project. It is never sent anywhere — there is no GitMir telemetry, and this is the record that lets you check that claim rather than take it.</div>';
  }

  h+='</div>';
  view.innerHTML=h;
  wire();

  function wire(){
    view.querySelectorAll('[data-copy]').forEach(b=>b.addEventListener('click', async ()=>{
      try{ await copyToClipboard(b.dataset.copy); toast('Copied ✓  Paste it into a terminal'); }
      catch(e){ toast('Copy failed: '+(e.message||e), true); }
    }));
    view.querySelectorAll('[data-go]').forEach(b=>b.addEventListener('click',()=>{
      const g=b.dataset.go, arg=b.dataset.arg;
      if(g==='mcp'){ setTab('settings'); setupSub='mcp'; renderDetail(); return; }
      if(g==='build-model'||g==='skill'){ setTab('settings'); setupSub='skills'; renderDetail(); return; }
      if(g==='impact'){ setTab('model'); modelView='impact'; if(arg) impactPick=arg; renderModelNav(); renderModelView(); return; }
      if(g==='spec'||g==='ownership'||g==='model'){
        setTab('model');
        if(g!=='model') modelView=g;
        renderModelNav(); renderModelView(); return;
      }
      setTab(g);
    }));
  }
  function card(label, value, sub, go, tone){
    return '<div class="hm-card '+(tone||'')+'"'+(go?' data-go="'+go+'" role="button" tabindex="0"':'')+'>'+
      '<div class="hm-c-l">'+esc(label)+'</div><div class="hm-c-v">'+esc(value)+'</div>'+
      '<div class="hm-c-s">'+sub+'</div></div>';
  }
}

// Relationships, not nodes: the count that says what the model is actually for.
function countLinks(m){
  let n=0;
  for(const e of (m.entities||[])){ for(const f of (e.fields||[])) if(f&&f.refEntityId) n++; n+=(e.derivedFrom||[]).length; }
  for(const f of (m.serverFunctions||[])) n+=(f.callsFunctionIds||[]).length+(f.emitsEventIds||[]).length+
    (f.subscribesEventIds||[]).length+(f.writesFieldIds||[]).length+(f.readsFieldIds||[]).length+(f.routeId?1:0);
  for(const u of (m.frontendUnits||[])) n+=(u.consumesRouteIds||[]).length+(u.dependsOn||[]).length+
    (u.emitsEventIds||[]).length+(u.subscribesEventIds||[]).length;
  for(const p of (m.processes||[])) n+=(p.steps||[]).filter(s=>s&&s.refId).length;
  for(const fl of (m.statusFlows||[])){ n+=fl.entityId?1:0; for(const tr of (fl.transitions||[])) n+=(tr.effects||[]).length; }
  for(const r of (m.reactions||[])) n+=(r.effects||[]).length;
  return n;
}

// Where the code does not do what the product says it does.
//
// Kept out of the model on purpose: the model is derived from code and rebuilt
// whole, and these are judgements a person made about the gap between two
// sources. A rebuild would throw them away.
let specFilter = 'open';
async function renderSpec(view, m, seq){
  if(modelSrc){ view.innerHTML=viewHead('spec')+'<div class="model-empty">A shared model is a snapshot of someone else’s code. Findings are claims about a repository this machine cannot see.</div>'; return; }
  await loadFindings(selected);
  if(seq!=null && !viewAlive(seq)) return;
  const all=findingsData.findings||[];
  if(!all.length){
    view.innerHTML=viewHead('spec')+
      '<div class="model-empty">Nothing recorded yet.<br><br>'+
      'These are written by whoever reads the product’s rules against its code — usually your agent, with '+
      '<code>gitmir_flag</code>, at the moment it notices. Ask it to <b>check the spec against the code and flag what does not match</b>, '+
      'and what it finds lands here instead of scrolling out of a conversation.</div>';
    return;
  }
  const S=findingsData.summary||{};
  const counts={open:all.filter(f=>f.status==='open').length,
                accepted:all.filter(f=>f.status==='accepted').length,
                fixed:all.filter(f=>f.status==='fixed').length, all:all.length};
  if(!counts[specFilter]) specFilter = counts.open ? 'open' : 'all';

  let h=viewHead('spec');
  h+='<div class="sp-sum">'+
     '<div class="sp-k'+(counts.open?' bad':'')+'"><b>'+counts.open+'</b><span>open</span></div>'+
     '<div class="sp-k"><b>'+counts.accepted+'</b><span>accepted on purpose</span></div>'+
     '<div class="sp-k"><b>'+counts.fixed+'</b><span>fixed</span></div>'+
     (S.stale?'<div class="sp-k warn"><b>'+S.stale+'</b><span>need re-checking</span></div>':'')+
     '</div>';
  h+='<div class="ent-picker">'+
    [['open','Open'],['accepted','Accepted'],['fixed','Fixed'],['all','All']]
      .filter(([k])=>counts[k])
      .map(([k,l])=>'<button class="epill'+(specFilter===k?' on':'')+'" data-f="'+k+'">'+l+' <i>'+counts[k]+'</i></button>').join('')+
    '</div><div class="sp-list"></div>';
  view.innerHTML=h;
  view.querySelectorAll('.epill').forEach(b=>b.addEventListener('click',()=>{ specFilter=b.dataset.f; renderSpec(view,m,seq); }));

  const list=view.querySelector('.sp-list');
  const rows=(specFilter==='all'?all:all.filter(f=>f.status===specFilter))
    // Worst first, and inside a severity the ones that need re-checking first:
    // an unverified claim is the one most likely to be wasting somebody's time.
    .sort((a,b)=>({high:0,medium:1,low:2}[a.severity]-{high:0,medium:1,low:2}[b.severity]) || (b.stale?1:0)-(a.stale?1:0));
  for(const f of rows) list.appendChild(specCard(f, m, view, seq));
}

function specCard(f, m, view, seq){
  const el=document.createElement('div');
  el.className='sp-card '+f.status+(f.stale?' stale':'');
  const KIND={'contradicts-spec':'does something else','not-implemented':'does nothing','undefined':'the rules never said','risk':'works, will not survive production'};
  const chips=(f.touches||[]).map(id=>'<button class="mm-chip missed" data-id="'+esc(id)+'">'+
    esc(labelOf(id,m)||id)+'<i class="hs-kind">'+esc(DIM_ONE[({module:'modules',entity:'entities',function:'serverFunctions',route:'apiRoutes',frontend:'frontendUnits',event:'events',process:'processes',statusFlow:'statusFlows'})[kindOf(id)]]||kindOf(id)||'')+'</i></button>').join('');
  el.innerHTML=
    '<div class="sp-top"><span class="sp-sev '+esc(f.severity)+'">'+esc(f.severity)+'</span>'+
      '<span class="sp-kind">'+esc(KIND[f.kind]||f.kind)+'</span>'+
      (f.source?'<span class="sp-src">'+esc(f.source)+'</span>':'')+
      (f.status==='accepted'?'<span class="sp-badge acc">accepted</span>':'')+
      (f.status==='fixed'?'<span class="sp-badge fix">fixed</span>':'')+
      (f.stale?'<span class="sp-badge stale">re-check · '+esc(f.movedFile||'')+' changed</span>':'')+'</div>'+
    '<div class="sp-line"><span>Should</span><div>'+esc(f.rule)+'</div></div>'+
    '<div class="sp-line"><span>Does</span><div>'+esc(f.actual)+'</div></div>'+
    (f.consequence?'<div class="sp-line"><span>Costs</span><div>'+esc(f.consequence)+'</div></div>':'')+
    (chips?'<div class="sp-line"><span>On</span><div class="sp-chips">'+chips+'</div></div>':'')+
    (f.decision?'<div class="sp-dec"><b>'+esc(f.decision.by)+'</b> decided on '+esc(f.decision.at)+': '+esc(f.decision.why)+'</div>':'')+
    '<div class="sp-act"></div>';
  el.querySelectorAll('.mm-chip').forEach(b=>b.addEventListener('click',()=>{
    const id=b.dataset.id; if(kindOf(id)) openContextPopup(kindOf(id), id);
  }));
  const act=el.querySelector('.sp-act');
  const btn=(label,title,fn)=>{ const b=document.createElement('button'); b.className='sp-btn'; b.textContent=label; b.title=title||''; b.addEventListener('click',fn); act.appendChild(b); return b; };
  const move=async(status,decision)=>{
    const r=await fetch('/api/finding-status',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({path:selected,id:f.id,status,decision})}).then(x=>x.json()).catch(()=>null);
    if(!r||r.error){ act.insertAdjacentHTML('beforeend','<span class="sp-err">'+esc((r&&r.error)||'Could not save.')+'</span>'); return; }
    renderSpec(view, m, seq);
  };
  if(f.status!=='fixed') btn('Mark fixed','The code now does what the rule says',()=>move('fixed'));
  if(f.status==='open'){
    btn('Accept this gap','The product will keep behaving this way, on purpose',()=>{
      // A decision with nobody attached is one everybody forgot; the form asks for
      // both before it will record anything.
      act.innerHTML='<div class="sp-form">'+
        '<input class="sp-by" placeholder="Who decided">'+
        '<input class="sp-why" placeholder="Why this is acceptable">'+
        '<button class="sp-btn go">Record the decision</button>'+
        '<button class="sp-btn cancel">Cancel</button>'+
        '<div class="sp-err-slot"></div></div>';
      act.querySelector('.cancel').addEventListener('click',()=>renderSpec(view,m,seq));
      act.querySelector('.go').addEventListener('click',()=>{
        const by=act.querySelector('.sp-by').value.trim(), why=act.querySelector('.sp-why').value.trim();
        if(!by||!why){ act.querySelector('.sp-err-slot').innerHTML='<span class="sp-err">Both, or it is not a decision anybody can be asked about later.</span>'; return; }
        move('accepted',{by,why});
      });
    });
  }
  if(f.status!=='open') btn('Reopen','It is still wrong',()=>move('open'));
  return el;
}

// How the product changed between two versions of the model.
//
// The versions are the project's own git history of .gitmir/model — nothing is
// stored here for it. That is why this works on a repository that ran for a year
// before it ever saw this dashboard: the record was already being kept.
let histCache=null, histFrom=null, histTo=null;
async function renderChanged(view, m, seq){
  if(modelSrc){ view.innerHTML=viewHead('changed')+'<div class="model-empty">A shared model is one snapshot. Its history lives in the repository it came from.</div>'; return; }
  view.innerHTML=viewHead('changed')+'<div class="model-empty">Reading the versions…</div>';
  if(!histCache || histCache.path!==selected){
    const r=await fetch('/api/history?path='+encodeURIComponent(selected)).then(x=>x.json()).catch(()=>null);
    histCache = r ? {path:selected, ...r} : {path:selected, ok:false, why:'git-failed', versions:[]};
    histFrom=histTo=null;
  }
  if(seq!=null && !viewAlive(seq)) return;
  const H=histCache;
  if(!H.ok || H.versions.length<2){
    // Every reason is a different thing to go and do, so name the actual one.
    const why = H.why==='not-a-repo' ? 'This project is not in git, so there are no versions to compare. History comes from the repository, not from us.'
      : H.why==='ignored'            ? '<code>.gitmir/model</code> is in <code>.gitignore</code>. Commit the model and every rebuild becomes a version you can compare — that is the whole mechanism.'
      : H.versions.length===1        ? 'The model has been committed once. The second commit is what makes a comparison possible.'
      :                                'The model has never been committed. Commit <code>.gitmir/model</code> and each rebuild lands as a version, dated, next to the work that caused it.';
    view.innerHTML=viewHead('changed')+'<div class="model-empty">'+why+'</div>';
    return;
  }
  const vs=H.versions;
  if(!histTo || !vs.some(v=>v.sha===histTo)) histTo=vs[0].sha;
  // A month is the period people actually ask about, so open on it rather than on
  // two adjacent rebuilds, which usually differ by nothing worth reading.
  if(!histFrom || !vs.some(v=>v.sha===histFrom)){
    const cut=Date.parse(vs[0].date)-30*864e5;
    const older=vs.find(v=>Date.parse(v.date)<=cut);
    // A project whose whole history is shorter than the period gets all of it.
    // Landing on an arbitrary rebuild in the middle opens the view on "nothing
    // changed", which is true and useless.
    histFrom=(older||vs[vs.length-1]).sha;
  }
  const pick=(which)=>vs.map(v=>'<option value="'+esc(v.sha)+'"'+
      ((which==='from'?histFrom:histTo)===v.sha?' selected':'')+'>'+
      esc(v.date+'  ·  '+v.short+'  ·  '+(v.subject||'').slice(0,54))+'</option>').join('');
  let h=viewHead('changed')+
    '<div class="hs-bar"><label>From<select class="hs-sel" data-w="from">'+pick('from')+'</select></label>'+
    '<label>To<select class="hs-sel" data-w="to">'+pick('to')+'</select></label>'+
    '<span class="hs-n">'+vs.length+' versions of this model, from '+esc(vs[vs.length-1].date)+'</span></div>'+
    '<div class="hs-body"><div class="model-empty">Comparing…</div></div>';
  view.innerHTML=h;
  view.querySelectorAll('.hs-sel').forEach(s=>s.addEventListener('change',()=>{
    if(s.dataset.w==='from') histFrom=s.value; else histTo=s.value;
    renderChanged(view, m, seq);
  }));
  if(histFrom===histTo){
    view.querySelector('.hs-body').innerHTML='<div class="model-empty">Same version on both sides — pick two.</div>';
    return;
  }
  const d=await fetch('/api/history/diff?path='+encodeURIComponent(selected)+
    '&from='+encodeURIComponent(histFrom)+'&to='+encodeURIComponent(histTo)).then(x=>x.json()).catch(()=>null);
  if(seq!=null && !viewAlive(seq)) return;
  const body=view.querySelector('.hs-body'); if(!body) return;
  if(!d || !d.ok){ body.innerHTML='<div class="model-empty">Could not read one of those versions.</div>'; return; }
  const diff=d.diff, T=diff.totals;
  const iFrom=vs.findIndex(v=>v.sha===histFrom), iTo=vs.findIndex(v=>v.sha===histTo);
  const span=Math.abs(iFrom-iTo);
  // The same name can belong to a function and to the endpoint in front of it.
  // Two identical chips side by side read as a duplicate rather than as two things.
  const chips=(list,cls)=>list.map(o=>'<button class="mm-chip '+cls+'" data-id="'+esc(o.id)+'">'+
    esc(o.name||o.id)+'<i class="hs-kind">'+esc(DIM_ONE[o.dim]||o.dim)+'</i></button>').join('');
  let b='';
  const sgn=(n,s)=> n ? s+n : '0';
  b+='<div class="hs-sum">'+
     '<div class="hs-k"><b>'+sgn(T.added,'+')+'</b><span>objects gained</span></div>'+
     '<div class="hs-k'+(T.removed?' bad':'')+'"><b>'+sgn(T.removed,'−')+'</b><span>no longer in the model</span></div>'+
     '<div class="hs-k"><b>'+T.renamed+'</b><span>renamed</span></div>'+
     '<div class="hs-k"><b>'+sgn(T.linksAdded,'+')+' / '+sgn(T.linksRemoved,'−')+'</b><span>links between objects</span></div>'+
     '<div class="hs-k"><b>'+span+'</b><span>rebuild'+(span===1?'':'s')+' apart</span></div></div>';
  // A removal is the finding. Everything else is a product growing; this is a
  // product that used to say it did something and no longer does.
  if(diff.lost.length){
    b+='<div class="own-warn"><b>'+diff.lost.length+' thing'+(diff.lost.length>1?'s':'')+
      ' the product used to have and no longer does.</b> Either the work finished, or a rebuild lost it — '+
      'which is exactly the judgement nobody could make before.</div><div class="hs-lost">'+chips(diff.lost,'missed')+'</div>';
  }
  // A count with nothing under it is a number to trust or not, with no way to
  // decide. Everything removed gets named, whether or not it was the important kind.
  const lostIds=new Set(diff.lost.map(o=>o.id));
  const goneRest=diff.objects.removed.filter(o=>!lostIds.has(o.id));
  if(goneRest.length){
    b+='<div class="hs-sec">Also no longer in the model</div><div class="hs-lost">'+
      chips(goneRest.slice(0,60),'missed')+
      (goneRest.length>60?'<span class="hs-more">+'+(goneRest.length-60)+' more</span>':'')+'</div>';
  }
  if(diff.lifecycles.length){
    b+='<div class="hs-sec">Rules that changed</div>';
    for(const l of diff.lifecycles){
      const part=(label,arr,cls)=>arr.length?'<div class="hs-line"><span>'+label+'</span>'+
        arr.map(x=>'<code class="hs-st '+cls+'">'+esc(x.replace('>',' → '))+'</code>').join('')+'</div>':'';
      b+='<div class="hs-lc"><div class="hs-lct">'+esc(l.name||l.id)+'</div>'+
        part('States added',l.statesAdded,'hs-a')+part('States gone',l.statesRemoved,'hs-r')+
        part('Transitions added',l.transAdded,'hs-a')+part('Transitions gone',l.transRemoved,'hs-r')+'</div>';
    }
  }
  const dims=diff.perDimension.filter(x=>x.added||x.removed||x.renamed);
  if(dims.length){
    b+='<div class="hs-sec">Where it moved</div><div class="hs-dims">';
    for(const x of dims){
      b+='<div class="hs-dim"><div class="hs-dn">'+esc(DIM_LABEL[x.dim]||x.dim)+'</div>'+
        '<div class="hs-dv">'+x.was+' → <b>'+x.now+'</b></div>'+
        '<div class="hs-dd">'+(x.added?'<span class="hs-a">+'+x.added+'</span>':'')+
        (x.removed?'<span class="hs-r">−'+x.removed+'</span>':'')+
        (x.renamed?'<span class="hs-ren-n">'+x.renamed+' renamed</span>':'')+'</div></div>';
    }
    b+='</div>';
  }
  if(diff.objects.renamed.length){
    b+='<div class="hs-sec">Renamed — same object, new words</div><div class="hs-ren">'+
      diff.objects.renamed.slice(0,40).map(o=>'<button class="hs-rn" data-id="'+esc(o.id)+'">'+
        '<s>'+esc(o.from)+'</s> → <b>'+esc(o.to)+'</b></button>').join('')+'</div>';
  }
  if(diff.objects.added.length){
    b+='<div class="hs-sec">New in the product</div><div class="hs-lost">'+
      chips(diff.objects.added.slice(0,60),'kept')+
      (diff.objects.added.length>60?'<span class="hs-more">+'+(diff.objects.added.length-60)+' more</span>':'')+'</div>';
  }
  // A link is the product saying it does something: this screen calls that
  // endpoint, this function writes that object. Objects staying put while the
  // links move is exactly how business logic drifts without anyone noticing.
  const lk=diff.links.removed.length+diff.links.added.length;
  if(lk){
    // One function leaving takes every field it wrote with it — twenty rows that
    // say one thing. Same source, same kind: one row, and the count carries the size.
    const fold=(list)=>{
      const by=new Map();
      for(const l of list){
        const k=l.from+'\u001f'+l.kind;
        if(!by.has(k)) by.set(k,{from:l.from, fromName:l.fromName, kind:l.kind, to:[]});
        by.get(k).to.push(l);
      }
      return [...by.values()];
    };
    const row=(g,cls)=>{
      const ends = g.to.length<=3
        ? g.to.map(x=>'<button class="hs-lkid" data-id="'+esc(x.to)+'">'+esc(x.toName||x.to)+'</button>').join('<span class="hs-lkc">·</span>')
        : '<button class="hs-lkid" data-id="'+esc(g.to[0].to)+'">'+esc(g.to[0].toName||g.to[0].to)+'</button>'+
          '<span class="hs-lkn">and '+(g.to.length-1)+' more</span>';
      return '<div class="hs-lk '+cls+'"><button class="hs-lkid" data-id="'+esc(g.from)+'">'+esc(g.fromName||g.from)+'</button>'+
        '<span class="hs-lkk">'+esc(g.kind)+'</span>'+ends+'</div>';
    };
    const gone=fold(diff.links.removed), got=fold(diff.links.added);
    b+='<div class="hs-sec">Connections that changed</div><div class="hs-lks">'+
      gone.slice(0,25).map(g=>row(g,'hs-r')).join('')+
      got.slice(0,25).map(g=>row(g,'hs-a')).join('')+'</div>'+
      ((gone.length>25||got.length>25)?'<div class="hs-more">'+
        (Math.max(0,gone.length-25)+Math.max(0,got.length-25))+' more sources not shown</div>':'');
  }
  if(!T.added && !T.removed && !T.renamed && !T.linksAdded && !T.linksRemoved){
    b+='<div class="model-empty">Nothing changed in the model between these two versions.</div>';
  }
  body.innerHTML=b;
  body.querySelectorAll('.mm-chip,.hs-rn,.hs-lkid').forEach(x=>x.addEventListener('click',()=>{
    const id=x.dataset.id; if(kindOf(id)) openContextPopup(kindOf(id), id);
  }));
}

async function renderMismatch(view, m, seq){
  const ch=await loadChanges(false);
  const tasks=((ch&&ch.tasks)||[]).filter(t=>t.col==='done');
  const hist=(ch&&ch.history)||[];
  if(!tasks.length){ view.innerHTML='<div class="model-empty">Nothing has reached <b>done</b> yet — there is nothing to compare.</div>'; return; }
  const norm=s=>String(s||'').toLowerCase().replace(/[^a-zа-яёіїєґ0-9]+/gi,' ').trim();
  const byTitle=new Map(); for(const h of hist) byTitle.set(norm(h.title), h);

  let h=viewHead('mismatch')+'<div class="map-cap">'+
    '<span class="map-cap2">The intent is the task\'s own <code>Touches:</code> line, written when the task was created. '+
    'The outcome is what the run logged. Anything touched that was never declared is the interesting column: it is work that '+
    'happened outside what was approved.</span></div><div class="mm-list">';
  // A task nobody logged is not a finding — it is a hole in the record, and one
  // hole reads the same as eighty-seven. Rows are for work that could actually be
  // compared; the rest collapses into a single line that says what to do about it.
  let clean=0;
  const rows=[]; const unchecked=[];
  for(const t of tasks){
    const log=byTitle.get(norm(t.title));
    const intended=t.declared ? t.ids : [];
    const done=(log&&log.touched)||[];
    if(!log || !done.length){ unchecked.push({title:t.title, hasLog:!!log}); continue; }
    const iSet=new Set(intended), dSet=new Set(done);
    const kept=intended.filter(i=>dSet.has(i));
    const missed=intended.filter(i=>!dSet.has(i));
    const extra=done.filter(i=>!iSet.has(i));
    const ok=!missed.length && !extra.length;
    if(ok) clean++;
    rows.push({t, kept, missed, extra, ok});
  }
  const compared=rows.length;
  // Work that left its declared scope is the reason this view exists; it goes first.
  rows.sort((a,b)=> (a.ok?1:0)-(b.ok?1:0) || b.extra.length-a.extra.length);
  const chips=(ids,cls)=>ids.map(i=>'<button class="mm-chip '+cls+'" data-id="'+esc(i)+'">'+esc(labelOf(i,m))+'</button>').join('');
  for(const r of rows){
    h+='<div class="mm-row'+(r.ok?' ok':' off')+'">'+
      '<div class="mm-t">'+esc(r.t.title)+(r.ok?'<span class="mm-badge ok">as approved</span>':'<span class="mm-badge off">differs</span>')+'</div>'+
      (r.kept.length?'<div class="mm-line"><span>Did what it said</span>'+chips(r.kept,'kept')+'</div>':'')+
      (r.missed.length?'<div class="mm-line"><span>Declared, never touched</span>'+chips(r.missed,'missed')+'</div>':'')+
      (r.extra.length?'<div class="mm-line"><span>Touched, never declared</span>'+chips(r.extra,'extra')+'</div>':'')+
      '</div>';
  }
  if(unchecked.length){
    h+='<details class="mm-un"><summary><b>'+unchecked.length+'</b> finished task'+(unchecked.length>1?'s':'')+
      ' could not be checked — nothing recorded which model objects the run touched.'+
      ' <span class="mm-fix">The <b>task-log</b> skill writes that line; without it a finished task leaves no evidence.</span></summary>'+
      '<div class="mm-unlist">'+unchecked.map(u=>'<span class="mm-unrow'+(u.hasLog?' filesonly':'')+'">'+esc(u.title)+
        (u.hasLog?'<i>files logged, not objects</i>':'')+'</span>').join('')+'</div></details>';
  }
  h+='</div>';
  const head='<div class="own-warn"><b>'+compared+' of '+tasks.length+' finished tasks could be compared'+
    (compared?(' — '+clean+' stayed inside what they declared'):'')+'.</b>'+
    (compared? '' : ' Nothing can be compared until runs record what they touched.')+'</div>';
  if(seq!=null && !viewAlive(seq)) return;
  view.innerHTML=h.replace('<div class="mm-list">', head+'<div class="mm-list">');
  view.querySelectorAll('.mm-chip').forEach(b=>b.addEventListener('click',()=>{
    const id=b.dataset.id; openContextPopup(kindOf(id), id);
  }));
}

async function renderModelView(){
  const view=document.getElementById('modelView'); if(!view||!modelData) return;
  const seq=++modelViewSeq;
  hudDrop();          // the canvas runs a loop; leaving a view must stop it
  const m=modelData.model;
  if(modelView==='logic') return renderLogic(view, m, seq);
  if(modelView==='overview') return renderOverview(view, modelData, seq);
  if(modelView==='journeys') return renderProcesses(view, m, seq);
  if(modelView==='impact') return renderImpact(view, m, seq);
  if(modelView==='timeline') return renderTimeline(view, m, seq);
  if(modelView==='decisions') return renderDecisions(view, m, seq);
  if(modelView==='events') return renderEvents(view, m, seq);
  if(modelView==='ownership') return renderOwnership(view, m, seq);
  if(modelView==='confidence') return renderConfidence(view, m, seq);
  if(modelView==='mismatch') return renderMismatch(view, m, seq);
  if(modelView==='changed') return renderChanged(view, m, seq);
  if(modelView==='spec') return renderSpec(view, m, seq);
  view.innerHTML='';
  const box=document.createElement('div'); view.appendChild(box);
  if(modelView==='map'){
    // This is the view shown to a client, so say what the picture means in their words.
    const layerData = mapLayer==='none' ? null : await mapLayerData(m);
    box.appendChild(mapLayerBar(layerData));
    box.insertAdjacentHTML('beforeend', viewHead('map'));
    const cap=document.createElement('div'); cap.className='map-cap';
    // No apostrophes in here on purpose: this string is emitted from a template literal.
    const structure='A line means one area touches another: <b>writes X</b> — it changes data owned by that area \u00b7 <b>uses</b> — its screens call that area \u00b7 <b>calls</b> — it triggers logic over there \u00b7 a named signal is an event one area raises and another reacts to.';
    // With a layer on, the layer is what the picture now means. Leaving the structure
    // paragraph in the prominent slot and demoting the layer to a grey line in the
    // toolbar inverts that — readers looked at the big text, saw it describe the plain
    // map, and reported the layer as having no explanation at all.
    if(layerData){
      const name=(MAP_LAYERS.find(l=>l.key===mapLayer)||{}).label||mapLayer;
      cap.innerHTML='<b>'+esc(name)+'</b> — '+esc(layerData.legend)+
        '<span class="map-cap2">The blocks and lines are unchanged: '+structure+'</span>';
    } else {
      cap.innerHTML=structure;
    }
    box.appendChild(cap);
    const d=document.createElement('div'); box.appendChild(d);
    // Areas are containers now, not summaries: "2 screens · 2 actions" is a thing
    // you can open rather than a claim you have to take on trust.
    const scene=window.hudSceneProductMap
      ? hudSceneProductMap(m, layerData, { onSelect:(id)=>{ if(id) openContextPopup(kindOf(id), id); } })
      : null;
    return renderHud(d, scene, seq);
  }
  if(modelView==='er'){ box.innerHTML=viewHead('er');
    const d=document.createElement('div'); box.appendChild(d);
    return hudRenderSpec(d, graphER(m), m, {title:'DATA', subtitle:'BUSINESS OBJECTS AND WHAT LINKS THEM'}, seq); }
  if(modelView==='flow'){
    // Areas and what moves between them, not every object at once. The caption
    // has to say how to read a line, because "Order" on an arrow is only obvious
    // once you know the arrow points the way the data travels.
    box.insertAdjacentHTML('beforeend', viewHead('flow'));
    const cap=document.createElement('div'); cap.className='map-cap';
    cap.innerHTML='<b>A line is data moving</b>, and it points the way it travels — the label names what moves: '+
      'an object written into another area, an object read out of the area that owns it, an event one area raises '+
      'and another handles, or an endpoint answering a screen.';
    box.appendChild(cap);
    const d=document.createElement('div'); box.appendChild(d);
    const scene=window.hudSceneDataFlow
      ? hudSceneDataFlow(m, { onSelect:(id)=>{ if(id) openContextPopup(kindOf(id), id); } })
      : null;
    if(scene) return renderHud(d, scene, seq);
    return hudRenderSpec(d, graphFlow(m), m, {title:'DATA FLOW', subtitle:'WHERE DATA COMES FROM AND WHERE IT GOES'}, seq);
  }
  view.innerHTML='<div class="model-empty">No data for this diagram.</div>';
}

function fsClose(){ const ov=document.getElementById('fsOverlay'); if(ov){ ov.classList.remove('show'); ov.innerHTML=''; } }

// ----- helpers -----
function mSafe(s){ return String(s==null?'':s).replace(/[^A-Za-z0-9_]/g,'_'); }
function mLabel(s){ return String(s==null?'':s).replace(/"/g,"'").replace(/[\[\]{}<>|]/g,' ').slice(0,44); }
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

// The context is what gets pasted into an agent. A known deviation left out of it
// means the agent plans a change against rules the code does not actually follow —
// so it goes in every path out of the builder, not into one of the six branches.
function gatherContext(kind,id,m){
  const base=gatherContextBase(kind,id,m);
  const bad=findingsOnId(id).filter(f=>f.status!=='fixed');
  if(!bad.length) return base;
  const L=[base,'','## Known to be wrong here'];
  for(const f of bad){
    L.push('');
    L.push('- SHOULD: '+f.rule+(f.source?'  ('+f.source+')':''));
    L.push('  DOES:   '+f.actual);
    if(f.consequence) L.push('  COSTS:  '+f.consequence);
    if(f.status==='accepted'&&f.decision) L.push('  ACCEPTED by '+f.decision.by+' on '+f.decision.at+': '+f.decision.why);
    if(f.stale) L.push('  RE-CHECK: '+(f.movedFile||'the file this was read from')+' has changed since it was checked.');
  }
  L.push('');
  L.push('Say this out loud before changing any of it.');
  return L.join('\n');
}

function gatherContextBase(kind,id,m){
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
    return L.join('\n');
  }
  if(kind==='function'){ const f=ix.sf.get(id); if(!f) return 'Function not found'; L.push('# Server function: '+f.name+' ('+f.id+')'); if(f.description) L.push(f.description); L.push('- unit: '+(f.serverUnitId?nm(ix.su,f.serverUnitId):'—')+'  ·  operation: '+(f.operation||'')); const rt=f.routeId&&ix.rt.get(f.routeId); if(rt) L.push('- route: '+rt.method+' '+rt.path+(rt.auth?' (auth)':'')); const rd=[...new Set((f.readsFieldIds||[]).map(x=>ix.owner.get(x)).filter(Boolean))].map(x=>nm(ix.ent,x)); const wr=[...new Set((f.writesFieldIds||[]).map(x=>ix.owner.get(x)).filter(Boolean))].map(x=>nm(ix.ent,x)); if(rd.length) L.push('- reads: '+rd.join(', ')); if(wr.length) L.push('- writes: '+wr.join(', ')); const cl=(f.callsFunctionIds||[]).map(x=>nm(ix.sf,x)); if(cl.length) L.push('- calls: '+cl.join(', ')); const em=(f.emitsEventIds||[]).map(x=>nm(ix.ev,x)); if(em.length) L.push('- emits: '+em.join(', ')); const sb=(f.subscribesEventIds||[]).map(x=>nm(ix.ev,x)); if(sb.length) L.push('- subscribes: '+sb.join(', ')); const procs=(m.processes||[]).filter(p=>(p.steps||[]).some(s=>s.refId===id)); if(procs.length){ L.push(''); L.push('## Processes'); for(const p of procs) L.push('- '+(p.name||p.id)); } return L.join('\n'); }
  if(kind==='route'){ const r=ix.rt.get(id); if(!r) return 'Route not found'; L.push('# API route: '+r.method+' '+r.path+' ('+r.id+')'); if(r.description) L.push(r.description); L.push('- unit: '+(r.serverUnitId?nm(ix.su,r.serverUnitId):'—')+'  ·  auth: '+(!!r.auth)); const fns=(m.serverFunctions||[]).filter(f=>f.routeId===id); if(fns.length){ L.push(''); L.push('## Handlers'); for(const f of fns) L.push('- '+f.name+' ('+(f.operation||'')+')'); } const fes=(m.frontendUnits||[]).filter(fe=>(fe.consumesRouteIds||[]).includes(id)); if(fes.length){ L.push(''); L.push('## Called from (frontend)'); for(const fe of fes) L.push('- '+fe.name); } return L.join('\n'); }
  if(kind==='event'){ const ev=ix.ev.get(id); if(!ev) return 'Event not found'; L.push('# Domain event: '+ev.name+' ('+ev.id+')'); if(ev.description) L.push(ev.description); const prod=(m.serverFunctions||[]).filter(f=>(f.emitsEventIds||[]).includes(id)); const cons=(m.serverFunctions||[]).filter(f=>(f.subscribesEventIds||[]).includes(id)); if(prod.length){ L.push(''); L.push('## Emitted by'); for(const f of prod) L.push('- '+f.name); } if(cons.length){ L.push(''); L.push('## Handled by'); for(const f of cons) L.push('- '+f.name); } return L.join('\n'); }
  if(kind==='frontend'){ const fe=ix.fe.get(id); if(!fe) return 'Frontend unit not found'; L.push('# Frontend unit: '+fe.name+' ('+fe.id+', '+(fe.kind||'')+')'); if(fe.description) L.push(fe.description); const routes=(fe.consumesRouteIds||[]).map(rid=>ix.rt.get(rid)).filter(Boolean); if(routes.length){ L.push(''); L.push('## Consumes routes'); for(const r of routes){ const fns=(m.serverFunctions||[]).filter(f=>f.routeId===r.id).map(f=>f.name); L.push('- '+r.method+' '+r.path+(fns.length?'  → '+fns.join(', '):'')); } } return L.join('\n'); }
  if(kind==='process'){ const p=(m.processes||[]).find(x=>x.id===id); if(!p) return 'Process not found'; L.push('# Business process: '+p.name+' ('+p.id+')'); if(p.description) L.push(p.description); L.push('- trigger: '+(p.triggerKind||'')+(p.triggerRefId?' → '+resolveRef({ui:'frontend',api:'route',event:'event',schedule:'route'}[p.triggerKind]||'frontend',p.triggerRefId,m):'')); L.push(''); L.push('## Steps'); (p.steps||[]).forEach((s,i)=> L.push((i+1)+'. '+resolveRef(s.refKind,s.refId,m)+'  ('+s.refKind+')'+(s.note?' — '+s.note:''))); return L.join('\n'); }
  return objName(kind,id,m)+' ('+kind+')';
}

// Display name of the model currently on screen (folder key → real name).
function srcLabel(){
  if(!modelSrc) return 'mine';
  const s=((modelData&&modelData.shared)||[]).find(x=>x.name===modelSrc);
  return (s&&s.label)||modelSrc;
}
// In fullscreen the browser paints only the fullscreen element's subtree, so an
// overlay parked on <body> is invisible exactly when someone is looking hardest
// at the diagram. Every overlay is parented to whoever currently owns the screen.
function overlayHost(){ return document.fullscreenElement || document.body; }
function mountOverlay(ov){ const h=overlayHost(); if(ov.parentNode!==h) h.appendChild(ov); return ov; }
// Entering or leaving fullscreen moves whatever is open along with it.
document.addEventListener('fullscreenchange', ()=>{
  const h=overlayHost();
  for(const id of ['ctxOverlay','taskOverlay','addOverlay','pvOverlay','shareOverlay']){
    const o=document.getElementById(id);
    if(o && o.classList.contains('show') && o.parentNode!==h) h.appendChild(o);
  }
});

// Known deviations on this object, for the card somebody opens before changing it.
function ctxFindings(id){
  const list=findingsOnId(id).filter(f=>f.status!=='fixed');
  if(!list.length) return '';
  const open=list.filter(f=>f.status==='open');
  return '<div class="ctx-bad'+(open.length?'':' accepted')+'">'+
    '<div class="ctx-bad-h">'+(open.length
      ? (open.length>1?open.length+' things here do not do what the product says':'This does not do what the product says')
      : 'A known gap here, accepted on purpose')+'</div>'+
    list.map(f=>'<div class="ctx-bad-i">'+
      '<div><b>Should</b> '+esc(f.rule)+(f.source?' <i>('+esc(f.source)+')</i>':'')+'</div>'+
      '<div><b>Does</b> '+esc(f.actual)+'</div>'+
      (f.decision?'<div class="ctx-bad-d">Accepted by '+esc(f.decision.by)+' on '+esc(f.decision.at)+': '+esc(f.decision.why)+'</div>':'')+
      (f.stale?'<div class="ctx-bad-d">Needs re-checking — '+esc(f.movedFile||'the file it was read from')+' has changed since.</div>':'')+
    '</div>').join('')+
    '<div class="ctx-bad-f">It travels with any task made here, and the radius warns anyone whose change reaches it.</div>'+
  '</div>';
}

function openContextPopup(kind,id){
  if(!modelData) return; const m=modelData.model;
  const ctx=gatherContext(kind,id,m); const title=ctxTitle(kind,id,m);
  let ov=document.getElementById('ctxOverlay');
  if(!ov){ ov=document.createElement('div'); ov.id='ctxOverlay'; ov.className='ctx-overlay'; overlayHost().appendChild(ov); }
  ov.innerHTML=
    '<div class="ctx-modal">'+
      '<div class="ctx-head"><div class="ctx-title">'+esc(title)+'</div><button class="ctx-x" title="Close (Esc)">✕</button></div>'+
      '<div class="ctx-note">'+(modelSrc
        ? 'Deterministic context from the model shared by <b>'+esc(srcLabel())+'</b>. <b>Send to team</b> delivers it to <b>everyone currently online</b> in your workspace (the relay broadcasts — it cannot target one person), landing in their <code>tasks/todo/</code>. <b>Queue here</b> instead writes it into this local project.'
        : 'Deterministic context — assembled from the model by walking id-links. Paste into Claude, or turn it into a queued task.')+'</div>'+
      objectFacts(kind, id, m)+
      // Above the context, not below it: somebody who opens this and stops reading
      // after two lines must still have seen that this thing is known to be wrong.
      ctxFindings(id)+
      '<pre class="ctx-pre">'+esc(ctx)+'</pre>'+
      // A shared view is read-only: it has no project on disk to queue into and no bridge
      // to send over. Copying context still works — that is the useful half for a reader.
      (SHARE ? '' : '<div class="ctx-taskl">Task for this element (optional):</div>'+
        '<textarea class="ctx-task" placeholder="e.g. Add a partial-refund transition from paid, updating Payment and Inventory…"></textarea>')+
      '<div class="ctx-actions">'+
        (SHARE ? '' : (modelSrc
          ? '<button class="run ctx-send">➤ Send to team</button><button class="ghost ctx-create">＋ Queue here</button>'
          : '<button class="run ctx-create">＋ Create task</button>'))+
        (SHARE ? '' : '<button class="ghost ctx-radius">◎ Radius on map</button>')+
        '<button class="ghost ctx-copy">📋 Copy context</button>'+
        (SHARE ? '' : '<button class="ghost ctx-copyt">📋 Copy context + task</button>')+
        '<button class="del ctx-close">Close</button>'+
      '</div>'+
    '</div>';
  mountOverlay(ov).classList.add('show');
  recordAnswer({ tool:'context', q:kindOf(id)+' '+id, served:ctx.length, ids:[id] });
  // Expanding a reach group, and stepping from here to any object it named.
  ov.querySelectorAll('.of-r').forEach(b=>b.addEventListener('click',()=>{
    const k=b.dataset.k, box=ov.querySelector('.of-exp[data-k="'+k+'"]');
    const on=b.classList.toggle('on'); if(box) box.classList.toggle('on', on);
  }));
  // From any object to the same picture the queue gets: its reach, lit on the map.
  const rb=ov.querySelector('.ctx-radius');
  if(rb) rb.addEventListener('click',()=>{
    impactPick='__adhoc'; adhocIds=[id]; mapLayer='change'; modelView='map';
    close(); renderModelNav(); renderModelView();
  });
  ov.querySelectorAll('.of-dep').forEach(b=>b.addEventListener('click',()=>{
    const nid=b.dataset.id, nk=kindOf(nid);
    if(['entity','function','route','event','frontend','module','process'].includes(nk)){ close(); openContextPopup(nk,nid); }
  }));
  const ta=ov.querySelector('.ctx-task');   // absent in a shared view — guarded below
  const CTXPRE='This is deterministic context extracted from the product information model — the GitMir multidimensional object model that lives in the .gitmir/ folder of this project. It maps how this element connects to the rest of the product (data, server logic, API, frontend, events, business processes, status flows, reactions) by stable ids. Use it to fully understand the context, so the task is carried out accurately and completely.';
  const withTask=()=> CTXPRE+'\n\n'+ctx + (ta && ta.value.trim()? '\n\n---\n## Task\n'+ta.value.trim() : '');
  const close=()=>{ ov.classList.remove('show'); ov.innerHTML=''; };
  ov.querySelector('.ctx-x').addEventListener('click', close);
  ov.querySelector('.ctx-close').addEventListener('click', close);
  ov.addEventListener('click', e=>{ if(e.target===ov) close(); });
  ov.querySelector('.ctx-copy').addEventListener('click', async ()=>{ await copyToClipboard(CTXPRE+'\n\n'+ctx); toast('Context copied ✓  paste into claude'); });
  if(!SHARE) ov.querySelector('.ctx-copyt').addEventListener('click', async ()=>{ await copyToClipboard(withTask()); toast('Context + task copied ✓'); });
  // When the context came from a teammate's snapshot, say so in the task file —
  // otherwise the local Claude would read it as a description of THIS project.
  const origin= modelSrc
    ? '> NOTE: this context describes the model shared by '+srcLabel()+' (a snapshot in .gitmir/shared/'+modelSrc+'/), NOT this project\'s own .gitmir/model.\n\n'
    : '';
  // The click already knows which object this task is about, so the task says so
  // in the one line every other surface reads. Without it the file came out with
  // its scope INFERRED — guessed from whichever ids the prose happens to mention —
  // even though the id was in hand the whole time. That line is what makes the
  // task's impact and risk computable before anyone runs it.
  const touches = (!SHARE && id) ? 'Touches: '+id+'\n\n' : '';
  const taskBody=(t)=> origin+touches+'> '+CTXPRE+'\n\n## Task\n'+t+'\n\n## Context (from the .gitmir model)\n'+ctx+'\n';
  if(!SHARE) ov.querySelector('.ctx-create').addEventListener('click', async ()=>{
    const t=ta.value.trim(); if(!t){ toast('Type the task first', true); ta.focus(); return; }
    const content='# '+title+' — '+t.split('\n')[0].slice(0,80)+'\n\n'+taskBody(t);
    const r=await fetch('/api/task',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:selected, title:title+' — '+t.slice(0,40), content})});
    const d=await r.json();
    if(d.ok){ toast('Task created in tasks/todo ✓'); close(); if(activeTab==='queue') loadQueue(selected); }
    else toast('Failed: '+(d.error||'error'), true);
  });
  // Viewing a teammate's model: the task belongs on THEIR machine, so send it over
  // the bridge with the same deterministic context attached.
  const sendBtn=SHARE?null:ov.querySelector('.ctx-send');
  if(sendBtn) sendBtn.addEventListener('click', async ()=>{
    const t=ta.value.trim(); if(!t){ toast('Type the task first', true); ta.focus(); return; }
    // The receiving side already writes "# title / ## Context (received from…) / ## Task",
    // so send the task text plus the model context — no duplicate headings.
    const body=t+'\n\n## Context (from the .gitmir model)\n> '+CTXPRE+'\n\n'+ctx+'\n';
    const r=await fetch('/api/team/send-task',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({ title: title+' — '+t.split('\n')[0].slice(0,60), body })});
    const d=await r.json();
    if(d.ok){ toast('Task sent to the team ✓'); close(); teamPoll(); }
    else toast(d.error||'Send failed — connect on the Team tab first', true);
  });
}

/* ---------- task queue view ---------- */
async function loadQueue(pathStr){
  const view=document.getElementById('queueView'); if(!view) return;
  let q; try{ q=await (await fetch('/api/queue?path='+encodeURIComponent(pathStr))).json(); }catch{ return; }
  if(selected!==pathStr) return;
  renderAudit(q);   // before the no-tasks return: an audit can outlive its tasks
  const total=(q.todo||[]).length+(q.inprogress||[]).length+(q.verify||[]).length+(q.done||[]).length;
  // The badge counts todo: what is waiting to be picked up. Verify is built but unproven —
  // it is shown in its own column, and it is not a number that says "start something".
  const badge=document.getElementById('queueBadge');
  if(badge) badge.textContent = (q.todo||[]).length ? String((q.todo||[]).length) : '';
  // The queue is where someone decides what to run next, so the impact figures have to be
  // here without a detour through the Model tab. Both loads are cheap and local; if the
  // model has not been read yet, read it and draw the queue again once it lands.
  await loadChanges(true);
  if(!modelData || modelFor!==pathStr){ loadModel(pathStr).then(()=>{ if(selected===pathStr && activeTab==='queue') loadQueue(pathStr); }); }
  if(!total){ view.innerHTML='<div class="model-empty">No tasks yet.<br>Open <b>Model</b>, click any element in a diagram → <b>＋ Create task</b> (or copy the <b>task-planner</b> skill). Then run <b>📋 task-runner</b> in Claude — it executes them one by one, moving each file todo → inprogress → verify → done — a task is only done once its checks actually pass.</div>'; return; }
  const cols=[['todo','To do','#8aa0ff'],['inprogress','In progress','#ffb86b'],['verify','Verify','#c084fc'],['done','Done','#34f0a6']];
  let html='<div class="q-cols">';
  for(const [k,label,acc] of cols){ const items=q[k]||[];
    html+='<div class="q-col"><div class="q-col-h" style="color:'+acc+'">'+label+' <span class="q-n">'+items.length+'</span></div><div class="q-list">';
    if(!items.length) html+='<div class="q-empty">—</div>';
    for(const it of items){
      // What the impact view already knows about this exact file: which model objects it
      // names, how far that reaches, and whether anyone approved it. Showing it here is
      // the point — the queue is where someone decides what to run next.
      const ci = queueImpact(it.file);
      html+='<div class="q-card q-clk" data-col="'+esc(k)+'" data-file="'+esc(it.file)+'" title="Open full task" style="border-left-color:'+acc+'">'+
        '<div class="q-t">'+esc(it.title)+'</div><div class="q-f">'+esc(it.file)+'</div>'+
        (ci ? '<div class="q-imp">'+
                (ci.approved?'<span class="q-ok" title="Approved '+esc(ci.approved)+'">✓ approved</span>':'')+
                '<button class="q-risk '+ci.level+'" data-imp="'+esc(it.file)+'" title="Open this in Impact">'+
                  esc(ci.level)+' · '+ci.n+' object'+(ci.n===1?'':'s')+'</button>'+
              '</div>' : '')+
        '</div>';
    }
    html+='</div></div>';
  }
  view.innerHTML=html+'</div>';
  view.querySelectorAll('.q-clk').forEach(c=> c.addEventListener('click', ()=> openTaskPopup(pathStr, c.dataset.col, c.dataset.file)));
  // The risk pill is a jump, not a label: it opens the Model tab on Impact with this
  // task already selected.
  view.querySelectorAll('.q-risk').forEach(b=> b.addEventListener('click', (e)=>{
    e.stopPropagation();
    impactPick=b.dataset.imp; modelView='impact'; setTab('model');
  }));
}

// Risk and object count for one task file, computed only when both the model and the
// change ledger are already in hand. The queue never waits on either.
function queueImpact(file){
  if(!modelData || !modelData.model || modelFor!==selected || !changesData || changesFor!==selected) return null;
  const t=(changesData.tasks||[]).find(x=>x.file===file);
  if(!t || !t.ids.length) return null;
  const r=riskOf(blastRadius(t.ids, modelData.model), modelData.model);
  return { level:r.level, n:t.ids.length, approved:t.approved };
}

let auSel = null;   // which page cell is expanded
// The audit report the skill asks for leads with the gaps, and so does this: a panel that
// shows only the defects invites the reading that everything else was checked.
function renderAudit(q){
  const box=document.getElementById('auditBox'); if(!box) return;
  const a=q.audit;
  if(!a || !a.counts || !a.counts.total){ box.innerHTML=''; box.style.display='none'; return; }
  box.style.display='block';
  const c=a.counts, seen=(c.passed||0)+(c.failed||0);
  const pct = c.total ? Math.round(seen*100/c.total) : 0;

  let html='<div class="ing-hd"><span class="ing-t">App audit</span>'+
    '<span class="ing-n">'+ingNum(seen)+' of '+ingNum(c.total)+' pages walked</span>'+
    '<span class="ing-pct">'+pct+'%</span></div>'+
    '<div class="ing-bar"><i style="width:'+pct+'%"></i></div>';

  html+='<div class="ing-tape">';
  for(const g of (a.pages||[])){
    const t='#'+g.n+' '+(g.url||'')+' — '+g.status+
      (g.useCases?(', '+g.useCases+' use cases'):'')+
      (g.notExercised&&g.notExercised.length?(', '+g.notExercised.length+' not pressed'):'');
    html+='<i class="ic '+g.status+(auSel===g.n?' sel':'')+'" data-pg="'+g.n+'" title="'+esc(t)+'"></i>';
  }
  html+='</div><div class="ing-frag" id="auFrag"></div>';

  // What the run could NOT see. This is the part that decides how much the rest is worth.
  const gaps=[];
  if(c.pending) gaps.push('<b>'+c.pending+'</b> page'+(c.pending>1?'s':'')+' not walked yet');
  if(c.unreachable) gaps.push('<b>'+c.unreachable+'</b> unreachable');
  if(c.skipped) gaps.push('<b>'+c.skipped+'</b> skipped');
  if(a.notExercised) gaps.push('<b>'+a.notExercised+'</b> destructive control'+(a.notExercised>1?'s':'')+' left unpressed');
  if(a.driver==='curl') gaps.push('<b>no browser</b> — API only, the interface went unchecked');
  if(!(a.auth||[]).length) gaps.push('<b>no auth state recorded</b>');
  else if((a.auth||[]).length===1) gaps.push('one auth state only (<b>'+esc(a.auth[0])+'</b>)');
  if(a.caps) for(const k of Object.keys(a.caps).slice(0,6)) gaps.push(esc(k)+' capped at <b>'+esc(String(a.caps[k]))+'</b>');
  html+='<div class="au-gaps">'+(gaps.length
    ? 'Not covered: '+gaps.join(' · ')+'.'
    : 'Every page walked, every control exercised, no caps applied.')+'</div>';

  const run=[];
  if(a.target) run.push('target <b>'+esc(a.target)+'</b>');
  if(a.env) run.push('env <b>'+esc(a.env)+'</b>');
  if(a.driver) run.push('driver <b>'+esc(a.driver)+'</b>');
  if((a.auth||[]).length) run.push('auth <b>'+a.auth.map(esc).join(', ')+'</b>');
  if(a.at) run.push('ran <b>'+esc(fmtTime(a.at))+'</b>');
  if(run.length) html+='<div class="au-run">'+run.map(x=>'<span>'+x+'</span>').join('')+'</div>';

  const sv=a.sev||{};
  const chips=['critical','major','minor','intermittent'].filter(k=>sv[k]);
  if(chips.length) html+='<div class="au-sev">'+chips.map(k=>'<span class="sv '+k+'">'+sv[k]+' '+k+'</span>').join('')+'</div>';

  if((a.findings||[]).length){
    html+='<div class="au-find">';
    for(const f of a.findings){
      html+='<div class="af"><div class="af-h"><span class="sv '+f.severity+'">'+esc(f.severity)+'</span>'+
        '<span class="af-t">'+esc(f.title||'(untitled)')+'</span>'+
        '<span class="af-p">'+esc(f.page||'')+(f.step?(' step '+f.step):'')+'</span></div>';
      if(f.expected) html+='<div class="af-r"><i>expected</i>'+esc(f.expected)+'</div>';
      if(f.observed) html+='<div class="af-r af-x"><i>observed</i>'+esc(f.observed)+'</div>';
      const tail=[];
      if(f.task) tail.push('fix task <b>'+esc(f.task)+'</b>');
      if(f.evidence) tail.push(esc(f.evidence));
      if(tail.length) html+='<div class="af-r"><i>filed</i>'+tail.join(' · ')+'</div>';
      html+='</div>';
    }
    html+='</div>';
    if(a.findingsTotal>a.findings.length)
      html+='<div class="ing-note">Showing '+a.findings.length+' of '+ingNum(a.findingsTotal)+
        ' — the rest are in <code>.gitmir/audit/findings.json</code>.</div>';
  } else if(!c.pending){
    html+='<div class="ing-note">No defects were observed. That covers what is listed above and nothing else.</div>';
  }

  if((a.mismatches||[]).length){
    html+='<div class="au-mm"><b>Sources disagree:</b><br>';
    for(const m of a.mismatches) html+='<code>'+esc(m.what||'')+'</code> — '+esc(m.detail||m.kind||'')+'<br>';
    html+='</div>';
  }

  box.innerHTML=html;
  const tape=box.querySelector('.ing-tape');
  if(tape) tape.addEventListener('click', (e)=>{
    const cell=e.target.closest('.ic'); if(!cell) return;
    const n=Number(cell.dataset.pg);
    auSel = (auSel===n) ? null : n;
    box.querySelectorAll('.ic').forEach(x=> x.classList.toggle('sel', Number(x.dataset.pg)===auSel));
    paintAuPage(a);
  });
  paintAuPage(a);
}
function paintAuPage(a){
  const el=document.getElementById('auFrag'); if(!el) return;
  const g=(a.pages||[]).find(x=>x.n===auSel);
  if(!g){ el.style.display='none'; el.innerHTML=''; return; }
  el.style.display='block';
  let h='<div class="fh">#'+g.n+' '+esc(g.url||'')+(g.title?(' · '+esc(g.title)):'')+' — '+esc(g.status)+'</div>';
  const bits=[];
  if(g.auth) bits.push('auth '+esc(g.auth));
  if(g.useCases) bits.push(g.useCases+' use cases');
  if(g.interactive) bits.push(g.interactive+' interactive elements');
  if(g.dataEls) bits.push(g.dataEls+' data regions');
  if((g.foundBy||[]).length) bits.push('found by '+g.foundBy.map(esc).join(' + '));
  if(bits.length) h+='<div>'+bits.join(' · ')+'</div>';
  if(g.task) h+='<div>task <code>'+esc(g.task)+'</code></div>';
  if((g.notExercised||[]).length) h+='<div style="color:#ffb86b">not pressed: '+g.notExercised.map(esc).join(', ')+'</div>';
  if(g.note) h+='<div style="color:#ffb86b">'+esc(g.note)+'</div>';
  el.innerHTML=h;
}

async function openTaskPopup(pathStr, col, file){
  let d; try{ d=await (await fetch('/api/task-file?path='+encodeURIComponent(pathStr)+'&col='+encodeURIComponent(col)+'&file='+encodeURIComponent(file))).json(); }
  catch{ toast('Failed to read task', true); return; }
  if(!d || !d.ok){ toast(d&&d.error==='not found'?'Task file no longer exists':'Failed to read task', true); return; }
  const COLS={todo:['To do','#8aa0ff'], inprogress:['In progress','#ffb86b'], verify:['Verify','#c084fc'], done:['Done','#34f0a6']};
  const meta=COLS[col]||['Task','#2fd8ff'];
  let ov=document.getElementById('taskOverlay');
  if(!ov){ ov=document.createElement('div'); ov.id='taskOverlay'; ov.className='ctx-overlay'; overlayHost().appendChild(ov); }
  ov.innerHTML=
    '<div class="ctx-modal">'+
      '<div class="ctx-head"><span class="q-badge" style="color:'+meta[1]+'; border-color:'+meta[1]+'">'+esc(meta[0])+'</span>'+
        '<div class="ctx-title">'+esc(file)+'</div><button class="ctx-x" title="Close (Esc)">✕</button></div>'+
      '<pre class="ctx-pre">'+esc(d.content||'')+'</pre>'+
      '<div class="ctx-actions">'+
        '<button class="ghost tk-copy">📋 Copy task</button>'+
        '<button class="del tk-close">Close</button>'+
      '</div>'+
    '</div>';
  mountOverlay(ov).classList.add('show');
  const close=()=>{ ov.classList.remove('show'); ov.innerHTML=''; };
  ov.querySelector('.ctx-x').addEventListener('click', close);
  ov.querySelector('.tk-close').addEventListener('click', close);
  ov.addEventListener('click', e=>{ if(e.target===ov) close(); });
  ov.querySelector('.tk-copy').addEventListener('click', async ()=>{ await copyToClipboard(d.content||''); toast('Task copied ✓'); });
}

// ----- overview -----
function renderOverview(view, d, seq){
  const m=d.model;
  const dims=DIM_ORDER.map(k=>[k,DIM_LABEL[k]]);
  let html=viewHead('overview')+'<div class="ov-grid">';
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
// The view you open in front of a client before anything is built: the product as
// business areas and the lines between them. Everything here is aggregated up from the
// fine-grained model — which module writes whose data, who notifies whom, who calls
// whom — so it cannot drift from what the code actually does.
function graphProductMap(m, layer){
  const mods=m.modules||[], ents=m.entities||[], sf=m.serverFunctions||[],
        fe=m.frontendUnits||[], ev=m.events||[], rt=m.apiRoutes||[];
  const owner=fieldOwner(m);
  const modById=new Map(mods.map(x=>[x.id,x]));
  const entById=new Map(ents.map(x=>[x.id,x]));
  const evById=new Map(ev.map(x=>[x.id,x]));
  const fnById=new Map(sf.map(x=>[x.id,x]));
  const rtById=new Map(rt.map(r=>[r.id,r]));     // needed to name what a screen calls
  const rtOwner=new Map();                       // routeId -> module that answers it
  for(const f of sf) if(f.routeId) rtOwner.set(f.routeId, f.moduleId||null);
  for(const r of rt) if(!rtOwner.has(r.id)) rtOwner.set(r.id, r.moduleId||null);
  const OTHER='__other';
  const mod=id=> (id && modById.has(id)) ? id : OTHER;
  const modName=id=> id===OTHER ? 'Everything else' : ((modById.get(id)||{}).name || id);

  // What lives in each area, in the words a client recognises.
  const bucket=new Map();
  const B=id=>{ if(!bucket.has(id)) bucket.set(id,{ents:[],screens:0,actions:0,desc:''}); return bucket.get(id); };
  for(const e of ents) B(mod(e.moduleId)).ents.push(e.name||e.id);
  for(const f of fe) B(mod(f.moduleId)).screens++;
  for(const f of sf) B(mod(f.moduleId)).actions++;
  for(const x of mods) if(bucket.has(x.id)) B(x.id).desc = x.description||'';
  if(!bucket.size) return {nodes:[],edges:[]};

  const nodes=[], edges=[];
  for(const [id,b] of bucket){
    const lines=[];
    if(b.ents.length) lines.push('◆ '+b.ents.slice(0,4).join(' · ')+(b.ents.length>4?' +'+(b.ents.length-4):''));
    const meta=[]; if(b.screens) meta.push(b.screens+' screen'+(b.screens>1?'s':''));
    if(b.actions) meta.push(b.actions+' action'+(b.actions>1?'s':''));
    if(meta.length) lines.push('▤ '+meta.join(' · '));
    // A layer replaces the area's own summary with what the layer measures. The
    // structure stays identical — only the reading of it changes.
    const lay = layer && layer.per.get(id);
    if(lay) lines.unshift((layer.kind==='owner'?'☗ ':layer.kind==='heat'?'▮ ':'⚠ ')+lay.text);
    const W=272;
    const dl = b.desc ? wrapPx(b.desc, W-15-11, CW_MONO).slice(0,2) : [];
    const h = 32 + dl.length*SUB_LH + Math.max(1,lines.length)*18 + 10;
    nodes.push({id, w:W, h, meta:{kind:'module', label:modName(id), sub:b.desc, subLines:dl, fields:lines,
      heat: lay ? lay.t : null,
      ref: id===OTHER?null:{k:'module', id}}});
  }

  // One line per pair of areas, labelled with the strongest thing that passes along it.
  const link=new Map();
  // A line between two areas keeps the strongest kind of thing crossing it AND
  // the names of those things. It used to keep only the kind, so a screen calling
  // another area's API came out as the bare word "uses" — true, and useless: the
  // model knows it is GET /api/favorites, which is the part worth reading.
  const add=(from,to,kind,label,rank)=>{
    if(from===to || !bucket.has(from) || !bucket.has(to)) return;
    const k=from+'>'+to; const cur=link.get(k);
    if(!cur || rank>cur.rank) link.set(k,{from,to,kind,rank,what:new Set(label?[label]:[])});
    else if(rank===cur.rank && label) cur.what.add(label);
  };
  for(const f of sf){
    const A=mod(f.moduleId);
    // data: this area writes something another area owns
    for(const fid of (f.writesFieldIds||[])){
      const e=entById.get(owner.get(fid)); if(!e) continue;
      add(A, mod(e.moduleId), 'data', 'writes '+(e.name||''), 3);
    }
    // a signal one area raises and another reacts to
    for(const id of (f.emitsEventIds||[])){
      const evt=evById.get(id); if(!evt) continue;
      for(const g of sf) if((g.subscribesEventIds||[]).includes(id)) add(A, mod(g.moduleId), 'effect', evt.name||'event', 4);
    }
    for(const id of (f.callsFunctionIds||[])){
      const g=fnById.get(id); if(g) add(A, mod(g.moduleId), 'spine', 'calls '+(g.name||g.id), 1);
    }
  }
  // screens of one area talking to another area's API
  for(const u of fe){ const A=mod(u.moduleId);
    for(const rid of (u.consumesRouteIds||[])) if(rtOwner.has(rid)){
      const r=rtById.get(rid);
      add(A, mod(rtOwner.get(rid)), 'spine', r ? ((r.method?r.method.toUpperCase()+' ':'')+(r.path||r.name||'api')) : 'api', 2);
    }
  }
  for(const e of link.values()){
    const what=[...e.what];
    // One name plus a count: three endpoints crossing the same pair is worth
    // knowing, and printing all three is a paragraph on a line.
    const label = what.length ? (what[0] + (what.length>1 ? '  +'+(what.length-1) : '')) : '';
    edges.push({from:e.from, to:e.to, kind:e.kind, label});
  }
  return {direction:'RIGHT', nodes, edges};
}

function graphER(m){
  const ents=m.entities||[]; const nodes=[], edges=[]; const byId=new Map(ents.map(e=>[e.id,e]));
  if(!ents.length) return {nodes,edges};
  for(const e of ents){
    const fs=(e.fields||[]).slice(0,8).map(f=> (f.isPrimary?'● ':(f.type==='ref'?'◇ ':'  '))+f.name+' : '+(f.type||''));
    const sub=e.description?String(e.description):'';
    const W = sub?250:224;
    const L = sub ? wrapPx(sub, W-15-11, CW_MONO) : [];
    const h = 32 + (L.length?L.length*SUB_LH+5:0) + Math.max(1,fs.length)*18 + 8;
    nodes.push({id:e.id, w:W, h, meta:{kind:'entity', label:e.name||e.id, sub, subLines:L, fields:fs, ref:{k:'entity',id:e.id}}});
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
  const add=(id,kind,label,sub)=>{ if(!have.has(id)){ have.add(id);
    const W = sub?218:190;
    const L = sub ? wrapPx(sub, W-15-11, CW_MONO) : [];
    nodes.push({id, w:W, h: L.length?subH(L.length):44, meta:{kind,label,sub:sub||'', subLines:L, ref:{k:kind,id}}}); } };
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
// Journeys and internal flows are the same object in the model and a different thing
// to a reader: one is a path a person walks, the other is machinery. Journeys come
// first, and every step says what it actually runs — the endpoint, the data it moves,
// the events it raises — because "step 4 of checkout" is only useful with that under it.
async function renderProcesses(view, m, seq){
  const procs=m.processes||[];
  if(!procs.length){ view.innerHTML='<div class="model-empty">No business processes in the model.</div>'; return; }
  const journeys=procs.filter(isJourney), internal=procs.filter(p=>!isJourney(p));
  const order=journeys.concat(internal);
  if(!journeyPick || !order.some(p=>p.id===journeyPick)) journeyPick=order[0].id;
  const p=order.find(x=>x.id===journeyPick);

  view.innerHTML=viewHead('journeys');
  // Journeys first, machinery after, and the difference said out loud: a person
  // walks the first kind and notices when it breaks.
  const items=order.map(x=>({ id:x.id, label:x.name||x.id,
    title:(isJourney(x)?'A person walks this':'Machinery — triggered by an event or a schedule')+(x.description?' · '+x.description:'') }));
  view.appendChild(subjectPicker(items, journeyPick, (id)=>{ journeyPick=id; renderProcesses(view, m); }));

  const kind=isJourney(p)?'A person walks this — if it breaks, they see it':'Machinery — nobody walks it, but its effects are real';
  const block=document.createElement('div'); block.className='proc-block';
  block.innerHTML='<div class="proc-title">'+esc(p.name||p.id)+
      '<span class="jr-trig">'+esc(p.triggerKind||'')+(p.audience?' · '+esc(p.audience):'')+'</span></div>'+
    '<div class="proc-kind">'+esc(kind)+'</div>'+
    (p.description?'<div class="proc-desc">'+esc(p.description)+'</div>':'')+
    journeyStepsHtml(p, m)+
    '<div class="proc-diagram"></div>';
  view.appendChild(block);
  if(seq!=null && !viewAlive(seq)) return;
  hudRenderSpec(block.querySelector('.proc-diagram'), graphProcess(p, m), m,
    {title:String(p.name||'JOURNEY').toUpperCase(), subtitle:'THE PATH A PERSON WALKS — STEP BY STEP'}, seq);
}

// One row per step: what it is, where it lives, and what it moves.
function journeyStepsHtml(p, m){
  const steps=p.steps||[]; if(!steps.length) return '';
  const owner=fieldOwner(m);
  let h='<table class="jr-steps"><thead><tr><th></th><th>Step</th><th>Kind</th><th>Endpoint</th><th>Data</th><th>Events</th></tr></thead><tbody>';
  steps.forEach((s,i)=>{
    const o=objById(s.refId,m)||{};
    let route='', data='', evs='';
    if(s.refKind==='function'){
      const rt=o.routeId&&objById(o.routeId,m); if(rt) route=(rt.method||'')+' '+(rt.path||'');
      const wr=[...new Set((o.writesFieldIds||[]).map(f=>owner.get(f)).filter(Boolean))].map(id=>labelOf(id,m));
      const rd=[...new Set((o.readsFieldIds||[]).map(f=>owner.get(f)).filter(Boolean))].map(id=>labelOf(id,m));
      data=[wr.length?'writes '+wr.join(', '):'', rd.length?'reads '+rd.join(', '):''].filter(Boolean).join(' · ');
      evs=(o.emitsEventIds||[]).map(id=>labelOf(id,m)).join(', ');
    } else if(s.refKind==='route'){ route=(o.method||'')+' '+(o.path||''); }
    else if(s.refKind==='frontend'){ route=(o.consumesRouteIds||[]).map(id=>labelOf(id,m)).join(', '); }
    else if(s.refKind==='entity'){ data=(o.fields||[]).length+' fields'; }
    h+='<tr data-k="'+esc(s.refKind)+'" data-id="'+esc(s.refId)+'">'+
      '<td class="n">'+(i+1)+'</td>'+
      '<td class="s"><b>'+esc(resolveRef(s.refKind,s.refId,m))+'</b>'+(s.note?'<span class="note">'+esc(s.note)+'</span>':'')+'</td>'+
      '<td class="k">'+esc(s.refKind)+'</td>'+
      '<td class="r"><code>'+esc(route)+'</code></td>'+
      '<td class="d">'+esc(data)+'</td>'+
      '<td class="e">'+esc(evs)+'</td></tr>';
  });
  return h+'</tbody></table>';
}

// ----- business logic (entity-centric) -----
// "create Payment" — what the effect does, without its prose description.
function effHead(ef, m){
  const en=ef.entityId ? (((m.entities||[]).find(x=>x.id===ef.entityId)||{}).name||'') : '';
  const tgt=[en, ef.fieldName].filter(Boolean).join('.');
  return (EFF_RU[ef.kind]||ef.kind)+(tgt?' '+tgt:'');
}
function effLabel(ef, m){
  return effHead(ef, m)+(ef.description?' — '+ef.description:'');
}
function entName(id, m){ const x=(m.entities||[]).find(y=>y.id===id); return x?x.name:id; }

async function renderLogic(view, m, seq){
  const ents=m.entities||[];
  if(!ents.length){ view.innerHTML='<div class="model-empty">No entities in the model.</div>'; return; }
  const hasFlow=id=>(m.statusFlows||[]).some(f=>f.entityId===id);
  if(!logicEntityId || !ents.some(e=>e.id===logicEntityId)){
    const wf=ents.find(e=>hasFlow(e.id)); logicEntityId=(wf||ents[0]).id;
  }
  view.innerHTML=viewHead('logic');
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
    hudRenderSpec(w, graphLifecycle(fl, m), m, {title:String(fl.name||'LIFECYCLE').toUpperCase(), subtitle:'STATES AND THE TRANSITIONS BETWEEN THEM'});
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
  else {
    // One view, one question. Drawing every journey again here made the page
    // seven thousand pixels tall and answered a question this view is not for;
    // the journeys have their own view, and this hands you over to it.
    const list=document.createElement('div'); list.className='logic-procs';
    for(const p of relProcs){
      const b=document.createElement('button'); b.className='logic-proc';
      b.innerHTML='<span class="lp-n">'+esc(p.name)+'</span>'+
        '<span class="lp-s">'+((p.steps||[]).length)+' steps</span>'+
        (p.description?'<span class="lp-d">'+esc(p.description)+'</span>':'');
      b.title='Open this journey';
      b.addEventListener('click', ()=>{ journeyPick=p.id; modelView='journeys'; renderModelNav(); renderModelView(); });
      list.appendChild(b);
    }
    secP.appendChild(list);
  }
}

function graphLifecycle(fl, m){
  const nodes=[], edges=[]; const states=fl.states||[], trans=fl.transitions||[];
  const sid=k=>'st_'+mSafe(k);
  for(const st of states){
    const sub = st.description||st.ownerRole||'';
    const W = sub?212:168;
    const L = sub ? wrapPx(sub, W-15-11, CW_MONO) : [];
    nodes.push({id:sid(st.key), w:W, h: L.length?subH(L.length):44, meta:{kind:'state', label:st.name||st.key, sub, subLines:L, ref:{k:'entity',id:fl.entityId}}});
  }
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
    const W=Math.max(140,Math.min(262, Math.max(trig.length*7+40, sub.length*6.6+30)));
    const L = sub ? wrapPx(sub, W-15-11, CW_MONO) : [];
    const tn='tr'+i; nodes.push({id:tn, w:Math.round(W), h: L.length?subH(L.length):40, meta:{kind:'trigger', label:trig, sub, subLines:L, ref:{k:'entity',id:fl.entityId}}});
    edges.push({from:sid(t.from), to:tn, kind:'spine'});
    edges.push({from:tn, to:sid(t.to), kind:'branch'});
    // An effect's own description goes on its own wrapped lines rather than being
    // glued onto the title, where it used to be cut off with an ellipsis.
    (t.effects||[]).forEach((ef,j)=>{
      const en='ef'+i+'_'+j, head=effHead(ef,m), desc=ef.description?String(ef.description):'';
      const W=Math.max(160,Math.min(272, Math.max(head.length*7+40, desc.length*6.6/2+40)));
      const L = desc ? wrapPx(desc, W-15-11, CW_MONO) : [];
      // An effect belongs to its transition and leads nowhere else, so the canvas
      // renderer folds it inside — the picture stays "state → transition → state"
      // and what fires is one click in.
      nodes.push({id:en, w:Math.round(W), h: L.length?subH(L.length):40, meta:{kind:'effect', ownedBy:tn, label:head, sub:desc, subLines:L, ref: ef.entityId?{k:'entity',id:ef.entityId}:{k:'entity',id:fl.entityId}}});
      edges.push({from:tn, to:en, kind:'effect'});
    });
  });
  return {direction:'DOWN', nodes, edges};
}

function graphProcess(p, m, hi){
  const nodes=[], edges=[]; const steps=p.steps||[];
  steps.forEach((st,i)=>{
    const kind = st.refKind==='entity'?'entity' : st.refKind==='route'?'route' : st.refKind==='event'?'event' : st.refKind==='frontend'?'frontend' : 'function';
    const desc = st.note || refDesc(st.refKind, st.refId, m) || st.refKind;
    const sub = desc+(st.refId===hi?'  ◄':'');
    const L = wrapPx(sub, 218-15-11, CW_MONO);
    nodes.push({id:'ps'+i, w:218, h: L.length?subH(L.length):44, meta:{kind, label:resolveRef(st.refKind,st.refId,m), sub, subLines:L, ref:{k:st.refKind,id:st.refId}}});
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
// Quotes MUST be escaped too: model data (including a teammate's shared model, which
// arrives over the network) is interpolated into HTML/SVG attributes like data-cid="…",
// and a value containing a quote would otherwise inject attributes into the page.
function esc(s){ return String(s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function fmtTime(iso){ try{ const d=new Date(iso); if(isNaN(d)) return iso; return d.toLocaleString('en-GB',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}); }catch{ return iso; } }
async function refreshTasks(pathStr){
  let d; try{ d = await (await fetch('/api/tasks?path='+encodeURIComponent(pathStr))).json(); }catch{ return; }
  if (selected !== pathStr) return;               // switched to another project
  const cont = document.getElementById('taskList'); if(!cont) return;
  const tasks = d.tasks || [];
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
  if(!confirm('Remove “'+displayName(p)+'” from the list?\n\nThe folder on disk is NOT deleted — only the card is removed.')) return;
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
  if(!ov){ ov=document.createElement('div'); ov.id='addOverlay'; ov.className='ctx-overlay'; overlayHost().appendChild(ov); }
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
  mountOverlay(ov).classList.add('show');
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
// Dashboard chrome. A shared view has no project list, no search and nothing to refresh
// on focus — these elements do not exist on that page.
if(!SHARE){
  document.getElementById('addBtn').addEventListener('click', openAddModal);
  searchEl.addEventListener('input', renderList);
  window.addEventListener('focus', ()=>load(true)); // refresh folder status on return
}

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

/* ---------------- preview & pick (client) ---------------- */
let PREVIEW_OK = true;
let PV_ORIGIN = '';   // preview is served from a different host, see /api/env
let pvPicked = null;
// A literal backtick would terminate the HTML template this script is emitted from.
const TICK = String.fromCharCode(96);
function pvMem(){ try{ return JSON.parse(localStorage.getItem('gitmir.preview')||'{}'); }catch{ return {}; } }
function pvRemember(u){ if(!selected) return; const m=pvMem(); m[selected]=u; try{ localStorage.setItem('gitmir.preview', JSON.stringify(m)); }catch{} }
function pvInit(){
  const go=document.getElementById('pvGo'), pick=document.getElementById('pvPick'),
        input=document.getElementById('pvUrl'), frame=document.getElementById('pvFrame');
  if(!go) return;
  if(go.dataset.wired){                       // already bound; just restore what was open
    if(!frame.src && input.value.trim()) pvOpen(input.value.trim());
    return;
  }
  go.dataset.wired='1';
  // Reopen whatever this project was last pointed at, so switching tabs or projects
  // does not throw the page away.
  const eg=document.getElementById('pvEg');
  if(eg && !eg.childElementCount){
    // Starting points that actually work: this dashboard, and the usual dev-server port.
    for(const u of ['http://localhost:4599/', 'http://localhost:3000/', 'https://example.com/']){
      // Plain string ops on purpose: a slash escape in a regex would not survive
      // being emitted from the HTML template literal below.
      let lbl=u; const q=lbl.indexOf('://'); if(q>=0) lbl=lbl.slice(q+3);
      if(lbl.endsWith('/')) lbl=lbl.slice(0,-1);
      const b2=document.createElement('button'); b2.className='pv-egb'; b2.textContent=lbl;
      b2.addEventListener('click', ()=>pvOpen(u)); eg.appendChild(b2);
    }
  }
  const last=pvMem()[selected];
  if(last && !input.value){ input.value=last; pvOpen(last); }
  const load=()=>{ const v=input.value.trim(); if(v) pvOpen(v); };
  go.addEventListener('click', load);
  input.addEventListener('keydown', e=>{ if(e.key==='Enter') load(); });
  pick.addEventListener('click', ()=> pvSetPick(!pick.classList.contains('on')));
}
function pvOpen(v){
  const input=document.getElementById('pvUrl'), frame=document.getElementById('pvFrame'),
        pick=document.getElementById('pvPick'), empty=document.getElementById('pvEmpty');
  if(!frame) return;
  if(!/^https?:/i.test(v)) v='https://'+v;   // no slashes: an escaped / would not survive the template
  input.value=v; pvRemember(v);
  if(empty) empty.style.display='none';
  const wrap=frame.parentElement; if(wrap) wrap.classList.add('loaded');
  frame.classList.add('on');
  frame.src=PV_ORIGIN+'/api/preview?url='+encodeURIComponent(v);
  if(pick) pick.disabled=false;
  pvSetPick(false);
  const box=document.getElementById('pvPicked'); if(box) box.innerHTML='';
}
let pvAck=null;
function pvSetPick(on){
  const pick=document.getElementById('pvPick'), frame=document.getElementById('pvFrame');
  if(!pick||!frame) return;
  pick.classList.toggle('on', on);
  pick.textContent = on ? '◉ Click an element…' : '◎ Select';
  try{ frame.contentWindow.postMessage({type: on?'gitmir:pick-on':'gitmir:pick-off'}, '*'); }catch{}
  // Do not let the button claim it is armed when the picker never answered — that is
  // indistinguishable from "hovering does nothing" and looks like the feature is broken.
  clearTimeout(pvAck);
  if(on) pvAck=setTimeout(()=>{
    const b=document.getElementById('pvPick');
    if(b && b.classList.contains('on')){
      b.classList.remove('on'); b.textContent='◎ Select';
      toast('The picker is not running on this page — press Go to reload it.', true);
    }
  }, 1200);
}
// The preview frame is sandboxed without allow-same-origin, so its origin is "null".
// Trust it by identity (the window we created), not by origin string.
window.addEventListener('message', async (e)=>{
  const frame=document.getElementById('pvFrame');
  if(!frame || e.source!==frame.contentWindow) return;
  const d=e.data||{};
  if(d.type==='gitmir:pick-state'){ clearTimeout(pvAck); const b=document.getElementById('pvPick');
    if(b){ b.classList.toggle('on', !!d.on); b.textContent = d.on ? '◉ Click an element…' : '◎ Select'; } return; }
  if(d.type==='gitmir:pick-cancelled'){ pvSetPick(false); return; }
  if(d.type!=='gitmir:picked') return;
  pvSetPick(false);
  pvPicked=d;
  await pvRenderPicked(d);
});
// Picking an element builds the text you paste into Claude Code and puts it straight
// on the clipboard, then shows it so you can see exactly what was copied.
function pvText(d, hits, model, what){
  const c=d.candidates||{};
  const L=[];
  // The element itself comes first — that is what the agent has to recognise. Then
  // the facts about it, then where it lives, then what to do.
  L.push('## The element I picked (with everything inside it)');
  L.push(TICK+TICK+TICK+'html');   // literal backticks would end the template
  L.push(d.html || '');
  L.push(TICK+TICK+TICK);
  L.push('');
  L.push('## What it is');
  L.push('- page: ' + (d.url||''));
  L.push('- tag: ' + (d.tag||'?') + ((c.classes&&c.classes.length) ? ' · classes: ' + c.classes.slice(0,8).join(' ') : ''));
  if(c.text) L.push('- visible text: "' + c.text.slice(0,200) + '"');
  if(c.testid) L.push('- data-testid: ' + c.testid);
  if(c.id) L.push('- id: ' + c.id);
  if(c.aria) L.push('- aria-label: ' + c.aria);
  if(d.attrs && d.attrs.href) L.push('- href: ' + d.attrs.href);
  L.push('- CSS selector: ' + (d.selector||''));
  if(d.ancestors && d.ancestors.length) L.push('- sits inside: ' + d.ancestors.join(' > '));
  L.push('');
  L.push('## Where it probably lives in this project');
  if(hits && hits.length){
    for(const h of hits.slice(0,14)) L.push('- ' + h.file + ':' + h.line + '  — matched ' + JSON.stringify(h.needle.slice(0,60)));
    L.push('');
    L.push('Those are text matches, not proof — open them and confirm before changing anything.');
  } else {
    L.push('- nothing in this project matched its text, id or classes. It may be rendered from data,');
    L.push('  or this page is not built by this project. Find the source before editing — do not guess a file.');
  }
  if(model && model.length){
    L.push('');
    L.push('From the .gitmir model: ' + model.map(f=>f.name).join(', '));
  }
  L.push('');
  L.push('## Do the following');
  L.push((what && what.trim()) ? what.trim() : '<describe it here, or just type it to Claude after pasting>');
  return L.join('\n');
}

async function pvRenderPicked(d){
  const c=d.candidates||{};
  // Look the element up in the project first, so the copied text carries the files.
  const UTIL=/^(flex|grid|block|inline|hidden|relative|absolute|fixed|w-|h-|p[xytblr]?-|m[xytblr]?-|text-|bg-|border|rounded|shadow|gap-|items-|justify-|font-|leading-|tracking-|space-|max-|min-|overflow|z-|opacity|transition|duration|cursor|select-)/;
  const needles=[];
  if(c.text) needles.push(c.text.slice(0,80));
  if(c.text){ const plain=c.text.replace(/[^p{L}p{N} ]/gu,'').trim(); if(plain && plain!==c.text) needles.push(plain.slice(0,80)); }
  if(c.testid) needles.push(c.testid);
  if(c.id) needles.push(c.id);
  for(const cl of (c.classes||[])) if(cl.length>3 && !UTIL.test(cl)) needles.push(cl);
  let r={hits:[],fromModel:[],searched:0};
  try{ r=await (await fetch('/api/preview-find',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({path:selected, needles})})).json(); }catch{}
  pvPicked._hits=r.hits||[]; pvPicked._model=r.fromModel||[];
  const text=pvText(d, r.hits, r.fromModel);
  pvPicked._text=text;

  // Try to copy immediately. A message from the frame is not a user gesture, so the
  // browser may refuse — say which happened instead of claiming success.
  let copied=false;
  try{ await copyToClipboard(text); copied=true; }catch{}

  let ov=document.getElementById('pvOverlay');
  if(!ov){ ov=document.createElement('div'); ov.id='pvOverlay'; ov.className='ctx-overlay'; overlayHost().appendChild(ov); }
  ov.innerHTML=
    '<div class="ctx-modal">'+
      '<div class="ctx-head"><div class="ctx-title">'+esc(d.tag||'element')+(c.text?' — “'+esc(c.text.slice(0,60))+'”':'')+'</div>'+
        '<button class="ctx-x" title="Close (Esc)">✕</button></div>'+
      '<div class="ctx-note">'+(copied
        ? '✓ Copied to the clipboard — paste it into Claude Code (⌘V + Enter) and it will know which element you mean.'
        : 'Press <b>Copy</b> below, then paste it into Claude Code (⌘V + Enter).')+'</div>'+
      '<pre class="ctx-pre" id="pvPre">'+esc(text)+'</pre>'+
      '<div class="ctx-taskl">What should change about this element?</div>'+
      '<textarea class="ctx-task" id="pvWhat" placeholder="e.g. make this image lazy-load and give it an alt text"></textarea>'+
      '<div class="ctx-actions">'+
        '<button class="run pv-copy">📋 '+(copied?'Copy again':'Copy')+'</button>'+
        '<button class="ghost pv-task">＋ Queue as a task</button>'+
        '<button class="del pv-close">Close</button>'+
      '</div>'+
    '</div>';
  mountOverlay(ov).classList.add('show');
  const close=()=>{ ov.classList.remove('show'); ov.innerHTML=''; };
  ov.querySelector('.ctx-x').addEventListener('click', close);
  ov.querySelector('.pv-close').addEventListener('click', close);
  ov.addEventListener('click', e=>{ if(e.target===ov) close(); });
  const what=ov.querySelector('#pvWhat'), pre=ov.querySelector('#pvPre');
  const current=()=> pvText(d, r.hits, r.fromModel, what.value);
  // Keep the preview honest: it shows exactly what a copy would put on the clipboard.
  what.addEventListener('input', ()=>{ pre.textContent=current(); });
  ov.querySelector('.pv-copy').addEventListener('click', async ()=>{
    try{ await copyToClipboard(current()); toast('Copied ✓  paste into Claude Code'); }catch{ toast('Could not copy — select the text and copy it', true); }
  });
  ov.querySelector('.pv-task').addEventListener('click', ()=>{
    const w=what.value.trim();
    if(!w){ toast('Say what should change first', true); what.focus(); return; }
    close(); pvQueueTask(current(), d, w);
  });
  setTimeout(()=>{ try{ what.focus(); }catch{} }, 30);
}
// Optional: the same text, dropped into the queue instead of the clipboard.
async function pvQueueTask(text, d, what){
  const c=(d && d.candidates)||{};
  const title=(what && what.trim()) ? what.trim().split('\n')[0].slice(0,80)
            : ((c.text ? c.text.slice(0,60) : (d && d.tag) || 'element') + ' — from the page');
  const content='# '+title+'\n\n## Context\nPicked from '+((d&&d.url)||'')+' in the Preview tab.\n\n'+text+'\n';
  const r=await (await fetch('/api/task',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({path:selected, title, content})})).json();
  if(r.ok){ toast('Task created in tasks/todo ✓'); if(activeTab==='queue') loadQueue(selected); }
  else toast('Failed: '+(r.error||'error'), true);
}


/* ---------------- team bridge (client) ---------------- */
let teamState=null, teamSeenTaskT=null, teamSeenModelT=null, RELAY_URL_DEFAULT='ws://localhost:4600';
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
  +   '<div class="team-lede">Connect this machine to your team through the GitMir relay. The relay only <b>routes</b> — your model and tasks move between your team\'s machines and nothing is stored on our servers. Requires a paid Team plan.</div>'
  +   '<div class="field"><label>Workspace key</label><input class="ti" id="teamKey" placeholder="wsk_…" autocomplete="off" spellcheck="false"></div>'
  +   '<div class="field"><label>Display name</label><input class="ti" id="teamName" placeholder="Your name"></div>'
  +   '<div class="field"><label>Project ID <span class="lbl-hint">from the Team bridge panel at ide.gitmir.com — this is the room</span></label><input class="ti" id="teamPid" placeholder="e.g. cms0a1b2c3" autocomplete="off" spellcheck="false"></div>'
  +   '<div class="field"><label>Bind to project <span class="lbl-hint">the local folder this machine works in</span></label><select class="ti" id="teamProj"></select></div>'
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
  +   '<div class="team-mirror" id="teamMirror"></div>'
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
  view.querySelector('#teamPid').value = mem.projectId || '';
  view.querySelector('#teamUrl').value = mem.url || (teamState && teamState.url) || RELAY_URL_DEFAULT;
  view.querySelector('#teamConnectBtn').addEventListener('click', teamDoConnect);
}
async function teamDoConnect(){
  const view=document.getElementById('teamView'); if(!view) return;
  const key=view.querySelector('#teamKey').value.trim();
  const name=view.querySelector('#teamName').value.trim();
  const path=view.querySelector('#teamProj').value;
  const projectId=view.querySelector('#teamPid').value.trim();
  const url=view.querySelector('#teamUrl').value.trim();
  if(!key){ toast('Enter a workspace key', true); return; }
  saveTeamMem({key,name,url,path,projectId});
  const cs=view.querySelector('#teamCStatus'); if(cs) cs.innerHTML='<span class="team-connecting">connecting…</span>';
  try{
    const r=await (await fetch('/api/team/connect',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key,name,path,projectId,url})})).json();
    teamState=r.status||teamState;
  }catch{ toast('Connect failed', true); }
  teamPoll();
}
function wireLive(){
  const view=document.getElementById('teamView'); if(!view) return;
  view.querySelector('#teamShareBtn').addEventListener('click', async ()=>{
    // One honest line: at 'full' the snapshot is kept on GitMir, not just passed on.
    if(teamState && teamState.sharing==='full' && !sessionStorage.getItem('gm.fullWarn')){
      sessionStorage.setItem('gm.fullWarn','1');
      toast('Note: this project mirrors at "full" — the model snapshot is stored on GitMir, not only passed to teammates.');
    }
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
// The owner flips this switch, but it is THIS machine that uploads — so it is stated
// plainly and always, never behind a tooltip. Spec 4.3.
function mirrorHtml(s){
  const lvl=s.sharing||'local';
  const label={local:'Nothing leaves this machine',tasks:'This project mirrors: the task queue',full:'This project mirrors: the task queue + the product model'}[lvl]
    || 'Nothing leaves this machine';
  const note={local:'The relay routes between your machines live and keeps nothing.',
              tasks:'Task titles, bodies, status and acceptance criteria are stored on GitMir so your team can follow along. Source code never is.',
              full:'Tasks and a snapshot of .gitmir/model are stored on GitMir. Source code never is.'}[lvl]||'';
  return '<div class="mirror-hd"><span class="mirror-dot '+esc(lvl)+'"></span><b>'+esc(label)+'</b>'
    + '<span class="mirror-lvl">'+esc(lvl)+'</span></div>'
    + '<div class="mirror-note">'+esc(note)+' Set by the project owner at ide.gitmir.com — it cannot be changed from here.</div>';
}
function teamUpdateDynamic(s){
  const mir=document.getElementById('teamMirror'); if(mir) mir.innerHTML=mirrorHtml(s);
  const dyn=document.getElementById('teamDyn'); if(dyn) dyn.innerHTML=activityHtml(s.activity);
  const mem=document.getElementById('teamMembers');
  if(mem) mem.innerHTML=(s.members||[]).map(x=> '<span class="team-chip'+(s.self&&x.id===s.self.id?' me':'')+'">'+esc(x.name)+'</span>').join('') || '<span class="team-empty">just you — waiting for teammates to join…</span>';
  const cs=document.getElementById('teamCStatus');
  if(cs) cs.innerHTML = s.error ? '<span class="team-err">✕ '+esc(s.error)+'</span>'
                       : (s.connecting?'<span class="team-connecting">connecting…</span>':'');
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
  // A teammate's model arriving used to be invisible unless the Model tab was open.
  const rx=(s.activity||[]).filter(a=> a.kind==='model' && /^received /.test(a.text));
  const newestM = rx.length ? rx[0].t : null;
  if(teamSeenModelT===null){ teamSeenModelT=newestM; }
  else if(newestM && newestM>teamSeenModelT){
    teamSeenModelT=newestM;
    const who=(rx[0].text.match(/from (.+?) →/)||[])[1]||'a teammate';
    toast('⇪ '+who+' shared their model — see the Model tab');
    if(selected && activeTab==='model') loadModel(selected);   // pick up the new source
  }
  if(activeTab==='team') renderTeam();
}

document.addEventListener('keydown', (e)=>{ if(e.key==='Escape'){ fsClose(); for(const id of ['ctxOverlay','addOverlay','taskOverlay','pvOverlay']){ const o=document.getElementById(id); if(o){ o.classList.remove('show'); o.innerHTML=''; } } } });

// ---------- boot ----------
// A shared view has no projects to list, no bridge to poll and no environment to ask
// about — every one of those calls would 404 on a page served from somewhere else.
function bootShare(){
  modelData = { exists:true, model:SHARE.model||{}, index:SHARE.index||null,
                brief:SHARE.brief||null, shared:[], stale:null, ingest:null, src:null };
  const nm=document.getElementById('shareName');
  if(nm) nm.textContent = SHARE.name || (SHARE.index && SHARE.index.project) || 'Product model';
  const at=document.getElementById('shareAt');
  if(at && SHARE.index && SHARE.index.at) at.textContent = 'model built '+fmtTime(SHARE.index.at);
  renderModelNav();
  renderModelView();
}
if(SHARE){ bootShare(); }
else {
  fetch('/api/env').then(r=>r.json()).then(d=>{ PICKER_OK = !!d.pickerAvailable; if(d.relayUrl) RELAY_URL_DEFAULT=d.relayUrl; if(d.previewOrigin) PV_ORIGIN=d.previewOrigin; if(d.preview===false){ PREVIEW_OK=false; renderDetail(); } }).catch(()=>{});
  loadSkillsList();
  load();
  teamPoll();
  setInterval(teamPoll, 3500);
}


/* =========================================================================
   Change reach — what a piece of work touches, and what that reaches.

   The model says how the product works now. It cannot, on its own, answer
   "what will this change break", because that question is about a proposed
   change and the model has no notion of one. These functions supply it: a
   task names the objects it will touch, and the graph says what sits
   downstream of those objects.
   ========================================================================= */

let changesData = null;              // {tasks, history, heat, knownIds}
let changesFor  = null;              // the project path changesData belongs to


/* ---------------- Impact — what a piece of work changes, before it runs ---------------- */
let impactPick = null;               // file name of the selected task, or '__adhoc'
let adhocIds = [];                   // objects picked by hand for a what-if estimate

async function loadChanges(force){
  const p = selected; if(!p) return null;
  if(!force && changesData && changesFor===p) return changesData;
  try{
    const r = await fetch('/api/changes?path='+encodeURIComponent(p));
    changesData = await r.json(); changesFor = p;
  }catch{ changesData=null; }
  return changesData;
}

const COL_LABEL = { todo:'todo', inprogress:'running', verify:'verify', done:'done' };

async function renderImpact(view, m, seq){
  // A shared model is a snapshot of someone else's product; their task queue does not
  // travel with it, so there is nothing to compute a radius over.
  if(modelSrc){ view.innerHTML='<div class="model-empty">Impact is computed from this project’s own task queue. Switch the source back to your model to see it.</div>'; return; }
  // With no model there is nothing to compute a radius against, and saying "write a
  // Touches: line" would send someone to fix the wrong thing.
  if(!(m.modules||[]).length && !(m.entities||[]).length && !(m.serverFunctions||[]).length){
    view.innerHTML='<div class="model-empty">There is no model for this project yet. Build one with the <b>gitmir-model</b> skill — impact is measured against it.</div>';
    return;
  }
  view.innerHTML='<div class="model-empty">Reading the queue…</div>';
  const ch = await loadChanges(true);
  if(!viewAlive(seq)) return;
  if(!ch || !ch.tasks || !ch.tasks.length){
    view.innerHTML='<div class="model-empty">No tasks in <code>tasks/</code> yet. Plan some with the <b>task-planner</b> skill and this fills in.</div>';
    return;
  }
  const withIds = ch.tasks.filter(t=>t.ids.length);
  if(!withIds.length){
    view.innerHTML='<div class="model-empty">'+ch.tasks.length+' task(s), none of them naming an object from the model. '+
      'The <b>task-planner</b> skill writes a <code>Touches:</code> line with the ids a task will change — that line is what this view reads.</div>';
    return;
  }
  if(impactPick!=='__adhoc' && !withIds.some(t=>t.file===impactPick)) impactPick = withIds[0].file;

  const rows = withIds.map(t=>{
    const br = blastRadius(t.ids, m);
    return { t, br, risk: riskOf(br, m) };
  });
  const adhocRow = ()=>{
    const br=blastRadius(adhocIds, m);
    return { t:{file:'__adhoc', col:'', title:'What if we change…', ids:adhocIds, declared:true, approved:null, adhoc:true},
             br, risk:riskOf(br,m) };
  };

  let html=viewHead('impact')+'<div class="imp-wrap"><div class="imp-list">';
  html+='<div class="imp-list-h">'+withIds.length+' task(s) that name part of the model</div>';
  html+='<button class="imp-item adhoc'+(impactPick==='__adhoc'?' on':'')+'" data-f="__adhoc">'+
    '<span class="imp-col">what if</span><span class="imp-t">Estimate a change by hand</span></button>';
  for(const r of rows){
    html+='<button class="imp-item'+(r.t.file===impactPick?' on':'')+'" data-f="'+esc(r.t.file)+'">'+
      '<span class="imp-col '+esc(r.t.col)+'">'+esc(COL_LABEL[r.t.col]||r.t.col)+'</span>'+
      '<span class="imp-t">'+esc(r.t.title)+'</span>'+
      (r.t.approved?'<span class="imp-ok" title="'+esc(r.t.approved)+'">✓</span>':'')+
      '<span class="imp-r '+r.risk.level+'">'+esc(r.risk.level)+'</span>'+
      '</button>';
  }
  html+='</div><div class="imp-detail" id="impDetail"></div></div>';
  view.innerHTML=html;
  const pickRow=()=> impactPick==='__adhoc' ? adhocRow() : rows.find(r=>r.t.file===impactPick);
  view.querySelectorAll('.imp-item').forEach(b=>b.addEventListener('click',()=>{
    impactPick=b.dataset.f;
    view.querySelectorAll('.imp-item').forEach(x=>x.classList.toggle('on', x.dataset.f===impactPick));
    drawImpactDetail(pickRow(), m);
  }));
  drawImpactDetail(pickRow(), m);
}

function drawImpactDetail(row, m){
  const box=document.getElementById('impDetail'); if(!box||!row) return;
  const { t, br, risk } = row;
  const got=k=>(br.byKind[k]||[]);
  const direct=k=>got(k).filter(x=>x.d===0).length;
  const states=got('statusFlow').reduce((s,x)=>{ const fl=objById(x.id,m); return s+((fl&&fl.states||[]).length); },0);
  const cards=[
    ['Business objects', got('entity').length, direct('entity')],
    ['Methods',          got('function').length, direct('function')],
    ['Events',           got('event').length, direct('event')],
    ['States',           states, null],
    ['API endpoints',    got('route').length, direct('route')],
    ['Screens',          got('frontend').length, direct('frontend')],
    ['Journeys',         got('process').map(x=>objById(x.id,m)).filter(p=>p&&isJourney(p)).length, null],
    ['Modules',          br.modules.length, null],
  ];
  let h='<div class="imp-head"><div class="imp-title">'+esc(t.title)+'</div>'+
    '<div class="imp-sub">'+(t.adhoc
      ? 'Pick the objects a change would touch and read the same analysis a queued task gets.'
      // Where the numbers come from decides how much to trust them, so it is a label
      // rather than a clause in a grey sentence someone has to find.
      : '<span class="imp-src '+(t.declared?'yes':'no')+'">'+(t.declared?'declared':'inferred')+'</span>'+
        '<code>tasks/'+esc(t.col)+'/'+esc(t.file)+'</code> · '+(t.declared
          ? 'the task named these on its <code>Touches:</code> line'
          : 'taken from every model id the task mentions — add a <code>Touches:</code> line for a deliberate one'))+
    '</div></div>';

  if(t.adhoc) h+='<div class="imp-sec">Objects</div>'+
    '<input class="imp-search" id="impSearch" placeholder="Type a name — entity, function, endpoint, screen, event…" autocomplete="off">'+
    '<div class="imp-sugg" id="impSugg"></div>';
  // What was named, not what naming it expanded into: picking one area walks its whole
  // contents, and showing forty chips for one choice would be unreadable — and, in the
  // what-if, unclickable, since removing a chip removes what was picked.
  const named=(t.ids||[]).filter(id=>objById(id,m));
  h+='<div class="imp-sec">Changes directly</div><div class="imp-chips">';
  if(!named.length) h+='<span class="imp-none">Nothing picked yet.</span>';
  for(const id of named) h+='<button class="imp-chip'+(t.adhoc?' rm':'')+'" data-id="'+esc(id)+'"><span class="k">'+esc(kindOf(id)||'')+'</span>'+esc(labelOf(id,m))+
    (kindOf(id)==='module'?'<span class="k">area — everything in it</span>':'')+(t.adhoc?'<span class="x">✕</span>':'')+'</button>';
  h+='</div>';

  h+='<div class="imp-sec">Impact analysis <span class="imp-note">everything within '+br.hops+' hops of that, counted from the model’s own links</span></div>';
  h+='<div class="imp-grid">';
  for(const [l,n,d] of cards) h+='<div class="imp-card"><div class="imp-n">'+n+'</div><div class="imp-l">'+esc(l)+'</div>'+
    (d!=null&&d>0&&d<n?'<div class="imp-d">'+d+' directly</div>':'')+'</div>';
  h+='</div>';

  // Before the picture and before the risk table: somebody about to approve this
  // needs to know the ground it lands on is already not doing what it promises.
  {
    const reached=new Set([].concat(br.seed||[], [...(br.dist||new Map()).keys()]));
    const hit=(findingsData.findings||[]).filter(f=>f.status==='open'&&(f.touches||[]).some(id=>reached.has(id)));
    if(hit.length){
      const direct=hit.filter(f=>(f.touches||[]).some(id=>(br.seed||[]).includes(id)));
      h+='<div class="imp-bad"><div class="imp-bad-h">'+hit.length+' known deviation'+(hit.length>1?'s':'')+
        ' in what this reaches'+(direct.length?' — '+direct.length+' on what it changes directly':'')+'</div>'+
        hit.slice(0,6).map(f=>'<div class="imp-bad-i"><b>'+esc(f.severity)+'</b>'+esc(f.rule)+
          (f.source?' <i>('+esc(f.source)+')</i>':'')+'<span>'+esc(f.actual)+'</span></div>').join('')+
        (hit.length>6?'<div class="imp-bad-i">…and '+(hit.length-6)+' more, in Spec vs code.</div>':'')+
        '<div class="imp-bad-f">Changing something that already breaks a rule is the cheapest moment to fix it, and the last moment anybody is looking.</div>'+
      '</div>';
    }
  }

  h+='<div class="imp-sec">What it reaches, drawn</div><div class="imp-graph" id="impGraph"></div>';

  h+='<div class="imp-risk '+risk.level+'"><div class="imp-risk-h"><span class="imp-risk-l">Business risk</span>'+
     '<span class="imp-risk-v">'+esc(risk.level)+'</span>'+
     '<span class="imp-risk-s">reaches '+Math.round(risk.share*100)+'% of the product · '+risk.score+' of '+risk.max+' points</span></div>';
  if(risk.parts.length){
    h+='<table class="imp-risk-t"><tbody>';
    for(const p of risk.parts) h+='<tr><td class="n">'+p.n+' × '+p.w+'</td><td class="l">'+esc(p.l)+'</td><td class="w">'+esc(p.why)+'</td></tr>';
    h+='</tbody></table>';
  } else h+='<div class="imp-risk-none">Nothing downstream of what this touches.</div>';
  h+='</div>';

  const mods=br.modules.map(id=>objById(id,m)).filter(Boolean);
  if(mods.length){
    h+='<div class="imp-sec">Areas affected</div><div class="imp-chips">';
    for(const md of mods) h+='<span class="imp-chip mod">'+esc(md.name||md.id)+(md.owner?'<span class="own">'+esc(md.owner)+'</span>':'')+'</span>';
    h+='</div>';
    if(!mods.some(md=>md.owner)) h+='<div class="imp-appr-h">No owner is recorded for any of these areas. Ownership is a field in the model — <code>owner</code> on a module — and it stays blank until something in the repo says who it is.</div>';
  }
  const procs=got('process').map(x=>objById(x.id,m)).filter(Boolean);
  if(procs.length){
    h+='<div class="imp-sec">Flows that run through it</div><div class="imp-flows">';
    for(const p of procs) h+='<div class="imp-flow'+(isJourney(p)?' j':'')+'"><b>'+esc(p.name||p.id)+'</b>'+
      (isJourney(p)?'<span class="tag">journey</span>':'')+
      '<span class="steps">'+esc((p.steps||[]).map(s=>resolveRef(s.refKind,s.refId,m)).join(' → '))+'</span></div>';
    h+='</div>';
  }
  h+= t.adhoc ? '<div class="imp-actions"><button class="ghost imp-map">Show on map</button><button class="ghost imp-copy">Copy impact</button></div>'
    : '<div class="imp-actions">'+
     (t.approved
       ? '<span class="imp-appr">Approved '+esc(t.approved)+'</span><button class="ghost imp-unappr">Withdraw</button>'
       : '<button class="run imp-appr-b">Approve this change</button>')+
     '<button class="ghost imp-map">Show on map</button>'+
     '<button class="ghost imp-copy">Copy impact</button>'+
     '<button class="ghost imp-open">Open task file</button></div>'+
     (t.approved?'':'<div class="imp-appr-h">Approving writes an <code>Approved:</code> line into the task file. It travels with the task and whoever runs it can see it — including Claude.</div>');
  box.innerHTML=h;
  drawImpactGraph(document.getElementById('impGraph'), named, m, null, t);
  box.querySelectorAll('.imp-chip[data-id]').forEach(b=>b.addEventListener('click',()=>{
    const id=b.dataset.id, k=kindOf(id);
    // In a what-if the chip is the selection, so clicking removes it; elsewhere it opens.
    if(t.adhoc){ adhocIds=adhocIds.filter(x=>x!==id); drawImpactDetail(Object.assign({},row,{br:blastRadius(adhocIds,m)}), m); redrawAdhoc(m); return; }
    if(['entity','function','route','event','frontend','module','process'].includes(k)) openContextPopup(k,id);
  }));
  if(t.adhoc) wireAdhocSearch(m);
  const setAppr=async(undo)=>{
    try{
      const r=await (await fetch('/api/task-approve',{method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({path:selected,col:t.col,file:t.file,undo:!!undo})})).json();
      if(!r.ok){ toast('Could not write to the task file', true); return; }
      t.approved=r.approved; changesData=null; drawImpactDetail(row,m); renderImpact(document.getElementById('modelView'),m);
      toast(undo?'Approval withdrawn':'Approved ✓');
    }catch{ toast('Could not write to the task file', true); }
  };
  const ab=box.querySelector('.imp-appr-b'); if(ab) ab.addEventListener('click',()=>setAppr(false));
  const ub=box.querySelector('.imp-unappr'); if(ub) ub.addEventListener('click',()=>setAppr(true));
  const mp=box.querySelector('.imp-map');
  if(mp) mp.addEventListener('click',()=>{ mapLayer='change'; modelView='map'; renderModelNav(); renderModelView(); });
  const cp=box.querySelector('.imp-copy');
  if(cp) cp.addEventListener('click',()=>{ copyToClipboard(impactText(row,m)); cp.textContent='Copied'; setTimeout(()=>cp.textContent='Copy impact',1200); });
  const op=box.querySelector('.imp-open');
  if(op) op.addEventListener('click',()=>openTaskPopup(selected,t.col,t.file));
}

function impactText(row, m){
  const { t, br, risk }=row; const L=[];
  L.push('# Impact — '+t.title);
  L.push('task: tasks/'+t.col+'/'+t.file+(t.declared?' (Touches: declared)':' (inferred from mentions)'));
  L.push('');
  L.push('## Changes directly');
  for(const id of (t.ids||[]).filter(x=>objById(x,m))) L.push('- '+labelOf(id,m)+'  ('+kindOf(id)+', '+id+')');
  const grp=[['entity','Business objects'],['function','Methods'],['event','Events'],
    ['route','API endpoints'],['frontend','Screens'],['statusFlow','Lifecycles'],['process','Flows']];
  L.push(''); L.push('## Within '+br.hops+' hops');
  for(const [k,l] of grp){ const a=(br.byKind[k]||[]).filter(x=>x.d>0); if(a.length) L.push('- '+l+': '+a.map(x=>labelOf(x.id,m)).join(', ')); }
  L.push(''); L.push('## Areas: '+br.modules.map(id=>labelOf(id,m)).join(', '));
  L.push(''); L.push('## Business risk: '+risk.level+' — reaches '+Math.round(risk.share*100)+'% of the product ('+risk.score+' of '+risk.max+' points)');
  for(const p of risk.parts) L.push('- '+p.n+' × '+p.w+'  '+p.l);
  return L.join('\n');
}

/* ---------------- Timeline — the product changing, in the order it changed ---------------- */
async function renderTimeline(view, m, seq){
  if(modelSrc){ view.innerHTML='<div class="model-empty">The timeline is built from this project’s own queue and task log.</div>'; return; }
  view.innerHTML='<div class="model-empty">Reading the record…</div>';
  const ch=await loadChanges(true);
  if(!viewAlive(seq)) return;
  if(!ch){ view.innerHTML='<div class="model-empty">Could not read the task record.</div>'; return; }
  // Two records exist and they answer different questions: the queue is the plan
  // (ordered by task number), the log is what actually happened (stamped with a time).
  // Show them as one column, log entries carrying their date.
  const items=[];
  for(const h of (ch.history||[])) items.push({ kind:'log', at:h.ts||'', title:h.title, ids:h.touched||[], files:h.files||[], status:h.status });
  for(const t of (ch.tasks||[])){
    // A finished task file has no timestamp inside it, but the runner writes its
    // `## Outcome` just before moving it to done/ — so the file's own mtime is when
    // the work landed. Without it every done task sorts as "no date" and the column
    // reads as if nothing happened in any particular order.
    const at = (t.col==='done' && t.mtime) ? new Date(t.mtime).toISOString() : '';
    items.push({ kind:'task', at, n:t.n, col:t.col, title:t.title, ids:t.ids, file:t.file });
  }
  if(!items.length){ view.innerHTML='<div class="model-empty">Nothing recorded yet — no tasks in <code>tasks/</code> and no <code>.claude/tasks.json</code>.</div>'; return; }
  // The same finished task is often in both records: a file in done/ and an entry in
  // the log. Two rows for one piece of work reads as a bug in the history. Keep the
  // task file — it carries the ids and the outcome — and drop the log twin, matching on
  // the title, which is the only thing both records are guaranteed to share.
  const norm=s=>String(s||'').toLowerCase().replace(/[^a-zа-яёіїєґ0-9]+/gi,' ').trim();
  const logAt=new Map();
  for(const i of items) if(i.kind==='log' && i.at) logAt.set(norm(i.title), i.at);
  const fromQueue=new Set(items.filter(i=>i.kind==='task'&&i.col==='done').map(i=>norm(i.title)));
  // Keep the task file — it has the ids and the outcome — but take the date from the
  // log twin when there is one. A log entry records when the work was done; a file's
  // mtime is only a stand-in for that, and a checkout rewrites it.
  for(const i of items) if(i.kind==='task' && i.col==='done' && logAt.has(norm(i.title))) i.at=logAt.get(norm(i.title));
  const merged=items.filter(i=>!(i.kind==='log' && fromQueue.has(norm(i.title))));
  const done=merged.filter(i=>i.kind==='log'||i.col==='done');
  const rest=merged.filter(i=>!(i.kind==='log'||i.col==='done'));
  done.sort((a,b)=> String(a.at).localeCompare(String(b.at)) || (a.n||0)-(b.n||0));
  rest.sort((a,b)=> (a.n||0)-(b.n||0));
  const ordered=done.concat(rest);

  let h=viewHead('timeline')+'<div class="tl-head">Finished work sits on the date it was done; '+
    'what is still ahead sits in the order it will run.</div><div class="tl">';
  for(const it of ordered){
    // Done work is placed in time; work still ahead is placed in the order it will run.
    const when = it.at ? esc(String(it.at).slice(0,10)) : (it.n?('#'+String(it.n).padStart(3,'0')):'—');
    const state = it.kind==='log' ? (it.status||'log') : (COL_LABEL[it.col]||it.col);
    h+='<div class="tl-row'+(it.kind==='log'?' log':'')+'">'+
      '<div class="tl-when">'+when+'</div>'+
      '<div class="tl-body"><div class="tl-t"><span class="tl-st '+esc(it.kind==='log'?'done':it.col)+'">'+esc(state)+'</span>'+esc(it.title)+'</div>';
    if(it.ids.length){
      h+='<div class="tl-ids">';
      for(const id of it.ids.slice(0,14)) h+='<button class="tl-id" data-id="'+esc(id)+'">'+esc(labelOf(id,m))+'</button>';
      if(it.ids.length>14) h+='<span class="tl-more">+'+(it.ids.length-14)+'</span>';
      h+='</div>';
    } else if(it.files && it.files.length){
      h+='<div class="tl-files">'+esc(it.files.slice(0,6).join(' · '))+'</div>';
    }
    h+='</div></div>';
  }
  h+='</div>';
  view.innerHTML=h;
  view.querySelectorAll('.tl-id').forEach(b=>b.addEventListener('click',()=>{
    const id=b.dataset.id, k=kindOf(id);
    if(['entity','function','route','event','frontend','module','process'].includes(k)) openContextPopup(k,id);
  }));
}

/* ---------------- Events — what happens, and what happens next ---------------- */
// An event graph is not a list of events. The useful shape is the chain: something
// raises OrderPaid, a handler reacts and raises InventoryReserved, and so on. That
// chain exists in the model as emits/subscribes and is drawn here by following it.
function graphEvents(m){
  const evs=m.events||[], fns=(m.serverFunctions||[]).concat(m.frontendUnits||[]);
  const nodes=[], edges=[], have=new Set();
  const put=(id,w,h,meta)=>{ if(have.has(id)) return; have.add(id); nodes.push({id,w,h,meta}); };
  for(const ev of evs){
    const sub=ev.description?String(ev.description):'';
    const W=200, L=sub?wrapPx(sub, W-15-11, CW_MONO):[];
    put('ev_'+mSafe(ev.id), W, L.length?subH(L.length):40,
      {kind:'event', label:ev.name||ev.id, sub, subLines:L, ref:{k:'event',id:ev.id}});
  }
  for(const f of fns){
    const subs=(f.subscribesEventIds||[]).filter(id=>have.has('ev_'+mSafe(id)));
    const emits=(f.emitsEventIds||[]).filter(id=>have.has('ev_'+mSafe(id)));
    if(!subs.length && !emits.length) continue;
    const isFe = f.consumesRouteIds!==undefined;
    const nid='fn_'+mSafe(f.id);
    put(nid, 190, 40, {kind:isFe?'frontend':'function', label:f.name||f.id, sub:'', subLines:[],
      ref:{k:isFe?'frontend':'function', id:f.id}});
    for(const id of subs) edges.push({from:'ev_'+mSafe(id), to:nid, kind:'spine', label:'handles'});
    for(const id of emits) edges.push({from:nid, to:'ev_'+mSafe(id), kind:'effect', label:'raises'});
  }
  return {direction:'RIGHT', nodes, edges};
}

async function renderEvents(view, m, seq){
  const evs=m.events||[];
  if(!evs.length){ view.innerHTML=viewHead('events')+'<div class="model-empty">No domain events recorded. If parts of the product do set each other in motion without calling directly, the model has not learned that yet.</div>'; return; }
  const fns=(m.serverFunctions||[]).concat(m.frontendUnits||[]);
  const orphan=evs.filter(ev=>!fns.some(f=>(f.emitsEventIds||[]).includes(ev.id))
                            && !fns.some(f=>(f.subscribesEventIds||[]).includes(ev.id)));
  view.innerHTML=viewHead('events');
  const cap=document.createElement('div'); cap.className='map-cap';
  cap.innerHTML='Follow a chain left to right: something raises an event, a handler reacts, and that handler raises the next one. '+
    'A long chain is where one change travels furthest.'+
    (orphan.length?'<span class="map-cap2"><b>'+orphan.length+' event(s)</b> with nothing raising or handling them: '+
      esc(orphan.slice(0,8).map(e=>e.name||e.id).join(', '))+(orphan.length>8?'…':'')+
      ' — either dead, or the model has not caught up with the code.</span>':'');
  view.appendChild(cap);
  const d=document.createElement('div'); view.appendChild(d);
  hudRenderSpec(d, graphEvents(m), m, {title:'EVENTS', subtitle:'WHAT RAISES A SIGNAL AND WHAT REACTS TO IT'}, seq);
}

/* ---------------- Decisions — every point where the product chooses ---------------- */
// Conditions live on status-flow transitions and reaction triggers. Scattered across
// diagrams they read as annotations; gathered here they are the business rules.
function graphDecisions(fl, m){
  const nodes=[], edges=[]; const states=fl.states||[], trans=fl.transitions||[];
  const sid=k=>'st_'+mSafe(k);
  for(const st of states){
    const sub=st.description?String(st.description):'';
    const W=Math.max(150,Math.min(240, (String(st.name||st.key).length*8+36)));
    const L=sub?wrapPx(sub, W-15-11, CW_MONO):[];
    nodes.push({id:sid(st.key), w:Math.round(W), h:L.length?subH(L.length):40,
      meta:{kind:'state', label:st.name||st.key, sub, subLines:L, ref:{k:'entity',id:fl.entityId}}});
  }
  trans.forEach((t,i)=>{
    const cond=String(t.condition||'').trim();
    if(cond){
      const did='dc'+i;
      const head=t.label||'decide';
      const W=Math.max(170,Math.min(280, cond.length*6.6+40));
      const L=wrapPx(cond, W-15-11, CW_MONO);
      nodes.push({id:did, w:Math.round(W)+30, h:subH(L.length),
        meta:{kind:'decision', label:head, sub:cond, subLines:L, ref:{k:'entity',id:fl.entityId}}});
      edges.push({from:sid(t.from), to:did, kind:'spine'});
      edges.push({from:did, to:sid(t.to), kind:'branch', label:'holds'});
    } else {
      edges.push({from:sid(t.from), to:sid(t.to), kind:'spine', label:String(t.label||t.byRole||'').slice(0,24)});
    }
  });
  return {direction:'DOWN', nodes, edges};
}

async function renderDecisions(view, m, seq){
  const flows=(m.statusFlows||[]).filter(fl=>(fl.transitions||[]).some(t=>(t.condition||'').trim()));
  const rx=(m.reactions||[]).filter(r=>r.trigger&&(r.trigger.change||r.trigger.fieldName));
  if(!flows.length && !rx.length){
    view.innerHTML=viewHead('decisions')+'<div class="model-empty">No decision points recorded. They come from a <code>condition</code> on a lifecycle transition and from reaction triggers — if the product does branch and none are here, the model has not learned them yet.</div>';
    return;
  }
  if(!decisionPick || !flows.some(f=>f.id===decisionPick)) decisionPick=(flows[0]||{}).id;
  view.innerHTML=viewHead('decisions');
  if(flows.length){
    view.appendChild(subjectPicker(flows.map(f=>({id:f.id,label:f.name||f.id,title:f.description||''})),
      decisionPick, (id)=>{ decisionPick=id; renderDecisions(view, m); }));
    const fl=flows.find(f=>f.id===decisionPick);
    const block=document.createElement('div'); block.className='proc-block';
    block.innerHTML='<div class="proc-title">'+esc(fl.name||fl.id)+'</div>'+
      (fl.description?'<div class="proc-desc">'+esc(fl.description)+'</div>':'')+
      '<div class="proc-diagram"></div>';
    view.appendChild(block);
    if(seq!=null && !viewAlive(seq)) return;
    hudRenderSpec(block.querySelector('.proc-diagram'), graphDecisions(fl, m), m,
      {title:'DECISIONS — '+String(fl.name||'').toUpperCase(), subtitle:'EVERY BRANCH AND THE CONDITION ON IT'}, seq);
  }
  if(rx.length){
    const r=document.createElement('div'); r.className='jr-group';
    r.innerHTML='<div class="jr-group-t">Reactions</div><div class="jr-group-h">'+rx.length+
      ' rule(s) that fire on a change rather than on a branch — a decision the product makes without anyone asking.</div>';
    view.appendChild(r);
  }
}

function mapLayerBar(data){
  const bar=document.createElement('div'); bar.className='lay-bar';
  // The legend is written by whatever computed the layer, so it can say what it
  // actually found — "no task has named an object yet" rather than a generic sentence.
  // The explanation lives in the caption below, where it is read. Repeating it here in
  // grey next to the buttons is where it went to be ignored.
  bar.innerHTML='<span class="lay-l">Layer</span>'+
    MAP_LAYERS.map(l=>'<button class="lay'+(mapLayer===l.key?' on':'')+'" data-k="'+l.key+'">'+esc(l.label)+'</button>').join('');
  bar.addEventListener('click',(e)=>{
    const k=e.target&&e.target.dataset&&e.target.dataset.k; if(!k||k===mapLayer) return;
    mapLayer=k; renderModelView();
  });
  return bar;
}

// One number per module, plus the wording that says what the number means. Each layer
// is computed, never declared — except ownership, which is only ever what the model says.
async function mapLayerData(m){
  if(mapLayer==='change'){
    const ch=await loadChanges(false);
    const task=((ch&&ch.tasks)||[]).find(x=>x.file===impactPick);
    const ids = task ? task.ids : (impactPick==='__adhoc' ? adhocIds : []);
    const what = task ? '“'+task.title+'”' : (ids.length===1 ? '“'+labelOf(ids[0],m)+'”' : 'The objects picked in Impact');
    if(!ids.length) return { kind:'change', per:new Map(), legend:'Pick a task on the Impact view first — this layer lights up where that one lands.' };
    const br=blastRadius(ids, m);
    const per=new Map();
    for(const id of br.seed){ const md=moduleOf(id,m); if(md) per.set(md,{n:2}); }
    for(const id of br.dist.keys()){ const md=moduleOf(id,m); if(md && !per.has(md)) per.set(md,{n:1}); }
    for(const [k,v] of per) per.set(k,{text: v.n===2?'changed here':'downstream', t: v.n===2?1:0.42});
    // The areas alone answer "somewhere in here". Which objects were reached is
    // the question a developer actually has, so the ids travel with the layer
    // and the map marks them inside each area.
    const seedSet=new Set(br.seed);
    const reach=new Map();
    for(const [id,d] of br.dist) if(kindOf(id)!=='field') reach.set(id,d);
    // Which object the question was asked about. On the map it is drawn in its
    // own colour: after the jump from the popup it would otherwise look like
    // every other thing the change happens to reach.
    return { kind:'change', per, reach, seeds:seedSet, origin: ids.length===1 ? ids[0] : null,
      legend: what+' — solid where it changes something, faint where the change arrives on its own.' };
  }
  if(mapLayer==='owner'){
    const out=new Map();
    for(const mod of (m.modules||[])) if(mod.owner) out.set(mod.id, {text:String(mod.owner).slice(0,40), t:1});
    return { kind:'owner', per:out, legend:'Owner as recorded in the model. Blank means nobody is recorded — not that nobody owns it.' };
  }
  if(mapLayer==='heat'){
    const ch=await loadChanges(false);
    const heat=(ch&&ch.heat)||{};
    const per=new Map(); let max=0;
    for(const [id,n] of Object.entries(heat)){
      const mod=moduleOf(id,m); if(!mod) continue;
      const v=(per.get(mod)||{n:0}).n+n; per.set(mod,{n:v}); if(v>max) max=v;
    }
    for(const [k,v] of per) per.set(k, {text:v.n+' touch'+(v.n===1?'':'es'), t: max?v.n/max:0});
    return { kind:'heat', per, legend: max
      ? 'How many tasks have named an object in that area. Brightest is the most worked-on part of the product.'
      : 'No task has named an object from the model yet, so nothing is warm.' };
  }
  // risk: what changing anything in this area would reach
  const per=new Map(); let max=0;
  for(const mod of (m.modules||[])){
    const seeds=[];
    for(const k of ['entities','serverFunctions','apiRoutes','frontendUnits','events'])
      for(const o of (m[k]||[])) if(moduleOf(o.id,m)===mod.id) seeds.push(o.id);
    if(!seeds.length){ continue; }
    const r=riskOf(blastRadius(seeds, m, 1), m);
    per.set(mod.id, {n:r.score, level:r.level});
    if(r.score>max) max=r.score;
  }
  for(const [k,v] of per) per.set(k, {text:v.level+' · '+v.n, t: max?v.n/max:0});
  return { kind:'risk', per, legend:'What a change anywhere in the area would reach, scored the same way a task is. High means the area is entangled with the rest of the product.' };
}

/* ---------------- The object card — what it reaches, who may use it, what has changed it ---------------- */
// The context text below this is for Claude. This part is for the person reading:
// three questions the model can answer about any object without opening code.
function objectFacts(kind, id, m){
  const o=objById(id,m); if(!o) return '';
  const br=blastRadius([id], m, 1);
  const down=[...br.dist.entries()].filter(([,d])=>d>0).map(([x])=>x);
  const groups=[['entity','data'],['function','logic'],['route','endpoints'],
    ['frontend','screens'],['event','events'],['process','flows'],['statusFlow','lifecycles']];
  let reach='';
  for(const [k,l] of groups){
    const a=down.filter(x=>kindOf(x)===k);
    if(a.length) reach+='<button class="of-r" data-k="'+k+'"><b>'+a.length+'</b> '+esc(l)+'</button>';
  }
  // Every downstream object by name, one row each, so "expand Payments" is a click and
  // not a re-read of the diagram.
  let lists='';
  for(const [k,l] of groups){
    const a=down.filter(x=>kindOf(x)===k);
    if(!a.length) continue;
    lists+='<div class="of-exp" data-k="'+k+'">'+a.map(x=>
      '<button class="of-dep" data-id="'+esc(x)+'">'+esc(labelOf(x,m))+'</button>').join('')+'</div>';
  }
  // Permissions: only what the model recorded, and say plainly when it recorded nothing.
  const roles=[];
  if(Array.isArray(o.roles)&&o.roles.length) roles.push(o.roles.join(', '));
  if(kind==='route'&&o.auth) roles.push('signed in');
  if(kind==='function'&&o.routeId){ const rt=objById(o.routeId,m);
    if(rt&&Array.isArray(rt.roles)&&rt.roles.length) roles.push('via route: '+rt.roles.join(', ')); }
  if(kind==='entity'){
    const byRole=new Set();
    for(const fl of (m.statusFlows||[])) if(fl.entityId===id)
      for(const tr of (fl.transitions||[])) if(tr.byRole) byRole.add(tr.byRole);
    if(byRole.size) roles.push('moves its lifecycle: '+[...byRole].join(', '));
  }
  const mod=moduleOf(id,m), modObj=mod&&objById(mod,m);

  // What work has named this object — the object's own history, from the queue and the log.
  let hist=[];
  if(changesData && changesFor===selected){
    for(const t of (changesData.tasks||[])) if(t.ids.includes(id)) hist.push({when:COL_LABEL[t.col]||t.col, title:t.title});
    for(const h of (changesData.history||[])) if((h.touched||[]).includes(id)) hist.push({when:(h.ts||'').slice(0,10), title:h.title});
  }

  let html='<div class="of">';
  html+='<div class="of-row"><span class="of-k">Reaches</span><span class="of-v">'+
    (reach||'<i>nothing downstream</i>')+lists+'</span></div>';
  html+='<div class="of-row"><span class="of-k">Area</span><span class="of-v">'+
    (modObj?esc(modObj.name||modObj.id):'<i>not assigned to an area</i>')+
    (modObj&&modObj.owner?' · owner <b>'+esc(modObj.owner)+'</b>':'')+'</span></div>';
  html+='<div class="of-row"><span class="of-k">Who may</span><span class="of-v">'+
    (roles.length?esc(roles.join(' · ')):'<i>no role recorded in the model</i>')+'</span></div>';
  // Where it lives, when the model recorded it. This is what turns "the model named
  // three functions" into "open these three files" without a search.
  if(Array.isArray(o.paths)&&o.paths.length)
    html+='<div class="of-row"><span class="of-k">Lives in</span><span class="of-v">'+
      o.paths.slice(0,6).map(x=>'<code class="of-p">'+esc(String(x).slice(0,160))+'</code>').join('')+'</span></div>';
  if(o.sensitivity==='high')
    html+='<div class="of-row"><span class="of-k">Care</span><span class="of-v sens">marked sensitive — money, credentials or personal data</span></div>';
  if(hist.length)
    html+='<div class="of-row"><span class="of-k">Changed by</span><span class="of-v">'+
      hist.slice(0,6).map(h=>'<span class="of-h"><i>'+esc(h.when)+'</i> '+esc(h.title)+'</span>').join('')+
      (hist.length>6?'<span class="of-h more">+'+(hist.length-6)+' more</span>':'')+'</span></div>';
  html+='</div>';
  return html;
}

// Searching the model by name so a change can be described before a task exists.
function redrawAdhoc(m){
  const br=blastRadius(adhocIds,m);
  drawImpactDetail({ t:{file:'__adhoc',col:'',title:'What if we change…',ids:adhocIds,declared:true,approved:null,adhoc:true},
    br, risk:riskOf(br,m) }, m);
}
function wireAdhocSearch(m){
  const inp=document.getElementById('impSearch'), sug=document.getElementById('impSugg');
  if(!inp||!sug) return;
  const pool=[];
  for(const [k,coll] of Object.entries(KIND_COLLECTION))
    for(const o of (m[coll]||[])) if(o&&o.id) pool.push({id:o.id, k, label:labelOf(o.id,m)});
  const draw=()=>{
    const q=inp.value.trim().toLowerCase();
    if(!q){ sug.innerHTML=''; return; }
    const hits=pool.filter(x=>!adhocIds.includes(x.id) &&
      (x.label.toLowerCase().includes(q)||x.id.toLowerCase().includes(q))).slice(0,12);
    sug.innerHTML = hits.length
      ? hits.map(x=>'<button class="imp-sg" data-id="'+esc(x.id)+'"><span class="k">'+esc(x.k)+'</span>'+esc(x.label)+'</button>').join('')
      : '<span class="imp-none">Nothing in the model matches that.</span>';
    sug.querySelectorAll('.imp-sg').forEach(b=>b.addEventListener('click',()=>{
      adhocIds=adhocIds.concat([b.dataset.id]); inp.value=''; redrawAdhoc(m);
      const again=document.getElementById('impSearch'); if(again) again.focus();
    }));
  };
  inp.addEventListener('input', draw);
  draw();
}

/* ---------------- The radius, drawn ----------------
   A node per reached object is never readable: on real tasks one hop already reaches
   up to 150 objects. It is also the wrong question. What someone deciding whether to
   run a task needs is: what does it change, whose part of the product does that touch,
   and which journeys can it break. Three columns, each small enough to read. */
const IMP_MAX_SEEDS = 14;

function kindWord(k, n){
  const w={entity:'object', function:'function', route:'endpoint', frontend:'screen',
    event:'event', statusFlow:'lifecycle', reaction:'rule', serverUnit:'unit', field:'field'}[k]||k;
  return n+' '+w+(n===1?'':'s');
}

function graphImpact(named, m, hops){
  const H = hops==null ? 2 : hops;
  const full = blastRadius(named, m, H);
  const nodes=[], edges=[];
  const seedIds=[...full.dist.entries()].filter(([,d])=>d===0).map(([id])=>id);
  // What each named object reaches on its own — that is what makes the arrows honest
  // rather than "everything connects to everything".
  const reachOf=new Map();
  for(const id of seedIds) reachOf.set(id, blastRadius([id], m, H).dist);

  const shownSeeds = seedIds.slice(0, IMP_MAX_SEEDS);
  const seedRest = seedIds.length - shownSeeds.length;
  for(const id of shownSeeds){
    const mod=moduleOf(id,m), label=labelOf(id,m);
    const sub=(kindOf(id)||'')+(mod?' · '+labelOf(mod,m):'');
    const W=Math.max(180, Math.min(268, label.length*7.4+50));
    const L=wrapPx(sub, W-15-11, CW_MONO);
    nodes.push({id:'s_'+mSafe(id), w:Math.round(W), h:L.length?subH(L.length):44,
      meta:{kind:kindOf(id)==='statusFlow'?'status':kindOf(id), label, sub, subLines:L,
            heat:1, ref:{k:kindOf(id), id}}});
  }
  if(seedRest>0) nodes.push({id:'s_more', w:190, h:44,
    meta:{kind:'entity', label:'+'+seedRest+' more', sub:'also changed directly', subLines:['also changed directly'], heat:1, ref:null}});

  // Areas the change lands in, each saying what of it is in reach.
  const byArea=new Map();
  for(const [id,d] of full.dist){
    if(d===0) continue;
    const mod=moduleOf(id,m); if(!mod) continue;
    if(!byArea.has(mod)) byArea.set(mod, {});
    const k=kindOf(id); byArea.get(mod)[k]=(byArea.get(mod)[k]||0)+1;
  }
  const areaOrder=[...byArea.entries()].sort((a,b)=>
    Object.values(b[1]).reduce((s,n)=>s+n,0)-Object.values(a[1]).reduce((s,n)=>s+n,0));
  for(const [mod,counts] of areaOrder){
    const parts=['entity','function','route','frontend','event','statusFlow']
      .filter(k=>counts[k]).map(k=>kindWord(k,counts[k]));
    const label=labelOf(mod,m), sub=parts.join(' · ');
    const W=Math.max(200, Math.min(290, Math.max(label.length*7.4+50, sub.length*6.2+30)));
    const L=wrapPx(sub, W-15-11, CW_MONO);
    nodes.push({id:'a_'+mSafe(mod), w:Math.round(W), h:L.length?subH(L.length):44,
      meta:{kind:'module', label, sub, subLines:L, heat:0.5, ref:{k:'module', id:mod}}});
    for(const sid of shownSeeds){
      const r=reachOf.get(sid); if(!r) continue;
      let touches=false;
      for(const [id,d] of r){ if(d>0 && moduleOf(id,m)===mod){ touches=true; break; } }
      if(touches) edges.push({from:'s_'+mSafe(sid), to:'a_'+mSafe(mod), kind:'spine'});
    }
  }

  // The journeys a person walks through — the answer to "what will users notice".
  const procs=(full.byKind.process||[]).map(x=>objById(x.id,m)).filter(Boolean);
  const journeys=procs.filter(isJourney), internal=procs.length-journeys.length;
  for(const j of journeys){
    const label=j.name||j.id, sub=(j.steps||[]).length+' steps · '+(j.audience||j.triggerKind||'journey');
    const W=Math.max(190, Math.min(280, label.length*7.4+50));
    const L=wrapPx(sub, W-15-11, CW_MONO);
    nodes.push({id:'j_'+mSafe(j.id), w:Math.round(W), h:L.length?subH(L.length):44,
      meta:{kind:'process', label, sub, subLines:L, heat:0.7, ref:{k:'process', id:j.id}}});
    const hit=new Set();
    for(const st of (j.steps||[])){ const mod=st.refId&&full.dist.has(st.refId)?moduleOf(st.refId,m):null; if(mod&&byArea.has(mod)) hit.add(mod); }
    for(const mod of hit) edges.push({from:'a_'+mSafe(mod), to:'j_'+mSafe(j.id), kind:'effect'});
  }
  if(internal>0){
    nodes.push({id:'j_internal', w:210, h:44,
      meta:{kind:'process', label:internal+' internal flow'+(internal===1?'':'s'),
            sub:'machinery, nobody walks through it', subLines:['machinery, nobody walks through it'], heat:0.25, ref:null}});
    // Without edges it lands in the first column and reads as something the task changes.
    const hit=new Set();
    for(const pr of procs){ if(isJourney(pr)) continue;
      for(const st of (pr.steps||[])){ const mod=st.refId&&full.dist.has(st.refId)?moduleOf(st.refId,m):null; if(mod&&byArea.has(mod)) hit.add(mod); } }
    for(const mod of hit) edges.push({from:'a_'+mSafe(mod), to:'j_internal', kind:'effect'});
  }

  return { direction:'RIGHT', nodes, edges, seedRest, areas:areaOrder.length, journeys:journeys.length };
}

async function drawImpactGraph(box, named, m, seq, task){
  if(!box) return;
  const spec=graphImpact(named, m);
  if(!spec.nodes.length){ box.innerHTML='<div class="model-empty">Nothing to draw — this task names no object that is in the model.</div>'; return; }
  const note=document.createElement('div'); note.className='map-cap';
  note.innerHTML='Read it left to right: <b>what the task changes</b> → <b>the areas that reaches</b>, each saying how much of it is in reach → '+
    '<b>the journeys that run through those areas</b>. Click any node for its own context.'+
    '<span class="map-cap2">Areas and journeys are grouped on purpose: one hop out already reaches over a hundred objects on a real task, '+
    'and a node for each of them is a picture nobody can read. The exact counts are in the cards above.</span>';
  box.innerHTML=''; box.appendChild(note);
  const d=document.createElement('div'); box.appendChild(d);
  // The HUD draws the same three columns, except an area now opens into exactly
  // which of its objects are in reach — the thing the flat picture could not say.
  const scene=window.hudSceneImpact
    ? hudSceneImpact(task, m, blastRadius(named, m, 2),
        { onSelect:(id)=>{ if(id) openContextPopup(kindOf(id), id); } })
    : null;
  renderHud(d, scene, seq);
  if(seq!=null && !viewAlive(seq)) box.innerHTML='';
}
