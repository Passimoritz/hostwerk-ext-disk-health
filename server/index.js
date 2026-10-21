'use strict';
/*
 * Drive health – server part (native extension, runs as part of Hostwerk).
 *   GET  /api/disk-health          → { at, source, notes, drives: [{ …values, level, problems, history }], limits, running }
 *   POST /api/disk-health/refresh  → read all drives now, same answer
 * Reads the drives every few minutes (setting), keeps a small history per drive and alerts through Hostwerk's
 * notifications (push, Discord, ntfy, mail – Live → Alerts) when errors grow, a drive runs hot or wears out.
 * Also shows up as a watcher under Live → Watchers. Only reading commands – nothing on a drive is ever changed.
 * Data: data/disk-health/state.json
 */
const fs = require('fs');
const path = require('path');
const H = require('./health');
const { probe } = require('./probe');
const { describe } = require('./texts');

const KEEP_SAMPLES = 720; // about a month at one sample per hour

/** The service itself – io = { exec, readdir, readFile, platform? } (injected by the tests). */
function createService(host, io) {
  const { ctx } = host;
  const dir = path.join(ctx.paths.data, 'disk-health');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'state.json');
  const read = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { drives: {}, last: null }; } };
  const write = (v) => { fs.writeFileSync(`${file}.tmp`, JSON.stringify(v)); fs.renameSync(`${file}.tmp`, file); };
  const settings = () => {
    let s = {};
    try { s = ctx.extMarket.settingsFor(host.id) || {}; } catch { /* defaults */ }
    const tempWarn = Number.isFinite(s.tempWarn) ? s.tempWarn : 60;
    const wearWarn = Number.isFinite(s.wearWarn) ? s.wearWarn : 80;
    return {
      notify: s.notify !== false,
      interval: Math.max(10, Number.isFinite(s.interval) ? s.interval : 30),
      limits: { tempWarn, tempCrit: tempWarn + 10, wearWarn, wearCrit: wearWarn >= 95 ? 99 : 95 },
    };
  };

  /** Notification for the problems that are new (or worse) on one drive. */
  const alert = (d, fresh) => {
    const err = fresh.some((p) => p.level === 'err');
    const title = err ? host.t('Drive “{name}” is in danger', { name: d.name }) : host.t('Drive “{name}” needs attention', { name: d.name });
    const text = fresh.map((p) => describe(p, host.t)).join('\n');
    try { if (ctx.monitor) ctx.monitor.send(title, text, { kind: err ? 'error' : 'warn', event: 'disk', force: true }).catch(() => {}); } catch { /* notifications are optional */ }
    host.broadcast({ type: 'toast', kind: err ? 'error' : 'info', text: `${title}: ${text.split('\n')[0]}` });
  };

  let running = null;
  const run = () => {
    if (running) return running;
    running = (async () => {
      const cfg = settings();
      const st = read();
      const r = await probe(io).catch((e) => ({ source: null, drives: [], notes: [], error: e.message }));
      const now = Date.now();
      const drives = [];
      for (const d of r.drives) {
        const rec = st.drives[d.id] || { samples: [], alerted: {} };
        const prev = rec.samples[rec.samples.length - 1] || null;
        const a = H.assess(d, prev, cfg.limits);
        const s = H.sample(d, now);
        if (H.worthKeeping(prev, s)) rec.samples = [...rec.samples, s].slice(-KEEP_SAMPLES);
        // Alerts: only new or worse problems; solved ones are forgotten so they alert again if they come back
        const fresh = a.problems.filter((p) => H.shouldAlert(p, rec.alerted[p.code], now));
        rec.alerted = Object.fromEntries(a.problems.map((p) => [p.code, fresh.includes(p) ? { t: now, level: p.level, value: p.value } : rec.alerted[p.code]]));
        if (fresh.length && cfg.notify) alert(d, fresh);
        rec.name = d.name;
        rec.seen = now;
        st.drives[d.id] = rec;
        drives.push({ ...d, level: a.level, problems: a.problems });
      }
      // Drives that have been gone for 90 days are forgotten
      for (const [id, rec] of Object.entries(st.drives)) if (now - (rec.seen || 0) > 90 * 86400000) delete st.drives[id];
      st.last = { at: now, source: r.source, notes: r.notes || [], error: r.error || null, drives };
      write(st);
      const bad = drives.filter((d) => d.level === 'err' || d.level === 'warn');
      try {
        host.watcher({
          id: 'drives', label: host.t('Drive health'), state: bad.length ? 'alert' : drives.length ? 'ok' : 'off', href: '/ext/disk-health',
          detail: bad.length ? bad.map((d) => d.name).join(', ') : host.t('Drives without problems: {n}', { n: drives.length }),
        });
      } catch { /* watchers are optional */ }
      return st.last;
    })().finally(() => { running = null; });
    return running;
  };

  const view = () => {
    const st = read();
    const last = st.last || { at: null, source: null, notes: [], error: null, drives: [] };
    return {
      ...last,
      running: !!running,
      limits: settings().limits,
      drives: last.drives.map((d) => ({ ...d, history: ((st.drives[d.id] || {}).samples || []).slice(-72).map((s) => ({ t: s.t, tempC: s.tempC, wearPct: s.wearPct })) })),
    };
  };

  return { run, view, settings };
}

function activate(host) {
  const { exec } = host.core('util');
  const svc = createService(host, {
    exec: (cmd, args, opts) => exec(cmd, args, opts),
    readdir: (p) => fs.promises.readdir(p),
    readFile: (p) => fs.promises.readFile(p, 'utf8'),
  });
  host.router.get('/disk-health', (req, res) => res.json(svc.view()));
  host.router.post('/disk-health/refresh', async (req, res) => { await svc.run(); res.json(svc.view()); });

  // First reading shortly after the start (Hostwerk is busy starting services), then in the chosen rhythm
  let timer = null;
  const schedule = (ms) => { clearTimeout(timer); timer = setTimeout(() => { svc.run().catch(() => {}).finally(() => schedule(svc.settings().interval * 60000)); }, ms); if (timer.unref) timer.unref(); };
  schedule(20000);
  host.on('shutdown', () => clearTimeout(timer));
}

function deactivate() {}

module.exports = { activate, deactivate, createService };
