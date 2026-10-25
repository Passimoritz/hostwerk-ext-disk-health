const test = require('node:test');
const assert = require('node:assert');
const D = require('../lib/usage.js');

test('Größen lesbar', () => { assert.strictEqual(D.bytes(0), '0 B'); assert.strictEqual(D.bytes(1536), '1,5 KB'); assert.strictEqual(D.bytes(1536, 'en'), '1.5 KB'); assert.strictEqual(D.bytes(5 * 1024 ** 3), '5 GB'); });
test('Anteile: größter Dienst = voller Balken, leere Dienste weg', () => {
  const s = D.shares([{ name: 'a', bytes: 100 }, { name: 'b', bytes: 300 }, { name: 'c', bytes: 0 }]);
  assert.deepStrictEqual(s.map((x) => [x.name, x.bar, x.pct]), [['b', 100, 75], ['a', 33, 25]]);
});
test('Laufwerk mit Warnstufen', () => {
  assert.strictEqual(D.disk({ total: 100, free: 50 }).level, 'ok'); assert.strictEqual(D.disk({ total: 100, free: 15 }).level, 'warn'); assert.strictEqual(D.disk({ total: 100, free: 5 }).level, 'err'); assert.strictEqual(D.disk(null), null);
});

test('Prozent in Hostwerk-Sprache', () => { assert.strictEqual(D.percent(12.5), '12,5 %'); assert.strictEqual(D.percent(12.5, 'en'), '12.5 %'); });
test('Verlauf: höchstens ein Punkt pro Stunde, alte fallen weg', () => {
  const now = 100 * D.DAY;
  let h = D.record([], { used: 10, total: 100 }, now);
  h = D.record(h, { used: 11, total: 100 }, now + 60000);
  assert.strictEqual(h.length, 1);
  h = D.record(h, { used: 12, total: 100 }, now + 3600000);
  assert.strictEqual(h.length, 2);
  assert.strictEqual(D.record([{ t: now - 91 * D.DAY, used: 1, total: 2 }], null, now).length, 0);
});
test('Prognose: voll in X Tagen, sonst kein Wachstum oder zu wenig Verlauf', () => {
  const G = 1073741824; const now = 50 * D.DAY;
  const grow = [0, 1, 2, 3].map((i) => ({ t: now - (3 - i) * D.DAY, used: 100 * G + i * G, total: 200 * G }));
  const f = D.forecast(grow, now);
  assert.strictEqual(Math.round(f.perDay / G), 1); assert.strictEqual(Math.round(f.days), 97);
  assert.strictEqual(D.forecast(grow.map((p) => ({ ...p, used: 5 * G })), now).days, null);
  assert.strictEqual(D.forecast(grow.slice(0, 1), now), null);
});
test('Klickziele je Dienst', () => {
  assert.strictEqual(D.route({ kind: 'minecraft', id: 'survival' }), '/mc/survival/files');
  assert.strictEqual(D.route({ kind: 'minecraft', id: 'survival' }, 'Sicherungen'), '/mc/survival/backups');
  assert.strictEqual(D.route({ kind: 'db', id: 'x' }, 'Sicherungen'), '/sicherungen');
  assert.strictEqual(D.route({ kind: 'web', id: '../x' }), '/web');
  assert.strictEqual(D.route({ kind: 'game', id: 'v' }), '/spiele/v');
  assert.strictEqual(D.route({ kind: 'game', id: '../x' }), '/ext/game-servers');
  assert.strictEqual(D.route({ kind: 'docker', id: 'hw-redis', app: 'redis1' }), '/apps/redis1');
  assert.strictEqual(D.route({ kind: 'docker', id: 'loose-volume' }), '/apps');
});
test('Aufräum-Vorschläge: große Sicherungen und volles Laufwerk', () => {
  const G = 1073741824;
  const s = [{ kind: 'minecraft', id: 'a', name: 'A', bytes: 5 * G, parts: [{ label: 'Server', bytes: 2 * G }, { label: 'Sicherungen', bytes: 3 * G }] }, { kind: 'minecraft', id: 'b', name: 'B', bytes: 10 * G, parts: [{ label: 'Sicherungen', bytes: 2 * G }] }];
  assert.deepStrictEqual(D.tips(s, { pct: 50 }).map((x) => x.name), ['A']); // B: Sicherungen nur 20 %
  assert.deepStrictEqual(D.tips([], { pct: 85 }).map((x) => x.kind), ['cache']);
  assert.deepStrictEqual(D.tips([{ name: 'C', bytes: 10 * G, parts: [{ label: 'Sicherungen', bytes: 2 * G }] }], null), []);
});

test('Belegung je Art für den Filter: feste Reihenfolge, Spiele-Server und Docker dabei, leere weg', () => {
  const k = D.byKind([{ kind: 'docker', bytes: 5 }, { kind: 'minecraft', bytes: 3 }, { kind: 'docker', bytes: 1 }, { kind: 'game', bytes: 7 }, { kind: 'neu', bytes: 1 }, { kind: 'web', bytes: 0 }]);
  assert.deepStrictEqual(k.map((x) => [x.kind, x.bytes, x.count]), [['minecraft', 3, 1], ['game', 7, 1], ['docker', 6, 2], ['neu', 1, 1]]);
  assert.deepStrictEqual(D.byKind(null), []);
});
test('jede Art und jeder Teil der Zählung hat einen Namen (ui/src/usage.jsx, Deutsch über locales/de.json)', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'ui', 'src', 'usage.jsx'), 'utf8');
  const block = (name) => src.slice(src.indexOf(`const ${name} = {`), src.indexOf('};', src.indexOf(`const ${name} = {`)));
  for (const kind of D.KINDS) assert.ok(new RegExp(`\\b${kind}: '`).test(block('KIND')), `KIND.${kind}`);
  for (const p of ['Server', 'Sicherungen', 'Daten', 'Projekt', 'Dokumente', 'Docker-Volume']) assert.ok(block('PART').includes(`${p.includes('-') ? `'${p}'` : p}: '`), `PART.${p}`);
});
