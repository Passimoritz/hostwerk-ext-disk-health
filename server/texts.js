'use strict';
/*
 * Plain-language text for a problem and for every S.M.A.R.T. value – shared by the server (notifications, host.t) and the
 * interface (t from @hostwerk/i18n). English is the source, German comes from locales/de.json.
 */
const COUNTER_LABEL = {
  readErrors: 'Uncorrected read errors',
  writeErrors: 'Uncorrected write errors',
  reallocated: 'Reallocated sectors',
  pending: 'Sectors waiting for reallocation',
  uncorrectable: 'Unreadable sectors',
  mediaErrors: 'Media errors',
  crcErrors: 'Transfer errors (cable)',
  ioErrors: 'I/O errors',
};

/** Readable names for the raw fields (NVMe health log, Windows reliability counters, well-known ATA attributes). */
const ATTR_LABEL = {
  'nvme:critical_warning': 'Critical warning',
  'nvme:temperature': 'Temperature',
  'nvme:available_spare': 'Spare left',
  'nvme:available_spare_threshold': 'Spare limit',
  'nvme:percentage_used': 'Wear',
  'nvme:data_units_read': 'Data read (units)',
  'nvme:data_units_written': 'Data written (units)',
  'nvme:host_reads': 'Read commands',
  'nvme:host_writes': 'Write commands',
  'nvme:controller_busy_time': 'Busy time (minutes)',
  'nvme:power_cycles': 'Power cycles',
  'nvme:power_on_hours': 'Power-on hours',
  'nvme:unsafe_shutdowns': 'Unsafe shutdowns',
  'nvme:media_errors': 'Media errors',
  'nvme:num_err_log_entries': 'Error log entries',
  'nvme:warning_temp_time': 'Minutes above warning temperature',
  'nvme:critical_comp_time': 'Minutes above critical temperature',
  'win:Temperature': 'Temperature',
  'win:TemperatureMax': 'Temperature limit',
  'win:Wear': 'Wear',
  'win:PowerOnHours': 'Power-on hours',
  'win:ReadErrorsUncorrected': 'Uncorrected read errors',
  'win:ReadErrorsCorrected': 'Corrected read errors',
  'win:ReadErrorsTotal': 'Read errors in total',
  'win:WriteErrorsUncorrected': 'Uncorrected write errors',
  'win:WriteErrorsCorrected': 'Corrected write errors',
  'win:WriteErrorsTotal': 'Write errors in total',
  'win:StartStopCycleCount': 'Start/stop cycles',
  'win:LoadUnloadCycleCount': 'Head load cycles',
  'ata:1': 'Raw read error rate',
  'ata:5': 'Reallocated sectors',
  'ata:9': 'Power-on hours',
  'ata:10': 'Spin-up retries',
  'ata:12': 'Power cycles',
  'ata:177': 'Wear leveling count',
  'ata:187': 'Reported uncorrectable errors',
  'ata:188': 'Command timeouts',
  'ata:190': 'Airflow temperature',
  'ata:192': 'Unsafe shutdowns',
  'ata:194': 'Temperature',
  'ata:196': 'Reallocation events',
  'ata:197': 'Sectors waiting for reallocation',
  'ata:198': 'Unreadable sectors',
  'ata:199': 'Transfer errors (cable)',
  'ata:202': 'Life used',
  'ata:231': 'Life left',
  'ata:233': 'Media wearout indicator',
  'ata:241': 'Data written (blocks)',
  'ata:242': 'Data read (blocks)',
};

/** What a value means – shown as ⓘ in the details table. Same text for the same idea from different sources. */
const T_TEMP = 'Current temperature of the drive. SSDs are comfortable up to about 60 °C, hard disks up to about 50 °C.';
const T_WEAR = 'How much of the rated write volume of an SSD is used up. 100 % does not mean it dies, but it should be replaced soon after.';
const T_POH = 'How long the drive has been switched on in total.';
const T_REALLOC = 'Sectors the drive had to replace with spare ones because they could no longer be read reliably. A few old ones are fine – if the number grows, back up your data.';
const T_PENDING = 'Sectors that could not be read and wait to be replaced. They are often the first sign of a failing hard disk.';
const T_UNC = 'Sectors that could not be read even after several attempts – data stored there may be lost.';
const T_CRC = 'Errors on the way between drive and computer. Usually the cable or the USB adapter, not the drive itself.';
const T_READ_UNC = 'Read errors the drive could not correct. Every one of them is worth a look.';
const T_WRITTEN = 'How much data has been written to the drive in total. SSDs are rated for a certain amount (TBW).';
const T_CYCLES = 'How often the drive was switched on.';
const T_UNSAFE = 'How often the power went off without the drive being told first (power cut, holding the power button).';
const T_SPARE = 'Reserve blocks an SSD uses to replace worn-out ones. Below the limit the drive counts as failing.';
const T_MEDIA = 'Errors the flash memory could not correct – data may be damaged. Should stay at 0.';
const ATTR_INFO = {
  'nvme:critical_warning': 'Set by the drive itself when something is seriously wrong (spare used up, too hot, read-only). 0 means all is well.',
  'nvme:temperature': T_TEMP,
  'nvme:available_spare': T_SPARE,
  'nvme:available_spare_threshold': 'Below this share of reserve blocks the drive counts as failing.',
  'nvme:percentage_used': T_WEAR,
  'nvme:data_units_read': 'Data read in units of 512,000 bytes.',
  'nvme:data_units_written': T_WRITTEN,
  'nvme:power_cycles': T_CYCLES,
  'nvme:power_on_hours': T_POH,
  'nvme:unsafe_shutdowns': T_UNSAFE,
  'nvme:media_errors': T_MEDIA,
  'nvme:num_err_log_entries': 'Entries in the drive’s error log. Often harmless (e.g. unsupported commands from tools) as long as media errors stay at 0.',
  'nvme:warning_temp_time': 'How long the drive was warmer than its own warning limit.',
  'nvme:critical_comp_time': 'How long the drive was warmer than its own critical limit.',
  'win:Temperature': T_TEMP,
  'win:TemperatureMax': 'The temperature the drive itself names as its upper limit.',
  'win:Wear': T_WEAR,
  'win:PowerOnHours': T_POH,
  'win:ReadErrorsUncorrected': T_READ_UNC,
  'win:ReadErrorsCorrected': 'Read errors the drive corrected itself – normal in small numbers.',
  'win:WriteErrorsUncorrected': 'Write errors the drive could not correct. Every one of them is worth a look.',
  'win:StartStopCycleCount': T_CYCLES,
  'win:LoadUnloadCycleCount': 'How often a hard disk parked its heads. Hard disks are rated for a few hundred thousand.',
  'ata:1': 'Errors when reading the raw data. Many manufacturers count in their own way – only the normalised value is meaningful.',
  'ata:5': T_REALLOC,
  'ata:9': T_POH,
  'ata:10': 'How often the disk needed more than one try to spin up. Should stay at 0.',
  'ata:12': T_CYCLES,
  'ata:177': T_WEAR,
  'ata:187': T_READ_UNC,
  'ata:188': 'Commands that took too long. Often the cable or the power supply.',
  'ata:190': T_TEMP,
  'ata:192': T_UNSAFE,
  'ata:194': T_TEMP,
  'ata:196': 'How often the drive moved data away from a weak sector.',
  'ata:197': T_PENDING,
  'ata:198': T_UNC,
  'ata:199': T_CRC,
  'ata:202': T_WEAR,
  'ata:231': T_WEAR,
  'ata:233': T_WEAR,
  'ata:241': T_WRITTEN,
  'ata:242': 'How much data has been read from the drive in total.',
};

/** One problem from health.assess() as a sentence. t = translator (text, vars) → text. */
function describe(p, t) {
  switch (p.code) {
    case 'health': return p.level === 'err' ? t('The drive reports itself as failing – back up your data now.') : t('The drive reports a problem with its health.');
    case 'critical': return t('The drive raises a critical warning (code {code}) – back up your data now.', { code: p.value });
    case 'spare': return t('The spare area is almost used up – replace the drive soon.');
    case 'temp': return p.level === 'err' ? t('{n} °C – much too hot.', { n: p.value }) : t('{n} °C – warmer than it should be.', { n: p.value });
    case 'wear': return p.level === 'err' ? t('{n} % worn – replace it soon.', { n: p.value }) : t('{n} % worn.', { n: p.value });
    case 'pending': return t('Sectors waiting to be reallocated: {n}.', { n: p.value });
    case 'attr': return t('Values below the manufacturer’s limit: {list} – back up your data.', { list: p.value });
    default: {
      const k = String(p.code).replace(/^grow:/, '');
      return t('{label} rose from {before} to {after}.', { label: t(COUNTER_LABEL[k] || k), before: p.before, after: p.value });
    }
  }
}

module.exports = { describe, COUNTER_LABEL, ATTR_LABEL, ATTR_INFO };
