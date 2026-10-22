'use strict';
// Drive health – administrator check, regular check (Windows task) and smartmontools with a fake Hostwerk and a fake
// "elevate" (Hostwerk's elevatedBatch). Nothing here asks Windows for anything or touches the system.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createService } = require('../server/index');
const H = require('../server/health');
const A = require('../server/admin');

const temp = [];
test.after(() => { for (const d of temp) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); temp.push(d); return d; };

function fakeHost() {
  const data = tmp('hw-disk-health-');
  const sent = [];
  const host = {
    id: 'disk-health',
    dir: path.join(data, 'ext', 'disk-health'),
    t: (s, v) => (v ? String(s).replace(/\{(\w+)\}/g, (m, k) => (v[k] !== undefined ? String(v[k]) : m)) : String(s)),
    broadcast: () => {},
    watcher: () => {},
    ctx: { paths: { data }, extMarket: { settingsFor: () => ({}) }, monitor: { send: async (title, text, o) => { sent.push({ title, text, ...o }); return []; } } },
  };
  return { host, sent };
}

/** What Windows shows without admin rights: the drive and its health, no counters. */
const BASIC = JSON.stringify([
  { DeviceId: '0', FriendlyName: 'Predator SSD GM7 2TB', SerialNumber: '0000_0000_0000_0000_50C6_8E52_7150_2160.', MediaType: 'SSD', BusType: 'NVMe', Size: 2048408248320, HealthStatus: 'Healthy', OperationalStatus: 'OK', Counters: null, CounterError: 'Access denied' },
]);
const adminDisks = (temp = 44) => [{ ...JSON.parse(BASIC)[0], Counters: { Temperature: temp, TemperatureMax: 84, Wear: 3, PowerOnHours: 3120, ReadErrorsUncorrected: 0, WriteErrorsUncorrected: 0 }, CounterError: null }];
const USB = { smartctl: { exit_status: 0 }, device: { name: '/dev/sdb', info_name: '/dev/sdb [USB]', type: 'sat', protocol: 'ATA' }, model_name: 'Ext HDD', serial_number: 'USB1', user_capacity: { bytes: 1e12 }, rotation_rate: 5400, smart_status: { passed: true }, ata_smart_attributes: { table: [{ id: 5, value: 100, raw: { value: 0 } }] } };
const adminOut = ({ at = Date.now(), admin = true, temp: tc = 44, smart = [] } = {}) => `${H.MARK_START}${JSON.stringify({ v: 1, at, admin, disks: adminDisks(tc), smart })}${H.MARK_END}`;

/** Windows machine: basic probe, optional winget/smartctl, elevate answers from `answers` (one per call). */
function windowsIo({ answers = [], elevate = true, smartctl = false } = {}) {
  const pd = tmp('hw-programdata-');
  const env = { ProgramData: pd, ProgramFiles: 'C:\\Program Files', ProgramW6432: 'C:\\Program Files' };
  const scPath = 'C:\\Program Files\\smartmontools\\bin\\smartctl.exe';
  const state = { smartctl, elevated: [], execs: [] };
  const io = {
    platform: 'win32', env, state,
    exists: (p) => (p === scPath ? state.smartctl : fs.existsSync(p)),
    readFile: (p) => fs.promises.readFile(p, 'utf8'),
    readdir: async () => [],
    exec: async (cmd, args) => {
      state.execs.push([cmd, ...args].join(' '));
      if (cmd === 'powershell.exe') return { code: 0, stdout: BASIC, stderr: '' };
      if (cmd === 'winget' && args[0] === '--version') return { code: 0, stdout: 'v1.9.25200', stderr: '' };
      if (cmd === 'winget' && args[0] === 'install') { state.smartctl = true; return { code: 0, stdout: 'Successfully installed', stderr: '' }; }
      if (cmd === scPath) return { code: 0, stdout: 'smartctl 7.5 2025-04-30 r5714 [x86_64-w64-mingw32-w10-b26100] (sf-7.5-1)', stderr: '' };
      return { code: 127, stdout: '', stderr: '', error: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) };
    },
  };
  if (elevate) {
    io.elevate = async (steps, opts) => {
      const scripts = steps.map((s) => (s.cmd === 'powershell.exe' ? Buffer.from(s.args[s.args.length - 1], 'base64').toString('utf16le') : [s.cmd, ...s.args].join(' ')));
      state.elevated.push({ scripts, opts });
      const a = answers.shift();
      return typeof a === 'function' ? a(scripts) : a || { code: 1, steps: [] };
    };
  }
  return io;
}

test('Mit Administratorrechten prüfen: EINE Rückfrage, Werte werden gespeichert und angezeigt', async () => {
  const f = fakeHost();
  const io = windowsIo({ answers: [{ code: 0, steps: [{ code: 0, out: adminOut() }] }] });
  const svc = createService(f.host, io);
  await svc.run();
  let v = svc.view();
  assert.deepStrictEqual(v.notes, ['needs-admin']);
  assert.strictEqual(v.drives[0].tempC, null);
  assert.strictEqual(v.canElevate, true);
  assert.strictEqual(v.admin, null);

  const r = await svc.adminCheck();
  assert.deepStrictEqual(r, { ok: true });
  assert.strictEqual(io.state.elevated.length, 1);
  assert.strictEqual(io.state.elevated[0].scripts.length, 1);
  assert.match(io.state.elevated[0].scripts[0], /Get-StorageReliabilityCounter/);
  assert.match(io.state.elevated[0].scripts[0], /\$sc = ''/); // smartctl nicht installiert
  v = svc.view();
  assert.deepStrictEqual(v.notes, []);
  assert.strictEqual(v.admin.source, 'check');
  assert.strictEqual(v.admin.fresh, true);
  const d = v.drives[0];
  assert.deepStrictEqual([d.tempC, d.wearPct, d.powerOnHours, d.readErrors, d.level, d.tempStale], [44, 3, 3120, 0, 'ok', false]);
  assert.ok(d.smartAt);
  assert.deepStrictEqual(d.life, { years: 11.5, basis: 'average' });
  // Die nächste normale Prüfung (ohne Rechte) behält die Admin-Werte
  await svc.run();
  assert.strictEqual(svc.view().drives[0].wearPct, 3);
});

test('Abgebrochen, keine Rechte bekommen, Hostwerk zu alt', async () => {
  const f = fakeHost();
  const io = windowsIo({ answers: [{ code: 1223, steps: [] }, { code: 0, steps: [{ code: 0, out: adminOut({ admin: false }) }] }] });
  const svc = createService(f.host, io);
  assert.deepStrictEqual(await svc.adminCheck(), { ok: false, reason: 'cancelled', error: null });
  assert.deepStrictEqual(await svc.adminCheck(), { ok: false, reason: 'not-admin', error: null });
  assert.strictEqual(svc.view().admin, null);

  const old = createService(fakeHost().host, windowsIo({ elevate: false }));
  assert.strictEqual((await old.adminCheck()).reason, 'needs-update');
  assert.strictEqual((await old.setSchedule(true)).reason, 'needs-update');
  const v = old.view();
  assert.deepStrictEqual([v.canElevate, v.needsUpdate, v.schedule.supported], [false, true, false]);
});

test('Alte Admin-Werte: Temperatur wird nicht mehr bewertet, Laufwerke nur aus der Admin-Prüfung verschwinden', async () => {
  const f = fakeHost();
  const old = Date.now() - 5 * 3600000;
  const io = windowsIo({ answers: [{ code: 0, steps: [{ code: 0, out: adminOut({ at: old, temp: 80, smart: [{ device: '/dev/sdb', type: 'sat', json: JSON.stringify(USB) }] }) }] }] });
  const svc = createService(f.host, io);
  await svc.adminCheck();
  const v = svc.view();
  assert.strictEqual(v.admin.fresh, false);
  assert.strictEqual(v.drives.length, 1); // der USB-Datenträger von vor 5 Stunden ist nicht mehr dabei
  const d = v.drives[0];
  assert.deepStrictEqual([d.tempC, d.tempStale, d.level, d.wearPct], [80, true, 'ok', 3]);
  assert.strictEqual(f.sent.length, 0); // keine Hitze-Meldung für einen alten Messwert
});

test('Frische Admin-Werte: zu heiß → Meldung; USB-Laufwerk, das nur smartctl kennt, erscheint', async () => {
  const f = fakeHost();
  const io = windowsIo({ answers: [{ code: 0, steps: [{ code: 0, out: adminOut({ temp: 86, smart: [{ device: '/dev/sdb', type: 'sat', json: JSON.stringify(USB) }] }) }] }] });
  const svc = createService(f.host, io);
  await svc.adminCheck();
  const v = svc.view();
  assert.deepStrictEqual(v.drives.map((d) => [d.name, d.bus, d.level]), [['Predator SSD GM7 2TB', 'NVMe', 'err'], ['Ext HDD', 'USB', 'ok']]);
  assert.strictEqual(f.sent.length, 1);
  assert.match(f.sent[0].text, /86 °C/);
});

test('Regelmäßig prüfen: Aufgabe einrichten, Ergebnisdatei lesen, Spuren zeigen, sauber abschalten', async () => {
  const f = fakeHost();
  const io = windowsIo({
    answers: [
      { code: 0, steps: [{ code: 0, out: `${H.MARK_START}{"ok":true}${H.MARK_END}` }] },
      { code: 0, steps: [{ code: 0, out: `${H.MARK_START}{"ok":true}${H.MARK_END}` }] },
    ],
  });
  const svc = createService(f.host, io);
  assert.strictEqual(svc.view().schedule.state, 'off');
  assert.deepStrictEqual(svc.view().traces, []);

  assert.deepStrictEqual(await svc.setSchedule(true), { ok: true });
  const inst = io.state.elevated[0].scripts[0];
  assert.match(inst, /Register-ScheduledTask/);
  assert.ok(inst.includes(path.join(f.host.dir, 'manifest.json')), 'Aufgabe prüft, ob die Erweiterung noch da ist');
  assert.ok(inst.includes(A.taskDir(io.env)));
  let v = svc.view();
  assert.strictEqual(v.schedule.on, true);
  assert.strictEqual(v.schedule.state, 'missing'); // Ordner gibt es (in der Attrappe) noch nicht

  // Die Aufgabe hat ihren Ordner angelegt und das erste Ergebnis geschrieben
  fs.mkdirSync(A.taskDir(io.env), { recursive: true });
  assert.strictEqual(svc.view().schedule.state, 'waiting');
  const at = Date.now() - 60000;
  fs.writeFileSync(A.taskFile(io.env), `\uFEFF${adminOut({ at })}`);
  await svc.run();
  v = svc.view();
  assert.deepStrictEqual([v.schedule.state, v.schedule.lastAt, v.admin.source, v.admin.at], ['ok', at, 'task', at]);
  assert.strictEqual(v.drives[0].tempC, 44);
  assert.deepStrictEqual(v.traces.map((x) => x.kind), ['task', 'folder']);
  assert.strictEqual(v.traces[0].label, '\\Hostwerk\\DiskHealth');

  // Ein älteres Ergebnis überschreibt keine neuere Prüfung per Knopf
  fs.writeFileSync(A.taskFile(io.env), adminOut({ at: at - 3600000 }));
  await svc.run();
  assert.strictEqual(svc.view().admin.at, at);

  // Keine Werte mehr seit Stunden → „liefert nicht mehr“
  const st = JSON.parse(fs.readFileSync(path.join(f.host.ctx.paths.data, 'disk-health', 'state.json'), 'utf8'));
  st.schedule.lastAt = Date.now() - 5 * 3600000;
  fs.writeFileSync(path.join(f.host.ctx.paths.data, 'disk-health', 'state.json'), JSON.stringify(st));
  assert.strictEqual(svc.view().schedule.state, 'stale');

  // Abschalten: eine Rückfrage, Aufgabe und Ordner weg (das erledigt das Skript), keine Spuren mehr
  assert.deepStrictEqual(await svc.setSchedule(false), { ok: true });
  assert.match(io.state.elevated[1].scripts[0], /Unregister-ScheduledTask/);
  fs.rmSync(A.taskDir(io.env), { recursive: true, force: true });
  v = svc.view();
  assert.deepStrictEqual([v.schedule.on, v.schedule.state, v.traces.length], [false, 'off', 0]);
});

test('Regelmäßig prüfen: abgebrochene Rückfrage oder Fehler ändern nichts', async () => {
  const f = fakeHost();
  const io = windowsIo({ answers: [{ code: 1, steps: [] }, { code: 1, steps: [{ code: 1, out: `${H.MARK_START}{"ok":false,"error":"icacls failed"}${H.MARK_END}` }] }] });
  const svc = createService(f.host, io);
  assert.deepStrictEqual(await svc.setSchedule(true), { ok: false, reason: 'cancelled', error: null });
  assert.deepStrictEqual(await svc.setSchedule(true), { ok: false, reason: 'error', error: 'icacls failed' });
  assert.strictEqual(svc.view().schedule.on, false);
  // Nur Windows
  const lin = createService(fakeHost().host, { platform: 'linux', exec: async () => ({ code: 127, error: { code: 'ENOENT' } }), readdir: async () => [], readFile: async () => '', elevate: async () => ({ code: 0, steps: [] }) });
  assert.strictEqual((await lin.setSchedule(true)).reason, 'unsupported');
  assert.strictEqual(lin.view().schedule.supported, false);
});

test('smartmontools: über winget installieren, danach nimmt die Admin-Prüfung smartctl mit', async () => {
  const f = fakeHost();
  const io = windowsIo({ answers: [{ code: 0, steps: [{ code: 0, out: adminOut() }] }] });
  const svc = createService(f.host, io);
  await svc.run();
  let v = svc.view();
  assert.deepStrictEqual([v.smartctl.path, v.smartctl.ok, v.smartctl.canInstall], [null, false, true]);
  assert.deepStrictEqual(await svc.installSmartctl(), { ok: true });
  for (let i = 0; i < 50 && svc.view().smartctl.install.running; i++) await new Promise((r) => setTimeout(r, 10));
  v = svc.view();
  assert.deepStrictEqual([v.smartctl.ok, v.smartctl.version, v.smartctl.trusted, v.smartctl.install.error], [true, '7.5', true, null]);
  assert.ok(io.state.execs.some((c) => c === `winget install --id ${A.WINGET_ID} -e --source winget --silent --accept-package-agreements --accept-source-agreements --disable-interactivity`));
  await svc.adminCheck();
  assert.match(io.state.elevated[0].scripts[0], /\$sc = 'C:\\Program Files\\smartmontools\\bin\\smartctl\.exe'/);
  assert.strictEqual((await createService(fakeHost().host, { platform: 'linux', exec: async () => ({}), readdir: async () => [], readFile: async () => '' }).installSmartctl()).reason, 'unsupported');
});

test('Linux: smartctl über pkexec, ein Lauf für alle Geräte', async () => {
  const f = fakeHost();
  const NVME = { smartctl: { exit_status: 0 }, device: { name: '/dev/nvme0', type: 'nvme', protocol: 'NVMe' }, model_name: 'WD Blue SN570 1TB', serial_number: '22123A456789', nvme_smart_health_information_log: { percentage_used: 4, temperature: 47, media_errors: 0, power_on_hours: 3100 } };
  const calls = [];
  const io = {
    platform: 'linux',
    exec: async (cmd, args) => {
      if (cmd === 'smartctl' && args[0] === '--scan') return { code: 0, stdout: JSON.stringify({ devices: [{ name: '/dev/nvme0', type: 'nvme' }] }) };
      if (cmd === 'smartctl' && args[0] === '--version') return { code: 0, stdout: 'smartctl 7.4 2023-08-01' };
      if (cmd === 'smartctl') return { code: 2, stdout: JSON.stringify({ smartctl: { exit_status: 2 }, device: { name: '/dev/nvme0' } }) };
      return { code: 127, stdout: '', error: { code: 'ENOENT' } };
    },
    readdir: async (p) => { if (p === '/sys/block') return ['nvme0n1']; throw new Error('ENOENT'); },
    readFile: async (p) => ({ '/sys/block/nvme0n1/size': '1953525168', '/sys/block/nvme0n1/queue/rotational': '0', '/sys/block/nvme0n1/device/model': 'WD Blue SN570 1TB', '/sys/block/nvme0n1/device/serial': '22123A456789' })[p] ?? Promise.reject(new Error('ENOENT')),
    elevate: async (steps, opts) => { calls.push({ steps, opts }); return { code: 0, steps: [{ code: 0, out: JSON.stringify(NVME) }] }; },
    pkgHint: () => 'sudo apt install smartmontools',
  };
  const svc = createService(f.host, io);
  await svc.run();
  assert.deepStrictEqual(svc.view().notes, ['smartctl-rights']);
  assert.deepStrictEqual(await svc.adminCheck(), { ok: true });
  assert.deepStrictEqual(calls[0], { steps: [{ cmd: 'smartctl', args: ['-j', '-d', 'nvme', '-a', '/dev/nvme0'] }], opts: { keepGoing: true } });
  const d = svc.view().drives[0];
  assert.deepStrictEqual([d.wearPct, d.tempC, d.powerOnHours], [4, 47, 3100]);
  assert.strictEqual(svc.view().drives.length, 1);
  assert.strictEqual(svc.view().smartctl.hint, 'sudo apt install smartmontools');
});

test('Spuren (Hostwerk 3.0+, SDK 3.3): Aufgabe und Ordner werden gemeldet, beim Abschalten abgemeldet; Entfernen-Haken', async () => {
  const f = fakeHost();
  const traces = new Map();
  f.host.traces = { add: (t) => { traces.set(t.id, t); return t; }, remove: (id) => traces.delete(id), list: () => [...traces.values()] };
  const ok = { code: 0, steps: [{ code: 0, out: `${H.MARK_START}{"ok":true}${H.MARK_END}` }] };
  const io = windowsIo({ answers: [ok, ok] });
  const svc = createService(f.host, io);
  assert.strictEqual(traces.size, 0, 'nichts eingerichtet → keine Spuren');
  await svc.setSchedule(true);
  assert.deepStrictEqual([...traces.keys()].sort(), ['folder', 'task']);
  const task = traces.get('task'); const folder = traces.get('folder');
  assert.deepStrictEqual([task.kind, task.admin, task.remove.name], ['task', true, `${A.TASK_FOLDER}${A.TASK_NAME}`]);
  assert.deepStrictEqual([folder.kind, folder.admin, folder.remove.path], ['dir', true, A.taskDir(io.env)]);
  // Kern-Prüfung: die Spuren sind gültig (gleiche Regeln wie Hostwerk)
  let core = null; try { core = require(path.join(__dirname, '..', '..', '..', 'hostwerk', 'server', 'core', 'exttraces')); } catch { /* Hostwerk nicht daneben */ }
  if (core) { assert.doesNotThrow(() => core.normalize(task)); }
  await svc.setSchedule(false);
  assert.strictEqual(traces.size, 0, 'abgeschaltet → Aufgabe und Ordner weg, Spuren abgemeldet');

  // Bestehende Einrichtung (vor 1.3.0): beim Start gemeldet
  const st = path.join(f.host.ctx.paths.data, 'disk-health', 'state.json');
  const cur = JSON.parse(fs.readFileSync(st, 'utf8')); cur.schedule = { on: true, since: Date.now() }; fs.writeFileSync(st, JSON.stringify(cur));
  const again = createService(f.host, windowsIo());
  assert.deepStrictEqual([...traces.keys()].sort(), ['folder', 'task']);
  // Entfernen: nur mit angehakter Aufgabe gilt der Zeitplan als aus
  assert.strictEqual(again.uninstalled([{ id: 'folder' }]), false);
  assert.strictEqual(again.uninstalled([{ id: 'task' }]), true);
  assert.strictEqual(JSON.parse(fs.readFileSync(st, 'utf8')).schedule.on, false);
  const ext = require('../server/index');
  assert.strictEqual(typeof ext.uninstall, 'function');
});

test('Ältere Hostwerk-Version ohne host.traces: alles wie bisher, Aufgabe räumt selbst auf', async () => {
  const f = fakeHost();
  const ok = { code: 0, steps: [{ code: 0, out: `${H.MARK_START}{"ok":true}${H.MARK_END}` }] };
  const svc = createService(f.host, windowsIo({ answers: [ok] }));
  assert.strictEqual(svc.syncTraces(true), false);
  assert.deepStrictEqual(await svc.setSchedule(true), { ok: true });
});
