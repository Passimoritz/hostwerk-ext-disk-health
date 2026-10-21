![Drive health](banner.svg)

# Drive health

The state of every drive at a glance: temperature, wear, read and write errors and power-on hours (S.M.A.R.T.). Alerts you through Hostwerk's notifications when errors grow, a drive runs hot or wears out. With a dashboard tile.

[Deutsch](README.de.md) · An official [Hostwerk](https://github.com/Passimoritz/hostwerk-public) extension (SDK 3.0, native extension)

## What it does

- **Where:** System → Drive health and the dashboard tile – no own sidebar entry since 1.2.0; the full page stays under Extensions → Open
- **Status bar** on top: all drives healthy, needs attention or in danger – with the last and next check, the age of the administrator values and the buttons *Check now* and *Check with admin rights*
- **One card per drive** in a grid: model, kind (NVMe/SATA SSD, hard disk, USB), size and state; big key figures – temperature with traffic light, wear as a ring, estimated life left, power-on time (hard disks: reallocated sectors and errors instead); data written/read, spare, power cycles, unsafe shutdowns, every error counter; temperature and wear trend
- **Details** per drive: every S.M.A.R.T. value as a table (current, worst, limit, raw value) with an explanation per row; values below the manufacturer's limit are marked
- Problems in plain words – “Reallocated sectors rose from 2 to 8.” instead of attribute numbers
- Warns when error counters **grow** (reallocated, pending and unreadable sectors, media errors → danger; read/write and cable errors → attention), when a drive gets too warm or wears out, when an attribute drops below the manufacturer's limit and when the drive itself reports a problem
- Alerts through Hostwerk's notifications (push, Discord, ntfy, mail – *Live → Alerts*), once per problem and again only when it gets worse; also listed under *Live → Watchers*
- Dashboard tile with the worst drive first; right-click a drive to copy its serial number or check again
- Settings under *Settings → Notifications*: notifications on/off, temperature and wear limits, how often to check (default every 30 minutes)

## Administrator rights

Windows shows programs without administrator rights only **whether** a drive is healthy. Temperature, wear and error
counters need administrator rights – Hostwerk itself keeps running without them:

- **Check with admin rights** – one Windows prompt (UAC), all drives are read at once, the values are kept and shown with
  their time. Uses Hostwerk's own way for administrator commands (`elevatedBatch`, Hostwerk 2.12 or newer).
- **Check regularly** (optional, only after you agree in the dialog) – one Windows prompt sets up the task
  `\Hostwerk\DiskHealth`: it runs as SYSTEM at start-up and every hour, runs **only** the reading script and writes the
  result to `%ProgramData%\HostwerkDiskHealth\smart.json`. Hostwerk reads that file without administrator rights. The
  folder belongs to the administrators (users may only read), so nothing without admin rights can swap the script.
  Switching it off asks once more and removes task and folder. When the extension is uninstalled, the task notices on its
  next run and removes itself and its folder.
- **Linux:** `smartctl` through `pkexec` (one password prompt). Without root, udisks offers temperature, power-on time and
  bad sectors, and `/sys/block` the basics.

Without any of this, the health status Windows reports stays visible – honestly, without made-up values.

## smartmontools (optional)

`smartctl` reads more than Windows: data written, every S.M.A.R.T. attribute and many drives in USB cases. smartmontools is
free software under the GPL and **not** part of this extension. On Windows the page offers to install it with `winget`
(package `smartmontools.smartmontools`, official source – winget checks the SHA-256 of the download); otherwise
[smartmontools.org](https://www.smartmontools.org/wiki/Download). Version 7.0 or newer (JSON output) from *Program Files* is
used – a `smartctl.exe` elsewhere is ignored, because the check runs it with administrator rights.

## Where the values come from

Only **reading** commands – nothing on a drive is ever changed.

| System | Without admin/root rights | With admin/root rights |
|---|---|---|
| Windows | `Get-PhysicalDisk`: health status, type, size | `Get-StorageReliabilityCounter`: temperature, wear, power-on hours, read/write errors – plus `smartctl` when installed |
| Linux | `/sys/block` and udisks (busctl): model, size, temperature, power-on time, bad sectors | `smartctl -j -a` per drive |
| Others | – | `smartctl` when installed and allowed |

Values a system does not reveal are marked “not reported” – unknown is never shown as “no errors”. Life left is a rough
estimate from the wear so far (or its trend over at least 30 days) at the same use.

## Works well with

[Storage per service](https://github.com/Passimoritz/hostwerk-ext-disk-usage) – how full the drive is and who uses the space; this extension shows whether the drive itself is healthy.

## Install

In Hostwerk: **Extensions → Discover** and click “Install”.

Native extensions run as part of Hostwerk (their own server and interface part). That is why Hostwerk installs them only from the official catalog (with checksum) or in developer mode.

## Data and traces

- `data/disk-health/state.json` – the last reading, the last administrator values, a small history per drive (about a month, one sample per hour or on every change) and which problems were already reported. Drives that have been gone for 90 days are forgotten. The file stays when you remove the extension.
- Only with *Check regularly*: the Windows task `\Hostwerk\DiskHealth` and the folder `%ProgramData%\HostwerkDiskHealth` – the page lists both (ⓘ next to the switch); switching off removes them, uninstalling makes the task remove itself.

## Develop

```bash
node --test tests/*.test.js          # tests with recorded outputs of PowerShell, smartctl, udisks and /sys, fake admin prompts
node build-native.js .               # build the interface (sdk/build-native.js from hostwerk-public)
node check.js . --strict             # the same check as the catalog (sdk/check.js)
```

Assessment in `server/health.js` (testable without Hostwerk), reading in `server/probe.js`, administrator scripts and the Windows task in `server/admin.js`, interface in `ui/src`. Texts in the code are English, German is in `locales/de.json`.

## License

MIT
