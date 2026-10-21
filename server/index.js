'use strict';
/*
 * Drive health – server part (native extension, runs as part of Hostwerk).
 *   GET  /api/disk-health                 → { at, drives: [{ …values, level, problems, history, life }], limits, admin, schedule, smartctl, traces … }
 *   POST /api/disk-health/refresh         → read all drives now (without admin rights), same answer
 *   POST /api/disk-health/admin-check     → ONE administrator prompt, reads all S.M.A.R.T. values, keeps them → { ok, reason?, view }
 *   POST /api/disk-health/schedule {on}   → Windows: set up / remove the task that reads hourly with admin rights → { ok, reason?, view }
 *   POST /api/disk-health/smartctl/install → Windows: smartmontools through winget (separate download, GPL) → { ok, view }
 * Reads the drives every few minutes (setting) without admin rights, joins the last administrator values (button or
 * Windows task), keeps a small history per drive and alerts through Hostwerk's notifications (push, Discord, ntfy, mail –
 * Live → Alerts) when errors grow, a drive runs hot or wears out. Also shows up as a watcher under Live → Watchers.
 * Only reading commands – nothing on a drive is ever changed.
 * Data: data/disk-health/state.json · task results: %ProgramData%\HostwerkDiskHealth\smart.json (see admin.js)
 */
const fs = require('fs');
const path = require('path');
const H = require('./health');
const A = require('./admin');
const { probe } = require('./probe');
const { describe } = require('./texts');

const KEEP_SAMPLES = 720; // about a month at one sample per hour
/** Administrator values younger than this count as "now" (temperature is judged, drives only they know are shown). */
const FRESH_MS = 2 * 3600000;
const TOOLS_TTL = 10 * 60000;

/**
 * The service itself – io = { exec, readdir, readFile, platform?, env?, exists?, elevate?(steps, opts), pkgHint?(pkg) }
 * (injected by the tests). elevate = Hostwerk's elevatedBatch – missing on Hostwerk before 2.12: then there is no admin check.
 */
function createService(host, io) {
  const { ctx } = host;
  const platform = io.platform || process.platform;
  const env = io.env || process.env;
  const exists = io.exists || ((p) => fs.existsSync(p));
  const canElevate = typeof io.elevate === 'function' && (platform === 'win32' || platform === 'linux');
  const marker = host.dir ? path.join(host.dir, 'manifest.json') : '';
  const dir = path.join(ctx.paths.data, 'disk-health');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'state.json');
  const read = () => { try { return { drives: {}, last: null, admin: null, schedule: null, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { return { drives: {}, last: null, admin: null, schedule: null }; } };
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

  /* ---------- smartctl and winget: found? which version? ---------- */
  let tools = null; let toolsAt = 0;
  const install = { running: false, error: null, at: null };
  const versionOf = async (cmd) => {
    const r = await io.exec(cmd, ['--version'], { timeout: 15000 }).catch(() => null);
    return r && !r.error ? A.parseVersion(r.stdout) : null;
  };
  const findTools = async (force = false) => {
    if (tools && !force && Date.now() - toolsAt < TOOLS_TTL) return tools;
    const out = { path: null, version: null, ok: false, trusted: false, canInstall: false, hint: null };
    if (platform === 'win32') {
      for (const p of A.smartctlCandidates(env)) {
        if (!exists(p)) continue;
        out.path = p; out.version = await versionOf(p); out.trusted = A.trustedSmartctl(p, env);
        break;
      }
      const wg = await io.exec('winget', ['--version'], { timeout: 15000 }).catch(() => null);
      out.canInstall = !!(wg && !wg.error && wg.code === 0);
    } else {
      out.version = await versionOf('smartctl');
      if (out.version) { out.path = 'smartctl'; out.trusted = true; }
      try { out.hint = io.pkgHint ? io.pkgHint({ apt: 'smartmontools' }) || null : null; } catch { /* no hint */ }
    }
    out.ok = !!out.path && A.versionOk(out.version);
    tools = out; toolsAt = Date.now();
    return out;
  };
  /** smartctl for an admin run on Windows: only a current one from Program Files (see admin.trustedSmartctl). */
  const adminSmartctl = async () => { const t = await findTools(); return platform === 'win32' && t.ok && t.trusted ? t.path : null; };

  /** Notification for the problems that are new (or worse) on one drive. */
  const alert = (d, fresh) => {
    const err = fresh.some((p) => p.level === 'err');
    const title = err ? host.t('Drive “{name}” is in danger', { name: d.name }) : host.t('Drive “{name}” needs attention', { name: d.name });
    const text = fresh.map((p) => describe(p, host.t)).join('\n');
    try { if (ctx.monitor) ctx.monitor.send(title, text, { kind: err ? 'error' : 'warn', event: 'disk', force: true }).catch(() => {}); } catch { /* notifications are optional */ }
    host.broadcast({ type: 'toast', kind: err ? 'error' : 'info', text: `${title}: ${text.split('\n')[0]}` });
  };

  /** Result file of the Windows task (readable without admin rights) – newer than what we have? Then it becomes the admin snapshot. */
  const readTaskFile = async (st) => {
    if (platform !== 'win32') return;
    const f = A.taskFile(env);
    if (!exists(f)) return;
    let text = '';
    try { text = String(await io.readFile(f)); } catch { return; }
    const res = H.parseAdminResult(text);
    if (!res || !res.admin || !res.at) return;
    st.schedule = { ...(st.schedule || {}), lastAt: res.at };
    if (!st.admin || res.at > st.admin.at) st.admin = { at: res.at, source: 'task', drives: res.drives, smartctl: res.smartctl };
  };

  let running = null;
  let nextAt = null;
  const run = () => {
    if (running) return running;
    running = (async () => {
      const cfg = settings();
      const st = read();
      const r = await probe(io).catch((e) => ({ source: null, drives: [], notes: [], error: e.message }));
      await readTaskFile(st).catch(() => {});
      const now = Date.now();
      // Administrator values fill what Windows/smartctl do not reveal without rights; drives only they know (USB adapter
      // read by smartctl) appear only while the values are fresh – an unplugged drive does not stay forever
      let list = r.drives;
      if (st.admin && Array.isArray(st.admin.drives) && st.admin.drives.length) {
        const fresh = now - st.admin.at < FRESH_MS;
        const merged = H.matchDrives(r.drives, st.admin.drives.map((d) => ({ ...d, smartAt: st.admin.at, tempStale: !fresh })));
        list = merged.slice(0, r.drives.length).concat(fresh ? merged.slice(r.drives.length) : []);
      }
      const drives = [];
      for (const d of list) {
        const rec = st.drives[d.id] || { samples: [], alerted: {} };
        const prev = rec.samples[rec.samples.length - 1] || null;
        const a = H.assess(d, prev, cfg.limits);
        const s = H.sample(d, now);
        if (H.worthKeeping(prev, s)) rec.samples = [...rec.samples, s].slice(-KEEP_SAMPLES);
        // Alerts: only new or worse problems; solved ones are forgotten so they alert again if they come back
        const freshP = a.problems.filter((p) => H.shouldAlert(p, rec.alerted[p.code], now));
        rec.alerted = Object.fromEntries(a.problems.map((p) => [p.code, freshP.includes(p) ? { t: now, level: p.level, value: p.value } : rec.alerted[p.code]]));
        if (freshP.length && cfg.notify) alert(d, freshP);
        rec.name = d.name;
        rec.seen = now;
        st.drives[d.id] = rec;
        drives.push({ ...d, level: a.level, problems: a.problems });
      }
      // Drives that have been gone for 90 days are forgotten
      for (const [id, rec] of Object.entries(st.drives)) if (now - (rec.seen || 0) > 90 * 86400000) delete st.drives[id];
      // "needs-admin" only while drives without administrator values are left
      const notes = (r.notes || []).filter((n) => n !== 'needs-admin' || drives.some((d) => d.partial && !d.smartAt));
      st.last = { at: now, source: r.source, notes, error: r.error || null, drives };
      write(st);
      const bad = drives.filter((d) => d.level === 'err' || d.level === 'warn');
      try {
        host.watcher({
          id: 'drives', label: host.t('Drive health'), state: bad.length ? 'alert' : drives.length ? 'ok' : 'off', href: '/ext/disk-health',
          detail: bad.length ? bad.map((d) => d.name).join(', ') : host.t('Drives without problems: {n}', { n: drives.length }),
        });
      } catch { /* watchers are optional */ }
      await findTools().catch(() => null);
      return st.last;
    })().finally(() => { running = null; });
    return running;
  };

  /* ---------- With administrator rights ---------- */
  let adminBusy = null;
  const fail = (reason, error) => ({ ok: false, reason, error: error || null });

  /** One administrator prompt, all drives at once. reason: unsupported | needs-update | cancelled | not-admin | no-result | no-smartctl | busy */
  const adminCheck = async () => {
    if (!canElevate) return fail(typeof io.elevate === 'function' ? 'unsupported' : 'needs-update');
    if (adminBusy) return fail('busy');
    adminBusy = 'check';
    try {
      const now = Date.now();
      let res = null;
      if (platform === 'win32') {
        const r = await io.elevate([{ cmd: 'powershell.exe', args: A.psArgs(A.checkScript({ smartctl: await adminSmartctl() })) }]);
        res = H.parseAdminResult(((r && r.steps && r.steps[0]) || {}).out);
        if (!res) return fail(r && r.code ? 'cancelled' : 'no-result');
        if (!res.admin) return fail('not-admin');
      } else {
        const scan = await io.exec('smartctl', ['--scan', '-j'], { timeout: 20000 }).catch((e) => ({ error: e }));
        if (!scan || (scan.error && (scan.error.code === 'ENOENT' || scan.code === 127))) return fail('no-smartctl');
        const list = H.extractJson(scan.stdout);
        let devices = list && Array.isArray(list.devices) ? list.devices : [];
        // smartctl lists nothing without rights on some systems – then the devices we already know from /sys
        if (!devices.length) devices = ((read().last || {}).drives || []).map((d) => ({ name: d.device })).filter((d) => d.name);
        const steps = A.linuxSteps(devices);
        if (!steps.length) return fail('no-result');
        const r = await io.elevate(steps, { keepGoing: true });
        const drives = ((r && r.steps) || []).map((s, i) => H.parseSmartctl(H.extractJson(s.out), steps[i].args[steps[i].args.length - 1])).filter(Boolean);
        if (!drives.length) return fail(r && r.code ? 'cancelled' : 'no-result');
        res = { at: now, admin: true, drives, smartctl: true };
      }
      const st = read();
      st.admin = { at: res.at || now, source: 'check', drives: res.drives, smartctl: res.smartctl };
      write(st);
      await run();
      return { ok: true };
    } catch (e) {
      return fail('error', e.message);
    } finally { adminBusy = null; }
  };

  /** Windows task on/off – each ONE administrator prompt. Only after the user agreed in the dialog (the interface asks). */
  const setSchedule = async (on) => {
    if (platform !== 'win32' || !canElevate) return fail(typeof io.elevate === 'function' ? 'unsupported' : 'needs-update');
    if (adminBusy) return fail('busy');
    adminBusy = 'schedule';
    try {
      const tdir = A.taskDir(env);
      const script = on
        ? A.installScript({ smartctl: await adminSmartctl(), marker, dir: tdir, intervalMin: A.TASK_INTERVAL_MIN })
        : A.removeScript({ dir: tdir });
      const r = await io.elevate([{ cmd: 'powershell.exe', args: A.psArgs(script) }]);
      const ok = A.parseOk(((r && r.steps && r.steps[0]) || {}).out);
      if (!ok.ok) return fail(ok.error ? 'error' : 'cancelled', ok.error);
      const st = read();
      st.schedule = on ? { on: true, since: Date.now(), intervalMin: A.TASK_INTERVAL_MIN, lastAt: null } : { on: false, since: Date.now() };
      write(st);
      // The task starts right away – its first result is there after a few seconds
      if (on) for (const ms of [20000, 90000]) { const tm = setTimeout(() => { run().catch(() => {}); }, ms); if (tm.unref) tm.unref(); }
      return { ok: true };
    } catch (e) {
      return fail('error', e.message);
    } finally { adminBusy = null; }
  };

  /** smartmontools through winget (Windows): separate download from the official package source, winget checks its SHA-256. */
  const installSmartctl = async () => {
    if (platform !== 'win32') return fail('unsupported');
    if (install.running) return fail('busy');
    const t = await findTools(true);
    if (!t.canInstall) return fail('no-winget');
    install.running = true; install.error = null;
    (async () => {
      const r = await io.exec('winget', ['install', '--id', A.WINGET_ID, '-e', '--source', 'winget', '--silent', '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity'], { timeout: 600000 }).catch((e) => ({ code: 1, stderr: e.message }));
      const after = await findTools(true);
      install.running = false; install.at = Date.now();
      install.error = after.ok ? null : ((r && (r.stderr || r.stdout)) || '').trim().split(/\r?\n/).filter(Boolean).pop() || 'smartctl not found after the installation';
    })();
    return { ok: true };
  };

  const view = () => {
    const st = read();
    const now = Date.now();
    const last = st.last || { at: null, source: null, notes: [], error: null, drives: [] };
    const sch = st.schedule || {};
    const tdir = A.taskDir(env);
    const present = platform === 'win32' && exists(tdir);
    let schState = 'off';
    if (sch.on) {
      // Task folder gone (removed elsewhere or cleaned up) → missing; no result for 3 rounds → stale
      if (!present) schState = 'missing';
      else if (!sch.lastAt) schState = now - (sch.since || 0) > 15 * 60000 ? 'stale' : 'waiting';
      else schState = now - sch.lastAt > 3 * (sch.intervalMin || A.TASK_INTERVAL_MIN) * 60000 + 600000 ? 'stale' : 'ok';
    }
    const traces = sch.on || present ? [
      { kind: 'task', label: `${A.TASK_FOLDER}${A.TASK_NAME}` },
      { kind: 'folder', label: tdir },
    ] : [];
    return {
      ...last,
      running: !!running,
      platform,
      nextAt,
      limits: settings().limits,
      admin: st.admin ? { at: st.admin.at, source: st.admin.source, smartctl: !!st.admin.smartctl, fresh: now - st.admin.at < FRESH_MS } : null,
      adminBusy,
      canElevate,
      needsUpdate: typeof io.elevate !== 'function',
      schedule: { supported: platform === 'win32' && canElevate, on: !!sch.on, since: sch.since || null, intervalMin: sch.intervalMin || A.TASK_INTERVAL_MIN, lastAt: sch.lastAt || null, state: schState },
      smartctl: { ...(tools || { path: null, version: null, ok: false, trusted: false, canInstall: false, hint: null }), min: A.SMARTCTL_MIN.join('.'), install: { ...install } },
      traces,
      drives: last.drives.map((d) => {
        const samples = (st.drives[d.id] || {}).samples || [];
        return { ...d, history: samples.slice(-168).map((s) => ({ t: s.t, tempC: s.tempC, wearPct: s.wearPct })), life: H.estimateLife(d, samples) };
      }),
    };
  };

  return { run, view, settings, adminCheck, setSchedule, installSmartctl, findTools, setNext: (t) => { nextAt = t; } };
}

function activate(host) {
  const { exec } = host.core('util');
  let plat = null;
  try { plat = host.core('platform'); } catch { /* old Hostwerk */ }
  const svc = createService(host, {
    exec: (cmd, args, opts) => exec(cmd, args, opts),
    readdir: (p) => fs.promises.readdir(p),
    readFile: (p) => fs.promises.readFile(p, 'utf8'),
    // SDK 2.10 (Hostwerk 2.12+): several commands with ONE administrator prompt – older Hostwerk: no admin check
    elevate: plat && typeof plat.elevatedBatch === 'function' ? (steps, opts) => plat.elevatedBatch(steps, opts) : undefined,
    pkgHint: plat && typeof plat.pkgHint === 'function' ? (p) => plat.pkgHint(p) : undefined,
  });
  host.router.get('/disk-health', (req, res) => res.json(svc.view()));
  host.router.post('/disk-health/refresh', async (req, res) => { await svc.run(); res.json(svc.view()); });
  host.router.post('/disk-health/admin-check', async (req, res) => { const r = await svc.adminCheck(); res.json({ ...r, view: svc.view() }); });
  host.router.post('/disk-health/schedule', async (req, res) => { const r = await svc.setSchedule(!!(req.body && req.body.on)); res.json({ ...r, view: svc.view() }); });
  host.router.post('/disk-health/smartctl/install', async (req, res) => { const r = await svc.installSmartctl(); res.json({ ...r, view: svc.view() }); });

  // First reading shortly after the start (Hostwerk is busy starting services), then in the chosen rhythm
  let timer = null;
  const schedule = (ms) => {
    clearTimeout(timer);
    svc.setNext(Date.now() + ms);
    timer = setTimeout(() => { svc.run().catch(() => {}).finally(() => schedule(svc.settings().interval * 60000)); }, ms);
    if (timer.unref) timer.unref();
  };
  schedule(20000);
  host.on('shutdown', () => clearTimeout(timer));
}

function deactivate() {}

module.exports = { activate, deactivate, createService };
