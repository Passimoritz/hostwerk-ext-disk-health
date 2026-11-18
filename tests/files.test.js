'use strict';
// Laufwerke, Teil „Dateien“ (server/files.js): nur Hostwerks Bereiche oder die ganze Maschine (nachgebautes Laufwerk),
// Zuordnung zu Anwendungen, keine doppelte Zählung, Papierkorb ausgelassen, Filter/Sortierung, Ordnerbaum, Schutz,
// Löschen (Hostwerks Papierkorb bzw. Windows-Papierkorb) und Umbenennen, Doppelte nach Inhalt, CSV.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createFiles, typeOf, classify, pkgName, topK } = require('../server/files');

function writer(base) {
  return (rel, content, mtime) => {
    const f = path.join(base, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, content);
    if (mtime) fs.utimesSync(f, mtime / 1000, mtime / 1000);
  };
}
function resolver(roots) {
  return (root, rel) => {
    const r = roots.find((x) => x.id === root);
    if (!r) throw new Error('Unbekannter Bereich');
    const full = path.resolve(r.path, rel);
    if (!full.startsWith(path.resolve(r.path) + path.sep)) throw new Error('Pfad außerhalb des Bereichs');
    return { full };
  };
}

/** Nur Hostwerks Bereiche (wie 2.2). */
function hostwerkOnly() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-dh-files-'));
  const w = writer(base);
  const big = Buffer.alloc(200000, 7);
  w('htdocs/index.html', '<h1>hi</h1>');
  w('htdocs/img/logo.png', Buffer.alloc(5000, 1));
  w('htdocs/img/copy-of-logo.png', Buffer.alloc(5000, 1));
  w('projekte/shop/package.json', '{}');
  w('projekte/app1/data.db', Buffer.alloc(3000, 2)); // gehört zum Bereich app:app1 (liegt im Projekte-Ordner)
  w('backups/db/main/2024.zip', big, Date.now() - 400 * 86400000);
  w('backups/db/main/2025.zip', big);
  w('backups/papierkorb/x/item', 'weg');
  const roots = [
    { id: 'htdocs', label: 'Webordner', kind: 'web', path: path.join(base, 'htdocs') },
    { id: 'projekte', label: 'Projekte', kind: 'project', path: path.join(base, 'projekte') },
    { id: 'app:app1', label: 'App: app1', kind: 'app', path: path.join(base, 'projekte', 'app1') },
    { id: 'backups', label: 'Sicherungen', kind: 'backup', path: path.join(base, 'backups') },
    { id: 'docker', label: 'Docker', kind: 'x', path: base, docker: true },
    { id: 'gone', label: 'Fehlt', kind: 'own', path: path.join(base, 'fehlt') },
  ];
  const resolve = resolver(roots);
  const trashed = [];
  const files = createFiles({
    roots: () => roots,
    resolve,
    toTrash: (root, rel) => { const { full } = resolve(root, rel); if (!fs.existsSync(full)) throw new Error('missing'); fs.rmSync(full); trashed.push(`${root}:${rel}`); return 'id'; },
    skip: [path.join(base, 'backups', 'papierkorb')],
  });
  return { base, files, trashed, P: (rel) => path.join(base, ...rel.split('/')) };
}

/** Ganze Maschine: ein Temp-Ordner als „Laufwerk“ mit Windows-typischen Ordnern; Hostwerk liegt im Benutzerordner. */
function machine() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-dh-machine-'));
  const w = writer(base);
  w('Windows/System32/kernel32.dll', Buffer.alloc(9000, 3));
  w('pagefile.sys', Buffer.alloc(4000, 4));
  w('Program Files/Google/Chrome/chrome.exe', Buffer.alloc(8000, 5));
  w('Program Files/7-Zip/7z.exe', Buffer.alloc(1000, 6));
  w('Users/bob/AppData/Local/Google/Chrome/User Data/cache.bin', Buffer.alloc(2000, 7));
  w('Users/bob/AppData/Roaming/Spotify/data.dat', Buffer.alloc(1500, 8));
  w('Users/bob/AppData/Local/Temp/setup.tmp', Buffer.alloc(700, 9));
  w('Users/bob/AppData/Local/Packages/Microsoft.WindowsTerminal_8wekyb3d8bbwe/settings.json', '{}');
  w('Users/bob/Downloads/movie.mp4', Buffer.alloc(30000, 10));
  w('Users/bob/Downloads/movie-copy.mp4', Buffer.alloc(30000, 10));
  w('Users/bob/Hostwerk/runtimes/php/php.exe', Buffer.alloc(600, 11));
  w('Users/bob/Hostwerk/htdocs/index.php', '<?php');
  w('Users/bob/Hostwerk/papierkorb/1/item', 'weg');
  w('Games/save.dat', Buffer.alloc(50, 12));
  const hw = path.join(base, 'Users', 'bob', 'Hostwerk');
  const roots = [{ id: 'htdocs', label: 'Webordner', kind: 'web', path: path.join(hw, 'htdocs') }];
  const resolve = resolver(roots);
  const trashed = []; const recycled = [];
  const files = createFiles({
    roots: () => roots,
    drives: async () => [base],
    hostwerkBase: hw,
    resolve,
    toTrash: (root, rel) => { const { full } = resolve(root, rel); fs.rmSync(full); trashed.push(`${root}:${rel}`); return 'id'; },
    recycle: async (list) => list.map((p) => { fs.rmSync(p); recycled.push(p); return { path: p }; }),
    skip: [path.join(hw, 'papierkorb')],
  });
  return { base, files, trashed, recycled, P: (rel) => path.join(base, ...rel.split('/')) };
}

test('Art aus der Endung, Paketnamen, Haufen-Auswahl', () => {
  assert.strictEqual(typeOf('a.PNG'), 'image');
  assert.strictEqual(typeOf('latest.log'), 'log');
  assert.strictEqual(typeOf('server.log.gz'), 'log');
  assert.strictEqual(typeOf('world.zip'), 'archive');
  assert.strictEqual(typeOf('ext4.vhdx'), 'archive');
  assert.strictEqual(typeOf('r.0.0.mca'), 'database');
  assert.strictEqual(typeOf('server.jar'), 'program');
  assert.strictEqual(typeOf('README'), 'other');
  assert.strictEqual(pkgName('Microsoft.WindowsTerminal_8wekyb3d8bbwe'), 'Windows Terminal');
  assert.strictEqual(pkgName('5319275A.WhatsAppDesktop_cv1g1gvanyjgm'), 'WhatsApp Desktop');
  const many = Array.from({ length: 50000 }, (_, i) => (i * 7919) % 50000);
  assert.deepStrictEqual(topK(many.slice(), 5, (a, b) => b - a), [49999, 49998, 49997, 49996, 49995]);
});

test('Zuordnung: Programme, Hersteller, AppData, persönliche Ordner, System', () => {
  const c = (p) => classify(p.split('/'), 'C:\\', true);
  assert.strictEqual(c('Windows').key, 'sys:windows');
  assert.strictEqual(c('Windows').lock, 'system');
  assert.strictEqual(c('Program Files/Google').final, false);
  assert.strictEqual(c('Program Files/Google/Chrome').key, 'app:googlechrome');
  assert.strictEqual(c('Program Files/Google/Chrome').lock, 'program');
  assert.strictEqual(c('Users/bob/AppData/Local/Google/Chrome').key, 'app:googlechrome', 'gleiche Anwendung an zwei Orten');
  assert.strictEqual(c('Users/bob/AppData/Local/Google/Chrome').lock, null, 'App-Daten dürfen weg');
  assert.strictEqual(c('Users/bob/AppData/Local/Programs/Hostwerk').key, 'app:hostwerk');
  assert.strictEqual(c('Users/bob/AppData/Local/Temp').key, 'sys:temp');
  assert.strictEqual(c('Users/bob/Downloads').key, 'personal:bob:downloads');
  assert.strictEqual(c('Users/bob/.vscode').key, 'app:vscode');
  assert.strictEqual(c('$Recycle.Bin').key, 'sys:recycle');
  assert.strictEqual(c('Games').label, 'C:\\Games');
  assert.strictEqual(classify(['home', 'ann', '.cache', 'pip'], '/', false).key, 'app:pip');
  assert.strictEqual(classify(['usr'], '/', false).lock, 'system');
});

test('Nur Hostwerk: je Bereich, verschachtelte Bereiche nicht doppelt, Docker, fehlende Ordner und Papierkorb ausgelassen', async () => {
  const { files } = hostwerkOnly();
  assert.strictEqual(files.summary().at, null);
  await files.scan();
  const s = files.summary();
  assert.strictEqual(s.mode, 'hostwerk');
  assert.deepStrictEqual(s.groups.map((g) => g.id).sort(), ['hw:app:app1', 'hw:backups', 'hw:htdocs', 'hw:projekte']);
  const by = Object.fromEntries(s.groups.map((g) => [g.id, g]));
  assert.strictEqual(by['hw:htdocs'].files, 3);
  assert.strictEqual(by['hw:projekte'].files, 1, 'app1 zählt bei der App, nicht im Projekte-Ordner');
  assert.strictEqual(by['hw:app:app1'].files, 1);
  assert.strictEqual(by['hw:backups'].bytes, 400000, 'Papierkorb nie gezählt');
  assert.strictEqual(by['hw:htdocs'].cat, 'hostwerk');
  assert.strictEqual(s.totals.files, 7);
  assert.strictEqual(s.totals.types.archive, 400000);
});

test('Liste: Filter nach Gruppe, Ordner, Art, Suche, Größe, Alter – sortiert und in Seiten, CSV', async () => {
  const { files, P } = hostwerkOnly();
  await files.scan();
  let r = files.list({});
  assert.strictEqual(r.total, 7);
  assert.strictEqual(r.items[0].size, 200000, 'größte zuerst');
  assert.strictEqual(r.items[0].root, 'backups');
  assert.strictEqual(r.items[0].rel.split('/')[0], 'db');
  r = files.list({ root: 'htdocs', dir: P('htdocs/img') });
  assert.deepStrictEqual(r.items.map((x) => x.name).sort(), ['copy-of-logo.png', 'logo.png']);
  assert.strictEqual(files.list({ group: 'hw:htdocs' }).total, 3);
  assert.strictEqual(files.list({ type: 'image' }).total, 2);
  assert.strictEqual(files.list({ q: 'MAIN db' }).total, 2, 'Wörter in beliebiger Reihenfolge, ohne Groß/klein');
  assert.strictEqual(files.list({ minSize: 100000 }).total, 2);
  assert.deepStrictEqual(files.list({ olderThan: 365 }).items.map((x) => x.name), ['2024.zip']);
  assert.strictEqual(files.list({ newerThan: 30 }).total, 6);
  r = files.list({ sort: 'name', order: 'asc', limit: 2, offset: 1 });
  assert.strictEqual(r.items.length, 2);
  assert.strictEqual(r.total, 7);
  assert.strictEqual(files.list({ root: 'htdocs,backups' }).total, 5);
  assert.strictEqual(files.list({ group: 'gibts-nicht' }).total, 0);
  const csv = files.csv({ type: 'archive' });
  assert.ok(csv.startsWith('\ufeffpath;name;size'));
  assert.strictEqual(csv.trim().split('\r\n').length, 3);
});

test('Ganze Maschine: Gruppen nach Anwendung, Hostwerk-Bereiche darin, Ordnerbaum, Laufwerk', async () => {
  const { files, P, base } = machine();
  await files.scan();
  const s = files.summary();
  assert.strictEqual(s.mode, 'machine');
  const by = Object.fromEntries(s.groups.map((g) => [g.id, g]));
  assert.strictEqual(by['app:googlechrome'].files, 2, 'Program Files und AppData zusammen');
  assert.strictEqual(by['app:googlechrome'].places, 2);
  assert.strictEqual(by['app:7zip'].files, 1);
  assert.strictEqual(by['app:spotify'].files, 1);
  assert.strictEqual(by['app:windowsterminal'].files, 1);
  assert.strictEqual(by['sys:windows'].files, 1);
  assert.strictEqual(by['sys:temp'].files, 1);
  assert.strictEqual(by['personal:bob:downloads'].files, 2);
  assert.strictEqual(by['hw:htdocs'].files, 1, 'Hostwerks Webordner als eigene Gruppe');
  assert.strictEqual(by['hw:base'].files, 1, 'Laufzeiten gehören zu Hostwerk – Papierkorb nicht gezählt');
  assert.ok(Object.values(by).some((g) => g.id.startsWith('top:') && g.label.endsWith(`${path.sep}Games`)));
  assert.strictEqual(s.totals.files, 13);
  assert.strictEqual(s.drives.length, 1);
  assert.strictEqual(s.drives[0].files, 13);
  // Ordnerbaum
  assert.strictEqual(files.tree({}).kids.length, 1);
  const t = files.tree({ dir: P('Users/bob') });
  assert.strictEqual(t.kids[0].name, 'Downloads', 'größter Unterordner zuerst');
  assert.strictEqual(t.crumbs[0].path, path.resolve(base));
  assert.strictEqual(files.tree({ group: 'app:googlechrome' }).kids.length, 2);
  assert.strictEqual(files.list({ dir: P('Users/bob/AppData') }).total, 4);
  // Schutz sichtbar
  assert.strictEqual(files.list({ q: 'kernel32' }).items[0].lock, 'system');
  assert.strictEqual(files.list({ q: 'pagefile' }).items[0].lock, 'system');
  assert.strictEqual(files.list({ q: 'chrome.exe' }).items[0].lock, 'program');
  assert.strictEqual(files.list({ q: 'movie.mp4' }).items[0].lock, undefined);
});

test('Ganze Maschine: Löschen – Hostwerks Bereiche in Hostwerks Papierkorb, sonst Windows-Papierkorb, Geschütztes nie', async () => {
  const { files, P, trashed, recycled } = machine();
  await files.scan();
  const before = files.summary().totals.bytes;
  const r = await files.remove([
    { path: P('Users/bob/Downloads/movie.mp4') },
    { path: P('Users/bob/Hostwerk/htdocs/index.php') },
    { path: P('Windows/System32/kernel32.dll') },
    { path: P('Program Files/7-Zip/7z.exe') },
    { path: P('pagefile.sys') },
    { path: P('Users/bob/Hostwerk/runtimes/php/php.exe') },
    { path: P('nicht/da.txt') },
    { bad: 1 },
  ]);
  assert.strictEqual(r.done, 2);
  assert.strictEqual(r.recycled, 1);
  assert.strictEqual(r.failed.length, 5);
  assert.deepStrictEqual(trashed, ['htdocs:index.php']);
  assert.deepStrictEqual(recycled, [P('Users/bob/Downloads/movie.mp4')]);
  assert.ok(fs.existsSync(P('Windows/System32/kernel32.dll')));
  assert.ok(fs.existsSync(P('Program Files/7-Zip/7z.exe')));
  const after = files.summary();
  assert.strictEqual(after.totals.files, 11);
  assert.strictEqual(after.totals.bytes, before - 30000 - 5);
  assert.strictEqual(after.drives[0].files, 11);
  assert.strictEqual(files.tree({ dir: P('Users/bob/Downloads') }).bytes, 30000);
  assert.throws(() => files.rename({ path: P('Windows/System32/kernel32.dll'), name: 'x.dll' }), /Windows/);
});

test('Umbenennen im selben Ordner; ungültige Namen, belegte Ziele und Unbekanntes abgelehnt', async () => {
  const { base, files, P } = hostwerkOnly();
  await files.scan();
  const r = files.rename({ path: P('htdocs/img/logo.png'), name: 'brand.png' });
  assert.strictEqual(r.path, P('htdocs/img/brand.png'));
  assert.ok(fs.existsSync(path.join(base, 'htdocs', 'img', 'brand.png')));
  assert.strictEqual(files.list({ q: 'brand' }).total, 1);
  assert.throws(() => files.rename({ path: P('htdocs/index.html'), name: '../x.html' }), /Invalid name/);
  assert.throws(() => files.rename({ path: P('htdocs/img/brand.png'), name: 'copy-of-logo.png' }), /already exists/);
  assert.throws(() => files.rename({ path: path.join(os.tmpdir(), 'irgendwas.txt'), name: 'y.txt' }), /Not in the list/);
  assert.throws(() => files.known(path.join(os.tmpdir(), 'irgendwas.txt')), /Not in the list/);
  assert.strictEqual(files.known(P('htdocs/index.html')), P('htdocs/index.html'));
});

test('Doppelte: gleicher Inhalt ab der Mindestgröße, gleiche Größe mit anderem Inhalt nicht', async () => {
  const { base, files, P } = hostwerkOnly();
  fs.writeFileSync(path.join(base, 'htdocs', 'same-size.bin'), Buffer.alloc(5000, 9));
  await files.scan();
  await files.findDuplicates({ minSize: 1000 });
  for (let i = 0; i < 200 && files.duplicates().running; i++) await new Promise((r) => setTimeout(r, 20));
  const d = files.duplicates();
  assert.strictEqual(d.running, false);
  const sets = d.groups.map((g) => g.files.map((f) => f.name).sort().join('|')).sort();
  assert.deepStrictEqual(sets, ['2024.zip|2025.zip', 'copy-of-logo.png|logo.png']);
  assert.strictEqual(d.waste, 205000);
  await files.remove([{ path: P('htdocs/img/copy-of-logo.png') }]);
  assert.strictEqual(files.duplicates().groups.length, 1, 'Gruppe mit nur noch einer Datei fällt weg');
});

test('Doppelte auf der Maschine: Windows-Dateien ausgenommen', async () => {
  const { files } = machine();
  await files.scan();
  await files.findDuplicates({ minSize: 100 });
  for (let i = 0; i < 200 && files.duplicates().running; i++) await new Promise((r) => setTimeout(r, 20));
  const d = files.duplicates();
  assert.deepStrictEqual(d.groups.map((g) => g.files.map((f) => f.name).sort().join('|')), ['movie-copy.mp4|movie.mp4']);
});

test('Obergrenze: Einzelliste endet, Summen zählen weiter', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-dh-cap-'));
  const w = writer(base);
  for (let i = 0; i < 6; i++) w(`d/f${i}.txt`, 'x'.repeat(10));
  const roots = [{ id: 'own:a', label: 'A', kind: 'own', path: base }];
  const files = createFiles({ roots: () => roots, resolve: resolver(roots), toTrash: () => 'id', max: 4 });
  await files.scan();
  const s = files.summary();
  assert.strictEqual(s.truncated, true);
  assert.strictEqual(s.totals.files, 6);
  assert.strictEqual(s.totals.bytes, 60);
  assert.strictEqual(files.list({}).total, 4);
});
