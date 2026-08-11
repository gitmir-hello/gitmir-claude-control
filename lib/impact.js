// The impact engine — the one implementation of reach and risk.
//
// Imported by the MCP server (Node) and served to the browser for the dashboard.
// It exists as a separate file so the two can never answer the same question
// differently: a second copy of this arithmetic would drift, and a risk score
// that disagrees with itself is worth less than no score.
//
// Pure functions over a loaded model — no DOM, no fetch, no filesystem.

const KIND_BY_PREFIX = { mod:'module', ent:'entity', f:'field', su:'serverUnit', sf:'function',
  sfw:'statusFlow', rt:'route', fe:'frontend', ev:'event', proc:'process', rx:'reaction' };
const KIND_COLLECTION = { module:'modules', entity:'entities', serverUnit:'serverUnits',
  function:'serverFunctions', route:'apiRoutes', frontend:'frontendUnits', event:'events',
  process:'processes', statusFlow:'statusFlows', reaction:'reactions' };
function kindOf(id){ return KIND_BY_PREFIX[String(id||'').split('-')[0]] || null; }
function objById(id, m){
  const k=kindOf(id); if(!k) return null;
  if(k==='field'){ for(const e of (m.entities||[])) for(const f of (e.fields||[])) if(f.id===id) return f; return null; }
  return ((m[KIND_COLLECTION[k]]||[]).find(x=>x.id===id))||null;
}
function labelOf(id, m){ const o=objById(id,m); if(!o) return id;
  if(kindOf(id)==='route') return ((o.method||'')+' '+(o.path||o.name||'')).trim();
  return o.name||o.id; }
function moduleOf(id, m){
  const o=objById(id,m); if(!o) return null;
  if(kindOf(id)==='module') return id;
  if(o.moduleId) return o.moduleId;
  // Not every object carries moduleId; fall back to the unit or entity that does.
  if(o.serverUnitId){ const su=objById(o.serverUnitId,m); if(su&&su.moduleId) return su.moduleId; }
  if(kindOf(id)==='statusFlow'&&o.entityId){ const e=objById(o.entityId,m); if(e&&e.moduleId) return e.moduleId; }
  return null;
}
function isJourney(p){
  if(p.audience) return p.audience==='customer'||p.audience==='staff';
  return p.triggerKind==='ui';
}
function fieldOwner(m){ const map=new Map(); for(const e of (m.entities||[])) for(const f of (e.fields||[])) map.set(f.id, e.id); return map; }
function reachIndex(m){
  const adj=new Map();
  const add=(a,b)=>{ if(!a||!b||a===b) return; if(!adj.has(a)) adj.set(a,new Set()); adj.get(a).add(b); };
  const owner=fieldOwner(m);
  for(const [fid,eid] of owner){ add(fid,eid); add(eid,fid); }
  for(const e of (m.entities||[])){
    for(const f of (e.fields||[])) if(f.type==='ref'&&f.refEntityId) add(f.refEntityId, e.id);
    for(const src of (e.derivedFrom||[])) add(src, e.id);
  }
  for(const fl of (m.statusFlows||[])){
    if(fl.entityId){ add(fl.entityId, fl.id); add(fl.id, fl.entityId); }
    for(const t of (fl.transitions||[])) for(const ef of (t.effects||[])) if(ef.entityId) add(fl.id, ef.entityId);
  }
  for(const r of (m.reactions||[])){
    if(r.trigger&&r.trigger.entityId) add(r.trigger.entityId, r.id);
    for(const ef of (r.effects||[])) if(ef.entityId) add(r.id, ef.entityId);
  }
  for(const f of (m.serverFunctions||[])){
    for(const fid of (f.writesFieldIds||[])){ const e=owner.get(fid); if(e) add(f.id,e); }
    for(const fid of (f.readsFieldIds||[])){ const e=owner.get(fid); if(e) add(e,f.id); }
    for(const c of (f.callsFunctionIds||[])) add(c, f.id);      // callee changes → caller affected
    for(const ev of (f.emitsEventIds||[])) add(f.id, ev);
    for(const ev of (f.subscribesEventIds||[])) add(ev, f.id);
    if(f.routeId){ add(f.id, f.routeId); add(f.routeId, f.id); }
    if(f.serverUnitId) add(f.serverUnitId, f.id);
  }
  for(const fe of (m.frontendUnits||[])){
    for(const rid of (fe.consumesRouteIds||[])) add(rid, fe.id);
    for(const d of (fe.dependsOn||[])) add(d, fe.id);
    for(const ev of (fe.subscribesEventIds||[])) add(ev, fe.id);
    for(const ev of (fe.emitsEventIds||[])) add(fe.id, ev);
  }
  for(const su of (m.serverUnits||[])){
    for(const eid of (su.entityIds||[])) add(su.id, eid);
    for(const d of (su.dependsOn||[])) add(d, su.id);
  }
  for(const p of (m.processes||[])) for(const s of (p.steps||[])) if(s.refId) add(s.refId, p.id);
  return adj;
}
function blastRadius(seedIds, m, hops){
  hops = hops==null ? 2 : hops;
  const adj = reachIndex(m);
  // Naming an area means touching what is inside it. Modules are not nodes in the reach
  // graph — nothing points out of them — so a module seed has to be opened into its own
  // contents, or the answer comes back "nothing downstream", which is false for every
  // area that contains anything.
  const seed=[];
  for(const id of seedIds){
    if(!objById(id,m)) continue;
    // Asking what a journey reaches, when the graph only has edges INTO it —
    // a step changes, the journey is affected — comes back "nothing", which is
    // useless and false to the question. A journey is what it walks through, so
    // seed it with the objects its steps name.
    if(kindOf(id)==='process'){
      const pr=objById(id,m);
      for(const s of ((pr&&pr.steps)||[])) if(s.refId && !seed.includes(s.refId)) seed.push(s.refId);
      if(!seed.includes(id)) seed.push(id);
      continue;
    }
    if(kindOf(id)==='module'){
      for(const k of ['entities','serverFunctions','apiRoutes','frontendUnits','events','statusFlows','processes'])
        for(const o of (m[k]||[])) if(o && o.id && moduleOf(o.id,m)===id && !seed.includes(o.id)) seed.push(o.id);
      if(!seed.includes(id)) seed.push(id);
      continue;
    }
    if(!seed.includes(id)) seed.push(id);
  }
  const dist = new Map(seed.map(id=>[id,0]));
  let front = seed.slice();
  for(let h=1; h<=hops && front.length; h++){
    const next=[];
    for(const id of front) for(const nb of (adj.get(id)||[])) if(!dist.has(nb)){ dist.set(nb,h); next.push(nb); }
    front=next;
  }
  const byKind={};
  for(const [id,d] of dist){ const k=kindOf(id); if(!k) continue; (byKind[k]=byKind[k]||[]).push({id,d}); }
  for(const k of Object.keys(byKind)) byKind[k].sort((a,b)=>a.d-b.d || a.id.localeCompare(b.id));
  const modules=new Set();
  for(const id of dist.keys()){ const md=moduleOf(id,m); if(md) modules.add(md); }
  return { seed, dist, byKind, modules:[...modules], hops, adj };
}
function riskOf(br, m){
  const got=k=>(br.byKind[k]||[]).map(x=>x.id);
  const procs=got('process').map(id=>objById(id,m)).filter(Boolean);
  const journeys=procs.filter(isJourney);
  const sensitive=got('entity').map(id=>objById(id,m)).filter(e=>e&&e.sensitivity==='high');
  const callers=(br.byKind.function||[]).filter(x=>x.d>0).length;
  const parts=[
    { k:'modules',   n:Math.max(0,br.modules.length-1), w:2, l:'module boundaries crossed',
      why:'a change inside one area is a smaller thing than one that spans several' },
    { k:'journeys',  n:journeys.length, w:3, l:'user journeys affected',
      why:'someone walks through these — breaking one is visible to them' },
    { k:'processes', n:procs.length-journeys.length, w:1, l:'internal processes affected',
      why:'machinery that runs behind the product' },
    { k:'lifecycle', n:got('statusFlow').length, w:3, l:'lifecycles touched',
      why:'state machines carry effects that fire on every transition' },
    { k:'sensitive', n:sensitive.length, w:4, l:'sensitive data reached',
      why:'money, credentials or personal data — marked in the model, not guessed' },
    { k:'routes',    n:got('route').length, w:1, l:'API endpoints in reach',
      why:'each one is a contract something outside already depends on' },
    { k:'screens',   n:got('frontend').length, w:1, l:'screens in reach',
      why:'what a user would see change' },
    { k:'callers',   n:callers, w:1, l:'other functions downstream',
      why:'code that runs through the changed part' },
  ].filter(p=>p.n>0);
  const score=parts.reduce((s,p)=>s+p.n*p.w,0);
  // A raw point score is not comparable between a nine-module product and a ninety-one
  // module one: the same number means "most of it" in the first and "a corner" in the
  // second. Divide by what the whole product would score, and the level becomes a share
  // of the product a change reaches — the same reading in every project.
  const max=riskCeiling(m);
  const share = max ? score/max : 0;
  const level = share>=0.25 ? 'high' : share>=0.08 ? 'medium' : 'low';
  return { parts, score, max, share, level };
}
function riskCeiling(m){
  const procs=m.processes||[], journeys=procs.filter(isJourney);
  const tot={ modules:Math.max(0,(m.modules||[]).length-1), journeys:journeys.length,
    processes:procs.length-journeys.length, lifecycle:(m.statusFlows||[]).length,
    sensitive:(m.entities||[]).filter(e=>e&&e.sensitivity==='high').length,
    routes:(m.apiRoutes||[]).length, screens:(m.frontendUnits||[]).length,
    callers:Math.max(0,(m.serverFunctions||[]).length-1) };
  const W={modules:2,journeys:3,processes:1,lifecycle:3,sensitive:4,routes:1,screens:1,callers:1};
  return Object.keys(W).reduce((s,k)=>s+tot[k]*W[k],0);
}

export { KIND_BY_PREFIX, KIND_COLLECTION, kindOf, objById, labelOf, moduleOf, isJourney, fieldOwner, reachIndex, blastRadius, riskOf, riskCeiling };
