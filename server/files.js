'use strict';
/*
 * Laufwerke, Teil „Dateien“ (2.2): alle Dateien in Hostwerks Bereichen (Webordner, Projekte, Apps, Dienste aus
 * Erweiterungen, eigene Ordner, Sicherungen, Protokolle, Konfiguration – dieselben „Wurzeln“ wie die Seite Dateien),
 * nach Dienst sortiert, durchsuchbar, mit Doppelten und Aufräumen.
 *   GET  /api/disk-health/files              → { at, scanning, progress, groups: [{ id, label, kind, path, files, bytes, types, folders }], totals, truncated }
 *   GET  /api/disk-health/files/list?…       → { total, bytes, items: [{ root, path, name, size, mtime, type }] }
 *        root (mehrere mit Komma) · type · q · folder · minSize · olderThan (Tage) · sort = size|name|mtime|root|type · order · offset · limit
 *   POST /api/disk-health/files/rescan       → neu einlesen (im Hintergrund)
 *   POST /api/disk-health/files/delete {items:[{root,path}]}  → in Hostwerks Papierkorb (30 Tage wiederherstellbar)
 *   POST /api/disk-health/files/rename {root,path,name}       → umbenennen im selben Ordner
 *   GET  /api/disk-health/files/duplicates   → { at, running, groups: [{ size, files: [{ root, path, … }] }], waste }
 *   POST /api/disk-health/files/duplicates   → Suche nach Doppelten starten (ab minSize, Prüfsumme über den Inhalt)
 * Der Index liegt nur im Speicher (höchstens MAX_FILES Dateien) und wird alle sechs Stunden und auf Knopfdruck neu
 * gelesen. Löschen geht nur in den Papierkorb und nur innerhalb der Bereiche (Hostwerks resolve prüft den Pfad).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_FILES = 300000;
const RESCAN_MS = 6 * 3600000;
const DUP_MIN = 1048576; // Doppelte erst ab 1 MB – kleine Dateien kosten kaum Platz
const DUP_MAX_GROUPS = 300;
const QUICK = 65536;

/** Art einer Datei aus der Endung – grob, für Filter und Aufteilung. */
const TYPES = [
  ['image', /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg|tiff?|heic|psd|psb|ai|raw|cr2|nef)$/i],
  ['video', /\.(mp4|webm|ogv|mov|m4v|mkv|avi|wmv|flv)$/i],
  ['audio', /\.(mp3|wav|ogg|oga|m4a|flac|aac|opus|wma)$/i],
  ['log', /(\.log(\.\d+)?|\.log\.gz|\.out|\.err)$/i],
  ['archive', /\.(zip|tar|gz|tgz|7z|rar|xz|bz2|zst|mrpack|iso|img|bak|dump)$/i],
  ['database', /\.(db|sqlite3?|mdb|accdb|ibd|frm|myd|myi|mca|mcr|dat|ldb|wal)$/i],
  ['document', /\.(pdf|docx?|xlsx?|pptx?|odt|ods|odp|rtf|txt|md|csv|tsv)$/i],
  ['code', /\.(js|mjs|cjs|jsx|ts|tsx|php|phtml|html?|css|scss|less|vue|svelte|json|ya?ml|toml|ini|cfg|conf|properties|xml|py|rb|go|rs|java|kt|cs|c|h|cpp|hpp|lua|sh|bat|cmd|ps1|sql|twig|env|lock|map)$/i],
  ['program', /\.(exe|dll|so|dylib|jar|msi|bin|node|wasm|pyd|class)$/i],
];
const TYPE_IDS = [...TYPES.map(([id]) => id), 'other'];
function typeOf(name) { for (const [id, re] of TYPES) if (re.test(name)) return id; return 'other'; }

/** Pfad in Vergleichsform (Windows: ohne Groß-/Kleinschreibung). */
const norm = (p, win) => { const r = path.resolve(p); return win ? r.toLowerCase() : r; };
/** Liegt b in a (oder ist gleich)? */
const inside = (a, b) => b === a || b.startsWith(a.endsWith(path.sep) ? a : a + path.sep);
const fail = (msg, status) => Object.assign(new Error(msg), { status });

/**
 * io = { roots(): [{ id, label, kind, path, docker?, custom? }], toTrash(root, rel), resolve(root, rel) → { full },
 *        skip?: [Ordner, die nie gezählt werden (Papierkorb)], platform?, now?() }
 */
function createFiles(io) {
  const win = (io.platform || process.platform) === 'win32';
  const now = io.now || Date.now;
  let index = null; // { at, roots: [...], files: [{ r, p, n, s, m, t }], truncated }
  let scanning = null;
  let progress = { files: 0, root: null };
  let dups = { at: null, running: false, groups: [], waste: 0, error: null, checked: 0 };

  /** Wurzeln ohne Docker-Bereiche (liegen nicht im Dateisystem) und ohne doppelte Pfade. */
  const rootsNow = () => {
    const seen = new Set();
    return (io.roots() || []).filter((r) => r && r.path && !r.docker && fs.existsSync(r.path)).filter((r) => {
      const k = norm(r.path, win);
      if (seen.has(k)) return false;
      seen.add(k); return true;
    });
  };

  async function walk(root, rIdx, others, skip, out) {
    const base = path.resolve(root.path);
    const stack = [base];
    while (stack.length) {
      const dir = stack.pop();
      let dh;
      try { dh = await fs.promises.opendir(dir); } catch { continue; }
      try {
        for await (const e of dh) {
          const full = path.join(dir, e.name);
          if (e.isSymbolicLink()) continue;
          if (e.isDirectory()) {
            const k = norm(full, win);
            // Ein anderer Bereich liegt hier drin (z. B. App-Ordner im Projekte-Ordner) → zählt dort, nicht doppelt
            if (others.has(k) || skip.some((s) => inside(s, k))) continue;
            stack.push(full);
            continue;
          }
          if (!e.isFile()) continue;
          if (out.length >= MAX_FILES) return true;
          let st;
          try { st = await fs.promises.stat(full); } catch { continue; }
          out.push({ r: rIdx, p: path.relative(base, full).split(path.sep).join('/'), n: e.name, s: st.size, m: Math.round(st.mtimeMs), t: typeOf(e.name) });
          progress.files = out.length;
        }
      } catch { /* Ordner verschwand während des Lesens */ }
    }
    return false;
  }

  function scan() {
    if (scanning) return scanning;
    scanning = (async () => {
      const roots = rootsNow();
      const skip = (io.skip || []).filter(Boolean).map((p) => norm(p, win));
      const files = [];
      let truncated = false;
      progress = { files: 0, root: null };
      for (let i = 0; i < roots.length && !truncated; i++) {
        const mine = norm(roots[i].path, win);
        if (skip.some((s) => inside(s, mine))) continue;
        const others = new Set(roots.map((x) => norm(x.path, win)).filter((p) => p !== mine && inside(mine, p)));
        progress.root = roots[i].label;
        truncated = await walk(roots[i], i, others, skip, files);
      }
      index = { at: now(), roots: roots.map((r) => ({ id: r.id, label: r.label, kind: r.kind || 'other', path: r.path, custom: !!r.custom })), files, truncated };
      if (dups.at) dups = { ...dups, stale: true };
      return index;
    })().finally(() => { scanning = null; progress = { files: 0, root: null }; });
    return scanning;
  }

  /** Erste Ebene eines Bereichs: welcher Ordner wie viel belegt (die größten zwölf; '' = Dateien direkt im Bereich). */
  function folders(rIdx) {
    const m = new Map();
    for (const f of index.files) {
      if (f.r !== rIdx) continue;
      const i = f.p.indexOf('/');
      const k = i < 0 ? '' : f.p.slice(0, i);
      const e = m.get(k) || { name: k, bytes: 0, files: 0 };
      e.bytes += f.s; e.files++; m.set(k, e);
    }
    return [...m.values()].sort((a, b) => b.bytes - a.bytes).slice(0, 12);
  }

  function summary() {
    const base = { scanning: !!scanning, progress: { ...progress }, max: MAX_FILES, typeIds: TYPE_IDS };
    if (!index) return { ...base, at: null, groups: [], totals: { files: 0, bytes: 0, types: {} }, truncated: false };
    const groups = index.roots.map((r) => ({ ...r, files: 0, bytes: 0, types: {}, newest: 0 }));
    const totals = { files: 0, bytes: 0, types: {} };
    for (const f of index.files) {
      const g = groups[f.r];
      g.files++; g.bytes += f.s; g.types[f.t] = (g.types[f.t] || 0) + f.s; if (f.m > g.newest) g.newest = f.m;
      totals.files++; totals.bytes += f.s; totals.types[f.t] = (totals.types[f.t] || 0) + f.s;
    }
    groups.forEach((g, i) => { g.folders = folders(i); });
    return { ...base, at: index.at, groups, totals, truncated: index.truncated };
  }

  const item = (f) => ({ root: index.roots[f.r].id, path: f.p, name: f.n, size: f.s, mtime: f.m, type: f.t });

  /** Gefilterte, sortierte Seite der Liste. */
  function list(q = {}) {
    if (!index) return { at: null, total: 0, bytes: 0, items: [] };
    const roots = q.root ? new Set(String(q.root).split(',').filter(Boolean)) : null;
    const rIdx = roots ? new Set(index.roots.map((r, i) => (roots.has(r.id) ? i : -1)).filter((i) => i >= 0)) : null;
    const types = q.type ? new Set(String(q.type).split(',').filter(Boolean)) : null;
    const words = String(q.q || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
    const minSize = Number(q.minSize) > 0 ? Number(q.minSize) : 0;
    const olderThan = Number(q.olderThan) > 0 ? now() - Number(q.olderThan) * 86400000 : 0;
    const folder = q.folder != null ? String(q.folder) : null;
    let bytes = 0;
    const hits = [];
    for (const f of index.files) {
      if (rIdx && !rIdx.has(f.r)) continue;
      if (types && !types.has(f.t)) continue;
      if (minSize && f.s < minSize) continue;
      if (olderThan && f.m > olderThan) continue;
      if (folder !== null && !(folder === '' ? !f.p.includes('/') : f.p.startsWith(`${folder}/`))) continue;
      if (words.length) { const hay = f.p.toLowerCase(); if (!words.every((w) => hay.includes(w))) continue; }
      hits.push(f); bytes += f.s;
    }
    const dir = q.order === 'asc' ? 1 : -1;
    const by = {
      size: (a, b) => (a.s - b.s) * dir,
      mtime: (a, b) => (a.m - b.m) * dir,
      name: (a, b) => a.n.localeCompare(b.n, 'de', { numeric: true }) * -dir,
      root: (a, b) => (index.roots[a.r].label.localeCompare(index.roots[b.r].label, 'de') * -dir) || b.s - a.s,
      type: (a, b) => (a.t.localeCompare(b.t) * -dir) || b.s - a.s,
    }[q.sort] || ((a, b) => b.s - a.s);
    hits.sort(by);
    const offset = Math.max(0, Number(q.offset) || 0);
    const limit = Math.min(500, Math.max(1, Number(q.limit) || 100));
    return { at: index.at, total: hits.length, bytes, items: hits.slice(offset, offset + limit).map(item) };
  }

  const rootIdx = (id) => (index ? index.roots.findIndex((r) => r.id === id) : -1);
  /** Einträge aus dem Index nehmen (nach dem Löschen) – ohne alles neu zu lesen. */
  function forget(items) {
    if (!index || !items.length) return;
    const gone = new Set(items.map((x) => `${rootIdx(x.root)}|${x.path}`));
    index.files = index.files.filter((f) => !gone.has(`${f.r}|${f.p}`));
    if (dups.groups.length) {
      dups.groups = dups.groups.map((g) => ({ ...g, files: g.files.filter((f) => !gone.has(`${rootIdx(f.root)}|${f.path}`)) })).filter((g) => g.files.length > 1);
      dups.waste = dups.groups.reduce((a, g) => a + g.size * (g.files.length - 1), 0);
    }
  }

  /** In den Papierkorb – jede Datei einzeln, Fehler je Datei zurück. */
  function remove(items) {
    const todo = (Array.isArray(items) ? items : []).filter((x) => x && typeof x.root === 'string' && typeof x.path === 'string' && x.path).slice(0, 5000);
    const done = []; const failed = [];
    for (const x of todo) {
      try { io.toTrash(x.root, x.path); done.push({ root: x.root, path: x.path }); } catch (e) { failed.push({ root: x.root, path: x.path, error: e.message }); }
    }
    forget(done);
    return { ok: !failed.length, done: done.length, failed };
  }

  function rename({ root, path: rel, name } = {}) {
    const n = String(name || '').trim();
    if (typeof root !== 'string' || typeof rel !== 'string' || !rel) throw fail('Missing file', 400);
    if (!n || /[\\/:*?"<>|]/.test(n) || n === '.' || n === '..') throw fail('Invalid name', 400);
    const to = rel.includes('/') ? `${rel.slice(0, rel.lastIndexOf('/'))}/${n}` : n;
    const a = io.resolve(root, rel).full; const b = io.resolve(root, to).full;
    if (a === b) return { ok: true, path: to };
    if (fs.existsSync(b) && a.toLowerCase() !== b.toLowerCase()) throw fail('A file with this name already exists', 409);
    fs.renameSync(a, b);
    const i = rootIdx(root);
    if (index && i >= 0) { const f = index.files.find((x) => x.r === i && x.p === rel); if (f) { f.p = to; f.n = n; f.t = typeOf(n); } }
    return { ok: true, path: to };
  }

  /** Prüfsumme: quick = Anfang + Ende (schnell), sonst über den ganzen Inhalt. */
  async function hashFile(full, size, quick) {
    const h = crypto.createHash('sha1');
    if (quick) {
      const fd = await fs.promises.open(full, 'r');
      try {
        const n = Math.min(QUICK, size); const a = Buffer.alloc(n);
        await fd.read(a, 0, n, 0); h.update(a);
        if (size > QUICK * 2) { const b = Buffer.alloc(QUICK); await fd.read(b, 0, QUICK, size - QUICK); h.update(b); }
      } finally { await fd.close(); }
      return h.digest('hex');
    }
    await new Promise((res, rej) => { fs.createReadStream(full).on('data', (c) => h.update(c)).on('end', res).on('error', rej); });
    return h.digest('hex');
  }

  /** Dateien gleicher Größe nach Prüfsumme gruppieren – erst Anfang + Ende, dann (bei Gleichstand) der ganze Inhalt. */
  async function groupBySum(l, size, fullOf) {
    const bucket = async (list0, quick) => {
      const by = new Map();
      for (const f of list0) {
        try { const h = await hashFile(fullOf(f), size, quick); const x = by.get(h); if (x) x.push(f); else by.set(h, [f]); } catch { /* weg oder gesperrt */ }
        dups.checked++;
      }
      return [...by.values()].filter((x) => x.length > 1);
    };
    const quick = await bucket(l, true);
    if (size <= QUICK * 2) return quick; // ganz gelesen
    const out = [];
    for (const g of quick) out.push(...await bucket(g, false));
    return out;
  }

  function findDuplicates({ minSize = DUP_MIN } = {}) {
    if (dups.running) return Promise.resolve(dups);
    dups = { ...dups, running: true, error: null, checked: 0, stale: false };
    (async () => {
      try {
        if (!index) await scan();
        const bySize = new Map();
        for (const f of index.files) { if (f.s < minSize) continue; const l = bySize.get(f.s); if (l) l.push(f); else bySize.set(f.s, [f]); }
        const cands = [...bySize.entries()].filter(([, l]) => l.length > 1).sort((a, b) => b[0] * (b[1].length - 1) - a[0] * (a[1].length - 1));
        const groups = [];
        const fullOf = (f) => io.resolve(index.roots[f.r].id, f.p).full;
        for (const [size, l] of cands) {
          if (groups.length >= DUP_MAX_GROUPS) break;
          for (const g of await groupBySum(l, size, fullOf)) groups.push({ size, files: g.map(item) });
        }
        groups.sort((a, b) => b.size * (b.files.length - 1) - a.size * (a.files.length - 1));
        dups = { at: now(), running: false, groups, waste: groups.reduce((a, g) => a + g.size * (g.files.length - 1), 0), error: null, checked: dups.checked, minSize };
      } catch (e) { dups = { ...dups, running: false, error: e.message }; }
    })();
    return Promise.resolve(dups);
  }

  return {
    scan, summary, list, remove, rename, forget, findDuplicates,
    duplicates: () => dups,
    ready: () => !!index,
    isStale: () => !index || now() - index.at > RESCAN_MS,
  };
}

/** In Hostwerk: Wurzeln und Papierkorb aus Hostwerks Datei-Dienst (ctx.files), Routen unter /disk-health/files. */
function mount(host) {
  const fsvc = host.ctx && host.ctx.files;
  if (!fsvc || typeof fsvc.roots !== 'function' || typeof fsvc.toTrash !== 'function') return null;
  const files = createFiles({
    roots: () => fsvc.roots(),
    toTrash: (root, rel) => fsvc.toTrash(root, rel),
    resolve: (root, rel) => fsvc.resolve(root, rel),
    skip: [fsvc.trashDir],
  });
  const r = host.router;
  const kick = () => { if (files.isStale()) files.scan().catch((e) => { if (host.log) host.log('files scan:', e.message); }); };
  r.get('/disk-health/files', (req, res) => { kick(); res.json(files.summary()); });
  r.get('/disk-health/files/list', (req, res) => res.json(files.list(req.query || {})));
  r.post('/disk-health/files/rescan', (req, res) => { files.scan().catch(() => {}); res.json(files.summary()); });
  r.post('/disk-health/files/delete', (req, res) => res.json(files.remove((req.body || {}).items)));
  r.post('/disk-health/files/rename', (req, res) => res.json(files.rename(req.body || {})));
  r.get('/disk-health/files/duplicates', (req, res) => res.json(files.duplicates()));
  r.post('/disk-health/files/duplicates', async (req, res) => res.json(await files.findDuplicates({ minSize: Number((req.body || {}).minSize) || DUP_MIN })));
  // Erstes Einlesen, wenn Hostwerk gestartet ist; danach alle sechs Stunden (oder beim Öffnen, wenn älter)
  const first = setTimeout(kick, 120000);
  const timer = setInterval(kick, RESCAN_MS);
  for (const x of [first, timer]) if (x && x.unref) x.unref();
  host.on('shutdown', () => { clearTimeout(first); clearInterval(timer); });
  return files;
}

module.exports = { createFiles, mount, typeOf, TYPE_IDS, MAX_FILES };
