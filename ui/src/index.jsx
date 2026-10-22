import { useEffect, useId, useState } from 'react';
import {
  Activity, HardDrive, RefreshCw, Thermometer, Clock, Copy, AlertTriangle, CheckCircle2, HelpCircle, XCircle, ShieldCheck, ChevronDown,
  Hourglass, Bell, Download, Usb, Wrench,
} from 'lucide-react';
import { post, useApi, fmtBytes, fmtDate, fmtNumber } from '@hostwerk/api';
import { Btn, Empty, Loading, Callout, InfoTip, TileEmpty, Sparkline, Switch, toast, confirmDialog } from '@hostwerk/ui';
import { contextMenu } from '@hostwerk/kit';
import { t, pl as hostPl } from '@hostwerk/i18n';
import { describe, COUNTER_LABEL, ATTR_LABEL, ATTR_INFO } from '../../server/texts';
import './style.css';

/*
 * Drive health, rebuilt (1.1): a status bar on top (overall state, last/next check, admin check, regular check), one card
 * per drive in a grid (state, big key figures with traffic lights, wear ring, estimated life, trend, details table with
 * every S.M.A.R.T. value) and a dashboard tile. Values the system does not reveal never show up as a lonely "–": without
 * administrator values the card says so once and offers the check. Explanations live in ⓘ pop-ups.
 * Texts are English; German comes from locales/de.json (also inside JSX).
 */
const LEVEL = {
  ok: { label: 'Healthy', icon: CheckCircle2, badge: 'ok' },
  warn: { label: 'Needs attention', icon: AlertTriangle, badge: 'warn' },
  err: { label: 'In danger', icon: XCircle, badge: 'err' },
  unknown: { label: 'Unknown', icon: HelpCircle, badge: '' },
};
const RANK = { err: 0, warn: 1, unknown: 2, ok: 3 };
const MEDIA = { nvme: 'NVMe SSD', ssd: 'SATA SSD', hdd: 'Hard disk', unknown: 'Drive' };
const COUNTERS = Object.keys(COUNTER_LABEL);
const SETTINGS_HREF = '#/settings/meldungen';
const byLevel = (a, b) => (RANK[a.level] ?? 2) - (RANK[b.level] ?? 2) || a.name.localeCompare(b.name);
const has = (v) => v !== null && v !== undefined;
// pl() exists since SDK 2.10 (Hostwerk 2.12) – on older Hostwerk the same with t()
const pl = (n, one, many, vars) => (typeof hostPl === 'function' ? hostPl(n, one, many, vars) : t(Number(n) === 1 ? one : many, { n, ...(vars || {}) }));

/** "5 minutes ago" / "in 12 minutes" – rough, for the status bar. */
function rel(ts) {
  if (!ts) return null;
  const diff = ts - Date.now();
  const m = Math.round(Math.abs(diff) / 60000);
  if (m < 1) return diff > 0 ? t('in a moment') : t('just now');
  const [n, one, many] = m < 60 ? [m, '{n} minute', '{n} minutes'] : m < 2880 ? [Math.round(m / 60), '{n} hour', '{n} hours'] : [Math.round(m / 1440), '{n} day', '{n} days'];
  const span = pl(n, one, many);
  return diff > 0 ? t('in {span}', { span }) : t('{span} ago', { span });
}
const levelOfTemp = (d, limits) => {
  if (!has(d.tempC)) return null;
  const crit = d.tempMaxC ? Math.min(d.tempMaxC, limits.tempCrit + 15) : limits.tempCrit;
  return d.tempC >= crit ? 'err' : d.tempC >= Math.min(limits.tempWarn, crit - 1) ? 'warn' : 'ok';
};
const levelOfWear = (w, limits) => (!has(w) ? null : w >= limits.wearCrit ? 'err' : w >= limits.wearWarn ? 'warn' : 'ok');
const errorSum = (d) => { const v = COUNTERS.map((k) => d[k]).filter(has); return v.length ? v.reduce((a, b) => a + b, 0) : null; };

/** What went wrong with an administrator action – one sentence for the toast. */
const REASON = {
  cancelled: 'The administrator prompt was cancelled – nothing was read.',
  'not-admin': 'Windows did not grant administrator rights.',
  'needs-update': 'Update Hostwerk (2.12 or newer) to check with administrator rights.',
  'no-smartctl': 'Install smartmontools first – the check uses smartctl.',
  'no-result': 'The check returned no values.',
  busy: 'A check with administrator rights is already running.',
  unsupported: 'Not available on this system.',
  'no-winget': 'winget is missing – download smartmontools from smartmontools.org.',
};
const reasonText = (r) => (r.reason === 'error' && r.error ? r.error : t(REASON[r.reason] || 'That did not work.'));

/* ---------------- Building blocks ---------------- */

/**
 * One key figure in Hostwerk's own stat style (.stat with .k label, .v value, .s line – like System → Resources).
 * The ⓘ sits behind the label; a text instead of a number (e.g. "Too early to say") comes as a note in normal size.
 */
function Stat({ icon: Icon, label, value, note, sub, tone, tip, bar }) {
  return (
    <div className={`stat dh-stat${tone ? ` dh-tone-${tone}` : ''}`}>
      <div className="k"><Icon aria-hidden="true" /><span className="dh-stat-label">{label}</span>{tip && <InfoTip pop title={label}>{tip}</InfoTip>}</div>
      {has(value) ? <div className="v">{value}</div> : <div className="dh-stat-note">{note || t('Not reported')}</div>}
      {has(bar) && <div className="progress dh-bar" role="progressbar" aria-label={label} aria-valuenow={bar} aria-valuemin={0} aria-valuemax={100}><div style={{ width: `${Math.max(2, Math.min(100, bar))}%` }} /></div>}
      {sub && <div className="s">{sub}</div>}
    </div>
  );
}

/** Compact hint with one action – instead of big info banners. */
function Hint({ icon: Icon = ShieldCheck, tone = 'info', children, action, tip, tipTitle }) {
  return (
    <div className={`dh-hint dh-hint-${tone}`} role="note">
      <Icon size={16} aria-hidden="true" />
      <span className="dh-hint-text">{children}</span>
      {tip && <InfoTip pop title={tipTitle}>{tip}</InfoTip>}
      {action}
    </div>
  );
}

function copy(text) {
  navigator.clipboard.writeText(text).then(() => toast.success('Copied')).catch(() => toast.error('Could not copy'));
}

/** All S.M.A.R.T. values of a drive with an explanation per row. */
function AttrTable({ d }) {
  const list = d.attributes || [];
  const norm = list.some((a) => has(a.norm));
  const fmt = (a) => {
    if (typeof a.value === 'string') return a.value;
    if (!has(a.value)) return '–';
    if (a.key === 'nvme:data_units_written' || a.key === 'nvme:data_units_read') return `${fmtNumber(a.value)} (${fmtBytes(a.value * 512000)})`;
    if (/temperature$|:194$|:190$|^win:Temperature/i.test(a.key) && a.value < 200) return `${a.value} °C`;
    if (a.key === 'nvme:percentage_used' || a.key === 'win:Wear' || a.key === 'nvme:available_spare' || a.key === 'nvme:available_spare_threshold') return `${a.value} %`;
    return fmtNumber(a.value);
  };
  return (
    <div className="table-wrap dh-attrs-wrap">
      <table className="table dh-attrs">
        <thead>
          <tr>
            <th scope="col">Value</th>
            <th scope="col" className="num">Raw</th>
            {norm && <th scope="col" className="num">Current</th>}
            {norm && <th scope="col" className="num">Worst</th>}
            {norm && <th scope="col" className="num">Limit</th>}
          </tr>
        </thead>
        <tbody>
          {list.map((a) => {
            const label = ATTR_LABEL[a.key] ? t(ATTR_LABEL[a.key]) : a.label;
            return (
              <tr key={a.key} className={a.failing ? 'dh-attr-failing' : undefined}>
                <th scope="row">
                  <span className="dh-attr-name">
                    {has(a.id) && <span className="dh-attr-id">{a.id}</span>}
                    {label}
                    {ATTR_INFO[a.key] && <InfoTip pop title={label}>{t(ATTR_INFO[a.key])}</InfoTip>}
                    {a.failing && <span className="badge err">Below limit</span>}
                  </span>
                </th>
                <td className="num">{fmt(a)}</td>
                {norm && <td className="num">{has(a.norm) ? a.norm : '–'}</td>}
                {norm && <td className="num">{has(a.worst) ? a.worst : '–'}</td>}
                {norm && <td className="num">{has(a.thresh) ? a.thresh : '–'}</td>}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ---------------- Drive card ---------------- */

function DriveCard({ d, limits, onRefresh, onAdmin, canElevate }) {
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const lv = LEVEL[d.level] || LEVEL.unknown;
  const ssd = d.media !== 'hdd';
  // Values to show: full S.M.A.R.T., administrator values or at least what udisks/the kernel tell without rights
  const smart = !d.partial || !!d.smartAt || has(d.tempC) || has(d.powerOnHours);
  const tTone = d.tempStale ? null : levelOfTemp(d, limits);
  const wTone = levelOfWear(d.wearPct, limits);
  const temps = (d.history || []).map((h) => h.tempC).filter(has);
  const wears = (d.history || []).map((h) => h.wearPct).filter(has);
  const errors = errorSum(d);
  const kind = [t(MEDIA[d.media] || 'Drive'), d.bus === 'USB' ? 'USB' : null, d.sizeBytes ? fmtBytes(d.sizeBytes) : null].filter(Boolean).join(' · ');
  // Windows' reliability counters leave some values out for many drives (e.g. power-on hours of NVMe SSDs) – say who is silent
  const silent = d.source === 'windows' ? t('Windows does not report it') : t('Not reported');
  const silentSub = d.source === 'windows' && d.smartAt ? t('smartmontools can read it') : null;
  const menu = (e) => contextMenu(e, [
    d.serial && { label: t('Copy serial number'), icon: Copy, onClick: () => copy(d.serial) },
    { label: t('Check now'), icon: RefreshCw, onClick: onRefresh },
    canElevate && { label: t('Check with admin rights'), icon: ShieldCheck, onClick: onAdmin },
  ]);
  const life = d.life;
  const lifeValue = life && life.years > 0 ? (life.years > 20 ? t('> 20 years') : t('≈ {n} years', { n: life.years.toLocaleString(undefined, { maximumFractionDigits: life.years < 3 ? 1 : 0 }) })) : null;
  const lifeNote = !has(d.wearPct) ? silent : life && life.years === 0 ? t('Worn out') : t('Too early to say');
  const facts = [
    has(d.dataWrittenBytes) && ['Data written', fmtBytes(d.dataWrittenBytes)],
    has(d.dataReadBytes) && ['Data read', fmtBytes(d.dataReadBytes)],
    has(d.spareLeftPct) && ['Spare left', `${d.spareLeftPct} %`],
    has(d.powerCycles) && ['Power cycles', fmtNumber(d.powerCycles)],
    has(d.unsafeShutdowns) && ['Unsafe shutdowns', fmtNumber(d.unsafeShutdowns)],
    ...COUNTERS.filter((k) => has(d[k])).map((k) => [COUNTER_LABEL[k], fmtNumber(d[k])]),
  ].filter(Boolean);
  return (
    <article className={`card dh-card dh-lv-${d.level}`} onContextMenu={menu} aria-label={d.name}>
      <div className="card-head">
        {d.bus === 'USB' ? <Usb size={16} aria-hidden="true" /> : <HardDrive size={16} aria-hidden="true" />}
        <div className="grow dh-title">
          <h3 title={d.name}>{d.name}</h3>
          <span className="sub">{kind}</span>
        </div>
        <div className="right"><span className={`badge ${lv.badge}`}><lv.icon size={12} aria-hidden="true" />{t(lv.label)}</span></div>
      </div>

      <div className="card-body stack dh-body">
        {d.problems && d.problems.length > 0 && (
          <ul className="dh-problems">
            {d.problems.map((p) => (
              <li key={p.code} className={p.level === 'err' ? 'dh-problem-err' : 'dh-problem-warn'}>
                {p.level === 'err' ? <XCircle size={15} aria-hidden="true" /> : <AlertTriangle size={15} aria-hidden="true" />}
                <span>{describe(p, t)}</span>
              </li>
            ))}
          </ul>
        )}

        {smart ? (
          <>
            <div className="dh-stats">
              <Stat icon={Thermometer} label={t('Temperature')} tone={tTone} value={has(d.tempC) ? `${d.tempC} °C` : null} note={silent}
                sub={!has(d.tempC) ? silentSub : d.tempStale ? t('measured {when}', { when: rel(d.smartAt) }) : t('warns from {n} °C', { n: limits.tempWarn })}
                tip={d.tempMaxC ? t('The drive itself reports {n} °C as its upper limit.', { n: d.tempMaxC }) : null} />
              {ssd ? (
                <Stat icon={Activity} label={t('Wear')} tone={wTone} value={has(d.wearPct) ? `${d.wearPct} %` : null} note={silent} bar={d.wearPct}
                  sub={has(d.wearPct) ? t('warns from {n} %', { n: limits.wearWarn }) : silentSub}
                  tip={t('How much of the rated write volume of an SSD is used up. 100 % does not mean it dies, but it should be replaced soon after.')} />
              ) : (
                <Stat icon={AlertTriangle} label={t('Reallocated sectors')} tone={has(d.reallocated) ? (d.reallocated > 0 ? 'warn' : 'ok') : null}
                  value={has(d.reallocated) ? fmtNumber(d.reallocated) : null} note={silent} sub={has(d.pending) ? t('{n} waiting', { n: fmtNumber(d.pending) }) : silentSub}
                  tip={t(ATTR_INFO['ata:5'])} />
              )}
              {ssd ? (
                <Stat icon={Hourglass} label={t('Life left')} tone={life && life.years === 0 ? 'err' : null} value={lifeValue} note={lifeNote}
                  sub={life && life.basis === 'trend' && lifeValue ? t('from the trend of the last weeks') : lifeValue ? t('from the wear so far') : null}
                  tip={t('A rough estimate at the same use – from how fast the wear grew so far. It says nothing about sudden failures, so keep backups anyway.')} />
              ) : (
                <Stat icon={AlertTriangle} label={t('Errors')} tone={has(errors) ? (errors > 0 ? 'warn' : 'ok') : null} value={has(errors) ? fmtNumber(errors) : null} note={silent}
                  sub={has(errors) ? t('all error counters together') : silentSub} />
              )}
              <Stat icon={Clock} label={t('Power-on time')} value={has(d.powerOnHours) ? `${fmtNumber(d.powerOnHours)} h` : null} note={silent}
                sub={has(d.powerOnHours) ? (d.powerOnHours >= 48 ? pl(Math.round(d.powerOnHours / 24), '≈ {n} day', '≈ {n} days') : null) : silentSub} />
            </div>

            {facts.length > 0 && (
              <dl className="dh-facts">
                {facts.map(([k, v]) => <div key={k}><dt>{t(k)}</dt><dd>{v}</dd></div>)}
              </dl>
            )}
            {(temps.length > 1 || (wears.length > 1 && Math.max(...wears) > Math.min(...wears))) && (
              <div className="dh-trends">
                {temps.length > 1 && (
                  <div className="dh-trend" title={t('Temperature over the last {n} readings', { n: temps.length })}>
                    <span>Temperature</span>
                    <Sparkline data={temps} width={140} height={28} color="var(--accent-2)" />
                    <span className="dh-trend-range">{`${Math.min(...temps)}–${Math.max(...temps)} °C`}</span>
                  </div>
                )}
                {wears.length > 1 && Math.max(...wears) > Math.min(...wears) && (
                  <div className="dh-trend" title={t('Wear over the last {n} readings', { n: wears.length })}>
                    <span>Wear</span>
                    <Sparkline data={wears} width={140} height={28} color="var(--accent)" max={100} />
                    <span className="dh-trend-range">{`${Math.min(...wears)}–${Math.max(...wears)} %`}</span>
                  </div>
                )}
              </div>
            )}
          </>
        ) : (
          <div className="dh-admin-cta">
            <ShieldCheck size={18} aria-hidden="true" />
            <div className="dh-admin-cta-text">
              <b>Only the health status so far</b>
              <span>Temperature, wear and error counters need administrator rights.</span>
            </div>
            {canElevate && <Btn className="sm" icon={ShieldCheck} onClick={onAdmin}>Check with admin rights</Btn>}
          </div>
        )}
        {open && <div id={detailsId}><AttrTable d={d} /></div>}
      </div>

      <div className="dh-card-foot">
        {d.attributes && d.attributes.length > 0 && (
          <button type="button" className="btn ghost sm" aria-expanded={open} aria-controls={detailsId} onClick={() => setOpen(!open)}>
            <ChevronDown size={14} className={open ? 'dh-rot' : undefined} aria-hidden="true" />
            {open ? t('Hide details') : pl(d.attributes.length, 'Show {n} value', 'Show all {n} values')}
          </button>
        )}
        {d.smartAt && <span className="dh-foot-meta">{t('Values read {when}', { when: rel(d.smartAt) })}</span>}
        {d.serial && (
          <button type="button" className="btn ghost sm dh-serial" title={t('Copy serial number')} aria-label={t('Copy serial number {serial}', { serial: d.serial })} onClick={() => copy(d.serial)}>
            <span className="mono">{d.serial}</span><Copy size={13} aria-hidden="true" />
          </button>
        )}
      </div>
    </article>
  );
}

/* ---------------- Status bar ---------------- */

function StatusBar({ d, drives, busy, onRefresh, onAdmin, onSchedule }) {
  const n = { err: 0, warn: 0, ok: 0, unknown: 0 };
  for (const x of drives) n[x.level in n ? x.level : 'unknown'] += 1;
  const overall = n.err ? 'err' : n.warn ? 'warn' : n.ok ? 'ok' : 'unknown';
  const Icon = LEVEL[overall].icon;
  const headline = n.err ? pl(n.err, '{n} drive is in danger', '{n} drives are in danger')
    : n.warn ? pl(n.warn, '{n} drive needs attention', '{n} drives need attention')
      : n.ok ? pl(drives.length, 'Your drive is healthy', 'All {n} drives are healthy') : t('State unknown');
  const sch = d.schedule || {};
  const schTip = (
    <>
      Hostwerk sets up a Windows task that reads the values every hour with administrator rights. Windows asks for permission once. The task only reads and removes itself when you uninstall the extension.
      {(d.traces || []).length > 0 && <span className="dh-traces">{(d.traces || []).map((x) => <span key={x.label} className="mono">{x.label}</span>)}</span>}
    </>
  );
  return (
    <section className={`card dh-status dh-lv-${overall}`} aria-label={t('Overview')}>
      <span className="dh-status-icon" aria-hidden="true"><Icon size={26} /></span>
      <div className="dh-status-main">
        <h2 className="dh-status-title">{headline}</h2>
        <div className="dh-status-meta">
          <span>{t('Checked {when}', { when: rel(d.at) })}</span>
          {d.nextAt && d.nextAt > Date.now() && <span>{t('next check {when}', { when: rel(d.nextAt) })}</span>}
          <span>{d.admin ? t('admin values {when}', { when: rel(d.admin.at) }) : t('no admin values yet')}</span>
        </div>
      </div>
      <div className="dh-status-actions">
        {sch.supported && (
          <div className="dh-switch-row">
            <Switch checked={sch.on} onChange={onSchedule} disabled={!!d.adminBusy} label={t('Check regularly with admin rights')} />
            <span>Check regularly</span>
            <InfoTip pop title={t('Check regularly with admin rights')}>{schTip}</InfoTip>
          </div>
        )}
        <Btn className="ghost" icon={RefreshCw} busy={busy} onClick={onRefresh} title={t('Check again without admin rights')}>Check now</Btn>
        {d.canElevate && <Btn className="primary" icon={ShieldCheck} busy={d.adminBusy === 'check'} onClick={onAdmin}>Check with admin rights</Btn>}
      </div>
    </section>
  );
}

/* ---------------- Page ---------------- */

function DiskHealthPage() {
  const st = useApi('/disk-health', [], { live: false });
  const [busy, setBusy] = useState(false);
  const d = st.data;
  const installing = !!(d && d.smartctl && d.smartctl.install && d.smartctl.install.running);
  // While smartmontools installs, look again every few seconds
  useEffect(() => {
    if (!installing) return undefined;
    const iv = setInterval(() => { st.reload({ silent: true }); }, 4000);
    return () => clearInterval(iv);
  }, [installing]); // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = async () => {
    setBusy(true);
    try { st.setData(await post('/disk-health/refresh')); } catch (e) { toast.error(e); }
    setBusy(false);
  };
  const adminCheck = async () => {
    const r = await post('/disk-health/admin-check');
    if (r.view) st.setData(r.view);
    if (r.ok) toast.success('Values read with administrator rights'); else toast.error(reasonText(r));
  };
  const setSchedule = async (on) => {
    const ok = on
      ? await confirmDialog({
        title: 'Check regularly with admin rights?',
        text: t('Hostwerk sets up a Windows task that reads the drive values every hour with administrator rights. Windows asks for permission once.\n\nThe task only reads (temperature, wear, errors) and writes the values to {dir}. Switch it off here at any time – it also removes itself when you uninstall the extension.', { dir: (d.traces || []).find((x) => x.kind === 'folder')?.label || 'C:\\ProgramData\\HostwerkDiskHealth' }),
        confirm: 'Set up',
      })
      : await confirmDialog({ title: 'Stop the regular check?', text: 'Windows asks for permission once more to remove the task and its folder. The values read so far stay.', confirm: 'Remove' });
    if (!ok) return;
    const r = await post('/disk-health/schedule', { on });
    if (r.view) st.setData(r.view);
    if (r.ok) toast.success(on ? 'Regular check set up – first values arrive in a minute' : 'Regular check removed'); else toast.error(reasonText(r));
  };
  const installSmartctl = async () => {
    const ok = await confirmDialog({
      title: 'Install smartmontools?',
      text: 'smartmontools (smartctl) reads more than Windows: data written, every S.M.A.R.T. value and many USB drives. Hostwerk installs it with winget from the official package source – winget checks the checksum of the download, Windows asks for permission.\n\nsmartmontools is free software under the GPL and not part of Hostwerk.',
      confirm: 'Install',
    });
    if (!ok) return;
    const r = await post('/disk-health/smartctl/install');
    if (r.view) st.setData(r.view);
    if (!r.ok) toast.error(reasonText(r));
  };

  const drives = d ? [...(d.drives || [])].sort(byLevel) : [];
  const sc = (d && d.smartctl) || {};
  const sch = (d && d.schedule) || {};
  const needsAdmin = drives.some((x) => x.partial && !x.smartAt);
  return (
    <div className="page fade-in dh-page">
      <div className="page-head">
        <div>
          <h1><Activity /> Drive health <InfoTip pop title="Drive health">Hostwerk reads the S.M.A.R.T. values of every drive – temperature, wear, errors – and tells you when something gets worse. Nothing on a drive is ever changed.</InfoTip></h1>
          <p>Health, wear and temperature of every drive – checked regularly.</p>
        </div>
      </div>
      {st.error && <Callout kind="err" dismissible={false}>{st.error}</Callout>}
      {st.loading && !d ? <Loading /> : !d || !d.at ? (
        <Empty icon={HardDrive} title="Not checked yet" text="The first check runs shortly after Hostwerk starts – or right now." action={<Btn className="primary" icon={RefreshCw} busy={busy} onClick={refresh}>Check now</Btn>} />
      ) : (d.notes || []).includes('unsupported') ? (
        <Empty icon={HardDrive} title="Not available on this system" text="Drive health works on Windows and Linux, and wherever smartctl is installed." />
      ) : (
        <>
          <StatusBar d={d} drives={drives} busy={busy} onRefresh={refresh} onAdmin={adminCheck} onSchedule={setSchedule} />
          <div className="dh-hints">
            {d.error && <Hint icon={AlertTriangle} tone="warn">{t('The drives could not be read: {error}', { error: d.error })}</Hint>}
            {needsAdmin && d.canElevate && (
              <Hint action={<Btn className="sm primary" icon={ShieldCheck} busy={d.adminBusy === 'check'} onClick={adminCheck}>Check with admin rights</Btn>}
                tipTitle={t('Why administrator rights?')}
                tip={d.platform === 'win32' ? t('Without administrator rights Windows only shows whether a drive is healthy. Temperature, wear and error counters are read in a single check – Windows asks for permission once. Hostwerk itself keeps running without admin rights.') : t('smartctl needs root rights for most drives. Your system asks for your password once; Hostwerk itself keeps running without root.')}>
                Temperature, wear and errors need one check with administrator rights.
              </Hint>
            )}
            {needsAdmin && d.needsUpdate && <Hint icon={Wrench}>Update Hostwerk (2.12 or newer) to read temperature, wear and errors with administrator rights.</Hint>}
            {(d.notes || []).includes('install-smartctl') && sc.hint && (
              <Hint icon={Download} action={<Btn className="sm" icon={Copy} onClick={() => copy(sc.hint)}>Copy command</Btn>}>
                {t('More values with smartmontools: {cmd}', { cmd: sc.hint })}
              </Hint>
            )}
            {(d.notes || []).includes('smartctl-rights') && (
              <Hint icon={ShieldCheck} tipTitle={t('Without the password prompt')} tip={t('Hostwerk can also get read access permanently, for example with: sudo setcap cap_sys_rawio,cap_sys_admin+ep $(command -v smartctl)')}>
                smartctl may not open some drives without root rights.
              </Hint>
            )}
            {sch.on && (sch.state === 'stale' || sch.state === 'missing') && (
              <Hint icon={AlertTriangle} tone="warn" action={<Btn className="sm" icon={ShieldCheck} onClick={() => setSchedule(true)}>Set up again</Btn>}>
                {sch.state === 'missing' ? t('The regular check is gone – the Windows task was removed.') : t('The regular check has not delivered values since {when}.', { when: sch.lastAt ? fmtDate(sch.lastAt) : fmtDate(sch.since) })}
              </Hint>
            )}
            {d.platform === 'win32' && d.admin && !sc.ok && (
              <Hint icon={Download}
                action={sc.canInstall ? <Btn className="sm" icon={Download} busy={installing} onClick={installSmartctl}>{installing ? t('Installing …') : t('Install smartmontools')}</Btn> : <a className="btn sm" href="https://www.smartmontools.org/wiki/Download" target="_blank" rel="noreferrer">Download page</a>}
                tipTitle="smartmontools" tip={t('Free tool (GPL) from smartmontools.org – a separate download, not part of Hostwerk. Version {min} or newer, installed to Program Files.', { min: sc.min || '7.0' })}>
                {sc.path && !sc.ok ? t('smartctl {v} is too old – version {min} or newer reads more values.', { v: sc.version || '?', min: sc.min || '7.0' }) : t('smartmontools reads more: data written, every S.M.A.R.T. value and USB drives.')}
              </Hint>
            )}
            {sc.install && sc.install.error && !installing && <Hint icon={AlertTriangle} tone="warn">{t('smartmontools could not be installed: {error}', { error: sc.install.error })}</Hint>}
          </div>
          {!drives.length ? (
            <Empty icon={HardDrive} title="No drives found" text="The system did not list any physical drive." />
          ) : (
            <div className="dh-grid">
              {drives.map((x) => <DriveCard key={x.id} d={x} limits={d.limits} canElevate={d.canElevate} onRefresh={refresh} onAdmin={adminCheck} />)}
            </div>
          )}
          <p className="dh-foot">
            <Bell size={14} aria-hidden="true" />
            <span>{t('Warns from {temp} °C and {wear} % wear.', { temp: d.limits.tempWarn, wear: d.limits.wearWarn })}</span>
            <a href={SETTINGS_HREF}>Change in the settings</a>
            <InfoTip pop title="Notifications">Warnings go to Hostwerk’s notifications (push, Discord, ntfy, mail) and appear under Live → Watchers.</InfoTip>
          </p>
        </>
      )}
    </div>
  );
}

/** Dashboard tile: the worst drive first, at most four. */
function DiskHealthTile() {
  const st = useApi('/disk-health', [], { live: false });
  const d = st.data;
  if (st.loading && !d) return <div className="card-body"><div className="skeleton dh-skel" /></div>;
  if (!d || !d.at || !d.drives.length) return <TileEmpty icon={HardDrive} text="No drive checked yet" href="#/ext/disk-health" />;
  const drives = [...d.drives].sort(byLevel).slice(0, 4);
  return (
    <div className="card-body dh-tile">
      {drives.map((x) => {
        const lv = LEVEL[x.level] || LEVEL.unknown;
        const facts = [has(x.tempC) && !x.tempStale ? `${x.tempC} °C` : null, has(x.wearPct) ? t('{n} % worn', { n: x.wearPct }) : null].filter(Boolean).join(' · ');
        return (
          <a key={x.id} className="dh-tile-row" href="#/ext/disk-health" title={x.problems && x.problems.length ? describe(x.problems[0], t) : t(lv.label)}>
            <lv.icon size={16} className={`dh-tile-icon dh-tone-${x.level}`} aria-label={t(lv.label)} />
            <span className="dh-tile-name ellipsis">{x.name}</span>
            <span className="dh-tile-facts">{facts || t(lv.label)}</span>
          </a>
        );
      })}
    </div>
  );
}

export default {
  pages: { main: DiskHealthPage },
  slots: {
    // Seit Hostwerk 3.0 (SDK 3.2) ohne eigenen Seitenleisten-Eintrag ("nav": false) – die ganze Seite als Reiter im passenden Bereich;
    // Hostwerk blendet dabei ihren Titel aus (Reiter + Herkunftszeile sagen schon, was es ist), die Knöpfe bleiben
    'system.tabs': [{ id: 'drives', title: 'Drive health', icon: HardDrive, Component: DiskHealthPage, order: 40 }],
    'dashboard.tiles': [{ id: 'drives', title: 'Drive health', icon: HardDrive, size: 'third', Component: DiskHealthTile }],
  },
};
