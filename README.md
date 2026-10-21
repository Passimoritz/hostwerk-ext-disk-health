![Drive health](banner.svg)

# Drive health

The state of every drive at a glance: temperature, wear, read and write errors and power-on hours (S.M.A.R.T.). Alerts you through Hostwerk's notifications when errors grow, a drive runs hot or wears out. With a dashboard tile.

[Deutsch](README.de.md) · An official [Hostwerk](https://github.com/Passimoritz/hostwerk-public) extension (SDK 2.7, native extension)

## What it does

- One card per drive: health status, temperature with its trend, wear (SSD), power-on time and every error counter the drive reveals
- Problems in plain words – “Reallocated sectors rose from 2 to 8.” instead of attribute numbers
- Warns when error counters **grow** (reallocated, pending and unreadable sectors, media errors → danger; read/write and cable errors → attention), when a drive gets too warm or wears out, and when the drive itself reports a problem
- Alerts through Hostwerk's notifications (push, Discord, ntfy, mail – *Live → Alerts*), once per problem and again only when it gets worse; also listed under *Live → Watchers*
- Dashboard tile with the worst drive first; right-click a drive to copy its serial number or check again
- Settings under *Settings → Notifications*: notifications on/off, temperature and wear limits, how often to check (default every 30 minutes)

## Where the values come from

Only **reading** commands – nothing on a drive is ever changed.

| System | Source | Without admin/root rights |
|---|---|---|
| Windows | `Get-PhysicalDisk` and `Get-StorageReliabilityCounter` (PowerShell) | Health status and type; temperature, wear and counters need Hostwerk to run as administrator |
| Linux | `smartctl -j -a` (smartmontools) | Drives smartctl may not open come from `/sys/block` (model, size, SSD/HDD, temperature where the kernel offers it, I/O errors) |
| Linux without smartctl | `/sys/block` | as above – the page suggests installing smartmontools |

Values a system does not reveal stay “–” – unknown is never shown as “no errors”.

## Works well with

[Storage per service](https://github.com/Passimoritz/hostwerk-ext-disk-usage) – how full the drive is and who uses the space; this extension shows whether the drive itself is healthy.

## Install

In Hostwerk: **Extensions → Discover** and click “Install”.

Native extensions run as part of Hostwerk (own server and interface part). That is why Hostwerk only installs them from the official catalogue (with checksum) or in developer mode.

## Data

`data/disk-health/state.json` – the last reading, a small history per drive (about a month, one sample per hour or on every change) and which problems were already reported. Drives that are gone for 90 days are forgotten. Removing the extension keeps the file.

## Develop

```bash
node --test tests/*.test.js          # tests with recorded outputs of PowerShell, smartctl and /sys
node build-native.js .               # build the interface (sdk/build-native.js from hostwerk-public)
node check.js . --strict             # same check as the catalogue (sdk/check.js)
```

Parsers and assessment in `server/health.js` (no Hostwerk needed), reading in `server/probe.js`, interface in `ui/src`. Texts in the code are English, German is in `locales/de.json`.

## License

MIT
