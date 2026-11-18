import { useMemo, useState } from 'react';
import { Trash2, RotateCcw, Search, RefreshCw, Folder, File, X, ArrowDown, ArrowUp, Info } from 'lucide-react';
import { post, useApi, fmtBytes, fmtDate, fmtNumber } from '@hostwerk/api';
import { Btn, Empty, Loading, Callout, toast, confirmDialog } from '@hostwerk/ui';
import { t, pl as hostPl } from '@hostwerk/i18n';

/*
 * Laufwerke, Teil „Papierkorb“ (2.4, Abschnitt unter System → Speicher): was im Windows-Papierkorb liegt – mit Größe,
 * altem Ort und Löschzeit; zurücklegen, endgültig löschen, leeren. Den Inhalt liest der Server-Teil (server/bin.js).
 */
const pl = (n, one, many, vars) => (typeof hostPl === 'function' ? hostPl(n, one, many, vars) : t(Number(n) === 1 ? one : many, { n, ...(vars || {}) }));
const AGE = { all: 0, week: 7, month: 30, older: -30 };

function SortHead({ id, label, sort, onSort, className }) {
  const on = sort.by === id;
  const next = on ? (sort.order === 'asc' ? 'desc' : 'asc') : (id === 'name' || id === 'from' ? 'asc' : 'desc');
  return (
    <th scope="col" className={className} aria-sort={on ? (sort.order === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button type="button" className="dh-fl-sort" onClick={() => onSort({ by: id, order: next })}>
        {label}{on && (sort.order === 'asc' ? <ArrowUp size={12} aria-hidden="true" /> : <ArrowDown size={12} aria-hidden="true" />)}
      </button>
    </th>
  );
}

export function BinPanel() {
  const d = useApi('/disk-health/bin', [], { live: false });
  const [q, setQ] = useState('');
  const [age, setAge] = useState('all');
  const [sort, setSort] = useState({ by: 'deleted', order: 'desc' });
  const [picked, setPicked] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const x = d.data;
  const items = useMemo(() => {
    if (!x || !x.items) return [];
    const w = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const days = AGE[age];
    const lim = Date.now() - Math.abs(days) * 86400000;
    const l = x.items.filter((it) => (!w.length || w.every((s) => `${it.name} ${it.from}`.toLowerCase().includes(s)))
      && (!days || (days > 0 ? (it.deleted || 0) >= lim : (it.deleted || 0) < lim)));
    const dir = sort.order === 'asc' ? 1 : -1;
    const by = { name: (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }) * dir, from: (a, b) => a.from.localeCompare(b.from) * dir, size: (a, b) => ((a.size || 0) - (b.size || 0)) * dir, deleted: (a, b) => ((a.deleted || 0) - (b.deleted || 0)) * dir }[sort.by];
    return l.sort(by);
  }, [x, q, age, sort]);

  if (d.error && !x) return <Callout kind="err" dismissible={false} title={t('The recycle bin could not be read')}>{String(d.error)} <Btn className="sm" icon={RefreshCw} onClick={() => d.reload()}>Try again</Btn></Callout>;
  if (!x) return <Loading />;
  if (x.supported === false) return <div className="card dh-fl-pad"><Empty icon={Trash2} title="Only on Windows" text="The recycle bin of Windows can only be shown when Hostwerk runs on Windows." /></div>;

  const sel = items.filter((it) => picked.has(it.id));
  const selBytes = sel.reduce((a, it) => a + (it.size || 0), 0);
  const all = items.length > 0 && items.every((it) => picked.has(it.id));
  const toggle = (id) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const toggleAll = () => setPicked((s) => { const n = new Set(s); for (const it of items) { if (all) n.delete(it.id); else n.add(it.id); } return n; });
  const run = async (what, list) => {
    if (!list.length) return;
    const size = list.reduce((a, it) => a + (it.size || 0), 0);
    if (what !== 'restore') {
      const ok = await confirmDialog({
        title: what === 'empty' ? t('Empty the recycle bin?') : list.length === 1 ? t('Delete “{name}” for good?', { name: list[0].name }) : t('Delete {n} items for good?', { n: fmtNumber(list.length) }),
        text: t('{size} will be freed. This cannot be undone.', { size: fmtBytes(size) }),
        confirm: what === 'empty' ? t('Empty') : t('Delete for good'), danger: true,
      });
      if (!ok) return;
    }
    setBusy(true);
    try {
      const r = what === 'empty' ? await post('/disk-health/bin/empty', {}) : await post(`/disk-health/bin/${what}`, { ids: list.map((it) => it.id) });
      if (r.done) toast.success(what === 'restore' ? pl(r.done, '{n} item restored', '{n} items restored', { n: fmtNumber(r.done) }) : t('{size} freed', { size: fmtBytes(r.bytes || size) }));
      if (r.failed && r.failed.length) toast.error(`${t('{n} did not work', { n: r.failed.length })}: ${t(r.failed[0].error)}`);
      setPicked(new Set());
      d.reload({ silent: true });
    } catch (e) { toast.error(e); }
    setBusy(false);
  };

  return (
    <div className="dh-bin">
      <div className="card dh-bin-head">
        <span className="dh-fl-scopeico"><Trash2 size={18} aria-hidden="true" /></span>
        <div className="grow dh-fl-scopemain">
          <b className="dh-bin-total">{fmtBytes(x.bytes)}</b>
          <span className="small muted">{pl(x.count, '{n} item in the Windows recycle bin', '{n} items in the Windows recycle bin', { n: fmtNumber(x.count) })} · {t('all drives')}</span>
        </div>
        <button type="button" className="btn ghost sm icon" title={t('Read again')} aria-label={t('Read again')} onClick={() => d.reload()}><RefreshCw size={14} /></button>
        <Btn className="sm danger" icon={Trash2} busy={busy} disabled={!x.count} onClick={() => run('empty', x.items)}>Empty the recycle bin</Btn>
      </div>
      <div className="dh-bin-hint small muted"><Info size={13} aria-hidden="true" />{t('Files deleted in Hostwerk’s own folders are in Hostwerk’s bin instead – under Files → Bin.')}</div>

      {x.count !== 0 && (
        <div className="dh-fl-filters">
          <label className="dh-fl-search">
            <Search size={15} aria-hidden="true" />
            <input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Search name or old place …')} aria-label={t('Search the recycle bin')} />
          </label>
          <select className="select dh-fl-select" value={age} onChange={(e) => setAge(e.target.value)} aria-label={t('Deleted')}>
            <option value="all">{t('Deleted any time')}</option>
            <option value="week">{t('In the last 7 days')}</option>
            <option value="month">{t('In the last 30 days')}</option>
            <option value="older">{t('More than 30 days ago')}</option>
          </select>
        </div>
      )}

      {sel.length > 0 && (
        <div className="bulk-bar dh-fl-bulk" role="region" aria-label={t('Selection')}>
          <b>{t('{n} selected · {size}', { n: fmtNumber(sel.length), size: fmtBytes(selBytes) })}</b>
          <div className="row-tight bulk-acts">
            <Btn className="sm" icon={RotateCcw} busy={busy} onClick={() => run('restore', sel)}>Restore</Btn>
            <Btn className="sm danger" icon={Trash2} busy={busy} onClick={() => run('delete', sel)}>Delete for good</Btn>
          </div>
          <button type="button" className="btn ghost xs icon" aria-label={t('Clear the selection')} onClick={() => setPicked(new Set())}><X size={13} /></button>
        </div>
      )}

      {!x.count ? (
        <div className="card dh-fl-pad"><Empty icon={Trash2} title="The recycle bin is empty" text="Nothing deleted is taking up space." /></div>
      ) : (
        <div className="card dh-fl-listcard">
          <div className="dh-fl-listhead small"><span className="grow">{pl(items.length, '{n} item · {size}', '{n} items · {size}', { n: fmtNumber(items.length), size: fmtBytes(items.reduce((a, it) => a + (it.size || 0), 0)) })}</span></div>
          {items.length ? (
            <div className="table-wrap">
              <table className="table dh-fl-table">
                <thead>
                  <tr>
                    <th scope="col" className="dh-fl-check"><input type="checkbox" className="bulk-check" checked={all} onChange={toggleAll} aria-label={t('Select all shown items')} /></th>
                    <SortHead id="name" label={t('Name')} sort={sort} onSort={setSort} />
                    <SortHead id="size" label={t('Size')} sort={sort} onSort={setSort} className="num dh-fl-size" />
                    <SortHead id="deleted" label={t('Deleted')} sort={sort} onSort={setSort} className="dh-bin-date" />
                    <th scope="col" className="dh-bin-acts"><span className="sr-only">{t('Actions')}</span></th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((it) => (
                    <tr key={it.id} className={picked.has(it.id) ? 'dh-fl-picked' : undefined}>
                      <td className="dh-fl-check"><input type="checkbox" className="bulk-check" checked={picked.has(it.id)} onChange={() => toggle(it.id)} aria-label={t('Select {name}', { name: it.name })} /></td>
                      <td className="dh-fl-name">
                        <span className="dh-fl-nameline">{it.dir ? <Folder size={15} aria-hidden="true" className="dh-fl-nico" /> : <File size={15} aria-hidden="true" className="muted" />}<b className="ellipsis" title={it.name}>{it.name}</b></span>
                        <span className="tiny muted ellipsis dh-fl-dir" title={it.from}>{t('from {place}', { place: it.from })}{it.dir && it.files ? ` · ${pl(it.files, '{n} file', '{n} files', { n: fmtNumber(it.files) })}` : ''}</span>
                      </td>
                      <td className="num dh-fl-size">{fmtBytes(it.size)}</td>
                      <td className="small muted dh-bin-date">{fmtDate(it.deleted)}</td>
                      <td className="dh-bin-acts">
                        <button type="button" className="btn ghost xs icon" title={t('Restore to {place}', { place: it.from })} aria-label={t('Restore')} onClick={() => run('restore', [it])}><RotateCcw size={14} /></button>
                        <button type="button" className="btn ghost xs icon" title={t('Delete for good')} aria-label={t('Delete for good')} onClick={() => run('delete', [it])}><Trash2 size={14} /></button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <div className="dh-fl-pad"><Empty icon={Search} title="Nothing matches" text="Change the search or the filter." /></div>}
        </div>
      )}
    </div>
  );
}
