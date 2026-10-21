'use strict';
// Drive health – the whole round with a fake Hostwerk: read, remember, alert once, alert again only when it gets worse.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createService } = require('../server/index');

const temp = [];
test.after(() => { for (const d of temp) fs.rmSync(d, { recursive: true, force: true }); });

function fakeHost(settings = {}) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-disk-health-'));
  temp.push(data);
  const sent = []; const toasts = []; const watchers = [];
  const fill = (s, v) => (v ? String(s).replace(/\{(\w+)\}/g, (m, k) => (v[k] !== undefined ? String(v[k]) : m)) : String(s));
  const host = {
    id: 'disk-health',
    t: fill,
    broadcast: (m) => toasts.push(m),
    watcher: (w) => watchers.push(w),
    ctx: {
      paths: { data },
      extMarket: { settingsFor: () => settings },
      monitor: { send: async (title, text, o) => { sent.push({ title, text, ...o }); return []; } },
    },
  };
  return { host, sent, toasts, watchers, data };
}

/** One drive whose values the test changes between the rounds. */
function windowsIo(state) {
  return {
    platform: 'win32',
    exec: async () => ({ code: 0, stderr: '', stdout: JSON.stringify([{ DeviceId: '0', FriendlyName: 'Old HDD', SerialNumber: 'WD-1', MediaType: 'HDD', BusType: 'SATA', Size: 2e12, HealthStatus: state.health,
      Counters: { Temperature: state.temp, TemperatureMax: 0, Wear: 0, PowerOnHours: 40000, ReadErrorsUncorrected: state.readErrors, WriteErrorsUncorrected: 0 } }]) }),
  };
}

test('Runde für Runde: speichert, meldet einmal, meldet wieder bei Wachstum', async () => {
  const f = fakeHost();
  const state = { health: 'Healthy', temp: 40, readErrors: 0 };
  const svc = createService(f.host, windowsIo(state));

  const first = await svc.run();
  assert.strictEqual(first.drives[0].level, 'ok');
  assert.strictEqual(f.sent.length, 0);
  assert.strictEqual(f.watchers.at(-1).state, 'ok');

  state.readErrors = 3; // Lesefehler wachsen → Warnung
  await svc.run();
  assert.strictEqual(f.sent.length, 1);
  assert.match(f.sent[0].title, /Old HDD/);
  assert.match(f.sent[0].text, /rose from 0 to 3/);
  assert.strictEqual(f.sent[0].kind, 'warn');
  assert.strictEqual(f.watchers.at(-1).state, 'alert');

  await svc.run(); // unverändert → keine zweite Meldung
  assert.strictEqual(f.sent.length, 1);

  state.temp = 75; state.health = 'Unhealthy'; // heiß und Zustand kritisch → Fehler
  await svc.run();
  assert.strictEqual(f.sent.length, 2);
  assert.strictEqual(f.sent[1].kind, 'error');
  assert.match(f.sent[1].text, /75 °C – much too hot/);

  const v = svc.view();
  assert.strictEqual(v.drives[0].level, 'err');
  assert.ok(v.drives[0].history.length >= 2);
  assert.deepStrictEqual(v.limits, { tempWarn: 60, tempCrit: 70, wearWarn: 80, wearCrit: 95 });
  assert.ok(fs.existsSync(path.join(f.data, 'disk-health', 'state.json')));
});

test('Benachrichtigen abgeschaltet und eigene Grenzen', async () => {
  const f = fakeHost({ notify: false, tempWarn: 45 });
  const svc = createService(f.host, windowsIo({ health: 'Healthy', temp: 50, readErrors: 0 }));
  const r = await svc.run();
  assert.strictEqual(r.drives[0].level, 'warn');
  assert.strictEqual(f.sent.length, 0);
  assert.strictEqual(svc.view().limits.tempCrit, 55);
});

test('Lesen schlägt fehl → leere Liste mit Hinweis, kein Absturz', async () => {
  const f = fakeHost();
  const svc = createService(f.host, { platform: 'win32', exec: async () => { throw new Error('spawn UNKNOWN'); } });
  const r = await svc.run();
  assert.deepStrictEqual(r.drives, []);
  assert.match(r.error, /spawn UNKNOWN/);
  assert.strictEqual(f.watchers.at(-1).state, 'off');
});
