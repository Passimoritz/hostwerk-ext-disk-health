![Festplatten-Gesundheit](banner.svg)

# Festplatten-Gesundheit

Zustand jedes Laufwerks auf einen Blick: Temperatur, Abnutzung, Lese- und Schreibfehler und Betriebsstunden (S.M.A.R.T.). Meldet sich über Hostwerks Benachrichtigungen, wenn Fehler wachsen, es zu warm wird oder ein Laufwerk verschleißt. Mit Kachel für die Übersicht.

[English](README.md) · Eine offizielle [Hostwerk](https://github.com/Passimoritz/hostwerk-public)-Erweiterung (SDK 3.0, native Erweiterung)

## Was sie kann

- **Wo:** System → Laufwerks-Gesundheit und Übersichtskachel – seit 1.2.0 ohne eigenen Seitenleisten-Eintrag; die ganze Seite bleibt unter Erweiterungen → Öffnen
- **Statusleiste** oben: alle Laufwerke gesund, ansehen oder gefährdet – mit letzter und nächster Prüfung, dem Alter der Admin-Werte und den Knöpfen *Jetzt prüfen* und *Mit Administratorrechten prüfen*
- **Eine Karte je Laufwerk** im Raster: Modell, Art (NVMe-/SATA-SSD, Festplatte, USB), Größe und Zustand; Kennzahlen im Hostwerk-Stil – Temperatur mit Ampel, Abnutzung mit Balken, geschätzte Restlebensdauer, Betriebszeit (bei Festplatten stattdessen ersetzte Sektoren und Fehler); geschrieben/gelesen, Reserve, Einschaltvorgänge, unsaubere Abschaltungen, jeder Fehlerzähler; Verlauf von Temperatur und Abnutzung
- **Details** je Laufwerk: jeder S.M.A.R.T.-Wert als Tabelle (aktuell, schlechtester, Grenze, Rohwert) mit Erklärung je Zeile; Werte unter der Herstellergrenze sind markiert
- Probleme in klaren Worten – „Ersetzte Sektoren: von 2 auf 8 gestiegen.“ statt Attributnummern
- Warnt, wenn Fehlerzähler **wachsen** (ersetzte, wartende und unlesbare Sektoren, Medienfehler → gefährdet; Lese-/Schreib- und Kabelfehler → ansehen), wenn ein Laufwerk zu warm oder abgenutzt ist, wenn ein Attribut unter die Herstellergrenze fällt und wenn es selbst ein Problem meldet
- Meldet sich über Hostwerks Benachrichtigungen (Push, Discord, ntfy, Mail – *Livebetrieb → Alarme*), einmal je Problem und erst wieder, wenn es schlimmer wird; steht außerdem unter *Livebetrieb → Wächter*
- Kachel für die Übersicht, das schlechteste Laufwerk zuerst; Rechtsklick auf ein Laufwerk kopiert die Seriennummer oder prüft neu
- Einstellungen unter *Einstellungen → Benachrichtigungen*: Benachrichtigungen an/aus, Grenzen für Temperatur und Abnutzung, wie oft geprüft wird (Standard: alle 30 Minuten)

## Administratorrechte

Programmen ohne Administratorrechte zeigt Windows nur, **ob** ein Laufwerk gesund ist. Temperatur, Abnutzung und
Fehlerzähler brauchen Administratorrechte – Hostwerk selbst läuft weiter ohne sie:

- **Mit Administratorrechten prüfen** – eine Windows-Rückfrage (UAC), alle Laufwerke werden auf einmal gelesen, die Werte
  bleiben gespeichert und erscheinen mit Zeitpunkt. Nutzt Hostwerks eigenen Weg für Admin-Befehle (`elevatedBatch`,
  Hostwerk 2.12 oder neuer).
- **Regelmäßig prüfen** (freiwillig, erst nach Zustimmung im Dialog) – eine Windows-Rückfrage richtet die Aufgabe
  `\Hostwerk\DiskHealth` ein: Sie läuft als SYSTEM beim Start und stündlich, führt **nur** das Lese-Skript aus und schreibt
  das Ergebnis nach `%ProgramData%\HostwerkDiskHealth\smart.json`. Hostwerk liest die Datei ohne Administratorrechte. Der
  Ordner gehört den Administratoren (Benutzer dürfen nur lesen) – ohne Admin-Rechte kann niemand das Skript austauschen.
  Abschalten fragt noch einmal nach und entfernt Aufgabe und Ordner. Wird die Erweiterung deinstalliert, merkt die Aufgabe
  das beim nächsten Lauf und entfernt sich samt Ordner selbst.
- **Linux:** `smartctl` über `pkexec` (eine Passwortabfrage). Ohne root liefert udisks Temperatur, Betriebszeit und defekte
  Sektoren, `/sys/block` das Nötigste.

Ohne all das bleibt der Zustand sichtbar, den Windows meldet – ehrlich, ohne ausgedachte Werte.

## smartmontools (freiwillig)

`smartctl` liest mehr als Windows: geschriebene Daten, jedes S.M.A.R.T.-Attribut und viele Laufwerke in USB-Gehäusen.
smartmontools ist freie Software unter der GPL und **kein** Teil dieser Erweiterung. Unter Windows bietet die Seite an, es
mit `winget` zu installieren (Paket `smartmontools.smartmontools`, offizielle Quelle – winget prüft die SHA-256 des
Downloads); sonst [smartmontools.org](https://www.smartmontools.org/wiki/Download). Genutzt wird Version 7.0 oder neuer
(JSON-Ausgabe) aus *Programme* – eine `smartctl.exe` woanders bleibt außen vor, weil die Prüfung sie mit Administratorrechten startet.

## Woher die Werte kommen

Nur **lesende** Befehle – an einem Laufwerk wird nie etwas verändert.

| System | Ohne Administrator-/root-Rechte | Mit Administrator-/root-Rechten |
|---|---|---|
| Windows | `Get-PhysicalDisk`: Zustand, Art, Größe | `Get-StorageReliabilityCounter`: Temperatur, Abnutzung, Betriebsstunden, Lese-/Schreibfehler – dazu `smartctl`, wenn installiert |
| Linux | `/sys/block` und udisks (busctl): Modell, Größe, Temperatur, Betriebszeit, defekte Sektoren | `smartctl -j -a` je Laufwerk |
| Andere | – | `smartctl`, wenn installiert und erlaubt |

Was ein System nicht verrät, steht als „nicht gemeldet“ da – unbekannt erscheint nie als „keine Fehler“. Die
Restlebensdauer ist eine grobe Schätzung aus der bisherigen Abnutzung (oder ihrem Verlauf über mindestens 30 Tage) bei
gleicher Nutzung.

## Passt gut zu

[Speicher je Dienst](https://github.com/Passimoritz/hostwerk-ext-disk-usage) – wie voll das Laufwerk ist und wer den Platz belegt; diese Erweiterung zeigt, ob das Laufwerk selbst gesund ist.

## Installieren

In Hostwerk: **Erweiterungen → Entdecken** und „Installieren“ klicken.

Native Erweiterungen laufen als Teil von Hostwerk (eigener Server- und Oberflächen-Teil). Deshalb installiert Hostwerk sie nur aus dem offiziellen Katalog (mit Prüfsumme) oder im Entwickler-Modus.

## Daten und Spuren

- `data/disk-health/state.json` – die letzte Messung, die letzten Admin-Werte, ein kleiner Verlauf je Laufwerk (etwa ein Monat, eine Messung je Stunde oder bei jeder Änderung) und welche Probleme schon gemeldet wurden. Laufwerke, die 90 Tage fehlen, werden vergessen. Beim Entfernen der Erweiterung bleibt die Datei erhalten.
- Nur mit *Regelmäßig prüfen*: die Windows-Aufgabe `\Hostwerk\DiskHealth` und der Ordner `%ProgramData%\HostwerkDiskHealth` – die Seite zeigt beide (ⓘ neben dem Schalter); Abschalten entfernt sie, beim Deinstallieren entfernt sich die Aufgabe selbst.

## Entwickeln

```bash
node --test tests/*.test.js          # Tests mit aufgezeichneten Ausgaben von PowerShell, smartctl, udisks und /sys, Admin-Rückfragen als Attrappe
node build-native.js .               # Oberfläche bauen (sdk/build-native.js aus hostwerk-public)
node check.js . --strict             # dieselbe Prüfung wie der Katalog (sdk/check.js)
```

Auswertung in `server/health.js` (ohne Hostwerk testbar), Lesen in `server/probe.js`, Admin-Skripte und Windows-Aufgabe in `server/admin.js`, Oberfläche in `ui/src`. Texte im Code sind Englisch, Deutsch steht in `locales/de.json`.

## Lizenz

MIT
