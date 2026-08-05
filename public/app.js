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
  if(!ov){ ov=document.createElement('div'); ov.id='shareOverlay'; ov.className='ctx-overlay'; document.body.appendChild(ov); }
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
  ov.classList.add('show');
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

// Feather-shaped, but at the IDE stroke weight of 1.7 so they sit with everything else.
const ICON = (function(){
  const w = function(d, extra){
    return '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
      + 'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"'
      + (extra || '') + '>' + d + '</svg>';
  };
  return {
    clock: w('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
    code:  w('<path d="M16 18l6-6-6-6M8 6l-6 6 6 6"/>', ' style="color:var(--cyan)"'),
  };
})();

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
    el.querySelector('.prj-strip').style.background =
      'linear-gradient(135deg, hsla(' + hue(displayName(p)) + ',55%,42%,.34), rgba(9,18,38,.62))';

    const open = () => { if(selected!==p.path){ modelSrc=null; logicEntityId=null; } selected = p.path; renderDetail(); };
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
  { tab:'settings', g:'⚙', l:'Setup' },
  { tab:'tasks',    g:'▤', l:'Tasks',   badge:'taskBadge' },
  { tab:'model',    g:'◫', l:'Model',   badge:'modelBadge' },
  { tab:'queue',    g:'▦', l:'Queue',   badge:'queueBadge' },
  { tab:'team',     g:'⇄', l:'Team',    badge:'teamBadge' },
  { tab:'preview',  g:'⌖', l:'Preview', only:'preview' },
];
function renderRail(){
  railEl.innerHTML = RAIL
    .filter(r => r.only !== 'preview' || PREVIEW_OK)
    .map(r => '<button class="rl" data-tab="' + r.tab + '" title="' + r.l + '">'
      + '<span class="g">' + r.g + '</span><span class="l">' + r.l + '</span>'
      + (r.badge ? '<span class="badge" id="' + r.badge + '"></span>' : '') + '</button>').join('')
    + '<div class="rail-foot">'
    + '<a href="https://github.com/gitmir-hello/gitmir-claude-control" target="_blank" rel="noopener">SRC</a>'
    + '<span>AGPL</span></div>';
  railEl.querySelectorAll('.rl').forEach(b => b.addEventListener('click', () => setTab(b.dataset.tab)));
}

let taskTimer = null;
let queueTimer = null;
let activeTab = 'settings';
function setTab(tab){
  activeTab = tab;
  document.querySelectorAll('.rl').forEach(b=>b.classList.toggle('active', b.dataset.tab===tab));
  document.querySelectorAll('.pane').forEach(p=>p.classList.toggle('active', p.dataset.pane===tab));
  clearInterval(queueTimer);
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
let modelSrc = null;   // null = this project's own model; otherwise a teammate's name
let mermaidReady = null;
const MODEL_VIEWS = [
  {key:'map', label:'Product map'},
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
  // In a self-contained shared view the layout engine is already inlined above this
  // script, and there is no server to fetch it from — use what is already here.
  if(window.ELK){ elkReady=Promise.resolve(new (window.ELK.default||window.ELK)()); return elkReady; }
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
function nodeSvg(n){
  const x=n.x||0,y=n.y||0,w=n.width,h=n.height,md=n.meta||{};
  const acc=ACCENTS[md.kind]||ACCENTS.entity, gl=GLYPHS[md.kind]||'•';
  const PAD=11;                      // right-hand breathing room inside the card
  const nameAvail = w - 14 - PAD - 13;   // 13px for the leading glyph + its space
  const subAvail  = w - 15 - PAD;
  let inner='<rect x="0" y="0" width="'+w+'" height="'+h+'" rx="8" class="hcard" stroke="'+acc+'"/>'+
            '<rect x="0" y="0" width="3" height="'+h+'" rx="1.5" fill="'+acc+'"/>';
  // Full text stays reachable on hover, so clipping never loses information.
  const full=[md.label, md.sub].filter(Boolean).join(' — ');
  if(full) inner+='<title>'+esc(full)+'</title>';
  // The description is shown in FULL, wrapped over as many lines as it needs; the
  // builder sized the card from the same line count.
  const lines = md.subLines && md.subLines.length ? md.subLines
              : (md.sub ? wrapPx(md.sub, subAvail, CW_MONO) : []);
  const subText = (startY) => lines.map((l,i)=>'<text x="15" y="'+(startY+i*SUB_LH)+'" class="hsub">'+esc(l)+'</text>').join('');
  if(md.fields && md.fields.length){
    inner+='<text x="14" y="22" class="hname"><tspan fill="'+acc+'">'+gl+'</tspan> '+esc(fitPx(md.label,nameAvail,CW_NAME))+'</text>';
    let fy=42;
    if(lines.length){ inner+=subText(38); fy = 38 + lines.length*SUB_LH + 5; }
    for(const f of md.fields){ inner+='<text x="15" y="'+fy+'" class="hfield">'+esc(fitPx(f,subAvail,CW_MONO))+'</text>'; fy+=18; }
  } else {
    const ny = lines.length ? 21 : Math.round(h/2+4);
    inner+='<text x="14" y="'+ny+'" class="hname"><tspan fill="'+acc+'">'+gl+'</tspan> '+esc(fitPx(md.label,nameAvail,CW_NAME))+'</text>';
    if(lines.length) inner+=subText(ny+17);
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
  modelData=d;
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
  if(modelView==='map'){
    // This is the view shown to a client, so say what the picture means in their words.
    const cap=document.createElement('div'); cap.className='map-cap';
    // No apostrophes in here on purpose: this string is emitted from a template literal.
    cap.innerHTML='Each block is an area of the product — what it owns (◆) and how much of it there is. '+
      'A line means one area touches another: <b>writes X</b> — it changes data owned by that area · '+
      '<b>uses</b> — its screens call that area · <b>calls</b> — it triggers logic over there · '+
      'a named signal is an event one area raises and another reacts to.'+
      '<span class="map-cap2">Read it together with whoever asked for the product: if a line is missing or points the wrong way, the understanding is wrong — and that is far cheaper to find now than after it is built.</span>';
    box.appendChild(cap);
    const d=document.createElement('div'); box.appendChild(d);
    return renderElk(d, graphProductMap(m));
  }
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
function openContextPopup(kind,id){
  if(!modelData) return; const m=modelData.model;
  const ctx=gatherContext(kind,id,m); const title=ctxTitle(kind,id,m);
  let ov=document.getElementById('ctxOverlay');
  if(!ov){ ov=document.createElement('div'); ov.id='ctxOverlay'; ov.className='ctx-overlay'; document.body.appendChild(ov); }
  ov.innerHTML=
    '<div class="ctx-modal">'+
      '<div class="ctx-head"><div class="ctx-title">'+esc(title)+'</div><button class="ctx-x" title="Close (Esc)">✕</button></div>'+
      '<div class="ctx-note">'+(modelSrc
        ? 'Deterministic context from the model shared by <b>'+esc(srcLabel())+'</b>. <b>Send to team</b> delivers it to <b>everyone currently online</b> in your workspace (the relay broadcasts — it cannot target one person), landing in their <code>tasks/todo/</code>. <b>Queue here</b> instead writes it into this local project.'
        : 'Deterministic context — assembled from the model by walking id-links. Paste into Claude, or turn it into a queued task.')+'</div>'+
      '<pre class="ctx-pre">'+esc(ctx)+'</pre>'+
      // A shared view is read-only: it has no project on disk to queue into and no bridge
      // to send over. Copying context still works — that is the useful half for a reader.
      (SHARE ? '' : '<div class="ctx-taskl">Task for this element (optional):</div>'+
        '<textarea class="ctx-task" placeholder="e.g. Add a partial-refund transition from paid, updating Payment and Inventory…"></textarea>')+
      '<div class="ctx-actions">'+
        (SHARE ? '' : (modelSrc
          ? '<button class="run ctx-send">➤ Send to team</button><button class="ghost ctx-create">＋ Queue here</button>'
          : '<button class="run ctx-create">＋ Create task</button>'))+
        '<button class="ghost ctx-copy">📋 Copy context</button>'+
        (SHARE ? '' : '<button class="ghost ctx-copyt">📋 Copy context + task</button>')+
        '<button class="del ctx-close">Close</button>'+
      '</div>'+
    '</div>';
  ov.classList.add('show');
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
  const taskBody=(t)=> origin+'> '+CTXPRE+'\n\n## Task\n'+t+'\n\n## Context (from the .gitmir model)\n'+ctx+'\n';
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
  // Unverified work is still open work, so the badge counts todo + verify.
  const pending=(q.todo||[]).length+(q.verify||[]).length;
  const badge=document.getElementById('queueBadge'); if(badge) badge.textContent = pending ? String(pending) : '';
  if(!total){ view.innerHTML='<div class="model-empty">No tasks yet.<br>Open <b>Model</b>, click any element in a diagram → <b>＋ Create task</b> (or copy the <b>task-planner</b> skill). Then run <b>📋 task-runner</b> in Claude — it executes them one by one, moving each file todo → inprogress → verify → done — a task is only done once its checks actually pass.</div>'; return; }
  const cols=[['todo','To do','#8aa0ff'],['inprogress','In progress','#ffb86b'],['verify','Verify','#c084fc'],['done','Done','#34f0a6']];
  let html='<div class="q-cols">';
  for(const [k,label,acc] of cols){ const items=q[k]||[];
    html+='<div class="q-col"><div class="q-col-h" style="color:'+acc+'">'+label+' <span class="q-n">'+items.length+'</span></div><div class="q-list">';
    if(!items.length) html+='<div class="q-empty">—</div>';
    for(const it of items) html+='<div class="q-card q-clk" data-col="'+esc(k)+'" data-file="'+esc(it.file)+'" title="Open full task" style="border-left-color:'+acc+'"><div class="q-t">'+esc(it.title)+'</div><div class="q-f">'+esc(it.file)+'</div></div>';
    html+='</div></div>';
  }
  view.innerHTML=html+'</div>';
  view.querySelectorAll('.q-clk').forEach(c=> c.addEventListener('click', ()=> openTaskPopup(pathStr, c.dataset.col, c.dataset.file)));
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
  if(!ov){ ov=document.createElement('div'); ov.id='taskOverlay'; ov.className='ctx-overlay'; document.body.appendChild(ov); }
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
  ov.classList.add('show');
  const close=()=>{ ov.classList.remove('show'); ov.innerHTML=''; };
  ov.querySelector('.ctx-x').addEventListener('click', close);
  ov.querySelector('.tk-close').addEventListener('click', close);
  ov.addEventListener('click', e=>{ if(e.target===ov) close(); });
  ov.querySelector('.tk-copy').addEventListener('click', async ()=>{ await copyToClipboard(d.content||''); toast('Task copied ✓'); });
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
// The view you open in front of a client before anything is built: the product as
// business areas and the lines between them. Everything here is aggregated up from the
// fine-grained model — which module writes whose data, who notifies whom, who calls
// whom — so it cannot drift from what the code actually does.
function graphProductMap(m){
  const mods=m.modules||[], ents=m.entities||[], sf=m.serverFunctions||[],
        fe=m.frontendUnits||[], ev=m.events||[], rt=m.apiRoutes||[];
  const owner=fieldOwner(m);
  const modById=new Map(mods.map(x=>[x.id,x]));
  const entById=new Map(ents.map(x=>[x.id,x]));
  const evById=new Map(ev.map(x=>[x.id,x]));
  const fnById=new Map(sf.map(x=>[x.id,x]));
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
    const W=272;
    const dl = b.desc ? wrapPx(b.desc, W-15-11, CW_MONO).slice(0,2) : [];
    const h = 32 + dl.length*SUB_LH + Math.max(1,lines.length)*18 + 10;
    nodes.push({id, w:W, h, meta:{kind:'module', label:modName(id), sub:b.desc, subLines:dl, fields:lines,
      ref: id===OTHER?null:{k:'module', id}}});
  }

  // One line per pair of areas, labelled with the strongest thing that passes along it.
  const link=new Map();
  const add=(from,to,kind,label,rank)=>{
    if(from===to || !bucket.has(from) || !bucket.has(to)) return;
    const k=from+'>'+to; const cur=link.get(k);
    if(!cur || rank>cur.rank) link.set(k,{from,to,kind,label,rank});
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
      const g=fnById.get(id); if(g) add(A, mod(g.moduleId), 'spine', 'calls', 1);
    }
  }
  // screens of one area talking to another area's API
  for(const u of fe){ const A=mod(u.moduleId);
    for(const rid of (u.consumesRouteIds||[])) if(rtOwner.has(rid)) add(A, mod(rtOwner.get(rid)), 'spine', 'uses', 2);
  }
  for(const e of link.values()) edges.push({from:e.from, to:e.to, kind:e.kind, label:e.label});
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
async function renderProcesses(view, m){
  const procs=m.processes||[];
  if(!procs.length){ view.innerHTML='<div class="model-empty">No business processes in the model.</div>'; return; }
  view.innerHTML='';
  // ELK layout is async, so a source/project switch can land mid-loop. Bail out
  // rather than grafting this model's diagrams onto the newly loaded one's pane.
  const mine=modelReq;
  for(const p of procs){
    if(mine!==modelReq || !view.isConnected) return;
    const block=document.createElement('div'); block.className='proc-block';
    block.innerHTML='<div class="proc-title">'+esc(p.name||p.id)+'</div>'+
      (p.description?'<div class="proc-desc">'+esc(p.description)+'</div>':'')+
      '<div class="proc-diagram"></div>';
    view.appendChild(block);
    await renderElk(block.querySelector('.proc-diagram'), graphProcess(p, m));
  }
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
      nodes.push({id:en, w:Math.round(W), h: L.length?subH(L.length):40, meta:{kind:'effect', label:head, sub:desc, subLines:L, ref: ef.entityId?{k:'entity',id:ef.entityId}:{k:'entity',id:fl.entityId}}});
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
  if(!ov){ ov=document.createElement('div'); ov.id='pvOverlay'; ov.className='ctx-overlay'; document.body.appendChild(ov); }
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
  ov.classList.add('show');
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

