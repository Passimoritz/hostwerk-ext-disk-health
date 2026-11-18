import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Files, Search, Image as ImageIcon, Film, Music, ScrollText, Archive, Database, FileText, Code2, Cpu, File, FolderOpen, Download,
  Pencil, Copy, Trash2, RefreshCw, CopyCheck, ArrowDown, ArrowUp, X, ChevronRight, ChevronDown, Globe, Boxes, Folder, Settings2, Server,
  Layers, HardDrive, Lock, AppWindow, MonitorCog, House, FolderTree, List, MoreHorizontal, FileDown, Recycle, FolderSearch, UserRound, Clock, Gamepad2,
} from 'lucide-react';
import { get, post, apiUrl, useApi, fmtBytes, fmtDate, fmtNumber } from '@hostwerk/api';
import { Btn, Empty, Loading, Callout, InfoTip, Seg, Progress, toast, confirmDialog, promptDialog } from '@hostwerk/ui';
import * as Kit from '@hostwerk/kit';
import { t, pl as hostPl } from '@hostwerk/i18n';

/*
 * Laufwerke, Teil „Dateien“ (2.3, Abschnitt unter System → Speicher): jede Datei auf den Laufwerken des Rechners.
 * Links die Belegung (Laufwerke, Arten) und wem die Dateien gehören (Hostwerk, Programme, persönliche Ordner, System,
 * sonstige Ordner); rechts die Liste (Suche, Art, Größe, Alter), der Ordnerbaum und die Doppelten – mit Mehrfachauswahl,
 * Umbenennen, Herunterladen, „Im Explorer zeigen“, Löschen in den Papierkorb und CSV-Export.
 * Den Index baut der Server-Teil (server/files.js). Texte Englisch, Deutsch aus locales/de.json.
 */
const TYPE = {
  image: { label: 'Images', icon: ImageIcon },
  video: { label: 'Videos', icon: Film },
  audio: { label: 'Audio', icon: Music },
  log: { label: 'Logs', icon: ScrollText },
  archive: { label: 'Archives & disk images', icon: Archive },
  database: { label: 'Databases & data', icon: Database },
  document: { label: 'Documents', icon: FileText },
  code: { label: 'Code & settings', icon: Code2 },
  program: { label: 'Programs', icon: Cpu },
  game: { label: 'Game data', icon: Gamepad2 },
  other: { label: 'Other', icon: File },
};
const TYPE_IDS = Object.keys(TYPE);
/** Gruppen links (cat vom Server) in dieser Reihenfolge. */
const GROUP = {
  hostwerk: 'Hostwerk',
  apps: 'Programs & apps',
  personal: 'Personal folders',
  system: 'System',
  other: 'Other folders',
};
const CAT_ORDER = Object.keys(GROUP);
const CAT_ICON = { hostwerk: Server, apps: AppWindow, personal: UserRound, system: MonitorCog, other: Folder };
const KIND_ICON = { web: Globe, project: Layers, app: Boxes, own: Folder, backup: Archive, logs: ScrollText, config: Settings2, program: AppWindow, personal: Folder, system: MonitorCog, temp: Clock, recycle: Recycle, drive: HardDrive, folder: Folder, hostwerk: Server };
/** Vom Server geschickte Namen (i18n: true) – hier, damit die Übersetzung geprüft wird. */
const LABEL = {
  users: 'Users', store: 'Store apps', os: 'Operating system', temp: 'Temporary files', pf: 'Programs (other)', pd: 'Program data (other)',
  appdata: 'App data (other)', recycle: 'Windows recycle bin', extra: 'Windows setup & recovery', hw: 'Hostwerk – programs & runtimes',
  downloads: 'Downloads', documents: 'Documents', desktop: 'Desktop', pictures: 'Pictures', videos: 'Videos', music: 'Music', saved: 'Saved games',
  objects: '3D objects', contacts: 'Contacts', favourites: 'Favourites', links: 'Links', searches: 'Searches', other: 'Other',
};
/** Was der Server bei geschützten Dateien und Fehlern meldet (Englisch) – hier, damit die Übersetzung geprüft wird. */
const REASON = {
  system: 'Part of Windows – it cannot be deleted here.',
  program: 'Part of an installed program – uninstall the program instead.',
  hostwerk: 'Part of Hostwerk itself – manage it in Hostwerk.',
  missing: 'Not in the list of files',
  recycle: 'Could not be moved to the recycle bin',
  exists: 'A file with this name already exists',
  name: 'Invalid name',
  folder: 'Folder not in the list',
};
const KNOWN_TEXT = new Set([...Object.values(REASON), ...Object.values(LABEL)]);
const PRESET = { all: {}, big: { minSize: 100 * 1048576 }, old: { olderThan: 365 }, recent: { newerThan: 7 } };
const PAGE = 100;
const SHOW_PER_CAT = 6;
const keyOf = (x) => x.path;
// Namen der Hostwerk-Bereiche kommen deutsch aus Hostwerk („Sicherungen“, „App: …“) – Hostwerks eigene Übersetzung
const tr = (s) => (typeof Kit.tr === 'function' ? Kit.tr(s) : s);
// pl() seit SDK 2.10 – sonst dasselbe mit t()
const pl = (n, one, many, vars) => (typeof hostPl === 'function' ? hostPl(n, one, many, vars) : t(Number(n) === 1 ? one : many, { n, ...(vars || {}) }));
const gLabel = (g) => (!g ? '' : g.i18n ? t(g.label) : g.cat === 'hostwerk' ? tr(g.label) : g.label);
const fmtDay = (ms) => (ms ? new Date(ms).toLocaleDateString(undefined, { day: '2-digit', month: '2-digit', year: 'numeric' }) : '–');
/** Langer Ordnerpfad gekürzt: Anfang … Ende. */
function shortPath(p, max = 64) {
  if (!p || p.length <= max) return p || '';
  return `${p.slice(0, 14)}…${p.slice(p.length - (max - 15))}`;
}
const errText = (e) => { const m = String((e && e.message) || e || ''); return KNOWN_TEXT.has(m) ? t(m) : m; };

function copy(text) {
  navigator.clipboard.writeText(text).then(() => toast.success('Copied')).catch(() => toast.error('Could not copy'));
}

/* ---------------- Leiste links: Belegung ---------------- */

function DriveBar({ d }) {
  const used = d.used || 0;
  const pct = d.total ? Math.min(100, (used / d.total) * 100) : 0;
  const counted = d.total ? Math.min(pct, (d.counted / d.total) * 100) : 0;
  const hidden = Math.max(0, used - d.counted);
  return (
    <div className="dh-fl-drive">
      <div className="dh-fl-line">
        <HardDrive size={14} aria-hidden="true" className="muted" />
        <b className="grow">{d.label}</b>
        <span className="small muted dh-fl-num">{d.total ? t('{used} of {total}', { used: fmtBytes(used), total: fmtBytes(d.total) }) : fmtBytes(d.counted)}</span>
      </div>
      {d.total ? (
        <div className={`dh-fl-meter${pct > 90 ? ' full' : ''}`} role="img" aria-label={t('{pct} % used', { pct: Math.round(pct) })}>
          <span style={{ width: `${counted}%` }} />
          <span className="dh-fl-meter-hidden" style={{ width: `${pct - counted}%` }} title={t('{size} the system keeps to itself (not readable)', { size: fmtBytes(hidden) })} />
        </div>
      ) : null}
      <div className="tiny muted">{d.free != null ? t('{free} free', { free: fmtBytes(d.free) }) : ''}{hidden > 1073741824 ? ` · ${t('{size} not readable', { size: fmtBytes(hidden) })}` : ''}</div>
    </div>
  );
}

/** Aufteilung nach Art: gestapelter Balken und Liste – ein Klick filtert. */
function TypeBreakdown({ types, value, onPick }) {
  const list = TYPE_IDS.filter((k) => types[k] > 0).sort((a, b) => types[b] - types[a]);
  const total = list.reduce((a, k) => a + types[k], 0);
  if (!total) return null;
  return (
    <div className="dh-fl-types">
      <div className="dh-fl-stack" role="img" aria-label={t('Used space by kind of file')}>
        {list.map((k) => <span key={k} className={`dh-ft-${k}`} style={{ width: `${Math.max(0.8, (types[k] / total) * 100)}%` }} title={`${t(TYPE[k].label)}: ${fmtBytes(types[k])}`} />)}
      </div>
      <div className="dh-fl-legend">
        {list.map((k) => (
          <button type="button" key={k} className={`dh-fl-leg${value === k ? ' on' : ''}`} aria-pressed={value === k} onClick={() => onPick(value === k ? '' : k)}>
            <i className={`dh-ft-${k}`} aria-hidden="true" />
            <span className="grow ellipsis">{t(TYPE[k].label)}</span>
            <span className="dh-fl-num">{fmtBytes(types[k])}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function UsageCard({ sum, curG, type, onType, onRescan }) {
  const types = (curG ? curG.types : sum.totals.types) || {};
  return (
    <section className="card dh-fl-card dh-fl-usage" aria-label={t('Used space')}>
      <div className="dh-fl-total">
        <b>{fmtBytes(sum.totals.bytes)}</b>
        <span className="small muted">{pl(sum.totals.files, 'in {n} file', 'in {n} files', { n: fmtNumber(sum.totals.files) })}</span>
      </div>
      <div className="dh-fl-line small muted">
        <span className="grow">
          {sum.scanning ? t('Reading again …') : t('As of {when}', { when: fmtDate(sum.at) })}
          {' '}<InfoTip pop title={t('Which files?')}>{sum.mode === 'machine'
            ? t('Every file on the fixed drives of this computer, sorted by who it belongs to: Hostwerk’s folders, programs and apps (the same name in Program Files, ProgramData and AppData counts as one), your personal folders, the system and other folders. Docker volumes only count under Used space. Read again every six hours and whenever you press the button.')
            : t('Every file in Hostwerk’s folders – the same ones as under Files. Switch on “Whole drives” in the settings of this extension to see the whole computer.')}</InfoTip>
        </span>
        <button type="button" className="btn ghost xs icon" title={t('Read again')} aria-label={t('Read again')} disabled={sum.scanning} onClick={onRescan}><RefreshCw size={13} className={sum.scanning ? 'spin' : undefined} /></button>
      </div>
      {sum.drives && sum.drives.length > 0 && <div className="dh-fl-drives">{sum.drives.map((d) => <DriveBar key={d.path} d={d} />)}</div>}
      <div className="dh-fl-sub">
        <div className="tiny muted dh-fl-caption">{curG ? t('Kinds of files in {name}', { name: gLabel(curG) }) : t('Kinds of files')}</div>
        <TypeBreakdown types={types} value={type} onPick={onType} />
      </div>
      {sum.truncated && <div className="tiny c-warn">{t('Very many files: from {n} on, only files from 1 MB are listed one by one – the sizes still count everything.', { n: fmtNumber(sum.max) })}</div>}
    </section>
  );
}

/* ---------------- Leiste links: wem die Dateien gehören ---------------- */

function GroupRow({ g, on, max, onPick }) {
  const Icon = KIND_ICON[g.kind] || Server;
  return (
    <button type="button" className={`dh-fl-grow${on ? ' on' : ''}`} aria-current={on ? 'true' : undefined} onClick={() => onPick(on ? '' : g.id)} title={g.path || ''}>
      <Icon size={15} aria-hidden="true" className="dh-fl-gico" />
      <span className="dh-fl-gmain">
        <span className="dh-fl-line">
          <span className="grow ellipsis">{gLabel(g)}{g.sub ? <span className="muted"> · {g.sub}</span> : null}</span>
          {g.lock && <Lock size={11} className="muted" aria-label={t('Protected')} />}
          <span className="dh-fl-num">{fmtBytes(g.bytes)}</span>
        </span>
        <span className="dh-fl-gbar" aria-hidden="true"><span style={{ width: `${Math.max(1.5, (g.bytes / max) * 100)}%` }} /></span>
      </span>
    </button>
  );
}

function GroupNav({ groups, total, group, onPick }) {
  const [filter, setFilter] = useState('');
  const [open, setOpen] = useState(() => new Set());
  const [shut, setShut] = useState(() => new Set());
  const f = filter.trim().toLowerCase();
  const by = new Map();
  for (const g of groups) {
    if (f && !`${gLabel(g)} ${g.sub || ''} ${g.path || ''}`.toLowerCase().includes(f)) continue;
    const c = GROUP[g.cat] ? g.cat : 'other';
    if (!by.has(c)) by.set(c, []);
    by.get(c).push(g);
  }
  const max = Math.max(1, ...groups.map((g) => g.bytes));
  const toggle = (setter, c) => setter((s) => { const n = new Set(s); if (n.has(c)) n.delete(c); else n.add(c); return n; });
  return (
    <nav className="card dh-fl-card dh-fl-groups" aria-label={t('Who the files belong to')}>
      <button type="button" className={`dh-fl-grow dh-fl-all${!group ? ' on' : ''}`} aria-current={!group ? 'true' : undefined} onClick={() => onPick('')}>
        <Files size={15} aria-hidden="true" className="dh-fl-gico" />
        <span className="dh-fl-gmain"><span className="dh-fl-line"><b className="grow">{t('All files')}</b><span className="dh-fl-num">{fmtBytes(total)}</span></span></span>
      </button>
      {groups.length > 10 && (
        <label className="dh-fl-search dh-fl-gfilter">
          <Search size={14} aria-hidden="true" />
          <input className="input" type="search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t('Find a program or folder …')} aria-label={t('Find a program or folder')} />
        </label>
      )}
      {CAT_ORDER.filter((c) => by.has(c)).map((c) => {
        const list = by.get(c).sort((a, b) => b.bytes - a.bytes);
        const sum = list.reduce((a, g) => a + g.bytes, 0);
        const CI = CAT_ICON[c];
        const collapsed = shut.has(c) && !f;
        const long = list.length > SHOW_PER_CAT + 2;
        const all = open.has(c) || !!f || !long;
        const shown = all ? list : list.slice(0, SHOW_PER_CAT);
        // gewählte Gruppe immer sichtbar
        if (!all && group && !shown.some((g) => g.id === group)) { const sel = list.find((g) => g.id === group); if (sel) shown.push(sel); }
        return (
          <div key={c} className="dh-fl-cat">
            <button type="button" className="dh-fl-cathead" aria-expanded={!collapsed} onClick={() => toggle(setShut, c)}>
              {collapsed ? <ChevronRight size={13} aria-hidden="true" /> : <ChevronDown size={13} aria-hidden="true" />}
              <CI size={13} aria-hidden="true" />
              <span className="grow">{t(GROUP[c])}</span>
              <span className="dh-fl-num">{fmtBytes(sum)}</span>
            </button>
            {!collapsed && (
              <div className="dh-fl-catlist">
                {shown.map((g) => <GroupRow key={g.id} g={g} on={group === g.id} max={max} onPick={onPick} />)}
                {long && !f && (
                  <button type="button" className="dh-fl-moregroups small" onClick={() => toggle(setOpen, c)}>{open.has(c) ? t('Show fewer') : t('Show all {n}', { n: list.length })}</button>
                )}
              </div>
            )}
          </div>
        );
      })}
      {f && !by.size && <div className="small muted dh-fl-none">{t('Nothing found')}</div>}
    </nav>
  );
}

/* ---------------- Liste ---------------- */

function actionsFor(x, onAct) {
  return [
    { label: t('Show in Explorer'), icon: FolderSearch, onClick: () => onAct('reveal', x) },
    x.root ? { label: t('Show in Hostwerk’s Files'), icon: FolderOpen, onClick: () => onAct('open', x) } : null,
    { label: t('Only this folder'), icon: FolderTree, onClick: () => onAct('folder', x) },
    { label: t('Download'), icon: Download, onClick: () => onAct('download', x) },
    { label: t('Copy path'), icon: Copy, onClick: () => onAct('copy', x) },
    x.lock ? null : { label: t('Rename'), icon: Pencil, onClick: () => onAct('rename', x) },
    x.lock ? null : { label: x.root ? t('Move to Hostwerk’s bin') : t('Move to the recycle bin'), icon: Trash2, danger: true, onClick: () => onAct('delete', x) },
  ].filter(Boolean);
}

/** Eine Zeile der Liste (auch bei den Doppelten). */
function Row({ x, g, picked, onPick, onAct, showGroup = true }) {
  const T = TYPE[x.type] || TYPE.other;
  const menu = (e) => { e.preventDefault(); Kit.contextMenu(e, actionsFor(x, onAct)); };
  const why = x.lock ? t(REASON[x.lock]) : undefined;
  return (
    <tr className={picked ? 'dh-fl-picked' : undefined} onContextMenu={menu}>
      <td className="dh-fl-check">
        <input type="checkbox" className="bulk-check" checked={picked} disabled={!!x.lock} onChange={() => onPick(x)} aria-label={t('Select {name}', { name: x.name })} title={why} />
      </td>
      <td className="dh-fl-name">
        <span className="dh-fl-nameline">
          <T.icon size={15} className={`dh-fi-${x.type}`} aria-hidden="true" />
          <b className="ellipsis" title={x.name}>{x.name}</b>
          {x.lock && <span className="dh-fl-lock" title={why}><Lock size={11} aria-label={why} /></span>}
        </span>
        <span className="tiny muted ellipsis dh-fl-dir" title={x.dir}>{shortPath(x.dir)}</span>
      </td>
      {showGroup && <td className="dh-fl-app small"><span className="ellipsis" title={g ? g.path || '' : ''}>{g ? gLabel(g) : '–'}</span></td>}
      <td className="num dh-fl-size">{fmtBytes(x.size)}</td>
      <td className="small muted dh-fl-date" title={fmtDate(x.mtime)}>{fmtDay(x.mtime)}</td>
      <td className="dh-fl-acts">
        <button type="button" className="btn ghost xs icon" title={t('Show in Explorer')} aria-label={t('Show in Explorer')} onClick={() => onAct('reveal', x)}><FolderSearch size={14} /></button>
        <button type="button" className="btn ghost xs icon" title={why || t('Delete')} aria-label={t('Delete')} disabled={!!x.lock} onClick={() => onAct('delete', x)}><Trash2 size={14} /></button>
        <button type="button" className="btn ghost xs icon" title={t('More')} aria-label={t('More')} onClick={menu}><MoreHorizontal size={14} /></button>
      </td>
    </tr>
  );
}

/** Spaltenkopf zum Sortieren. */
function SortHead({ id, label, sort, onSort, className }) {
  const on = sort.by === id;
  const next = on ? (sort.order === 'asc' ? 'desc' : 'asc') : (id === 'name' || id === 'group' ? 'asc' : 'desc');
  return (
    <th scope="col" className={className} aria-sort={on ? (sort.order === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button type="button" className="dh-fl-sort" onClick={() => onSort({ by: id, order: next })}>
        {label}{on && (sort.order === 'asc' ? <ArrowUp size={12} aria-hidden="true" /> : <ArrowDown size={12} aria-hidden="true" />)}
      </button>
    </th>
  );
}

function FileTable({ res, byId, picked, onPick, onPickAll, allOnPage, onAct, sort, onSort, more, onMore, showGroup }) {
  return (
    <div className="card dh-fl-listcard">
      <div className="dh-fl-listhead small">
        <span className="grow">{pl(res.total, '{n} file · {size}', '{n} files · {size}', { n: fmtNumber(res.total), size: fmtBytes(res.bytes) })}</span>
      </div>
      {res.items.length ? (
        <div className="table-wrap">
          <table className="table dh-fl-table">
            <thead>
              <tr>
                <th scope="col" className="dh-fl-check"><input type="checkbox" className="bulk-check" checked={allOnPage} onChange={onPickAll} aria-label={t('Select all shown files')} /></th>
                <SortHead id="name" label={t('Name')} sort={sort} onSort={onSort} />
                {showGroup && <SortHead id="group" label={t('Belongs to')} sort={sort} onSort={onSort} className="dh-fl-app" />}
                <SortHead id="size" label={t('Size')} sort={sort} onSort={onSort} className="num dh-fl-size" />
                <SortHead id="mtime" label={t('Changed')} sort={sort} onSort={onSort} className="dh-fl-date" />
                <th scope="col" className="dh-fl-acts"><span className="sr-only">{t('Actions')}</span></th>
              </tr>
            </thead>
            <tbody>
              {res.items.map((x) => <Row key={keyOf(x)} x={x} g={byId.get(x.group)} picked={picked.has(keyOf(x))} onPick={onPick} onAct={onAct} showGroup={showGroup} />)}
            </tbody>
          </table>
        </div>
      ) : <div className="dh-fl-pad"><Empty icon={Files} title="No files match" text="Change the search or the filters." /></div>}
      {res.items.length < res.total && (
        <div className="dh-fl-more">
          <Btn className="ghost sm" busy={more} onClick={onMore}>{t('Show more ({n} left)', { n: fmtNumber(res.total - res.items.length) })}</Btn>
        </div>
      )}
    </div>
  );
}

/* ---------------- Ordnerbaum ---------------- */

function FolderView({ group, curG, dir, setDir, onList, onRevealDir, rev }) {
  const qs = new URLSearchParams();
  if (dir) qs.set('dir', dir); else if (group) qs.set('group', group);
  const d = useApi(`/disk-health/files/tree?${qs.toString()}`, [dir, group, rev], { live: false });
  const x = d.data;
  if (d.error && !x) return <Callout kind="err" dismissible={false}>{errText(d.error)}</Callout>;
  if (!x) return <Loading />;
  const max = Math.max(1, ...x.kids.map((k) => k.bytes));
  const rootName = curG ? gLabel(curG) : t('This computer');
  return (
    <div className="card dh-fl-listcard">
      <div className="dh-fl-crumbs">
        <nav className="dh-fl-crumbpath" aria-label={t('Folder path')}>
          <button type="button" className={`dh-fl-crumb${!dir ? ' on' : ''}`} onClick={() => setDir(null)}>{curG ? <FolderTree size={13} aria-hidden="true" /> : <House size={13} aria-hidden="true" />}{rootName}</button>
          {(x.crumbs || []).map((c, i) => (
            <span key={c.path} className="dh-fl-crumbwrap">
              <ChevronRight size={12} aria-hidden="true" className="muted" />
              <button type="button" className={`dh-fl-crumb${i === x.crumbs.length - 1 ? ' on' : ''}`} onClick={() => setDir(c.path)}>{c.name}</button>
            </span>
          ))}
        </nav>
        <span className="small muted dh-fl-num">{fmtBytes(x.bytes)} · {pl(x.files, '{n} file', '{n} files', { n: fmtNumber(x.files) })}</span>
        {dir && <button type="button" className="btn ghost xs icon" title={t('Show in Explorer')} aria-label={t('Show in Explorer')} onClick={() => onRevealDir(dir)}><FolderSearch size={14} /></button>}
        {dir && <Btn className="ghost xs" icon={List} onClick={() => onList(dir)}>List files</Btn>}
      </div>
      {x.kids.length || (x.own && x.own.files) ? (
        <ul className="dh-fl-tree">
          {x.kids.map((k) => (
            <li key={k.path}>
              <button type="button" className="dh-fl-node" onClick={() => (k.kids ? setDir(k.path) : onList(k.path))} title={k.path}>
                <Folder size={15} aria-hidden="true" className="dh-fl-nico" />
                <span className="dh-fl-nmain">
                  <span className="dh-fl-line"><span className="grow ellipsis">{k.name}</span><span className="tiny muted">{pl(k.files, '{n} file', '{n} files', { n: fmtNumber(k.files) })}</span><span className="dh-fl-num dh-fl-nsize">{fmtBytes(k.bytes)}</span></span>
                  {!dir && k.path !== k.name && <span className="tiny muted ellipsis">{shortPath(k.path, 80)}</span>}
                  <span className="dh-fl-gbar" aria-hidden="true"><span style={{ width: `${Math.max(0.8, (k.bytes / max) * 100)}%` }} /></span>
                </span>
                {k.kids ? <ChevronRight size={14} aria-hidden="true" className="muted" /> : <span className="dh-fl-nsp" />}
              </button>
            </li>
          ))}
          {x.own && x.own.files > 0 && (
            <li>
              <button type="button" className="dh-fl-node dh-fl-own" onClick={() => onList(dir)}>
                <Files size={15} aria-hidden="true" className="dh-fl-nico" />
                <span className="dh-fl-nmain"><span className="dh-fl-line"><span className="grow ellipsis muted">{t('Files directly in this folder')}</span><span className="tiny muted">{pl(x.own.files, '{n} file', '{n} files', { n: fmtNumber(x.own.files) })}</span><span className="dh-fl-num dh-fl-nsize">{fmtBytes(x.own.bytes)}</span></span></span>
                <span className="dh-fl-nsp" />
              </button>
            </li>
          )}
          {x.more > 0 && <li className="small muted dh-fl-none">{t('… and {n} smaller folders', { n: fmtNumber(x.more) })}</li>}
        </ul>
      ) : <div className="dh-fl-pad"><Empty icon={Folder} title="Empty folder" text="There are no files in here." /></div>}
    </div>
  );
}

/* ---------------- Doppelte ---------------- */

function Duplicates({ byId, group, curG, picked, onPick, onAct, setPicked, rev }) {
  const d = useApi('/disk-health/files/duplicates', [], { live: false });
  const x = d.data;
  // Nach Löschen/Umbenennen (rev zählt hoch): die Gruppen frisch vom Server
  useEffect(() => { if (rev) d.reload({ silent: true }); }, [rev]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!(x && x.running)) return undefined;
    const tm = setTimeout(() => d.reload({ silent: true }), 2000);
    return () => clearTimeout(tm);
  }, [x]); // eslint-disable-line react-hooks/exhaustive-deps
  const start = async () => { try { d.setData(await post('/disk-health/files/duplicates', group ? { group } : {})); } catch (e) { toast.error(errText(e)); } };
  if (!x) return <Loading />;
  const keepNewest = () => {
    const m = new Map();
    for (const g of x.groups) { const newest = [...g.files].sort((a, b) => b.mtime - a.mtime)[0]; for (const f of g.files) if (f !== newest && !f.lock) m.set(keyOf(f), f); }
    setPicked(m);
  };
  const scope = x.group ? gLabel(byId.get(x.group)) || x.group : null;
  return (
    <div className="dh-fl-stackcol">
      <div className="card dh-fl-dupbar">
        <CopyCheck size={18} aria-hidden="true" className="dh-fl-dupico" />
        <div className="grow">
          <b>
            {x.running ? t('Comparing files … {n} checked', { n: fmtNumber(x.checked || 0) })
              : x.at ? (x.groups.length ? pl(x.groups.length, '{n} group of identical files – {size} could be freed', '{n} groups of identical files – {size} could be freed', { size: fmtBytes(x.waste) }) : t('No identical files found'))
                : t('Find identical files')}
          </b>
          <div className="small muted">
            {x.at ? t('Checked {when} · files from 1 MB, compared by their content', { when: fmtDate(x.at) }) : t('Compares files from 1 MB by their content – this can take a while on big drives. Windows’ own files are left out.')}
            {scope ? ` · ${t('only in {name}', { name: scope })}` : ''}
            {x.stale ? ` · ${t('the list of files changed since')}` : ''}
          </div>
        </div>
        <div className="dh-fl-dupacts">
          {!x.running && x.groups.length ? <Btn className="sm" icon={CopyCheck} onClick={keepNewest} title={t('Select every copy except the newest one of each group')}>Select copies</Btn> : null}
          <Btn className={x.at ? 'sm' : 'sm primary'} icon={RefreshCw} busy={x.running} onClick={start} title={curG ? t('Searches only in {name}', { name: gLabel(curG) }) : undefined}>{x.at ? t('Search again') : t('Search')}</Btn>
        </div>
      </div>
      {x.error && <Callout kind="err" dismissible={false}>{errText(x.error)}</Callout>}
      {x.groups.map((g) => (
        <div className="card dh-fl-listcard" key={`${g.size}:${keyOf(g.files[0])}`}>
          <div className="dh-fl-listhead"><Copy size={14} aria-hidden="true" /><b className="grow">{t('{n} × {size}', { n: g.files.length, size: fmtBytes(g.size) })}</b><span className="small muted">{t('{size} could be freed', { size: fmtBytes(g.size * (g.files.length - 1)) })}</span></div>
          <div className="table-wrap">
            <table className="table dh-fl-table"><tbody>
              {g.files.map((f) => <Row key={keyOf(f)} x={f} g={byId.get(f.group)} picked={picked.has(keyOf(f))} onPick={onPick} onAct={onAct} />)}
            </tbody></table>
          </div>
        </div>
      ))}
    </div>
  );
}

/* ---------------- Einlesen ---------------- */

function ScanProgress({ p, first }) {
  const pct = p && p.of ? Math.min(99, (p.bytes / p.of) * 100) : null;
  return (
    <div className="card dh-fl-scan" role="status">
      <div className="dh-fl-line">
        <RefreshCw size={16} className="spin" aria-hidden="true" />
        <b className="grow">{first ? t('Hostwerk is reading the files for the first time …') : t('Reading the files again …')}</b>
        {pct != null && <span className="small muted dh-fl-num">{pct < 1 ? '< 1 %' : `${Math.round(pct)} %`}</span>}
      </div>
      <Progress value={pct || 0} indeterminate={pct == null} />
      <div className="small muted">
        {t('{n} files · {size} so far', { n: fmtNumber((p && p.counted) || (p && p.files) || 0), size: fmtBytes((p && p.bytes) || 0) })}
        {first ? ` · ${t('a whole drive takes a few minutes – you can leave this page.')}` : ''}
      </div>
      {p && p.dir && <div className="tiny muted ellipsis" title={p.dir}>{shortPath(p.dir, 90)}</div>}
    </div>
  );
}

/* ---------------- Teil „Dateien“ ---------------- */

/** Teil „Dateien“ – eigener Abschnitt unter System → Speicher. */
export function FilesPanel() {
  const s = useApi('/disk-health/files', [], { live: false });
  const sum = s.data;
  const [group, setGroup] = useState('');
  const [dir, setDir] = useState(null); // Liste: nur dieser Ordner (samt Unterordnern)
  const [tdir, setTdir] = useState(null); // Ordnerbaum: offener Ordner
  const [view, setView] = useState('list');
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
  const searchRef = useRef(null);

  // Während Hostwerk einliest: alle paar Sekunden nachsehen
  useEffect(() => {
    if (!(sum && sum.scanning)) return undefined;
    const tm = setTimeout(() => s.reload({ silent: true }), 2500);
    return () => clearTimeout(tm);
  }, [sum]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const tm = setTimeout(() => setQd(q.trim()), 250); return () => clearTimeout(tm); }, [q]);
  // Esc hebt die Auswahl auf, „/“ springt in die Suche
  useEffect(() => {
    const onKey = (e) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target && e.target.tagName) || '') || (e.target && e.target.isContentEditable);
      if (e.key === 'Escape' && !typing) setPicked(new Map());
      if (e.key === '/' && !typing) { e.preventDefault(); setView('list'); setTimeout(() => searchRef.current && searchRef.current.focus(), 0); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const query = useMemo(() => {
    const p = new URLSearchParams({ sort: sort.by, order: sort.order, limit: String(PAGE) });
    if (group) p.set('group', group);
    if (dir) p.set('dir', dir);
    if (type) p.set('type', type);
    if (qd) p.set('q', qd);
    for (const [k, v] of Object.entries(PRESET[preset] || {})) p.set(k, String(v));
    return p.toString();
  }, [group, dir, type, qd, sort, preset]);
  const load = async (append = false) => {
    if (append) setMore(true);
    try {
      const r = await get(`/disk-health/files/list?${query}&offset=${append && res ? res.items.length : 0}`);
      setRes((prev) => (append && prev ? { ...r, items: [...prev.items, ...r.items] } : r));
    } catch (e) { toast.error(errText(e)); }
    setMore(false);
  };
  useEffect(() => { if (view === 'list' && sum && sum.at) load(false); }, [query, view, sum && sum.at]); // eslint-disable-line react-hooks/exhaustive-deps

  const groups = (sum && sum.groups) || [];
  const byId = useMemo(() => new Map(groups.map((g) => [g.id, g])), [groups]);
  const pick = (x) => { if (x.lock) return; setPicked((m) => { const n = new Map(m); if (n.has(keyOf(x))) n.delete(keyOf(x)); else n.set(keyOf(x), x); return n; }); };
  const pickable = res ? res.items.filter((x) => !x.lock) : [];
  const allOnPage = !!(pickable.length && pickable.every((x) => picked.has(keyOf(x))));
  const pickAll = () => setPicked((m) => { const n = new Map(m); for (const x of pickable) { if (allOnPage) n.delete(keyOf(x)); else n.set(keyOf(x), x); } return n; });

  /** Nach Löschen/Umbenennen: Liste und Summen frisch. */
  const after = () => { s.reload({ silent: true }); setRev((n) => n + 1); if (view === 'list') load(false); };
  const remove = async (list0) => {
    const list = list0.filter((x) => !x.lock);
    if (!list.length) return;
    const size = list.reduce((a, x) => a + x.size, 0);
    const inHw = list.filter((x) => x.root).length;
    const appData = list.some((x) => { const g = byId.get(x.group); return g && g.cat === 'apps'; });
    const where = inHw === list.length
      ? t('Hostwerk keeps them in its bin for 30 days – you can restore them under Files → Bin.')
      : inHw ? t('Files in Hostwerk’s folders go to Hostwerk’s bin (Files → Bin), all others to the Windows recycle bin.')
        : t('They go to the Windows recycle bin – you can restore them from there.');
    const ok = await confirmDialog({
      title: list.length === 1 ? t('Delete “{name}”?', { name: list[0].name }) : t('Delete {n} files?', { n: fmtNumber(list.length) }),
      text: `${t('{size} in total.', { size: fmtBytes(size) })} ${where}${appData ? ` ${t('Some of them belong to a program – it may need them or create them again.')}` : ''}`,
      confirm: t('Delete'), danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      const r = await post('/disk-health/files/delete', { items: list.map((x) => ({ path: x.path })) });
      if (r.done) toast.success(pl(r.done, '{n} file deleted', '{n} files deleted', { n: fmtNumber(r.done) }));
      if (r.failed && r.failed.length) toast.error(`${t('{n} could not be deleted', { n: r.failed.length })}: ${errText(r.failed[0].error)}`);
      const failed = new Set((r.failed || []).map((f) => f.path));
      setPicked((m) => { const n = new Map(m); for (const x of list) if (!failed.has(keyOf(x))) n.delete(keyOf(x)); return n; });
      after();
    } catch (e) { toast.error(errText(e)); }
    setBusy(false);
  };
  const reveal = async (p, isDir) => { try { await post('/disk-health/files/reveal', { path: p, dir: !!isDir }); } catch (e) { toast.error(errText(e)); } };
  const listIn = (p) => { setDir(p); setView('list'); };
  const act = async (what, x) => {
    if (what === 'reveal') return reveal(x.path, false);
    if (what === 'open') { location.hash = `/files?root=${encodeURIComponent(x.root)}&path=${encodeURIComponent(x.rel.includes('/') ? x.rel.slice(0, x.rel.lastIndexOf('/')) : '')}`; return undefined; }
    if (what === 'folder') { listIn(x.dir); return undefined; }
    if (what === 'download') { location.href = apiUrl(`/api/disk-health/files/download?path=${encodeURIComponent(x.path)}`); return undefined; }
    if (what === 'copy') { copy(x.path); return undefined; }
    if (what === 'delete') return remove([x]);
    if (what === 'rename') {
      const name = await promptDialog({
        title: t('Rename'), label: t('New name'), value: x.name, confirm: t('Rename'),
        validate: (v) => (!String(v || '').trim() ? t('Enter a name') : /[\\/:*?"<>|]/.test(v) ? t('Use a name without special characters such as / or :') : null),
      });
      if (!name || name === x.name) return undefined;
      try { await post('/disk-health/files/rename', { path: x.path, name }); toast.success('Renamed'); after(); } catch (e) { toast.error(errText(e)); }
    }
    return undefined;
  };
  const rescan = async () => { try { s.setData(await post('/disk-health/files/rescan')); } catch (e) { toast.error(errText(e)); } };
  const exportCsv = () => { location.href = apiUrl(`/api/disk-health/files/export?${query}`); };
  const pickGroup = (id) => { setGroup(id); setDir(null); setTdir(null); };

  if (s.error && !sum) return <Callout kind="err" dismissible={false} title={t('The files could not be loaded')}>{errText(s.error)} <Btn className="sm" icon={RefreshCw} onClick={() => s.reload()}>Try again</Btn></Callout>;
  if (!sum) return <Loading />;
  if (!sum.at) {
    return sum.scanning
      ? <ScanProgress p={sum.progress} first />
      : <div className="card dh-fl-pad"><Empty icon={Files} title="No list of files yet" text="Hostwerk reads every file on the drives once – sorted by program, service and folder. On a full drive this takes a few minutes." action={<Btn className="primary" icon={RefreshCw} onClick={rescan}>Read the files</Btn>} /></div>;
  }
  const curG = group ? byId.get(group) : null;
  const pickedList = [...picked.values()];
  const pickedBytes = pickedList.reduce((a, x) => a + x.size, 0);
  const filtered = !!(type || qd || dir || preset !== 'all');
  const GIcon = curG ? KIND_ICON[curG.kind] || Server : null;
  const presetLabel = { big: t('Over 100 MB'), old: t('Untouched for a year'), recent: t('Changed in the last 7 days') };
  return (
    <div className="dh-fl-wrap">
    <div className="dh-fl">
      <aside className="dh-fl-side">
        <UsageCard sum={sum} curG={curG} type={type} onType={(k) => { setType(k); if (view !== 'list') setView('list'); }} onRescan={rescan} />
        <GroupNav groups={groups} total={sum.totals.bytes} group={group} onPick={pickGroup} />
      </aside>

      <div className="dh-fl-main">
        {sum.scanning && <ScanProgress p={sum.progress} />}

        {curG && (
          <div className="card dh-fl-scope">
            <span className="dh-fl-scopeico"><GIcon size={18} aria-hidden="true" /></span>
            <div className="grow dh-fl-scopemain">
              <b className="ellipsis">{gLabel(curG)}{curG.sub ? <span className="muted"> · {curG.sub}</span> : null}</b>
              <span className="small muted">
                {fmtBytes(curG.bytes)} · {pl(curG.files, '{n} file', '{n} files', { n: fmtNumber(curG.files) })}
                {curG.places > 1 ? ` · ${t('in {n} places', { n: curG.places })}` : curG.path ? ` · ${shortPath(curG.path, 70)}` : ''}
              </span>
              {curG.lock && <span className="tiny muted dh-fl-line"><Lock size={10} aria-hidden="true" />{t(REASON[curG.lock])}</span>}
            </div>
            <button type="button" className="btn ghost xs icon" title={t('Show all files')} aria-label={t('Show all files')} onClick={() => pickGroup('')}><X size={14} /></button>
          </div>
        )}

        <div className="dh-fl-toolbar">
          <Seg value={view} onChange={setView} options={[
            { id: 'list', label: t('Files'), icon: List },
            { id: 'tree', label: t('Folders'), icon: FolderTree },
            { id: 'dups', label: t('Duplicates'), icon: CopyCheck },
          ]} />
          {view === 'list' && (
            <div className="dh-fl-filters">
              <label className="dh-fl-search">
                <Search size={15} aria-hidden="true" />
                <input ref={searchRef} className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Search name or folder …')} aria-label={t('Search files')} title={t('Shortcut: /')} />
              </label>
              <select className="select dh-fl-select" value={type} onChange={(e) => setType(e.target.value)} aria-label={t('Kind of file')}>
                <option value="">{t('All kinds')}</option>
                {TYPE_IDS.map((k) => <option key={k} value={k}>{t(TYPE[k].label)}</option>)}
              </select>
              <select className="select dh-fl-select" value={preset} onChange={(e) => setPreset(e.target.value)} aria-label={t('Size and age')}>
                <option value="all">{t('Any size and age')}</option>
                <option value="big">{t('Over 100 MB')}</option>
                <option value="old">{t('Untouched for a year')}</option>
                <option value="recent">{t('Changed in the last 7 days')}</option>
              </select>
              <button type="button" className="btn ghost sm icon" title={t('Export the list (CSV)')} aria-label={t('Export the list (CSV)')} onClick={exportCsv}><FileDown size={15} /></button>
            </div>
          )}
        </div>

        {view === 'list' && filtered && (
          <div className="dh-fl-chips">
            {dir && <button type="button" className="chip" onClick={() => setDir(null)} title={dir}><FolderTree size={12} aria-hidden="true" />{shortPath(dir, 48)}<X size={12} aria-label={t('Remove filter')} /></button>}
            {type && <button type="button" className="chip" onClick={() => setType('')}>{t(TYPE[type].label)}<X size={12} aria-label={t('Remove filter')} /></button>}
            {preset !== 'all' && <button type="button" className="chip" onClick={() => setPreset('all')}>{presetLabel[preset]}<X size={12} aria-label={t('Remove filter')} /></button>}
            {qd && <button type="button" className="chip" onClick={() => setQ('')}>{`“${qd}”`}<X size={12} aria-label={t('Remove filter')} /></button>}
            <button type="button" className="chip chip-clear" onClick={() => { setDir(null); setType(''); setPreset('all'); setQ(''); }}>{t('Clear all')}</button>
          </div>
        )}

        {pickedList.length > 0 && (
          <div className="bulk-bar dh-fl-bulk" role="region" aria-label={t('Selection')}>
            <b>{t('{n} selected · {size}', { n: fmtNumber(pickedList.length), size: fmtBytes(pickedBytes) })}</b>
            <div className="row-tight bulk-acts">
              <Btn className="sm danger" icon={Trash2} busy={busy} onClick={() => remove(pickedList)}>Delete</Btn>
              <Btn className="sm ghost" icon={Copy} onClick={() => copy(pickedList.map((x) => x.path).join('\n'))}>Copy paths</Btn>
            </div>
            <button type="button" className="btn ghost xs icon" aria-label={t('Clear the selection')} title={t('Clear the selection (Esc)')} onClick={() => setPicked(new Map())}><X size={13} /></button>
          </div>
        )}

        {view === 'dups' ? (
          <Duplicates byId={byId} group={group} curG={curG} picked={picked} onPick={pick} onAct={act} setPicked={setPicked} rev={rev} />
        ) : view === 'tree' ? (
          <FolderView group={group} curG={curG} dir={tdir} setDir={setTdir} onList={listIn} onRevealDir={(p) => reveal(p, true)} rev={rev} />
        ) : !res ? <Loading /> : (
          <FileTable res={res} byId={byId} picked={picked} onPick={pick} onPickAll={pickAll} allOnPage={allOnPage} onAct={act} sort={sort} onSort={setSort} more={more} onMore={() => load(true)} showGroup={!curG} />
        )}
      </div>
    </div>
    </div>
  );
}
