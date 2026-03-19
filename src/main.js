// ═══════════════════════════════════════════════════════════════
//  IFC Studio — main.js
//  3D Engine: web-ifc-three (exact IFC geometry via web-ifc WASM)
//  Tree/Properties: web-ifc API (semantic data)
// ═══════════════════════════════════════════════════════════════

import * as THREE from 'three';
import * as WebIFC from 'web-ifc';
import { IFCLoader } from 'web-ifc-three/IFCLoader';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh';

// ── Patch Three.js for BVH raycast (much faster picking) ──────
THREE.Mesh.prototype.raycast = acceleratedRaycast;
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;

// ── STATE ─────────────────────────────────────────────────────
let loader, scene, camera, renderer, controls;
let ifcModel = null;
let ifcModelID = null;
let rawBuf = null;
let selectedExpressID = null;
let selectedExpressIDs = new Set();
let hiddenIDs = new Set();
let curProps = [];
let editOn = false;
let chgN = 0;
let curTab = 'tree';

// ── SPATIAL TYPE CONFIG ───────────────────────────────────────
const SP_ICON = {
  IFCPROJECT:        { l: 'P', c: 'ic-P' },
  IFCSITE:           { l: 'S', c: 'ic-S' },
  IFCBUILDING:       { l: 'B', c: 'ic-B' },
  IFCBUILDINGSTOREY: { l: 'G', c: 'ic-G' },
  IFCSPACE:          { l: 'R', c: 'ic-R' },
};

// ── INIT THREE.JS ────────────────────────────────────────────
function initThree() {
  const vp = document.getElementById('vp');
  const cv = document.getElementById('cv');

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0d0f12);

  camera = new THREE.PerspectiveCamera(45, vp.clientWidth / vp.clientHeight, 0.01, 5000);
  camera.position.set(10, 10, 10);

  renderer = new THREE.WebGLRenderer({ canvas: cv, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(vp.clientWidth, vp.clientHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  // Lights
  const ambient = new THREE.AmbientLight(0xffffff, 0.5);
  scene.add(ambient);
  const sun = new THREE.DirectionalLight(0xffffff, 1.0);
  sun.position.set(50, 100, 80);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0x6aabff, 0.3);
  fill.position.set(-60, 20, -80);
  scene.add(fill);

  // Grid
  const grid = new THREE.GridHelper(500, 100, 0x1a1e26, 0x1a1e26);
  scene.add(grid);

  // Orbit controls
  controls = new OrbitControls(camera, cv);
  controls.enableDamping = true;
  controls.dampingFactor = 0.07;
  controls.screenSpacePanning = false;
  controls.maxPolarAngle = Math.PI / 1.8;

  // Resize
  new ResizeObserver(() => {
    const w = vp.clientWidth, h = vp.clientHeight;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }).observe(vp);

  // Render loop
  (function animate() {
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
  })();

  // Click → pick
  cv.addEventListener('click', onPick);
}

// ── INIT WEB-IFC LOADER ───────────────────────────────────────
async function initIFC() {
  setSpin('Initialisiere web-ifc…');
  showSpin();

  loader = new IFCLoader();

  // Point to the WASM files served from public/ (Vite serves them at BASE_URL)
  // We set isWasmPathAbsolute = true directly because web-ifc-three doesn't expose
  // that flag — without it the script-directory prefix gets prepended (→ 404).
  await loader.ifcManager.setWasmPath(import.meta.env.BASE_URL);
  loader.ifcManager.ifcAPI.isWasmPathAbsolute = true;

  // Reduce circle segment counts → much faster geometry computation for curved elements
  await loader.ifcManager.applyWebIfcConfig({
    COORDINATE_TO_ORIGIN: true,
    USE_FAST_BOOLS: true,
    CIRCLE_SEGMENTS_LOW: 4,
    CIRCLE_SEGMENTS_MEDIUM: 6,
    CIRCLE_SEGMENTS_HIGH: 12,
    BOOL_ABORT_THRESHOLD: 10000,
  });

  // Enable BVH for fast raycast picking
  await loader.ifcManager.setupThreeMeshBVH(
    computeBoundsTree,
    disposeBoundsTree,
    acceleratedRaycast
  );

  hideSpin();
  setSt('Bereit', 'g');
  toast('IFC Studio bereit ✓', 'ok');
}

// ── FILE LOADING ──────────────────────────────────────────────
async function loadFile(file) {
  if (!file || !loader) return;

  // Dispose previous model
  if (ifcModel) {
    loader.ifcManager.disposeMemory();
    scene.remove(ifcModel);
    ifcModel = null;
    ifcModelID = null;
    selectedExpressID = null;
    selectedExpressIDs.clear();
    hiddenIDs.clear();
  }

  showSpin('Datei lesen…');
  setSt('Laden…', 'a');

  try {
    rawBuf = await file.arrayBuffer();
    const data = new Uint8Array(rawBuf);

    setSpin('3D-Geometrie berechnen…');
    showProgress();

    // Load model — web-ifc parses real IFC geometry
    ifcModel = await loader.parse(data);
    ifcModel.castShadow = true;
    ifcModel.receiveShadow = true;
    scene.add(ifcModel);

    ifcModelID = 0; // single model always ID 0

    // Fit camera to model
    fitAll();

    // Build UI
    setSpin('Struktur laden…');
    await buildTree();

    setSpin('Typen laden…');
    await buildTypesView();

    setSpin('Geschosse laden…');
    await buildStoreysView();

    // Stats
    const stats = getModelStats();
    document.getElementById('flbl').textContent = file.name + ' — ' + fmtSz(file.size);
    document.getElementById('dz').classList.add('gone');
    const vi = document.getElementById('vpinfo');
    vi.style.display = 'block';
    vi.innerHTML = getVersion() + ' · ' + stats.entities + ' Entities<br>' + stats.objects + ' 3D-Objekte';
    document.getElementById('vbadge').textContent = getVersion();
    document.getElementById('vbadge').style.display = '';
    document.getElementById('btn-dl').disabled = false;
    document.getElementById('tcnt').textContent = stats.entities;
    document.getElementById('si-e').style.display = 'flex';
    document.getElementById('si-ev').textContent = stats.entities;
    document.getElementById('si-o').style.display = 'flex';
    document.getElementById('si-ov').textContent = stats.objects;
    setSt('Geladen', 'g');
    toast('IFC geladen ✓', 'ok');

  } catch (err) {
    console.error('[IFC Studio] Load error:', err);
    toast('Fehler: ' + err.message, 'err');
    setSt('Fehler', '');
  }

  hideSpin();
}

function getVersion() {
  try {
    // Try to read FILE_SCHEMA from the raw text
    const text = new TextDecoder('utf-8', { fatal: false }).decode(rawBuf.slice(0, 4096));
    const m = text.match(/FILE_SCHEMA\s*\(\s*\(\s*'([^']+)'/i);
    if (m) return m[1].split(';')[0].toUpperCase();
  } catch { /* ignore */ }
  return 'IFC';
}

function getModelStats() {
  let entities = 0, objects = 0;
  try {
    const ifcapi = loader.ifcManager.ifcAPI;
    entities = ifcapi.GetAllLines(0).size();
    // Count mesh-generating entities
    ifcModel.traverse(o => { if (o.isMesh) objects++; });
  } catch { /* ignore */ }
  return { entities, objects };
}

// ── CAMERA CONTROLS ───────────────────────────────────────────
function fitAll() {
  if (!ifcModel) return;
  const box = new THREE.Box3().setFromObject(ifcModel);
  if (box.isEmpty()) return;
  const c = box.getCenter(new THREE.Vector3());
  const sz = box.getSize(new THREE.Vector3());
  const dist = Math.max(sz.x, sz.y, sz.z) * 1.8;
  camera.position.set(c.x + dist * 0.6, c.y + dist * 0.5, c.z + dist * 0.6);
  controls.target.copy(c);
  controls.update();
}

function fitSelection() {
  if (selectedExpressID === null) return fitAll();
  try {
    const mesh = ifcModel.children.find(c => c.isMesh) || ifcModel;
    const subset = loader.ifcManager.createSubset({
      modelID: ifcModelID,
      ids: [selectedExpressID],
      applyBVH: false,
      scene,
      removePrevious: false,
    });
    const box = new THREE.Box3().setFromObject(mesh);
    if (!box.isEmpty()) {
      const c = box.getCenter(new THREE.Vector3());
      const sz = box.getSize(new THREE.Vector3());
      camera.position.set(c.x, c.y + sz.y, c.z + sz.z * 2);
      controls.target.copy(c);
      controls.update();
    }
  } catch { fitAll(); }
}

function camSet(v) {
  if (!ifcModel) return;
  const box = new THREE.Box3().setFromObject(ifcModel);
  const c = box.getCenter(new THREE.Vector3());
  const sz = box.getSize(new THREE.Vector3());
  const d = Math.max(sz.x, sz.y, sz.z) * 1.5;
  controls.target.copy(c);
  if (v === 'top') camera.position.set(c.x, c.y + d * 1.5, c.z);
  else if (v === 'fr') camera.position.set(c.x, c.y, c.z + d);
  else if (v === 'si') camera.position.set(c.x + d, c.y, c.z);
  controls.update();
}

// ── RAYCASTING / PICKING ──────────────────────────────────────
const raycaster = new THREE.Raycaster();
raycaster.firstHitOnly = true;

async function onPick(e) {
  if (!ifcModel || !loader) return;
  const vp = document.getElementById('vp');
  const rect = vp.getBoundingClientRect();
  const x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  const y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera({ x, y }, camera);

  const hits = raycaster.intersectObjects(ifcModel.children || [ifcModel], true);
  if (!hits.length) { deselect(); return; }

  const hit = hits[0];
  const expressID = await loader.ifcManager.getExpressId(hit.object.geometry, hit.faceIndex);
  if (expressID === undefined) { deselect(); return; }

  await selectEntity(expressID, false, e.ctrlKey);
}

async function selectEntity(expressID, fromTree = false, ctrlKey = false) {
  if (ctrlKey) {
    if (selectedExpressIDs.has(expressID)) {
      selectedExpressIDs.delete(expressID);
      if (selectedExpressIDs.size === 0) { deselect(); return; }
      selectedExpressID = [...selectedExpressIDs].at(-1);
    } else {
      selectedExpressIDs.add(expressID);
      selectedExpressID = expressID;
    }
  } else {
    selectedExpressIDs.clear();
    selectedExpressIDs.add(expressID);
    selectedExpressID = expressID;
  }

  // Highlight all selected elements
  try { loader.ifcManager.removeSubset(ifcModelID, undefined, 'selection'); } catch { /* ignore */ }
  loader.ifcManager.createSubset({
    modelID: ifcModelID,
    ids: [...selectedExpressIDs],
    material: new THREE.MeshLambertMaterial({ color: 0x4f9eff, transparent: true, opacity: 0.85, depthTest: true }),
    scene,
    removePrevious: true,
    customID: 'selection',
  });

  // Get type name of primary selection
  const props = await loader.ifcManager.getItemProperties(ifcModelID, selectedExpressID);
  const typeName = props?.type || 'Entity';
  const name = props?.Name?.value || props?.LongName?.value || '';

  const count = selectedExpressIDs.size;
  const pill = document.getElementById('selpill');
  if (count > 1) {
    pill.textContent = count + ' Bauteile ausgewählt · Strg+Klick zum Hinzufügen';
  } else {
    pill.textContent = '#' + selectedExpressID + ' · ' + typeName.replace('IFC', '') + (name ? ' · ' + name : '');
  }
  pill.classList.add('show');
  document.getElementById('si-s').style.display = 'flex';
  document.getElementById('si-sv').textContent = count > 1 ? count + ' ×' : typeName.replace('IFC', '');

  if (!fromTree) syncTreeSelection(selectedExpressID);
  updateAddAttrBar();
  await showProperties(selectedExpressID);
}

function deselect(clearPanel = true) {
  selectedExpressID = null;
  selectedExpressIDs.clear();
  try { loader.ifcManager.removeSubset(ifcModelID, undefined, 'selection'); } catch { /* ignore */ }
  document.getElementById('selpill').classList.remove('show');
  document.querySelectorAll('.tr.sel').forEach(r => r.classList.remove('sel'));
  updateAddAttrBar();
  if (clearPanel) {
    document.getElementById('pw').innerHTML = '<div class="pempty"><div class="pempty-icon">◫</div><div>Element auswählen</div></div>';
    document.getElementById('pcnt').textContent = '—';
  }
}

// ── VISIBILITY ────────────────────────────────────────────────
function hideSelected() {
  if (selectedExpressID === null) return;
  hiddenIDs.add(selectedExpressID);
  loader.ifcManager.createSubset({
    modelID: ifcModelID,
    ids: [...hiddenIDs],
    material: new THREE.MeshLambertMaterial({ visible: false }),
    scene,
    removePrevious: true,
    customID: 'hidden',
  });
  toast('Ausgeblendet', '');
}

function isolateSelected() {
  if (selectedExpressID === null) return;
  loader.ifcManager.createSubset({
    modelID: ifcModelID,
    ids: [selectedExpressID],
    material: undefined,
    scene,
    removePrevious: true,
    customID: 'isolated',
  });
  toast('Isoliert', '');
}

function showAll() {
  hiddenIDs.clear();
  try { loader.ifcManager.removeSubset(ifcModelID, undefined, 'hidden'); } catch { }
  try { loader.ifcManager.removeSubset(ifcModelID, undefined, 'isolated'); } catch { }
  toast('Alles eingeblendet', 'ok');
}

// ── IFC SPATIAL TREE ─────────────────────────────────────────
async function buildTree() {
  const wrap = document.getElementById('tree-body');
  wrap.innerHTML = '';

  const ifcapi = loader.ifcManager.ifcAPI;

  // Get all IfcProject instances
  const projects = ifcapi.GetLineIDsWithType(ifcModelID, WebIFC.IFCPROJECT);
  const roots = [];
  for (let i = 0; i < projects.size(); i++) {
    const id = projects.get(i);
    roots.push(id);
  }

  if (!roots.length) {
    wrap.innerHTML = '<div style="padding:12px;font-family:var(--mono);font-size:11px;color:var(--tx3)">Keine Struktur gefunden</div>';
    return;
  }

  for (const rootId of roots) {
    const node = await buildTreeNode(rootId, 0, ifcapi);
    wrap.appendChild(node);
  }

  // Auto-expand first 3 levels
  wrap.querySelectorAll('.tch').forEach((ch, i) => {
    if (i < 30) {
      ch.classList.add('open');
      ch.previousElementSibling?.querySelector('.tc')?.classList.add('open');
    }
  });
}

async function buildTreeNode(expressID, depth, ifcapi) {
  const props = await loader.ifcManager.getItemProperties(ifcModelID, expressID);
  const type = props?.type || 'IFCUNKNOWN';
  const name = props?.Name?.value || props?.LongName?.value || '';
  const ic = SP_ICON[type] || null;
  const isEl = !SP_ICON[type];

  const children = await getChildren(expressID, ifcapi);

  const outer = document.createElement('div');
  outer.className = 'tn';
  outer.dataset.id = expressID;
  outer.dataset.type = type;
  outer.dataset.name = name.toLowerCase();

  const hasKids = children.length > 0;

  const row = document.createElement('div');
  row.className = 'tr';
  row.dataset.id = expressID;
  row.style.paddingLeft = (depth * 14 + 3) + 'px';

  const tc = document.createElement('span');
  tc.className = 'tc' + (hasKids ? '' : ' leaf');
  tc.textContent = '▶';

  const ti = document.createElement('span');
  ti.className = 'ti ' + (ic ? ic.c : (isEl ? 'ic-E' : 'ic-X'));
  ti.textContent = ic ? ic.l : (isEl ? '▪' : '⊞');

  const lbl = document.createElement('span');
  lbl.className = 'tl';
  lbl.title = type + (name ? ' — ' + name : '') + ' #' + expressID;
  lbl.textContent = name || (type.replace('IFC', '') + ' #' + expressID);

  const badge = document.createElement('span');
  badge.className = 'tbg';
  badge.textContent = type.replace('IFC', '');

  row.appendChild(tc); row.appendChild(ti); row.appendChild(lbl); row.appendChild(badge);
  outer.appendChild(row);

  const ch = document.createElement('div');
  ch.className = 'tch';

  for (const childId of children) {
    const childNode = await buildTreeNode(childId, depth + 1, ifcapi);
    ch.appendChild(childNode);
  }
  outer.appendChild(ch);

  tc.addEventListener('click', ev => {
    ev.stopPropagation();
    ch.classList.toggle('open');
    tc.classList.toggle('open');
  });

  row.addEventListener('click', async (e) => {
    if (hasKids && SP_ICON[type]) {
      ch.classList.toggle('open');
      tc.classList.toggle('open');
    }
    await selectEntity(expressID, true, e.ctrlKey);
  });

  return outer;
}

async function getChildren(expressID, ifcapi) {
  const children = [];
  try {
    // IfcRelAggregates — structural decomposition
    const rels = await loader.ifcManager.getItemProperties(ifcModelID, expressID, true);
    const agg = rels?.IsDecomposedBy || [];
    for (const rel of agg) {
      const relProps = await loader.ifcManager.getItemProperties(ifcModelID, rel.value);
      const related = relProps?.RelatedObjects || [];
      for (const obj of related) {
        children.push(obj.value);
      }
    }
    // IfcRelContainedInSpatialStructure — contained elements
    const cont = rels?.ContainsElements || [];
    for (const rel of cont) {
      const relProps = await loader.ifcManager.getItemProperties(ifcModelID, rel.value);
      const related = relProps?.RelatedElements || [];
      for (const obj of related) {
        children.push(obj.value);
      }
    }
  } catch { /* ignore */ }
  return children;
}

// ── TYPES VIEW ────────────────────────────────────────────────
async function buildTypesView() {
  const wrap = document.getElementById('types-body');
  wrap.innerHTML = '';
  if (!loader || ifcModelID === null) return;

  // Get all IFC types present in the model
  const ifcapi = loader.ifcManager.ifcAPI;
  const typeGroups = {};

  // Scan all lines for type names
  try {
    const allLines = ifcapi.GetAllLines(ifcModelID);
    const total = Math.min(allLines.size(), 50000);
    for (let i = 0; i < total; i++) {
      if (i % 500 === 0) await new Promise(r => setTimeout(r, 0)); // yield to UI thread
      const id = allLines.get(i);
      try {
        const props = ifcapi.GetLine(ifcModelID, id, false);
        if (!props?.type) continue;
        const typeName = ifcapi.GetNameFromTypeCode(props.type) || ('Type_' + props.type);
        if (!typeGroups[typeName]) typeGroups[typeName] = [];
        typeGroups[typeName].push(id);
      } catch { /* skip */ }
    }
  } catch { /* ignore */ }

  const sorted = Object.entries(typeGroups).sort(([a], [b]) => a.localeCompare(b));
  for (const [typeName, ids] of sorted) {
    const grp = document.createElement('div');
    grp.className = 'tn';
    const row = document.createElement('div');
    row.className = 'tr';
    row.style.paddingLeft = '3px';
    const tc = document.createElement('span'); tc.className = 'tc'; tc.textContent = '▶';
    const ti = document.createElement('span'); ti.className = 'ti ic-X'; ti.textContent = '⊞';
    const lbl = document.createElement('span'); lbl.className = 'tl'; lbl.style.fontWeight = '600';
    lbl.textContent = typeName.replace('IFC', '');
    const badge = document.createElement('span'); badge.className = 'tbg'; badge.textContent = ids.length;
    row.appendChild(tc); row.appendChild(ti); row.appendChild(lbl); row.appendChild(badge);
    const ch = document.createElement('div'); ch.className = 'tch';

    for (const id of ids.slice(0, 500)) {
      const itemRow = document.createElement('div');
      itemRow.className = 'tr';
      itemRow.dataset.id = id;
      itemRow.style.paddingLeft = '18px';
      const t2 = document.createElement('span'); t2.className = 'tc leaf'; t2.textContent = '▶';
      const i2 = document.createElement('span'); i2.className = 'ti ic-E'; i2.textContent = '▪';
      const l2 = document.createElement('span'); l2.className = 'tl'; l2.textContent = '#' + id;
      itemRow.appendChild(t2); itemRow.appendChild(i2); itemRow.appendChild(l2);
      itemRow.addEventListener('click', async (e) => { await selectEntity(id, true, e.ctrlKey); });
      ch.appendChild(itemRow);
    }

    grp.appendChild(row); grp.appendChild(ch);
    tc.addEventListener('click', ev => { ev.stopPropagation(); ch.classList.toggle('open'); tc.classList.toggle('open'); });
    row.addEventListener('click', () => { ch.classList.toggle('open'); tc.classList.toggle('open'); });
    wrap.appendChild(grp);
  }
}

// ── STOREYS VIEW ──────────────────────────────────────────────
async function buildStoreysView() {
  const wrap = document.getElementById('storeys-body');
  wrap.innerHTML = '';
  if (!loader || ifcModelID === null) return;

  try {
    const spatial = await loader.ifcManager.getSpatialStructure(ifcModelID, true);
    renderSpatialGroup(spatial, wrap, 0);
  } catch (err) {
    wrap.innerHTML = '<div style="padding:12px;font-family:var(--mono);font-size:11px;color:var(--tx3)">Fehler: ' + err.message + '</div>';
  }
}

function renderSpatialGroup(node, parent, depth) {
  if (!node) return;
  const type = node.type || '';
  const name = node.Name?.value || node.LongName?.value || '';
  const expressID = node.expressID;
  const children = node.children || [];

  const outer = document.createElement('div');
  outer.className = 'tn';
  const row = document.createElement('div');
  row.className = 'tr';
  row.style.paddingLeft = (depth * 14 + 3) + 'px';
  const hasKids = children.length > 0;
  const ic = SP_ICON[type] || null;

  const tc = document.createElement('span'); tc.className = 'tc' + (hasKids ? '' : ' leaf'); tc.textContent = '▶';
  const ti = document.createElement('span'); ti.className = 'ti ' + (ic ? ic.c : 'ic-E'); ti.textContent = ic ? ic.l : '▪';
  const lbl = document.createElement('span'); lbl.className = 'tl';
  lbl.textContent = name || (type.replace('IFC', '') + ' #' + expressID);
  const badge = document.createElement('span'); badge.className = 'tbg'; badge.textContent = type.replace('IFC', '');

  row.appendChild(tc); row.appendChild(ti); row.appendChild(lbl); row.appendChild(badge);
  outer.appendChild(row);

  const ch = document.createElement('div'); ch.className = 'tch';
  for (const child of children) renderSpatialGroup(child, ch, depth + 1);
  outer.appendChild(ch);

  tc.addEventListener('click', ev => { ev.stopPropagation(); ch.classList.toggle('open'); tc.classList.toggle('open'); });
  row.addEventListener('click', async (e) => {
    if (hasKids) { ch.classList.toggle('open'); tc.classList.toggle('open'); }
    if (expressID !== undefined) await selectEntity(expressID, true, e.ctrlKey);
  });

  parent.appendChild(outer);

  // Auto-expand storeys
  if (type === 'IFCBUILDING' || type === 'IFCSITE' || type === 'IFCPROJECT') {
    ch.classList.add('open');
    tc.classList.add('open');
  }
}

// ── TREE SYNC ─────────────────────────────────────────────────
function syncTreeSelection(expressID) {
  document.querySelectorAll('.tr.sel').forEach(r => r.classList.remove('sel'));
  // Highlight all selected IDs in the tree
  selectedExpressIDs.forEach(id => {
    document.querySelectorAll('.tr[data-id="' + id + '"]').forEach(r => r.classList.add('sel'));
  });
  // Scroll to and expand the primary selection
  const rows = document.querySelectorAll('.tr[data-id="' + expressID + '"]');
  rows.forEach(row => {
    row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    let p = row.parentElement;
    while (p) {
      if (p.classList?.contains('tch')) {
        p.classList.add('open');
        p.previousElementSibling?.querySelector('.tc')?.classList.add('open');
      }
      p = p.parentElement;
    }
  });
}

// ── TREE SEARCH ───────────────────────────────────────────────
function filterTree(q) {
  q = q.toLowerCase().trim();
  const activeBody = document.querySelector('.tbody.on');
  if (!activeBody) return;
  activeBody.querySelectorAll('.tn').forEach(n => {
    if (!q) { n.style.display = ''; return; }
    const id = (n.dataset.id || '').toLowerCase();
    const type = (n.dataset.type || '').toLowerCase();
    const name = (n.dataset.name || '').toLowerCase();
    const show = type.includes(q) || name.includes(q) || id.includes(q);
    n.style.display = show ? '' : 'none';
    if (show) {
      let p = n.parentElement;
      while (p && p !== activeBody) {
        if (p.classList.contains('tch')) p.classList.add('open');
        p = p.parentElement;
      }
    }
  });
}

// ── PROPERTIES ────────────────────────────────────────────────
async function showProperties(expressID) {
  const wrap = document.getElementById('pw');
  wrap.innerHTML = '';
  curProps = [];

  try {
    // 1. Item properties (Name, GlobalId, Tag, etc.)
    const props = await loader.ifcManager.getItemProperties(ifcModelID, expressID);
    if (props) {
      const items = Object.entries(props)
        .filter(([k]) => k !== 'expressID' && k !== 'type')
        .map(([key, val]) => ({
          key,
          val: formatPropValue(val),
          raw: val,
        }));
      if (items.length) curProps.push({ title: 'Basis-Attribute', items });
    }

    // 2. Property sets
    const psets = await loader.ifcManager.getPropertySets(ifcModelID, expressID, true);
    for (const pset of (psets || [])) {
      const psName = pset.Name?.value || pset.type || 'PropertySet';
      const items = [];
      for (const prop of (pset.HasProperties || [])) {
        const p = await loader.ifcManager.getItemProperties(ifcModelID, prop.value);
        if (!p) continue;
        const name = p.Name?.value || ('Prop #' + prop.value);
        const val = p.NominalValue?.value ?? p.Value?.value ?? '—';
        items.push({ key: name, val: String(val), raw: val });
      }
      if (items.length) curProps.push({ title: psName, items });
    }

    // 3. Type object
    const typeObj = await loader.ifcManager.getTypeProperties(ifcModelID, expressID, true);
    for (const t of (typeObj || [])) {
      const typeName = t.Name?.value || t.type || 'Type';
      curProps.push({ title: 'Typ: ' + typeName, items: [] });
    }

  } catch (err) {
    curProps = [{ title: 'Fehler', items: [{ key: 'Error', val: err.message, raw: err.message }] }];
  }

  renderProps();
}

function formatPropValue(val) {
  if (val === null || val === undefined) return '—';
  if (typeof val === 'object') {
    if (val.value !== undefined) return String(val.value);
    if (val.expressID !== undefined) return '#' + val.expressID;
    return JSON.stringify(val);
  }
  return String(val);
}

function renderProps() {
  const wrap = document.getElementById('pw');
  wrap.innerHTML = '';
  const fa = document.getElementById('fa').value.toLowerCase().trim();
  const fv = document.getElementById('fv').value.toLowerCase().trim();
  let total = 0, vis = 0;

  curProps.forEach(sec => {
    const filtered = sec.items.filter(it => {
      total++;
      const km = !fa || it.key.toLowerCase().includes(fa);
      const vm = !fv || it.val.toLowerCase().includes(fv);
      if (km && vm) { vis++; return true; }
      return false;
    });
    if (!filtered.length && sec.items.length) return;

    const sd = document.createElement('div'); sd.className = 'psec';
    const hdr = document.createElement('div'); hdr.className = 'psh';
    hdr.innerHTML = `<span class="psh-t">${esc(sec.title)}</span><span class="psh-c">${filtered.length}</span><span class="psh-v open">▶</span>`;
    const rows = document.createElement('div'); rows.className = 'prows open';
    hdr.addEventListener('click', () => {
      rows.classList.toggle('open');
      hdr.querySelector('.psh-v').classList.toggle('open');
    });
    filtered.forEach(it => rows.appendChild(mkPR(it, fa, fv)));
    sd.appendChild(hdr); sd.appendChild(rows);
    wrap.appendChild(sd);
  });

  if (vis === 0 && (fa || fv)) {
    wrap.innerHTML = '<div class="pempty"><div class="pempty-icon">🔍</div><div>Keine Treffer</div></div>';
  }

  document.getElementById('pcnt').textContent = vis || curProps.reduce((s, c) => s + c.items.length, 0);
  document.getElementById('fcnt').textContent = (fa || fv) ? (vis + '/' + total) : '';
}

function mkPR(item, fa, fv) {
  const row = document.createElement('div');
  row.className = 'pr' + (fa && item.key.toLowerCase().includes(fa) ? ' hk' : '') + (fv && item.val.toLowerCase().includes(fv) ? ' hv' : '');
  const pk = document.createElement('div'); pk.className = 'pk'; pk.title = item.key; pk.innerHTML = hl(item.key, fa);
  const pv = document.createElement('div'); pv.className = 'pv';
  const pvt = document.createElement('span'); pvt.className = 'pvt'; pvt.innerHTML = hl(item.val, fv);
  if (item.val === '—') pvt.classList.add('v-null');
  else if (item.val === 'true') pvt.classList.add('v-t');
  else if (item.val === 'false') pvt.classList.add('v-f');
  else if (!isNaN(Number(item.val)) && item.val !== '') pvt.classList.add('v-num');
  else if (item.val.startsWith('#')) pvt.classList.add('v-ref');
  pv.appendChild(pvt);
  row.appendChild(pk); row.appendChild(pv);
  return row;
}

// ── GUID & ATTRIBUTE WRITING ──────────────────────────────────
function generateIfcGuid() {
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$';
  return Array.from({ length: 22 }, () => chars[Math.floor(Math.random() * 64)]).join('');
}

function updateAddAttrBar() {
  const bar = document.getElementById('addattr-bar');
  if (!bar) return;
  const active = selectedExpressID !== null;
  bar.style.display = active ? 'flex' : 'none';
  const lbl = document.getElementById('addattr-lbl');
  if (lbl) {
    lbl.textContent = selectedExpressIDs.size > 1
      ? '+ Attribut für ' + selectedExpressIDs.size + ' Elemente'
      : '+ Attribut hinzufügen';
  }
}

async function addAttribute(psetName, propName, propValue) {
  const targetIDs = [...selectedExpressIDs];
  if (!targetIDs.length || !rawBuf) { toast('Kein Element ausgewählt', 'err'); return; }
  if (!psetName.trim() || !propName.trim()) { toast('Property Set und Name erforderlich', 'err'); return; }

  const text = new TextDecoder('utf-8', { fatal: false }).decode(rawBuf);

  // Find max express ID
  let maxID = 0;
  const idPat = /#(\d+)=/g;
  let m;
  while ((m = idPat.exec(text)) !== null) {
    const n = parseInt(m[1], 10);
    if (n > maxID) maxID = n;
  }

  const propID = maxID + 1;
  const psetID = maxID + 2;
  const relID  = maxID + 3;
  const idsStr = targetIDs.map(id => '#' + id).join(',');

  const newLines =
    `#${propID}=IFCPROPERTYSINGLEVALUE('${propName.trim()}',$,IFCLABEL('${propValue.trim()}'),$);\n` +
    `#${psetID}=IFCPROPERTYSET('${generateIfcGuid()}',$,'${psetName.trim()}',$,(#${propID}));\n` +
    `#${relID}=IFCRELDEFINESBYPROPERTIES('${generateIfcGuid()}',$,$,$,(${idsStr}),#${psetID});\n`;

  rawBuf = new TextEncoder().encode(text.replace('END-ISO-10303-21;', newLines + 'END-ISO-10303-21;')).buffer;

  // Reflect immediately in the properties panel
  curProps.push({ title: psetName.trim(), items: [{ key: propName.trim(), val: propValue.trim(), raw: propValue.trim() }] });
  renderProps();

  chgN++;
  document.getElementById('unsaved').classList.add('show');
  toast('Attribut \'' + propName.trim() + '\' hinzugefügt ✓', 'ok');
  document.getElementById('addattr-form').style.display = 'none';
}

// ── EDGES TOGGLE ──────────────────────────────────────────────
let edgesOn = true;
function toggleEdges() {
  edgesOn = !edgesOn;
  if (ifcModel) {
    ifcModel.traverse(o => {
      if (o.isLineSegments) o.visible = edgesOn;
    });
  }
  document.getElementById('btn-edges').classList.toggle('on', edgesOn);
}

// ── TAB SWITCHING ─────────────────────────────────────────────
function switchTab(tab) {
  curTab = tab;
  document.querySelectorAll('.ltab').forEach(t => t.classList.toggle('on', t.dataset.tab === tab));
  document.querySelectorAll('.tbody').forEach(b => b.classList.toggle('on', b.id === tab + '-body'));
}

// ── EXPORT ────────────────────────────────────────────────────
function doExport() {
  if (!rawBuf) return;
  const blob = new Blob([rawBuf], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = document.getElementById('flbl').textContent.split(' — ')[0] || 'model.ifc';
  a.click();
  URL.revokeObjectURL(url);
  toast('Exportiert ✓', 'ok');
}

// ── RESIZE PANELS ─────────────────────────────────────────────
function initResizers() {
  setupRH('rh-l', 'left', true);
  setupRH('rh-r', 'right', false);
}

function setupRH(rhId, panelId, isLeft) {
  const rh = document.getElementById(rhId);
  const panel = document.getElementById(panelId);
  let drag = false, sx = 0, sw = 0;
  rh.addEventListener('mousedown', e => {
    drag = true; sx = e.clientX; sw = panel.offsetWidth;
    rh.classList.add('drag');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });
  window.addEventListener('mousemove', e => {
    if (!drag) return;
    const dx = e.clientX - sx;
    const nw = isLeft ? Math.max(140, Math.min(560, sw + dx)) : Math.max(160, Math.min(600, sw - dx));
    panel.style.width = nw + 'px';
  });
  window.addEventListener('mouseup', () => {
    if (!drag) return;
    drag = false; rh.classList.remove('drag');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });
}

// ── HELPERS ───────────────────────────────────────────────────
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function hl(text, q) {
  const e = esc(String(text));
  if (!q) return e;
  return e.replace(new RegExp('(' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi'), '<mark>$1</mark>');
}
function fmtSz(b) { if (b < 1e3) return b + 'B'; if (b < 1e6) return (b / 1e3).toFixed(1) + 'KB'; return (b / 1e6).toFixed(2) + 'MB'; }
function showSpin(m) { if (m) document.getElementById('smsg').textContent = m; document.getElementById('spn').classList.add('show'); }
function setSpin(m) { document.getElementById('smsg').textContent = m; }
function hideSpin() { document.getElementById('spn').classList.remove('show'); }
function showProgress() { document.getElementById('sprog').style.display = 'block'; }
function setProgress(pct) { document.getElementById('sprogbar').style.width = pct + '%'; }
function setSt(m, d) { document.getElementById('stxt').textContent = m; const s = document.getElementById('sdot'); s.className = 'sdot'; if (d) s.classList.add(d); }
let _tt;
function toast(msg, cls) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = 'toast show' + (cls ? ' ' + cls : '');
  clearTimeout(_tt); _tt = setTimeout(() => t.classList.remove('show'), 2600);
}

// ── WIRE UP UI EVENTS ─────────────────────────────────────────
function initUI() {
  // File open
  const fi = document.getElementById('fi');
  document.getElementById('btn-open').addEventListener('click', () => fi.click());
  fi.addEventListener('change', e => { const f = e.target.files[0]; if (f) loadFile(f); });

  // Drop zone
  const dz = document.getElementById('dz');
  dz.addEventListener('click', () => fi.click());
  dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('ov'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('ov'));
  dz.addEventListener('drop', e => {
    e.preventDefault(); dz.classList.remove('ov');
    const f = e.dataTransfer.files[0];
    if (f && f.name.endsWith('.ifc')) loadFile(f);
  });

  // Viewport controls
  document.getElementById('btn-fit').addEventListener('click', fitAll);
  document.getElementById('btn-fitsel').addEventListener('click', fitSelection);
  document.getElementById('btn-showall').addEventListener('click', showAll);
  document.getElementById('btn-hide').addEventListener('click', hideSelected);
  document.getElementById('btn-iso').addEventListener('click', isolateSelected);
  document.getElementById('btn-top').addEventListener('click', () => camSet('top'));
  document.getElementById('btn-fr').addEventListener('click', () => camSet('fr'));
  document.getElementById('btn-si').addEventListener('click', () => camSet('si'));
  document.getElementById('btn-edges').addEventListener('click', toggleEdges);

  // Export
  document.getElementById('btn-dl').addEventListener('click', doExport);

  // Tabs
  document.querySelectorAll('.ltab').forEach(t => {
    t.addEventListener('click', () => switchTab(t.dataset.tab));
  });

  // Tree search
  document.getElementById('tq').addEventListener('input', e => filterTree(e.target.value));

  // Property filter
  document.getElementById('fa').addEventListener('input', renderProps);
  document.getElementById('fv').addEventListener('input', renderProps);
  document.getElementById('fa-clr').addEventListener('click', () => { document.getElementById('fa').value = ''; renderProps(); });
  document.getElementById('fv-clr').addEventListener('click', () => { document.getElementById('fv').value = ''; renderProps(); });

  // Edit mode
  document.getElementById('echk').addEventListener('change', e => {
    editOn = e.target.checked;
    document.getElementById('est').textContent = editOn ? 'aktiv' : 'aus';
    document.getElementById('est').style.color = editOn ? 'var(--am)' : 'var(--tx3)';
  });

  // Add attribute form
  document.getElementById('btn-addattr').addEventListener('click', () => {
    const form = document.getElementById('addattr-form');
    const visible = form.style.display !== 'none';
    form.style.display = visible ? 'none' : 'block';
    if (!visible) document.getElementById('aa-pset').focus();
  });
  document.getElementById('aa-cancel').addEventListener('click', () => {
    document.getElementById('addattr-form').style.display = 'none';
  });
  document.getElementById('aa-ok').addEventListener('click', async () => {
    const pset = document.getElementById('aa-pset').value;
    const name = document.getElementById('aa-name').value;
    const val  = document.getElementById('aa-val').value;
    await addAttribute(pset, name, val);
    document.getElementById('aa-pset').value = '';
    document.getElementById('aa-name').value = '';
    document.getElementById('aa-val').value  = '';
  });
  // Submit form with Enter on last field
  document.getElementById('aa-val').addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') document.getElementById('aa-ok').click();
  });

  // Keyboard shortcut
  window.addEventListener('keydown', e => {
    if (e.key === 'f' || e.key === 'F') fitAll();
    if (e.key === 'Escape') deselect();
  });
}

// ── BOOT ──────────────────────────────────────────────────────
initThree();
initResizers();
initUI();
initIFC();  // async, shows spinner while loading WASM
