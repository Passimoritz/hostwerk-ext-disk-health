'use strict';
/*
 * Laufwerke, Teil „Dateien“ (2.3): jede Datei auf den Laufwerken des Rechners – nicht nur in Hostwerks Ordnern –,
 * zugeordnet zu dem, wem sie gehört: Hostwerks Bereiche (Webordner, Projekte, Apps, Dienste, Sicherungen …),
 * Programme (Program Files, ProgramData, AppData – derselbe Name an mehreren Orten zählt als eine Anwendung),
 * persönliche Ordner (Downloads, Dokumente …), System (Windows, temporäre Dateien, Windows-Papierkorb) und sonstige
 * Ordner. Durchsuchbar, als Ordnerbaum, mit Doppelten und Aufräumen.
 *   GET  /api/disk-health/files              → { at, scanning, progress, mode, groups, drives, totals, truncated, max }
 *   GET  /api/disk-health/files/list?…       → { total, bytes, items: [{ id, path, dir, name, size, mtime, type, group, root?, rel?, lock? }] }
 *        group (mehrere mit Komma) · root (Hostwerk-Bereich) · dir (Ordner samt Unterordnern) · type · q · minSize ·
 *        olderThan / newerThan (Tage) · sort = size|name|mtime|group|type · order · offset · limit
 *   GET  /api/disk-health/files/tree?dir=…   → Ordner mit Größe und Unterordnern (ohne dir: die Laufwerke; group=…: deren Orte)
 *   GET  /api/disk-health/files/export?…     → dieselbe Liste als CSV (höchstens 100.000 Zeilen)
 *   POST /api/disk-health/files/rescan       → neu einlesen (im Hintergrund)
 *   POST /api/disk-health/files/delete {items:[{path}]} → Hostwerks Bereiche: Hostwerks Papierkorb; sonst Windows-Papierkorb
 *   POST /api/disk-health/files/rename {path,name}      → umbenennen im selben Ordner
 *   POST /api/disk-health/files/reveal {path, dir?}     → im Explorer zeigen (Datei markiert)
 *   GET  /api/disk-health/files/download?path=…         → herunterladen
 *   GET|POST /api/disk-health/files/duplicates          → doppelte Dateien (gleiche Größe, gleicher Inhalt)
 * Der Index liegt nur im Speicher, spaltenweise (bis MAX_FILES Dateien einzeln; darüber zählen Ordner und Summen
 * weiter, nur die Einzelliste endet). Geschützt (nie löschen/umbenennen): Windows, Program Files, Hostwerks eigene
 * Programme und Laufzeiten, Auslagerungsdateien. Alles wirkt nur auf Dateien, die im Index stehen.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

/** Einzeln gemerkt: alle Dateien bis MAX_FILES, darüber nur noch große (ab BIG_ONLY) bis HARD_MAX – Summen immer vollständig. */
const MAX_FILES = 1000000;
const HARD_MAX = 1600000;
const BIG_ONLY = 1048576;
const collator = new Intl.Collator('de', { numeric: true, sensitivity: 'base' });
const RESCAN_MS = 6 * 3600000;
const DUP_MIN = 1048576; // Doppelte erst ab 1 MB – kleine Dateien kosten kaum Platz
const DUP_MAX_GROUPS = 300;
const QUICK = 65536;
const STAT_BATCH = 48;

/** Art einer Datei aus der Endung – grob, für Filter und Aufteilung. */
const TYPES = [
  ['image', /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg|tiff?|heic|psd|psb|ai|raw|cr2|nef)$/i],
  ['video', /\.(mp4|webm|ogv|mov|m4v|mkv|avi|wmv|flv)$/i],
  ['audio', /\.(mp3|wav|ogg|oga|m4a|flac|aac|opus|wma)$/i],
  ['log', /(\.log(\.\d+)?|\.log\.gz|\.out|\.err|\.etl|\.evtx|\.dmp)$/i],
  ['archive', /\.(zip|tar|gz|tgz|7z|rar|xz|bz2|zst|mrpack|iso|img|bak|dump|cab|vhdx?|vmdk|qcow2|wim|esd)$/i],
  ['database', /\.(db|sqlite3?|mdb|accdb|ibd|frm|myd|myi|mca|mcr|dat|ldb|wal|edb|pst|ost)$/i],
  ['document', /\.(pdf|docx?|xlsx?|pptx?|odt|ods|odp|rtf|txt|md|csv|tsv|epub)$/i],
  ['code', /\.(js|mjs|cjs|jsx|ts|tsx|php|phtml|html?|css|scss|less|vue|svelte|json|ya?ml|toml|ini|cfg|conf|properties|xml|py|pyc|rb|go|rs|java|kt|cs|c|h|cpp|hpp|lua|sh|bat|cmd|ps1|sql|twig|env|lock|map)$/i],
  ['game', /\.(pak|ucas|utoc|rpkg|vpk|bsa|ba2|assets|resource|resources|bundle|forge|wad|gcf|vdf|acf|bik|bk2|upk|xnb|uasset|umap)$/i],
  ['program', /\.(exe|dll|sys|so|dylib|jar|msi|msp|bin|node|wasm|pyd|class|mui)$/i],
];
const TYPE_IDS = [...TYPES.map(([id]) => id), 'other'];
const TYPE_NUM = Object.fromEntries(TYPE_IDS.map((id, i) => [id, i]));
function typeOf(name) { for (const [id, re] of TYPES) if (re.test(name)) return id; return 'other'; }

/** Hersteller-Ordner: die Anwendung ist eine Ebene tiefer („Google\Chrome“ → „Google Chrome“). */
const VENDORS = new Set(['microsoft', 'google', 'adobe', 'jetbrains', 'apple', 'apple computer', 'intel', 'nvidia', 'nvidia corporation', 'amd', 'mozilla', 'common files', 'microsoft shared', 'windows kits', 'reference assemblies', 'oracle', 'logitech', 'razer', 'corsair', 'electronic arts', 'ubisoft', 'epic games', 'riot games', 'valve']);
const PERSONAL = { downloads: 'Downloads', documents: 'Documents', desktop: 'Desktop', pictures: 'Pictures', videos: 'Videos', music: 'Music', 'saved games': 'Saved games', '3d objects': '3D objects', contacts: 'Contacts', favorites: 'Favourites', links: 'Links', searches: 'Searches' };
const SYSTEM_TOP = new Set(['system volume information', 'recovery', '$winreagent', 'boot', '$windows.~bt', '$windows.~ws', '$sysreset', 'perflogs', 'config.msi', 'msocache', '$getcurrent', 'esd', 'onedrivetemp', 'windows.old']);
const SYSTEM_FILES = /^(pagefile|hiberfil|swapfile)\.sys$|^dumpstack\.log(\.tmp)?$|^bootmgr$|^bootnxt$/i;
const UNIX_SKIP = ['/proc', '/sys', '/dev', '/run', '/snap', '/var/lib/docker', '/System/Volumes', '/private/var/vm', '/Volumes'];

const fail = (msg, status) => Object.assign(new Error(msg), { status });
/** Name als Schlüssel: „Google Chrome“, „google-chrome“ und „GoogleChrome“ sind dieselbe Anwendung. */
const keyName = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '');
/** Paketname aus „Microsoft.WindowsTerminal_8wekyb3d8bbwe“ bzw. „…_1.18.0_x64__8wekyb3d8bbwe“ → „Windows Terminal“. */
function pkgName(s) {
  const base = String(s).split('_')[0];
  const parts = base.split('.').filter(Boolean);
  if (parts.length > 1 && /^[A-Z0-9]{5,}$/.test(parts[0])) parts.shift(); // Herausgeber-Kürzel („5319275A“)
  const last = parts.length > 1 ? parts.slice(1).join(' ') : parts[0] || base;
  return last.replace(/([a-z])([A-Z][a-z]{3,})/g, '$1 $2');
}

/**
 * Die Zuordnung eines Ordners (Pfadstücke unterhalb des Laufwerks). final = alles darunter gehört dazu; sonst
 * entscheiden die Unterordner selbst (z. B. „Program Files“ → je Unterordner eine Anwendung).
 */
function classify(segs, drive, win) {
  const n = segs.length;
  const low = segs.map((s) => s.toLowerCase());
  const D = String(drive).replace(/[\\/]+$/, '');
  const lockFor = (where) => (where === 'pf' ? 'program' : null);
  const app = (label0, where) => { const label = String(label0).replace(/^\.+/, '') || label0; return { key: `app:${keyName(label)}`, label, kind: 'program', cat: 'apps', final: true, lock: lockFor(where) }; };
  const vendorApp = (i, where) => {
    // segs[i] ist der Ordner der Anwendung – bei Herstellern eine Ebene tiefer
    if (VENDORS.has(low[i])) {
      if (n === i + 1) return { key: `app:${keyName(segs[i])}`, label: segs[i], kind: 'program', cat: 'apps', final: false, lock: lockFor(where) };
      const sub = low[i] === 'common files' || low[i] === 'microsoft shared' ? segs[i + 1] : `${segs[i]} ${segs[i + 1]}`;
      return app(sub, where);
    }
    if (low[i] === 'windowsapps' || low[i] === 'packages') {
      if (n === i + 1) return { key: 'app:storeapps', label: 'Store apps', i18n: true, kind: 'program', cat: 'apps', final: false, lock: lockFor(where) };
      return app(pkgName(segs[i + 1]), where);
    }
    return app(segs[i], where);
  };
  if (!n) return { key: `drive:${keyName(D) || 'root'}`, label: win ? `${D}\\` : D || '/', kind: 'drive', cat: 'other', final: false };
  if (!win) {
    if (low[0] === 'home' || low[0] === 'users') {
      if (n === 1) return { key: 'users', label: 'Users', i18n: true, kind: 'personal', cat: 'personal', final: false };
      if (n === 2) return { key: `user:${low[1]}`, label: segs[1], kind: 'personal', cat: 'personal', final: false };
      if (low[2] === '.cache' || low[2] === '.local' || low[2] === '.config' || low[2] === 'library') {
        if (n === 3) return { key: `user:${low[1]}:${low[2]}`, label: segs[2], kind: 'program', cat: 'apps', final: false };
        return app(segs[3], 'data');
      }
      if (low[2].startsWith('.')) return app(segs[2].slice(1), 'data');
      return { key: `personal:${low[1]}:${low[2]}`, label: PERSONAL[low[2]] || segs[2], i18n: !!PERSONAL[low[2]], kind: 'personal', cat: 'personal', final: true };
    }
    if (['usr', 'bin', 'sbin', 'lib', 'lib64', 'etc', 'boot', 'system', 'private'].includes(low[0])) return { key: 'sys:os', label: 'Operating system', i18n: true, kind: 'system', cat: 'system', final: true, lock: 'system' };
    if (low[0] === 'tmp') return { key: 'sys:temp', label: 'Temporary files', i18n: true, kind: 'temp', cat: 'system', final: true };
    if (low[0] === 'applications' || low[0] === 'opt') return n === 1 ? { key: 'apps:pf', label: 'Programs (other)', i18n: true, kind: 'program', cat: 'apps', final: false } : app(segs[1].replace(/\.app$/i, ''), 'pf');
    return { key: `top:${low[0]}`, label: `/${segs[0]}`, kind: 'folder', cat: 'other', final: true };
  }
  const s0 = low[0];
  if (s0 === 'windows') return { key: 'sys:windows', label: 'Windows', kind: 'system', cat: 'system', final: true, lock: 'system' };
  if (s0 === '$recycle.bin') return { key: 'sys:recycle', label: 'Windows recycle bin', i18n: true, kind: 'recycle', cat: 'system', final: true, lock: 'system' };
  if (SYSTEM_TOP.has(s0)) return { key: 'sys:extra', label: 'Windows setup & recovery', i18n: true, kind: 'system', cat: 'system', final: true, lock: 'system' };
  if (s0 === 'program files' || s0 === 'program files (x86)' || s0 === 'programdata') {
    const where = s0 === 'programdata' ? 'data' : 'pf';
    if (n === 1) return { key: where === 'pf' ? 'apps:pf' : 'apps:pd', label: where === 'pf' ? 'Programs (other)' : 'Program data (other)', i18n: true, kind: 'program', cat: 'apps', final: false, lock: lockFor(where) };
    return vendorApp(1, where);
  }
  if (s0 === 'users') {
    if (n === 1) return { key: 'users', label: 'Users', i18n: true, kind: 'personal', cat: 'personal', final: false };
    if (n === 2) return { key: `user:${low[1]}`, label: segs[1], kind: 'personal', cat: 'personal', final: false };
    const s2 = low[2];
    if (s2 === 'appdata') {
      if (n === 3) return { key: `user:${low[1]}`, label: segs[1], kind: 'personal', cat: 'personal', final: false };
      if (n === 4) return { key: 'apps:appdata', label: 'App data (other)', i18n: true, kind: 'program', cat: 'apps', final: false };
      if (low[3] === 'local' && low[4] === 'temp') return { key: 'sys:temp', label: 'Temporary files', i18n: true, kind: 'temp', cat: 'system', final: true };
      if (low[3] === 'local' && low[4] === 'programs') return n === 5 ? { key: 'apps:pf', label: 'Programs (other)', i18n: true, kind: 'program', cat: 'apps', final: false } : vendorApp(5, 'data');
      return vendorApp(4, 'data');
    }
    if (PERSONAL[s2]) return { key: `personal:${low[1]}:${s2}`, label: PERSONAL[s2], i18n: true, sub: segs[1], kind: 'personal', cat: 'personal', final: true };
    if (s2.startsWith('onedrive')) return { key: `personal:${low[1]}:onedrive`, label: 'OneDrive', sub: segs[1], kind: 'personal', cat: 'personal', final: true };
    // .cache, .local, .config sind Sammelordner – darin je Unterordner eine Anwendung
    if (s2 === '.cache' || s2 === '.local' || s2 === '.config') return n === 3 ? { key: `apps:${s2}`, label: segs[2], kind: 'program', cat: 'apps', final: false } : app(segs[3], 'data');
    if (s2.startsWith('.')) return app(segs[2], 'data');
    return { key: `personal:${low[1]}:${s2}`, label: segs[2], sub: segs[1], kind: 'personal', cat: 'personal', final: true };
  }
  return { key: `top:${keyName(D)}:${s0}`, label: `${D}\\${segs[0]}`, kind: 'folder', cat: 'other', final: true };
}

/** Viele stat() gleichzeitig, Ergebnis in Reihenfolge. */
async function statAll(list) {
  const out = new Array(list.length);
  for (let i = 0; i < list.length; i += STAT_BATCH) {
    const chunk = list.slice(i, i + STAT_BATCH);
    const r = await Promise.all(chunk.map((f) => fs.promises.stat(f).catch(() => null)));
    for (let j = 0; j < r.length; j++) out[i + j] = r[j];
  }
  return out;
}

/** Die ersten k nach cmp, ohne alles zu sortieren (Haufen) – für Seiten aus Millionen Dateien. */
function topK(idx, k, cmp) {
  if (idx.length <= k * 4 || idx.length < 20000) return idx.sort(cmp).slice(0, k);
  const h = []; // Max-Haufen nach cmp: h[0] ist das hinterste der behaltenen
  const up = (i) => { while (i) { const p = (i - 1) >> 1; if (cmp(h[i], h[p]) <= 0) break; [h[i], h[p]] = [h[p], h[i]]; i = p; } };
  const down = (i) => { for (;;) { const l = 2 * i + 1; const r = l + 1; let m = i; if (l < h.length && cmp(h[l], h[m]) > 0) m = l; if (r < h.length && cmp(h[r], h[m]) > 0) m = r; if (m === i) break; [h[i], h[m]] = [h[m], h[i]]; i = m; } };
  for (const x of idx) {
    if (h.length < k) { h.push(x); up(h.length - 1); } else if (cmp(x, h[0]) < 0) { h[0] = x; down(0); }
  }
  return h.sort(cmp);
}

/**
 * io = { roots(): [{ id, label, kind, path, docker? }] (Hostwerks Bereiche), drives?(): Promise<[Pfad]> (leer = nur
 *        Hostwerks Bereiche), hostwerkBase?, toTrash(root, rel), resolve(root, rel) → { full }, recycle?(fulls) →
 *        Promise<[{ path, error? }]>, trashAbs?(full, opts), skip?: [nie zählen], platform?, now?(), max? }
 */
function createFiles(io) {
  const win = (io.platform || process.platform) === 'win32';
  const sep = win ? '\\' : '/';
  const P = win ? path.win32 : path.posix;
  const norm = (p) => { const r = P.resolve(p); return win ? r.toLowerCase() : r; };
  const inside = (a, b) => b === a || b.startsWith(a.endsWith(sep) ? a : a + sep);
  const join = (d, n) => (d.endsWith(sep) ? d + n : d + sep + n);
  const now = io.now || Date.now;
  const MAX = io.max || MAX_FILES;
  const HARD = io.hardMax || (io.max ? io.max : HARD_MAX);
  let index = null;
  let scanning = null;
  let progress = { files: 0, dirs: 0, dir: null };
  let dups = { at: null, running: false, groups: [], waste: 0, error: null, checked: 0 };

  /** Hostwerks Bereiche: vorhanden, ohne Docker, ohne doppelte Pfade. */
  const rootsNow = () => {
    const seen = new Set();
    return (io.roots() || []).filter((r) => r && r.path && !r.docker && fs.existsSync(r.path)).filter((r) => {
      const k = norm(r.path);
      if (seen.has(k)) return false;
      seen.add(k); return true;
    });
  };

  function scan() {
    if (scanning) return scanning;
    scanning = (async () => {
      const roots = rootsNow();
      const skip = (io.skip || []).filter(Boolean).map(norm);
      let drives = [];
      try { drives = io.drives ? (await io.drives()) || [] : []; } catch { drives = []; }
      drives = [...new Set(drives.filter((d) => d && fs.existsSync(d)).map((d) => P.resolve(d)))];
      const mode = drives.length ? 'machine' : 'hostwerk';
      // Ziele: die Laufwerke – und Hostwerks Bereiche, die auf keinem davon liegen (ohne Laufwerke: nur die Bereiche)
      const targets = drives.map((d) => ({ path: d, drive: d, machine: true }));
      for (const r of roots) {
        const k = norm(r.path);
        if (!targets.some((t) => inside(norm(t.path), k))) targets.push({ path: P.resolve(r.path), drive: P.parse(P.resolve(r.path)).root, machine: false });
      }

      // Gruppen (wem die Dateien gehören)
      const groups = []; const gByKey = new Map();
      const groupOf = (c) => {
        let i = gByKey.get(c.key);
        if (i === undefined) {
          i = groups.length; gByKey.set(c.key, i);
          groups.push({ id: c.key, label: c.label, i18n: !!c.i18n, sub: c.sub || null, kind: c.kind, cat: c.cat, lock: c.lock || null, root: c.root || null, rootPath: c.rootPath || null, bases: [], final: !!c.final });
        }
        return i;
      };
      const rootGroup = new Map();
      for (const r of roots) rootGroup.set(norm(r.path), { key: `hw:${r.id}`, label: r.label, kind: r.kind || 'other', cat: 'hostwerk', final: true, root: r.id, rootPath: P.resolve(r.path) });
      const hwBase = io.hostwerkBase ? norm(io.hostwerkBase) : null;

      // Spalten
      const dirs = []; const dParent = []; const dGroup = []; const dLock = []; const dFirst = []; const dNext = []; const dOwnB = []; const dOwnN = [];
      const fDir = []; const fName = []; const fSize = []; const fM = []; const fT = [];
      const dirMap = new Map();
      let truncated = false;
      const addDir = (full, parent, [g, lock]) => {
        const i = dirs.length;
        dirs.push(full); dParent.push(parent); dGroup.push(g); dLock.push(lock); dFirst.push(-1); dOwnB.push(0); dOwnN.push(0);
        dNext.push(parent >= 0 ? dFirst[parent] : -1);
        if (parent >= 0) dFirst[parent] = i;
        dirMap.set(norm(full), i);
        const G = groups[g];
        if (G.seen && G.lock !== lock) G.lock = null; // gemischt (z. B. Program Files geschützt, AppData nicht)
        G.seen = true;
        if ((parent < 0 || dGroup[parent] !== g) && G.bases.length < 40) G.bases.push(i);
        return i;
      };
      /** Zuordnung eines Ordners aus der seines Elternordners → [Gruppe, Schutz] (Schutz je Ordner, nicht je Gruppe). */
      const groupFor = (full, parent, segs, drive, machine) => {
        const k = norm(full);
        const rg = rootGroup.get(k);
        if (rg) return [groupOf(rg), null];
        if (hwBase && k === hwBase) return [groupOf({ key: 'hw:base', label: 'Hostwerk – programs & runtimes', i18n: true, kind: 'hostwerk', cat: 'hostwerk', final: true, lock: 'hostwerk' }), 'hostwerk'];
        if (parent >= 0 && groups[dGroup[parent]].final) return [dGroup[parent], dLock[parent]];
        if (!machine) return parent >= 0 ? [dGroup[parent], dLock[parent]] : [groupOf({ key: `top:${keyName(full)}`, label: full, kind: 'folder', cat: 'other', final: true }), null];
        const c = classify(segs, drive, win);
        return [groupOf(c), c.lock || null];
      };

      let of = 0;
      for (const d of drives) { try { const st = fs.statfsSync(d); of += (st.blocks - st.bavail) * st.bsize; } catch { /* älteres Node */ } }
      progress = { files: 0, dirs: 0, dir: null, bytes: 0, of, started: now() };
      let lastYield = Date.now();
      for (const t of targets) {
        if (dirMap.has(norm(t.path))) continue;
        const g0 = groupFor(t.path, -1, [], t.drive, t.machine);
        const stack = [[t.path, addDir(t.path, -1, g0), groups[g0[0]].final ? null : []]];
        while (stack.length) {
          const [dir, di, segs] = stack.pop();
          progress.dir = dir; progress.dirs = dirs.length;
          let ents;
          try { ents = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { continue; }
          const names = [];
          for (const e of ents) {
            if (e.isSymbolicLink()) continue; // auch Verknüpfungen/Junctions („Dokumente und Einstellungen“) – sonst doppelt
            const full = join(dir, e.name);
            if (e.isDirectory()) {
              const k = norm(full);
              if (dirMap.has(k) || skip.some((s) => inside(s, k))) continue;
              if (!win && UNIX_SKIP.some((s) => k === s || k.startsWith(`${s}/`))) continue;
              const csegs = segs ? [...segs, e.name] : null;
              const g = groupFor(full, di, csegs || [], t.drive, t.machine);
              stack.push([full, addDir(full, di, g), groups[g[0]].final ? null : csegs]);
            } else if (e.isFile()) names.push(e.name);
          }
          if (!names.length) continue;
          const sts = await statAll(names.map((nm) => join(dir, nm)));
          for (let j = 0; j < names.length; j++) {
            const st = sts[j];
            if (!st) continue;
            dOwnB[di] += st.size; dOwnN[di]++; progress.bytes += st.size; progress.counted = (progress.counted || 0) + 1;
            // Summen zählen weiter; über MAX nur noch große Dateien einzeln (die interessieren beim Aufräumen)
            if (fDir.length >= MAX && (st.size < BIG_ONLY || fDir.length >= HARD)) { truncated = true; continue; }
            fDir.push(di); fName.push(names[j]); fSize.push(st.size); fM.push(Math.round(st.mtimeMs)); fT.push(TYPE_NUM[typeOf(names[j])]);
          }
          progress.files = fDir.length;
          if (Date.now() - lastYield > 50) { await new Promise((r) => setImmediate(r)); lastYield = Date.now(); }
        }
      }
      // Ordnergrößen samt Unterordnern (Kinder stehen immer hinter ihren Eltern)
      const dB = dOwnB.slice(); const dN = dOwnN.slice();
      for (let i = dirs.length - 1; i > 0; i--) { const p = dParent[i]; if (p >= 0) { dB[p] += dB[i]; dN[p] += dN[i]; } }
      // Laufwerke: belegt laut System gegenüber gezählt (Rest = nicht lesbar, z. B. geschützte Systemordner)
      const driveInfo = [];
      for (const d of drives) {
        let total = null; let free = null;
        try { const s = fs.statfsSync(d); total = s.blocks * s.bsize; free = s.bavail * s.bsize; } catch { /* älteres Node */ }
        const i = dirMap.get(norm(d));
        driveInfo.push({ path: d, label: win ? d.replace(/\\$/, '') : d, total, free, used: total != null ? total - free : null, counted: i !== undefined ? dB[i] : 0, files: i !== undefined ? dN[i] : 0 });
      }
      index = { at: now(), mode, groups, dirs, dParent, dGroup, dLock,dFirst, dNext, dOwnB, dOwnN, dB, dN, dirMap, fDir, fName, fSize, fM, fT, truncated, drives: driveInfo, lower: null };
      if (dups.at) dups = { ...dups, stale: true };
      return index;
    })().finally(() => { scanning = null; progress = { files: 0, dirs: 0, dir: null }; });
    return scanning;
  }

  const fullOf = (i) => join(index.dirs[index.fDir[i]], index.fName[i]);
  const lockOf = (i) => {
    const l = index.dLock[index.fDir[i]];
    if (l) return l;
    if (index.dParent[index.fDir[i]] < 0 && SYSTEM_FILES.test(index.fName[i])) return 'system';
    return null;
  };
  function item(i) {
    const G = index.groups[index.dGroup[index.fDir[i]]];
    const full = fullOf(i);
    const x = { id: full, path: full, dir: index.dirs[index.fDir[i]], name: index.fName[i], size: index.fSize[i], mtime: index.fM[i], type: TYPE_IDS[index.fT[i]], group: G.id };
    if (G.root && G.rootPath) { x.root = G.root; x.rel = P.relative(G.rootPath, full).split(sep).join('/'); }
    const lock = lockOf(i);
    if (lock) x.lock = lock;
    return x;
  }
  /** Spalte einer Datei aus ihrem Pfad (nur was im Index steht, zählt). */
  function findMany(list) {
    const out = new Map(); // Pfad → Spalte
    if (!index) return out;
    const want = new Map(); // Ordner-Nummer → Map(Name → Pfad)
    for (const full of list) {
      if (typeof full !== 'string' || !full) continue;
      const abs = P.resolve(full);
      const di = index.dirMap.get(norm(P.dirname(abs)));
      if (di === undefined) continue;
      if (!want.has(di)) want.set(di, new Map());
      want.get(di).set(win ? P.basename(abs).toLowerCase() : P.basename(abs), full);
    }
    if (!want.size) return out;
    for (let i = 0; i < index.fDir.length; i++) {
      const w = want.get(index.fDir[i]);
      if (!w) continue;
      const p = w.get(win ? index.fName[i].toLowerCase() : index.fName[i]);
      if (p !== undefined) out.set(p, i);
    }
    return out;
  }
  const find = (full) => { const r = findMany([full]).get(full); return r === undefined ? -1 : r; };

  function summary() {
    const base = { scanning: !!scanning, progress: { ...progress }, max: MAX, typeIds: TYPE_IDS };
    if (!index) return { ...base, at: null, mode: null, groups: [], drives: [], totals: { files: 0, bytes: 0, types: {} }, truncated: false };
    const gs = index.groups.map((g) => ({ id: g.id, label: g.label, i18n: g.i18n, sub: g.sub, kind: g.kind, cat: g.cat, lock: g.lock, root: g.root, path: g.rootPath || (g.bases.length ? index.dirs[g.bases.reduce((a, b) => (index.dB[b] > index.dB[a] ? b : a))] : null), places: g.bases.length, files: 0, bytes: 0, types: {}, newest: 0 }));
    for (let d = 0; d < index.dirs.length; d++) { const g = gs[index.dGroup[d]]; g.bytes += index.dOwnB[d]; g.files += index.dOwnN[d]; }
    const totals = { files: 0, bytes: 0, types: {} };
    for (let i = 0; i < index.fDir.length; i++) {
      if (index.fDir[i] < 0) continue;
      const g = gs[index.dGroup[index.fDir[i]]]; const t = TYPE_IDS[index.fT[i]]; const s = index.fSize[i];
      g.types[t] = (g.types[t] || 0) + s; if (index.fM[i] > g.newest) g.newest = index.fM[i];
      totals.types[t] = (totals.types[t] || 0) + s;
    }
    for (const g of gs) { totals.files += g.files; totals.bytes += g.bytes; }
    return { ...base, at: index.at, mode: index.mode, groups: gs.filter((g) => g.files > 0), drives: index.drives, totals, truncated: index.truncated };
  }

  /** Ordner samt Unterordnern als Menge (für den Filter dir=…). */
  function subtree(di) {
    const inSub = new Uint8Array(index.dirs.length);
    inSub[di] = 1;
    for (let i = di + 1; i < index.dirs.length; i++) if (index.dParent[i] >= 0 && inSub[index.dParent[i]]) inSub[i] = 1;
    return inSub;
  }

  /** Treffer für eine Abfrage – Spalten-Nummern. */
  function hitsFor(q = {}) {
    const gIds = new Set(String(q.group || '').split(',').filter(Boolean));
    if (q.root) for (const r of String(q.root).split(',').filter(Boolean)) gIds.add(`hw:${r}`);
    const gSet = gIds.size ? new Set(index.groups.map((g, i) => (gIds.has(g.id) ? i : -1)).filter((i) => i >= 0)) : null;
    if (gSet && !gSet.size) return { hits: [], bytes: 0 };
    let dirSet = null;
    if (q.dir) {
      const di = index.dirMap.get(norm(String(q.dir)));
      if (di === undefined) return { hits: [], bytes: 0 };
      dirSet = subtree(di);
    }
    const types = q.type ? new Set(String(q.type).split(',').filter(Boolean).map((t) => TYPE_NUM[t]).filter((n) => n !== undefined)) : null;
    const words = String(q.q || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
    const minSize = Number(q.minSize) > 0 ? Number(q.minSize) : 0;
    const olderThan = Number(q.olderThan) > 0 ? now() - Number(q.olderThan) * 86400000 : 0;
    const newerThan = Number(q.newerThan) > 0 ? now() - Number(q.newerThan) * 86400000 : 0;
    if (words.length && !index.lower) index.lower = index.dirs.map((d) => d.toLowerCase());
    let bytes = 0;
    const hits = [];
    const { fDir, fSize, fM, fT, fName, dGroup } = index;
    for (let i = 0; i < fDir.length; i++) {
      const d = fDir[i];
      if (d < 0) continue;
      if (gSet && !gSet.has(dGroup[d])) continue;
      if (dirSet && !dirSet[d]) continue;
      if (types && !types.has(fT[i])) continue;
      if (minSize && fSize[i] < minSize) continue;
      if (olderThan && fM[i] > olderThan) continue;
      if (newerThan && fM[i] < newerThan) continue;
      if (words.length) {
        const n = fName[i].toLowerCase(); const dl = index.lower[d];
        let ok = true;
        for (const w of words) if (!n.includes(w) && !dl.includes(w)) { ok = false; break; }
        if (!ok) continue;
      }
      hits.push(i); bytes += fSize[i];
    }
    return { hits, bytes };
  }
  function comparator(q) {
    const dir = q.order === 'asc' ? 1 : -1;
    const { fSize, fM, fName, fT, fDir, dGroup, groups } = index;
    const byGroup = (a, b) => { const ga = dGroup[fDir[a]]; const gb = dGroup[fDir[b]]; return (ga === gb ? 0 : collator.compare(groups[ga].label, groups[gb].label) * -dir) || fSize[b] - fSize[a]; };
    return {
      size: (a, b) => (fSize[a] - fSize[b]) * dir,
      mtime: (a, b) => (fM[a] - fM[b]) * dir,
      name: (a, b) => collator.compare(fName[a], fName[b]) * -dir,
      group: byGroup,
      root: byGroup,
      type: (a, b) => ((fT[a] - fT[b]) * -dir) || fSize[b] - fSize[a],
    }[q.sort] || ((a, b) => fSize[b] - fSize[a]);
  }

  /** Gefilterte, sortierte Seite der Liste. */
  function list(q = {}) {
    if (!index) return { at: null, total: 0, bytes: 0, items: [] };
    const { hits, bytes } = hitsFor(q);
    const offset = Math.max(0, Number(q.offset) || 0);
    const limit = Math.min(500, Math.max(1, Number(q.limit) || 100));
    const page = topK(hits, offset + limit, comparator(q)).slice(offset, offset + limit);
    return { at: index.at, total: hits.length, bytes, items: page.map(item) };
  }

  /** Liste als CSV (Trennzeichen ;, mit BOM – für Excel). */
  function csv(q = {}) {
    if (!index) return '';
    const { hits } = hitsFor(q);
    const rows = topK(hits, Math.min(100000, hits.length), comparator(q));
    const esc = (s) => (/[";\n\r]/.test(String(s)) ? `"${String(s).replace(/"/g, '""')}"` : String(s));
    const lines = ['path;name;size;modified;kind;belongs_to'];
    for (const i of rows) lines.push([fullOf(i), index.fName[i], index.fSize[i], new Date(index.fM[i]).toISOString(), TYPE_IDS[index.fT[i]], index.groups[index.dGroup[index.fDir[i]]].label].map(esc).join(';'));
    return `﻿${lines.join('\r\n')}\r\n`;
  }

  /** Ordnerbaum: ein Ordner mit seinen Unterordnern (größte zuerst). Ohne dir: Laufwerke bzw. die Orte einer Gruppe. */
  function tree({ dir, group } = {}) {
    if (!index) return { at: null, kids: [] };
    const node = (i) => ({ path: index.dirs[i], name: P.basename(index.dirs[i]) || index.dirs[i], bytes: index.dB[i], files: index.dN[i], group: index.groups[index.dGroup[i]].id, kids: index.dFirst[i] >= 0 });
    if (!dir) {
      let tops;
      if (group) {
        const g = index.groups.find((x) => x.id === group);
        tops = g ? g.bases : [];
      } else tops = index.dirs.map((d, i) => i).filter((i) => index.dParent[i] < 0);
      const kids = tops.map(node).sort((a, b) => b.bytes - a.bytes);
      return { at: index.at, path: null, crumbs: [], bytes: kids.reduce((a, k) => a + k.bytes, 0), files: kids.reduce((a, k) => a + k.files, 0), own: null, kids, more: 0 };
    }
    const di = index.dirMap.get(norm(String(dir)));
    if (di === undefined) throw fail('Folder not in the list', 404);
    const kids = [];
    for (let c = index.dFirst[di]; c >= 0; c = index.dNext[c]) kids.push(node(c));
    kids.sort((a, b) => b.bytes - a.bytes);
    const crumbs = [];
    for (let p = di; p >= 0; p = index.dParent[p]) crumbs.unshift({ path: index.dirs[p], name: P.basename(index.dirs[p]) || index.dirs[p] });
    return { at: index.at, ...node(di), crumbs, own: { bytes: index.dOwnB[di], files: index.dOwnN[di] }, kids: kids.slice(0, 300), more: Math.max(0, kids.length - 300) };
  }

  /** Eintrag aus dem Index nehmen (nach dem Löschen) – Summen der Ordner und Laufwerke mit. */
  function drop(i) {
    const d = index.fDir[i]; const s = index.fSize[i];
    index.fDir[i] = -1;
    index.dOwnB[d] -= s; index.dOwnN[d]--;
    for (let p = d; p >= 0; p = index.dParent[p]) { index.dB[p] -= s; index.dN[p]--; }
    const k = norm(index.dirs[d]);
    for (const dv of index.drives) if (inside(norm(dv.path), k)) { dv.counted -= s; dv.files--; }
  }
  function forgetDups(paths) {
    if (!dups.groups.length) return;
    const gone = new Set(paths.map(norm));
    dups.groups = dups.groups.map((g) => ({ ...g, files: g.files.filter((f) => !gone.has(norm(f.path))) })).filter((g) => g.files.length > 1);
    dups.waste = dups.groups.reduce((a, g) => a + g.size * (g.files.length - 1), 0);
  }

  const LOCK_TEXT = {
    system: 'Part of Windows – it cannot be deleted here.',
    program: 'Part of an installed program – uninstall the program instead.',
    hostwerk: 'Part of Hostwerk itself – manage it in Hostwerk.',
  };

  /** Löschen: Hostwerks Bereiche → Hostwerks Papierkorb, sonst Windows-Papierkorb. Fehler je Datei. */
  async function remove(items) {
    const todo = (Array.isArray(items) ? items : []).map((x) => (x && typeof x.path === 'string' ? x.path : null)).filter(Boolean).slice(0, 5000);
    const done = []; const failed = []; const machine = [];
    const found = findMany(todo);
    for (const p of todo) {
      const i = found.has(p) ? found.get(p) : -1;
      if (i < 0) { failed.push({ path: p, error: 'Not in the list of files' }); continue; }
      const lock = lockOf(i);
      if (lock) { failed.push({ path: p, error: LOCK_TEXT[lock] }); continue; }
      const it = item(i);
      if (it.root) {
        try { io.toTrash(it.root, it.rel); done.push({ path: it.path, where: 'hostwerk', i }); } catch (e) { failed.push({ path: it.path, error: e.message }); }
      } else machine.push({ path: it.path, i });
    }
    if (machine.length) {
      let res = null;
      if (io.recycle) { try { res = await io.recycle(machine.map((m) => m.path)); } catch (e) { res = machine.map((m) => ({ path: m.path, error: e.message })); } }
      for (const m of machine) {
        if (res) {
          const r = res.find((x) => x && x.path === m.path);
          if (r && !r.error && !fs.existsSync(m.path)) done.push({ path: m.path, where: 'recycle', i: m.i });
          else failed.push({ path: m.path, error: (r && r.error) || 'Could not be moved to the recycle bin' });
        } else if (io.trashAbs) {
          try { io.trashAbs(m.path, { label: index.groups[index.dGroup[index.fDir[m.i]]].label }); done.push({ path: m.path, where: 'hostwerk', i: m.i }); } catch (e) { failed.push({ path: m.path, error: e.message }); }
        } else failed.push({ path: m.path, error: 'Deleting is not available' });
      }
    }
    for (const d of done) drop(d.i);
    forgetDups(done.map((d) => d.path));
    return { ok: !failed.length, done: done.length, recycled: done.filter((d) => d.where === 'recycle').length, failed };
  }

  function rename({ path: p, name } = {}) {
    const n = String(name || '').trim();
    const i = find(p);
    if (i < 0) throw fail('Not in the list of files', 404);
    if (!n || /[\\/:*?"<>|]/.test(n) || n === '.' || n === '..') throw fail('Invalid name', 400);
    const lock = lockOf(i);
    if (lock) throw fail(LOCK_TEXT[lock], 403);
    const a = fullOf(i);
    const b = join(index.dirs[index.fDir[i]], n);
    if (a === b) return { ok: true, path: b };
    if (fs.existsSync(b) && a.toLowerCase() !== b.toLowerCase()) throw fail('A file with this name already exists', 409);
    fs.renameSync(a, b);
    index.fName[i] = n; index.fT[i] = TYPE_NUM[typeOf(n)];
    forgetDups([a]);
    return { ok: true, path: b };
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
  async function groupBySum(l, size) {
    const bucket = async (list0, quick) => {
      const by = new Map();
      for (const i of list0) {
        try { const h = await hashFile(fullOf(i), size, quick); const x = by.get(h); if (x) x.push(i); else by.set(h, [i]); } catch { /* weg oder gesperrt */ }
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
  function findDuplicates({ minSize = DUP_MIN, group = null } = {}) {
    if (dups.running) return Promise.resolve(dups);
    dups = { ...dups, running: true, error: null, checked: 0, stale: false };
    (async () => {
      try {
        if (!index) await scan();
        const gi = group ? index.groups.findIndex((g) => g.id === group) : -1;
        const bySize = new Map();
        for (let i = 0; i < index.fDir.length; i++) {
          const d = index.fDir[i];
          if (d < 0 || index.fSize[i] < minSize) continue;
          if (gi >= 0 && index.dGroup[d] !== gi) continue;
          if (index.dLock[d] === 'system') continue; // Windows hält Dateien gewollt mehrfach
          const l = bySize.get(index.fSize[i]); if (l) l.push(i); else bySize.set(index.fSize[i], [i]);
        }
        const cands = [...bySize.entries()].filter(([, l]) => l.length > 1).sort((a, b) => b[0] * (b[1].length - 1) - a[0] * (a[1].length - 1));
        const groups = [];
        for (const [size, l] of cands) {
          if (groups.length >= DUP_MAX_GROUPS) break;
          for (const g of await groupBySum(l, size)) groups.push({ size, files: g.map(item) });
        }
        groups.sort((a, b) => b.size * (b.files.length - 1) - a.size * (a.files.length - 1));
        dups = { at: now(), running: false, groups, waste: groups.reduce((a, g) => a + g.size * (g.files.length - 1), 0), error: null, checked: dups.checked, minSize, group };
      } catch (e) { dups = { ...dups, running: false, error: e.message }; }
    })();
    return Promise.resolve(dups);
  }

  /** Datei bzw. Ordner im Index? Dann der volle Pfad (für Herunterladen und „Im Explorer zeigen“). */
  function known(p) { const i = find(p); if (i < 0) throw fail('Not in the list of files', 404); return fullOf(i); }
  function knownDir(p) { if (!index) throw fail('No list of files yet', 404); const di = index.dirMap.get(norm(String(p || ''))); if (di === undefined) throw fail('Folder not in the list', 404); return index.dirs[di]; }

  return {
    scan, summary, list, csv, tree, remove, rename, findDuplicates, known, knownDir,
    duplicates: () => dups,
    ready: () => !!index,
    isStale: () => !index || now() - index.at > RESCAN_MS,
  };
}

/* ---------------- In Hostwerk ---------------- */

/** Lokale, feste Laufwerke (Windows: DriveType 3 – keine Netz-, USB- oder CD-Laufwerke; sonst „/“). */
function listDrives(platform = process.platform) {
  if (platform !== 'win32') return Promise.resolve(['/']);
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object { $_.DeviceID }"], { windowsHide: true, timeout: 20000 }, (err, out) => {
      const list = String(out || '').split(/\r?\n/).map((s) => s.trim()).filter((s) => /^[A-Z]:$/i.test(s)).map((s) => `${s.toUpperCase()}\\`);
      if (list.length) return resolve(list);
      const found = []; // Rückfall: Laufwerksbuchstaben, die es gibt
      for (let c = 67; c <= 90; c++) { const d = `${String.fromCharCode(c)}:\\`; try { fs.statfsSync(d); found.push(d); } catch { /* nicht da */ } }
      return resolve(found);
    });
  });
}

/** Windows-Papierkorb: mehrere Dateien in EINEM PowerShell-Aufruf, Pfade über eine Umgebungsvariable (nie im Befehl). */
function recycleWin(paths) {
  const script = [
    "$ErrorActionPreference='Stop'",
    'Add-Type -AssemblyName Microsoft.VisualBasic',
    '$list = $env:HW_DH_PATHS | ConvertFrom-Json',
    '$out = @()',
    "foreach ($p in $list) { try { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin'); $out += @{ path = $p } } catch { $out += @{ path = $p; error = $_.Exception.Message } } }",
    'ConvertTo-Json -InputObject @($out) -Compress',
  ].join('; ');
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 120000, maxBuffer: 16 * 1048576, env: { ...process.env, HW_DH_PATHS: JSON.stringify(paths) } }, (err, out) => {
      try { const r = JSON.parse(String(out || '').trim() || '[]'); return resolve(Array.isArray(r) ? r : [r]); } catch { return reject(err || new Error('No answer from Windows')); }
    });
  });
}

function revealNative(full, isDir, platform = process.platform) {
  if (platform === 'win32') execFile('explorer.exe', isDir ? [full] : [`/select,${full}`], () => {});
  else if (platform === 'darwin') execFile('open', isDir ? [full] : ['-R', full], () => {});
  else execFile('xdg-open', [isDir ? full : path.dirname(full)], () => {});
}

/** In Hostwerk: Bereiche und Papierkorb aus Hostwerks Datei-Dienst (ctx.files), Routen unter /disk-health/files. */
function mount(host) {
  const { ctx } = host;
  const fsvc = ctx && ctx.files;
  if (!fsvc || typeof fsvc.roots !== 'function' || typeof fsvc.toTrash !== 'function') return null;
  // Einstellung „Ganze Laufwerke“ (Standard an) – aus: nur Hostwerks Bereiche wie in 2.2
  const machine = () => { try { return (ctx.extMarket.settingsFor(host.id) || {}).filesMachine !== false; } catch { return true; } };
  const files = createFiles({
    roots: () => fsvc.roots(),
    drives: () => (machine() ? listDrives() : Promise.resolve([])),
    hostwerkBase: ctx.paths && ctx.paths.base,
    toTrash: (root, rel) => fsvc.toTrash(root, rel),
    resolve: (root, rel) => fsvc.resolve(root, rel),
    recycle: process.platform === 'win32' ? recycleWin : null,
    trashAbs: typeof fsvc.trashAbs === 'function' ? (full, o) => fsvc.trashAbs(full, o) : null,
    skip: [fsvc.trashDir],
  });
  const r = host.router;
  const kick = () => { if (files.isStale()) files.scan().catch((e) => { if (host.log) host.log('files scan:', e.message); }); };
  const safe = (fn) => async (req, res) => {
    try { await fn(req, res); } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  };
  r.get('/disk-health/files', (req, res) => { kick(); res.json(files.summary()); });
  r.get('/disk-health/files/list', safe((req, res) => res.json(files.list(req.query || {}))));
  r.get('/disk-health/files/tree', safe((req, res) => res.json(files.tree(req.query || {}))));
  r.get('/disk-health/files/export', safe((req, res) => {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="files-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(files.csv(req.query || {}));
  }));
  r.post('/disk-health/files/rescan', (req, res) => { files.scan().catch(() => {}); res.json(files.summary()); });
  r.post('/disk-health/files/delete', safe(async (req, res) => res.json(await files.remove((req.body || {}).items))));
  r.post('/disk-health/files/rename', safe((req, res) => res.json(files.rename(req.body || {}))));
  r.post('/disk-health/files/reveal', safe((req, res) => {
    const b = req.body || {};
    revealNative(b.dir ? files.knownDir(b.path) : files.known(b.path), !!b.dir);
    res.json({ ok: true });
  }));
  r.get('/disk-health/files/download', safe((req, res) => res.download(files.known(String((req.query || {}).path || '')))));
  r.get('/disk-health/files/duplicates', (req, res) => res.json(files.duplicates()));
  r.post('/disk-health/files/duplicates', safe(async (req, res) => { const b = req.body || {}; res.json(await files.findDuplicates({ minSize: Number(b.minSize) || DUP_MIN, group: b.group || null })); }));
  // Erstes Einlesen, wenn Hostwerk gestartet ist; danach alle sechs Stunden (oder beim Öffnen, wenn älter)
  const first = setTimeout(kick, 120000);
  const timer = setInterval(kick, RESCAN_MS);
  for (const x of [first, timer]) if (x && x.unref) x.unref();
  host.on('shutdown', () => { clearTimeout(first); clearInterval(timer); });
  return files;
}

module.exports = { createFiles, mount, typeOf, classify, pkgName, topK, TYPE_IDS, MAX_FILES };
