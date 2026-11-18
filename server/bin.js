'use strict';
/*
 * Laufwerke, Teil „Papierkorb“ (2.4, Abschnitt unter System → Speicher): der Windows-Papierkorb aller festen Laufwerke.
 *   GET  /api/disk-health/bin                 → { at, supported, items: [{ id, name, from, path, size, files, dir, deleted, drive }], bytes, count }
 *   POST /api/disk-health/bin/restore {ids}   → an den alten Ort zurück (gibt es dort schon eine Datei: Fehler je Eintrag)
 *   POST /api/disk-health/bin/delete  {ids}   → endgültig löschen
 *   POST /api/disk-health/bin/empty           → Papierkorb leeren (alle Einträge des Benutzers)
 * Windows legt je gelöschter Datei zwei Einträge in X:\$Recycle.Bin\<SID>\ an: $R…  (die Datei/der Ordner selbst) und
 * $I… (Metadaten: Größe, Löschzeit, ursprünglicher Pfad). Hostwerk liest die $I-Dateien direkt – schnell, unabhängig
 * von der Sprache und ohne Shell-Aufrufe – und arbeitet nur mit Einträgen, die es selbst gelistet hat (id = $I-Name + Laufwerk).
 */
const fs = require('fs');
const path = require('path');

const FILETIME_EPOCH = 11644473600000n; // ms zwischen 1601-01-01 und 1970-01-01
const MAX_ITEMS = 20000;
const fail = (msg, status) => Object.assign(new Error(msg), { status });

/**
 * Eine $I-Datei lesen → { size, deleted, from } oder null. Format 1 (Vista–8): Pfad fest 520 Bytes ab 24;
 * Format 2 (Windows 10+): Länge (Zeichen) ab 24, Pfad ab 28 – beides UTF-16LE.
 */
function parseInfo(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 26) return null;
  const ver = Number(buf.readBigUInt64LE(0));
  const size = Number(buf.readBigUInt64LE(8));
  const ft = buf.readBigUInt64LE(16);
  const deleted = ft ? Number(ft / 10000n - FILETIME_EPOCH) : null;
  let from;
  if (ver === 2) {
    const len = buf.readUInt32LE(24);
    from = buf.toString('utf16le', 28, Math.min(buf.length, 28 + len * 2));
  } else if (ver === 1) {
    from = buf.toString('utf16le', 24, Math.min(buf.length, 24 + 520));
  } else return null;
  from = from.replace(/\0[\s\S]*$/, '');
  if (!from) return null;
  return { size, deleted, from };
}

/** Eine $I-Datei schreiben (für die Tests – so wie Windows sie anlegt). */
function makeInfo({ size, deleted, from }) {
  const p = Buffer.from(`${from}\0`, 'utf16le');
  const b = Buffer.alloc(28 + p.length);
  b.writeBigUInt64LE(2n, 0);
  b.writeBigUInt64LE(BigInt(size), 8);
  b.writeBigUInt64LE((BigInt(deleted) + FILETIME_EPOCH) * 10000n, 16);
  b.writeUInt32LE(p.length / 2, 24);
  p.copy(b, 28);
  return b;
}

/**
 * io = { bins(): Promise<[Ordner X:\$Recycle.Bin\<SID>]>, dirSize?(p) → { bytes, files } | null (aus dem Datei-Index),
 *        now?() } – in Hostwerk die Ordner des angemeldeten Benutzers auf allen festen Laufwerken.
 */
function createBin(io) {
  const now = io.now || Date.now;
  let last = null; // zuletzt gelistet: id → Eintrag (nur damit wird gearbeitet)

  async function list() {
    const items = [];
    for (const dir of (await io.bins()) || []) {
      let names;
      try { names = await fs.promises.readdir(dir); } catch { continue; }
      for (const n of names) {
        if (!/^\$I/i.test(n) || items.length >= MAX_ITEMS) continue;
        const r = `$R${n.slice(2)}`;
        const rFull = path.join(dir, r);
        let info = null; let st = null;
        try { info = parseInfo(await fs.promises.readFile(path.join(dir, n))); } catch { info = null; }
        try { st = await fs.promises.stat(rFull); } catch { st = null; }
        if (!info || !st) continue; // halb gelöscht oder fremd
        const isDir = st.isDirectory();
        let size = isDir ? info.size : st.size; let files = isDir ? null : 1;
        if (isDir && io.dirSize) { const s = io.dirSize(rFull); if (s) { size = s.bytes; files = s.files; } }
        items.push({
          id: `${path.parse(dir).root.slice(0, 1).toUpperCase()}:${n}`,
          name: path.win32.basename(info.from), from: path.win32.dirname(info.from), original: info.from,
          path: rFull, info: path.join(dir, n), dir: isDir, size, files, deleted: info.deleted, drive: path.parse(dir).root,
        });
      }
    }
    items.sort((a, b) => (b.deleted || 0) - (a.deleted || 0));
    last = new Map(items.map((x) => [x.id, x]));
    return { at: now(), supported: true, items: items.map(({ info, ...x }) => x), count: items.length, bytes: items.reduce((a, x) => a + (x.size || 0), 0), truncated: items.length >= MAX_ITEMS };
  }

  const pick = (ids) => {
    if (!last) throw fail('List the recycle bin first', 409);
    return (Array.isArray(ids) ? ids : []).slice(0, MAX_ITEMS).map((id) => ({ id, x: last.get(String(id)) }));
  };
  const rm = (p) => fs.rmSync(p, { recursive: true, force: true, maxRetries: 2 });

  /** Zurück an den alten Ort – den Ordner legt Hostwerk bei Bedarf an; liegt dort schon etwas: Fehler. */
  function restore(ids) {
    const done = []; const failed = [];
    for (const { id, x } of pick(ids)) {
      if (!x) { failed.push({ id, error: 'Not in the recycle bin anymore' }); continue; }
      try {
        if (fs.existsSync(x.original)) throw fail('A file with this name already exists', 409);
        fs.mkdirSync(path.dirname(x.original), { recursive: true });
        fs.renameSync(x.path, x.original);
        try { fs.rmSync(x.info, { force: true }); } catch { /* Windows räumt es auf */ }
        last.delete(id);
        done.push({ id, path: x.original });
      } catch (e) { failed.push({ id, error: e.message }); }
    }
    return { ok: !failed.length, done: done.length, restored: done, failed };
  }

  /** Endgültig löschen. */
  function remove(ids) {
    const done = []; const failed = []; let bytes = 0;
    for (const { id, x } of pick(ids)) {
      if (!x) { failed.push({ id, error: 'Not in the recycle bin anymore' }); continue; }
      try { rm(x.path); rm(x.info); last.delete(id); done.push(id); bytes += x.size || 0; } catch (e) { failed.push({ id, error: e.message }); }
    }
    return { ok: !failed.length, done: done.length, bytes, failed };
  }

  async function empty() {
    const l = await list();
    return remove(l.items.map((x) => x.id));
  }

  return { list, restore, remove, empty };
}

/** Papierkorb-Ordner des angemeldeten Benutzers: je Laufwerk der Unterordner von $Recycle.Bin, den er lesen darf (seine SID). */
function userBins(drives, sid) {
  return Promise.all(drives.map(async (d) => {
    const base = path.join(d, '$Recycle.Bin');
    if (sid) { const p = path.join(base, sid); try { await fs.promises.access(p); return p; } catch { return null; } }
    let subs;
    try { subs = await fs.promises.readdir(base); } catch { return null; }
    for (const s of subs) {
      if (!/^S-1-5-21-/.test(s)) continue;
      try { await fs.promises.readdir(path.join(base, s)); return path.join(base, s); } catch { /* fremder Benutzer */ }
    }
    return null;
  })).then((l) => l.filter(Boolean));
}

function currentSid() {
  return new Promise((resolve) => {
    require('child_process').execFile('whoami', ['/user', '/fo', 'csv', '/nh'], { windowsHide: true, timeout: 10000 }, (err, out) => {
      const m = /"(S-1-5-[\d-]+)"/.exec(String(out || ''));
      resolve(m ? m[1] : null);
    });
  });
}

/** In Hostwerk: Routen unter /disk-health/bin (nur Windows). files = Datei-Teil (Ordnergrößen, Laufwerke). */
function mount(host, files) {
  if (process.platform !== 'win32') {
    host.router.get('/disk-health/bin', (req, res) => res.json({ supported: false, items: [], count: 0, bytes: 0 }));
    return null;
  }
  let sid; // einmal ermitteln
  const drives = async () => {
    const s = files && files.summary ? files.summary() : null;
    const list = s && s.drives && s.drives.length ? s.drives.map((d) => d.path) : [];
    if (list.length) return list;
    const found = [];
    for (let c = 67; c <= 90; c++) { const d = `${String.fromCharCode(c)}:\\`; try { fs.statfsSync(d); found.push(d); } catch { /* nicht da */ } }
    return found;
  };
  const bin = createBin({
    bins: async () => { if (sid === undefined) sid = await currentSid(); return userBins(await drives(), sid); },
    dirSize: files && files.dirSize ? (p) => files.dirSize(p) : null,
  });
  const safe = (fn) => async (req, res) => { try { res.json(await fn(req)); } catch (e) { res.status(e.status || 500).json({ error: e.message }); } };
  host.router.get('/disk-health/bin', safe(() => bin.list()));
  host.router.post('/disk-health/bin/restore', safe((req) => bin.restore((req.body || {}).ids)));
  host.router.post('/disk-health/bin/delete', safe((req) => bin.remove((req.body || {}).ids)));
  host.router.post('/disk-health/bin/empty', safe(() => bin.empty()));
  return bin;
}

module.exports = { createBin, parseInfo, makeInfo, userBins, mount };
