import { useEffect, useMemo, useState } from 'react';
import {
  Files, Search, Image as ImageIcon, Film, Music, ScrollText, Archive, Database, FileText, Code2, Cpu, File, FolderOpen, Download,
  Pencil, Copy, Trash2, RefreshCw, CopyCheck, ArrowDown, ArrowUp, X, ChevronRight, Globe, Boxes, Folder, Settings2, Server, Layers,
} from 'lucide-react';
import { get, post, apiUrl, useApi, fmtBytes, fmtDate, fmtNumber } from '@hostwerk/api';
import { Btn, Empty, Loading, Callout, InfoTip, Seg, toast, confirmDialog, promptDialog } from '@hostwerk/ui';
import * as Kit from '@hostwerk/kit';
import { t, pl as hostPl } from '@hostwerk/i18n';

/*
 * Laufwerke, Teil „Dateien“ (2.2, Abschnitt unter System → Speicher): jede Datei in Hostwerks Bereichen, nach Dienst
 * sortiert (links), durchsuchbar und filterbar nach Art, Größe und Alter (rechts), mit Mehrfachauswahl, Umbenennen,
 * Herunterladen, „In Dateien zeigen“, Löschen in den Papierkorb und einer Suche nach doppelten Dateien.
 * Den Index baut der Server-Teil (server/files.js). Texte Englisch, Deutsch aus locales/de.json.
 */
const TYPE = {
  image: { label: 'Images', icon: ImageIcon },
  video: { label: 'Videos', icon: Film },
  audio: { label: 'Audio', icon: Music },
  log: { label: 'Logs', icon: ScrollText },
  archive: { label: 'Archives & backups', icon: Archive },
  database: { label: 'Databases & worlds', icon: Database },
  document: { label: 'Documents', icon: FileText },
  code: { label: 'Code & settings', icon: Code2 },
  program: { label: 'Programs', icon: Cpu },
  other: { label: 'Other', icon: File },
};
const TYPE_IDS = Object.keys(TYPE);
/** Gruppen links: welche Bereichs-Arten wohin (Arten aus Erweiterungen, z. B. minecraft, landen unter „Services“). */
const GROUP = {
  web: 'Web & projects', project: 'Web & projects', app: 'Web & projects',
  own: 'Own folders',
  backup: 'Hostwerk', logs: 'Hostwerk', config: 'Hostwerk',
};
const GROUP_ORDER = ['Web & projects', 'Services', 'Own folders', 'Hostwerk'];
const KIND_ICON = { web: Globe, project: Layers, app: Boxes, own: Folder, backup: Archive, logs: ScrollText, config: Settings2 };
const PRESET = { all: {}, big: { minSize: 100 * 1048576 }, old: { olderThan: 365 } };
const PAGE = 100;
const keyOf = (x) => `${x.root}\n${x.path}`;
// Namen der Bereiche kommen deutsch aus Hostwerk („Sicherungen“, „App: …“) – Hostwerks eigene Übersetzung
const tr = (s) => (typeof Kit.tr === 'function' ? Kit.tr(s) : s);
// pl() seit SDK 2.10 – sonst dasselbe mit t()
const pl = (n, one, many, vars) => (typeof hostPl === 'function' ? hostPl(n, one, many, vars) : t(Number(n) === 1 ? one : many, { n, ...(vars || {}) }));
const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

function copy(text) {
  navigator.clipboard.writeText(text).then(() => toast.success('Copied')).catch(() => toast.error('Could not copy'));
}

/** Aufteilung nach Art als gestapelter Balken – ein Klick filtert. */
function TypeBar({ types, total, value, onPick }) {
  const list = TYPE_IDS.filter((k) => types[k] > 0).sort((a, b) => types[b] - types[a]);
  if (!total || !list.length) return null;
  return (
    <div className="dh-fl-types">
      <div className="dh-fl-stack" role="img" aria-label={t('Used space by kind of file')}>
        {list.map((k) => <span key={k} className={`dh-ft-${k}`} style={{ width: `${Math.max(0.6, (types[k] / total) * 100)}%` }} title={`${t(TYPE[k].label)}: ${fmtBytes(types[k])}`} />)}
      </div>
      <div className="dh-fl-legend">
        {list.map((k) => (
          <button type="button" key={k} className={`dh-fl-leg${value === k ? ' on' : ''}`} aria-pressed={value === k} onClick={() => onPick(value === k ? '' : k)}>
            <i className={`dh-ft-${k}`} aria-hidden="true" />{t(TYPE[k].label)} <span className="muted">{fmtBytes(types[k])}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** Linke Spalte: Bereiche nach Dienst, mit Balken; der gewählte zeigt seine größten Ordner. */
function RootList({ groups, total, root, folder, onRoot, onFolder }) {
  const by = new Map();
  for (const g of groups) {
    if (!g.files) continue;
    const name = GROUP[g.kind] || 'Services';
    if (!by.has(name)) by.set(name, []);
    by.get(name).push(g);
  }
  const max = Math.max(1, ...groups.map((g) => g.bytes));
  return (
    <nav className="card dh-fl-roots" aria-label={t('Services and folders')}>
      <button type="button" className={`dh-fl-root${!root ? ' on' : ''}`} aria-current={!root ? 'true' : undefined} onClick={() => onRoot('')}>
        <Files size={15} aria-hidden="true" /><span className="grow ellipsis"><b>All files</b></span><span className="small muted">{fmtBytes(total)}</span>
      </button>
      {GROUP_ORDER.filter((n) => by.has(n)).map((name) => (
        <div key={name} className="dh-fl-rgroup">
          <div className="dh-fl-rhead tiny muted">{t(name)}</div>
          {by.get(name).sort((a, b) => b.bytes - a.bytes).map((g) => {
            const Icon = KIND_ICON[g.kind] || Server;
            const on = root === g.id;
            return (
              <div key={g.id}>
                <button type="button" className={`dh-fl-root${on ? ' on' : ''}`} aria-current={on ? 'true' : undefined} onClick={() => onRoot(on ? '' : g.id)} title={g.path}>
                  <Icon size={15} aria-hidden="true" />
                  <span className="grow dh-fl-rmain">
                    <span className="row-tight"><span className="grow ellipsis">{tr(g.label)}</span><span className="small">{fmtBytes(g.bytes)}</span></span>
                    <span className="dh-fl-rbar" aria-hidden="true"><span style={{ width: `${Math.max(2, (g.bytes / max) * 100)}%` }} /></span>
                    <span className="tiny muted">{pl(g.files, '{n} file', '{n} files', { n: fmtNumber(g.files) })}</span>
                  </span>
                </button>
                {on && g.folders && g.folders.length > 1 && (
                  <div className="dh-fl-folders">
                    {g.folders.map((f) => (
                      <button type="button" key={f.name || '.'} className={`dh-fl-folder${folder === f.name ? ' on' : ''}`} aria-pressed={folder === f.name} onClick={() => onFolder(folder === f.name ? null : f.name)}>
                        <ChevronRight size={12} aria-hidden="true" /><span className="grow ellipsis">{f.name || t('(directly in here)')}</span><span className="tiny muted">{fmtBytes(f.bytes)}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

/** Eine Zeile der Liste (auch bei den Doppelten). */
function Row({ x, g, picked, onPick, onAct }) {
  const T = TYPE[x.type] || TYPE.other;
  const menu = (e) => Kit.contextMenu(e, [
    { label: t('Show in Files'), icon: FolderOpen, onClick: () => onAct('open', x) },
    { label: t('Download'), icon: Download, onClick: () => onAct('download', x) },
    { label: t('Rename'), icon: Pencil, onClick: () => onAct('rename', x) },
    { label: t('Copy path'), icon: Copy, onClick: () => onAct('copy', x) },
    { label: t('Move to the bin'), icon: Trash2, danger: true, onClick: () => onAct('delete', x) },
  ]);
  return (
    <tr className={picked ? 'dh-fl-picked' : undefined} onContextMenu={menu}>
      <td className="dh-fl-check"><input type="checkbox" className="bulk-check" checked={picked} onChange={() => onPick(x)} aria-label={t('Select {name}', { name: x.name })} /></td>
      <td className="dh-fl-name">
        <span className="row-tight"><T.icon size={14} className={`dh-fi-${x.type}`} aria-hidden="true" /><b className="ellipsis" title={x.name}>{x.name}</b></span>
        <span className="tiny muted ellipsis" title={x.path}>{dirOf(x.path) || '/'}</span>
      </td>
      <td className="dh-fl-app small ellipsis" title={g ? g.path : ''}>{g ? tr(g.label) : x.root}</td>
      <td className="num small">{fmtBytes(x.size)}</td>
      <td className="small muted dh-fl-date">{fmtDate(x.mtime)}</td>
      <td className="dh-fl-acts">
        <button type="button" className="btn ghost xs icon" title={t('Show in Files')} aria-label={t('Show in Files')} onClick={() => onAct('open', x)}><FolderOpen size={14} /></button>
        <button type="button" className="btn ghost xs icon" title={t('Rename')} aria-label={t('Rename')} onClick={() => onAct('rename', x)}><Pencil size={14} /></button>
        <button type="button" className="btn ghost xs icon" title={t('Download')} aria-label={t('Download')} onClick={() => onAct('download', x)}><Download size={14} /></button>
        <button type="button" className="btn ghost xs icon" title={t('Move to the bin')} aria-label={t('Move to the bin')} onClick={() => onAct('delete', x)}><Trash2 size={14} /></button>
      </td>
    </tr>
  );
}

/** Spaltenkopf zum Sortieren. */
function SortHead({ id, label, sort, onSort, className }) {
  const on = sort.by === id;
  const next = on ? (sort.order === 'asc' ? 'desc' : 'asc') : (id === 'name' || id === 'root' ? 'asc' : 'desc');
  return (
    <th scope="col" className={className} aria-sort={on ? (sort.order === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button type="button" className="dh-fl-sort" onClick={() => onSort({ by: id, order: next })}>
        {label}{on && (sort.order === 'asc' ? <ArrowUp size={12} aria-hidden="true" /> : <ArrowDown size={12} aria-hidden="true" />)}
      </button>
    </th>
  );
}

/** Doppelte Dateien: gleiche Größe und gleicher Inhalt (Prüfsumme). */
function Duplicates({ byId, picked, onPick, onAct, setPicked, rev }) {
  const d = useApi('/disk-health/files/duplicates', [], { live: false });
  const x = d.data;
  // Nach Löschen/Umbenennen (rev zählt hoch): die Gruppen frisch vom Server
  useEffect(() => { if (rev) d.reload({ silent: true }); }, [rev]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!(x && x.running)) return undefined;
    const tm = setTimeout(() => d.reload({ silent: true }), 2000);
    return () => clearTimeout(tm);
  }, [x]); // eslint-disable-line react-hooks/exhaustive-deps
  const start = async () => { try { d.setData(await post('/disk-health/files/duplicates', {})); } catch (e) { toast.error(e); } };
  if (!x) return <Loading />;
  const keepNewest = () => {
    const m = new Map();
    for (const g of x.groups) { const newest = [...g.files].sort((a, b) => b.mtime - a.mtime)[0]; for (const f of g.files) if (f !== newest) m.set(keyOf(f), f); }
    setPicked(m);
  };
  return (
    <div className="dh-fl-dups">
      <div className="card card-pad row dh-fl-dupbar">
        <CopyCheck size={18} aria-hidden="true" />
        <div className="grow">
          <b>
            {x.running ? t('Comparing files … {n} checked', { n: fmtNumber(x.checked || 0) })
              : x.at ? (x.groups.length ? pl(x.groups.length, '{n} group of identical files – {size} could be freed', '{n} groups of identical files – {size} could be freed', { size: fmtBytes(x.waste) }) : t('No identical files found'))
                : t('Find identical files')}
          </b>
          <div className="small muted">
            {x.at ? t('Checked {when} · files from 1 MB, compared by their content', { when: fmtDate(x.at) }) : t('Compares files from 1 MB by their content – this can take a while on big drives.')}
            {x.stale ? ` · ${t('the list of files changed since')}` : ''}
          </div>
        </div>
        {!x.running && x.groups.length ? <Btn className="sm" icon={CopyCheck} onClick={keepNewest} title={t('Select every copy except the newest one of each group')}>Select copies</Btn> : null}
        <Btn className={x.at ? 'sm' : 'sm primary'} icon={RefreshCw} busy={x.running} onClick={start}>{x.at ? t('Search again') : t('Search')}</Btn>
      </div>
      {x.error && <Callout kind="err" dismissible={false}>{x.error}</Callout>}
      {x.groups.map((g) => (
        <div className="card dh-fl-dupgroup" key={`${g.size}:${keyOf(g.files[0])}`}>
          <div className="card-head"><Copy size={14} aria-hidden="true" /><b className="grow">{t('{n} × {size}', { n: g.files.length, size: fmtBytes(g.size) })}</b><span className="small muted">{t('{size} could be freed', { size: fmtBytes(g.size * (g.files.length - 1)) })}</span></div>
          <div className="table-wrap">
            <table className="table dh-fl-table"><tbody>
              {g.files.map((f) => <Row key={keyOf(f)} x={f} g={byId.get(f.root)} picked={picked.has(keyOf(f))} onPick={onPick} onAct={onAct} />)}
            </tbody></table>
          </div>
        </div>
      ))}
    </div>
  );
}

/** Teil „Dateien“ – eigener Abschnitt unter System → Speicher. */
export function FilesPanel() {
  const s = useApi('/disk-health/files', [], { live: false });
  const sum = s.data;
  const [root, setRoot] = useState('');
  const [folder, setFolder] = useState(null);
  const [type, setType] = useState('');
  const [preset, setPreset] = useState('all');
  const [q, setQ] = useState('');
  const [qd, setQd] = useState('');
  const [sort, setSort] = useState({ by: 'size', order: 'desc' });
  const [res, setRes] = useState(null);
  const [more, setMore] = useState(false);
  const [picked, setPicked] = useState(() => new Map());
  const [busy, setBusy] = useState(false);
  const [rev, setRev] = useState(0);

  // Während Hostwerk einliest: alle paar Sekunden nachsehen
  useEffect(() => {
    if (!(sum && sum.scanning)) return undefined;
    const tm = setTimeout(() => s.reload({ silent: true }), 2500);
    return () => clearTimeout(tm);
  }, [sum]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const tm = setTimeout(() => setQd(q.trim()), 250); return () => clearTimeout(tm); }, [q]);

  const query = useMemo(() => {
    const p = new URLSearchParams({ sort: sort.by, order: sort.order, limit: String(PAGE) });
    if (root) p.set('root', root);
    if (root && folder !== null) p.set('folder', folder);
    if (type) p.set('type', type);
    if (qd) p.set('q', qd);
    for (const [k, v] of Object.entries(PRESET[preset] || {})) p.set(k, String(v));
    return p.toString();
  }, [root, folder, type, qd, sort, preset]);
  const load = async (append = false) => {
    if (append) setMore(true);
    try {
      const r = await get(`/disk-health/files/list?${query}&offset=${append && res ? res.items.length : 0}`);
      setRes((prev) => (append && prev ? { ...r, items: [...prev.items, ...r.items] } : r));
    } catch (e) { toast.error(e); }
    setMore(false);
  };
  useEffect(() => { if (preset !== 'dups' && sum && sum.at) load(false); }, [query, sum && sum.at]); // eslint-disable-line react-hooks/exhaustive-deps

  const groups = (sum && sum.groups) || [];
  const byId = useMemo(() => new Map(groups.map((g) => [g.id, g])), [groups]);
  const fullPath = (x) => {
    const g = byId.get(x.root);
    if (!g) return x.path;
    const sep = g.path.includes('\\') ? '\\' : '/';
    return `${g.path.replace(/[\\/]+$/, '')}${sep}${x.path.split('/').join(sep)}`;
  };
  const pick = (x) => setPicked((m) => { const n = new Map(m); if (n.has(keyOf(x))) n.delete(keyOf(x)); else n.set(keyOf(x), x); return n; });
  const allOnPage = !!(res && res.items.length && res.items.every((x) => picked.has(keyOf(x))));
  const pickAll = () => setPicked((m) => { const n = new Map(m); for (const x of (res ? res.items : [])) { if (allOnPage) n.delete(keyOf(x)); else n.set(keyOf(x), x); } return n; });

  /** Nach Löschen/Umbenennen: Liste und Summen frisch. */
  const after = () => { s.reload({ silent: true }); setRev((n) => n + 1); if (preset !== 'dups') load(false); };
  const remove = async (list) => {
    const size = list.reduce((a, x) => a + x.size, 0);
    const ok = await confirmDialog({
      title: list.length === 1 ? t('Move “{name}” to the bin?', { name: list[0].name }) : t('Move {n} files to the bin?', { n: fmtNumber(list.length) }),
      text: t('{size} in total. Hostwerk keeps them in its bin for 30 days – you can restore them under Files → Bin. A service that still needs a file may stop working.', { size: fmtBytes(size) }),
      confirm: t('Move to the bin'), danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      const r = await post('/disk-health/files/delete', { items: list.map((x) => ({ root: x.root, path: x.path })) });
      if (r.done) toast.success(t('{n} moved to the bin', { n: r.done }));
      if (r.failed && r.failed.length) toast.error(`${t('{n} could not be moved', { n: r.failed.length })}: ${r.failed[0].error}`);
      const failed = new Set((r.failed || []).map(keyOf));
      setPicked((m) => { const n = new Map(m); for (const x of list) if (!failed.has(keyOf(x))) n.delete(keyOf(x)); return n; });
      after();
    } catch (e) { toast.error(e); }
    setBusy(false);
  };
  const act = async (what, x) => {
    if (what === 'open') { location.hash = `/files?root=${encodeURIComponent(x.root)}&path=${encodeURIComponent(dirOf(x.path))}`; return; }
    if (what === 'download') { location.href = apiUrl(`/api/files/download?root=${encodeURIComponent(x.root)}&path=${encodeURIComponent(x.path)}`); return; }
    if (what === 'copy') { copy(fullPath(x)); return; }
    if (what === 'delete') { remove([x]); return; }
    if (what === 'rename') {
      const name = await promptDialog({
        title: t('Rename'), label: t('New name'), value: x.name, confirm: t('Rename'),
        validate: (v) => (!String(v || '').trim() ? t('Enter a name') : /[\\/:*?"<>|]/.test(v) ? t('Use a name without special characters such as / or :') : null),
      });
      if (!name || name === x.name) return;
      try { await post('/disk-health/files/rename', { root: x.root, path: x.path, name }); toast.success('Renamed'); after(); } catch (e) { toast.error(e); }
    }
  };
  const rescan = async () => { try { s.setData(await post('/disk-health/files/rescan')); } catch (e) { toast.error(e); } };

  if (s.error && !sum) return <Callout kind="err" dismissible={false} title={t('The files could not be loaded')}>{String(s.error)} <Btn className="sm" icon={RefreshCw} onClick={() => s.reload()}>Try again</Btn></Callout>;
  if (!sum) return <Loading />;
  if (!sum.at) {
    return sum.scanning
      ? <Loading text={t('Hostwerk is reading the files – {n} so far …', { n: fmtNumber(sum.progress.files || 0) })} />
      : <Empty icon={Files} title="No list of files yet" text="Hostwerk reads every file in its folders once – web folders, projects, apps, services, backups and logs." action={<Btn className="primary" icon={RefreshCw} onClick={rescan}>Read the files</Btn>} />;
  }
  const curG = root ? byId.get(root) : null;
  const pickedList = [...picked.values()];
  const pickedBytes = pickedList.reduce((a, x) => a + x.size, 0);
  const typeTotal = curG ? curG.bytes : sum.totals.bytes;
  const types = (curG ? curG.types : sum.totals.types) || {};
  const filtered = !!(root || type || qd || folder !== null);
  return (
    <div className="dh-fl">
      <div className="card card-pad dh-fl-head">
        <div className="row">
          <div className="grow">
            <div className="dh-fl-total"><b>{fmtBytes(sum.totals.bytes)}</b> <span className="muted">{pl(sum.totals.files, 'in {n} file', 'in {n} files', { n: fmtNumber(sum.totals.files) })}</span></div>
            <div className="small muted">
              {sum.scanning ? t('Reading again … {n} files', { n: fmtNumber(sum.progress.files || 0) }) : t('As of {when}', { when: fmtDate(sum.at) })}
              {' '}<InfoTip pop title={t('Which files?')}>Every file in Hostwerk’s folders – the same ones as under Files: web folders, projects, apps, services from extensions, your own folders, backups, logs and settings. Docker volumes only count under Used space. The list is read again every six hours and whenever you press the button.</InfoTip>
            </div>
          </div>
          <Btn className="ghost sm" icon={RefreshCw} busy={sum.scanning} onClick={rescan}>Read again</Btn>
        </div>
        {sum.truncated && <div className="small c-warn">{t('Only the first {n} files are listed.', { n: fmtNumber(sum.max) })}</div>}
        <TypeBar types={types} total={typeTotal} value={type} onPick={(k) => { setType(k); if (preset === 'dups') setPreset('all'); }} />
      </div>

      <div className="dh-fl-grid">
        <RootList groups={groups} total={sum.totals.bytes} root={root} folder={folder} onRoot={(id) => { setRoot(id); setFolder(null); if (preset === 'dups') setPreset('all'); }} onFolder={setFolder} />

        <div className="dh-fl-main">
          <div className="dh-fl-tools">
            <label className="dh-fl-search">
              <Search size={15} aria-hidden="true" />
              <input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Search name or folder …')} aria-label={t('Search files')} />
            </label>
            <select className="select dh-fl-type" value={type} onChange={(e) => setType(e.target.value)} aria-label={t('Kind of file')}>
              <option value="">{t('All kinds')}</option>
              {TYPE_IDS.map((k) => <option key={k} value={k}>{t(TYPE[k].label)}</option>)}
            </select>
            <Seg value={preset} onChange={setPreset} options={[
              { id: 'all', label: t('All') },
              { id: 'big', label: t('Over 100 MB') },
              { id: 'old', label: t('Untouched for a year') },
              { id: 'dups', label: t('Duplicates') },
            ]} />
          </div>

          {filtered && preset !== 'dups' && (
            <div className="dh-fl-chips">
              {curG && <button type="button" className="chip" onClick={() => { setRoot(''); setFolder(null); }}>{tr(curG.label)}<X size={12} aria-label={t('Remove filter')} /></button>}
              {folder !== null && <button type="button" className="chip" onClick={() => setFolder(null)}>{folder || t('(directly in here)')}<X size={12} aria-label={t('Remove filter')} /></button>}
              {type && <button type="button" className="chip" onClick={() => setType('')}>{t(TYPE[type].label)}<X size={12} aria-label={t('Remove filter')} /></button>}
              {qd && <button type="button" className="chip" onClick={() => setQ('')}>{`“${qd}”`}<X size={12} aria-label={t('Remove filter')} /></button>}
            </div>
          )}

          {pickedList.length > 0 && (
            <div className="bulk-bar dh-fl-bulk" role="region" aria-label={t('Selection')}>
              <b>{t('{n} selected · {size}', { n: pickedList.length, size: fmtBytes(pickedBytes) })}</b>
              <div className="row-tight bulk-acts">
                <Btn className="sm danger" icon={Trash2} busy={busy} onClick={() => remove(pickedList)}>Move to the bin</Btn>
                <Btn className="sm ghost" icon={Copy} onClick={() => copy(pickedList.map(fullPath).join('\n'))}>Copy paths</Btn>
              </div>
              <button type="button" className="btn ghost xs icon" aria-label={t('Clear the selection')} onClick={() => setPicked(new Map())}><X size={13} /></button>
            </div>
          )}

          {preset === 'dups' ? (
            <Duplicates byId={byId} picked={picked} onPick={pick} onAct={act} setPicked={setPicked} rev={rev} />
          ) : !res ? <Loading /> : (
            <div className="card">
              <div className="card-head small"><span className="grow">{pl(res.total, '{n} file · {size}', '{n} files · {size}', { n: fmtNumber(res.total), size: fmtBytes(res.bytes) })}</span></div>
              {res.items.length ? (
                <div className="table-wrap">
                  <table className="table dh-fl-table">
                    <thead>
                      <tr>
                        <th scope="col" className="dh-fl-check"><input type="checkbox" className="bulk-check" checked={allOnPage} onChange={pickAll} aria-label={t('Select all shown files')} /></th>
                        <SortHead id="name" label={t('Name')} sort={sort} onSort={setSort} />
                        <SortHead id="root" label={t('Service')} sort={sort} onSort={setSort} className="dh-fl-app" />
                        <SortHead id="size" label={t('Size')} sort={sort} onSort={setSort} className="num" />
                        <SortHead id="mtime" label={t('Changed')} sort={sort} onSort={setSort} className="dh-fl-date" />
                        <th scope="col" className="dh-fl-acts"><span className="sr-only">{t('Actions')}</span></th>
                      </tr>
                    </thead>
                    <tbody>
                      {res.items.map((x) => <Row key={keyOf(x)} x={x} g={byId.get(x.root)} picked={picked.has(keyOf(x))} onPick={pick} onAct={act} />)}
                    </tbody>
                  </table>
                </div>
              ) : <Empty icon={Files} title="No files match" text="Change the search or the filters." />}
              {res.items.length < res.total && (
                <div className="card-pad dh-fl-more">
                  <Btn className="ghost" busy={more} onClick={() => load(true)}>{t('Show more ({n} left)', { n: fmtNumber(res.total - res.items.length) })}</Btn>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
