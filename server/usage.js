'use strict';
/*
 * Laufwerke, Teil „Belegung“ (bis 1.5 eigene Erweiterung „Speicher je Dienst“, aufgegangen mit SDK 3.8 "replaces"):
 * schreibt einmal pro Stunde den Füllstand des Laufwerks mit – jetzt im Server-Teil, also auch, wenn niemand die Seite
 * offen hat (vorher nur, solange die Seite lief). Die Größen je Dienst zählt Hostwerk selbst (/system/disk-usage).
 *   GET /api/disk-health/usage-history → { history: [{ t, used, total }], at }
 * Daten: data/disk-health/usage.json = { history, migrated } – höchstens 600 Punkte / 90 Tage (lib/usage.js record).
 * Beim ersten Start holt sie den Verlauf aus dem Speicher der alten Erweiterung (replaced:disk-usage) – einmal.
 */
const fs = require('fs');
const path = require('path');
const D = require('../lib/usage.js');

const HOUR = 3600000;

/** Verlauf zusammenführen: nach Zeit sortiert, doppelte Zeitpunkte nur einmal, wie record() begrenzt. */
function mergeHistory(a, b, now = Date.now()) {
  const seen = new Set();
  const all = [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]
    .filter((p) => p && Number.isFinite(p.t) && p.t > now - 90 * D.DAY && p.t <= now && p.used >= 0 && p.total > 0)
    .sort((x, y) => x.t - y.t)
    .filter((p) => { if (seen.has(p.t)) return false; seen.add(p.t); return true; });
  return all.slice(-600);
}

/**
 * io = { dir, get(): Promise<{ disk }>, oldStorage(): object|null, now?() } – in Hostwerk aus ctx, in den Tests nachgebaut.
 */
function createUsage(io) {
  const now = io.now || Date.now;
  const file = path.join(io.dir, 'usage.json');
  const read = () => { try { return { history: [], migrated: null, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { return { history: [], migrated: null }; } };
  const write = (v) => { fs.mkdirSync(io.dir, { recursive: true }); fs.writeFileSync(`${file}.tmp`, JSON.stringify(v)); fs.renameSync(`${file}.tmp`, file); };

  /** Verlauf der abgelösten Erweiterung einmal übernehmen. */
  function takeOver() {
    const st = read();
    if (st.migrated) return false;
    let old = null;
    try { old = io.oldStorage(); } catch { old = null; }
    const hist = old && old.storage && Array.isArray(old.storage.history) ? old.storage.history : [];
    st.history = mergeHistory(st.history, hist, now());
    st.migrated = now();
    write(st);
    return hist.length > 0;
  }

  /** Einen Punkt aufnehmen (höchstens einer pro Stunde – record() entscheidet). */
  async function sample() {
    const d = await io.get();
    const dk = D.disk(d && d.disk);
    if (!dk) return null;
    const st = read();
    const next = D.record(st.history, dk, now());
    if (next.length !== st.history.length || (next[next.length - 1] || {}).t !== (st.history[st.history.length - 1] || {}).t) { st.history = next; write(st); }
    return dk;
  }

  const view = () => { const st = read(); return { history: st.history, at: (st.history[st.history.length - 1] || {}).t || null }; };
  return { takeOver, sample, view, read };
}

/** In Hostwerk: Daten über Hostwerks eigene Schnittstelle (im Prozess), Zeitgeber stündlich. */
function mount(host) {
  const { ctx } = host;
  const usage = createUsage({
    dir: path.join(ctx.paths.data, 'disk-health'),
    get: async () => {
      if (ctx.audit && typeof ctx.audit.selfCall === 'function') return ctx.audit.selfCall('GET', '/system/disk-usage');
      if (ctx.system && typeof ctx.system.diskUsage === 'function') return ctx.system.diskUsage();
      throw new Error('Hostwerk is still starting');
    },
    oldStorage: () => (ctx.extMarket && typeof ctx.extMarket.storageAll === 'function' ? ctx.extMarket.storageAll(host.id)['replaced:disk-usage'] || null : null),
  });
  try { usage.takeOver(); } catch (e) { if (host.log) host.log('usage take over:', e.message); }
  host.router.get('/disk-health/usage-history', (req, res) => res.json(usage.view()));
  const tick = () => { usage.sample().catch(() => {}); };
  const first = setTimeout(tick, 60000); // Hostwerk zählt beim Start selbst nach – erst danach
  const timer = setInterval(tick, HOUR);
  for (const x of [first, timer]) if (x && x.unref) x.unref();
  host.on('shutdown', () => { clearTimeout(first); clearInterval(timer); });
  return usage;
}

module.exports = { createUsage, mergeHistory, mount };
