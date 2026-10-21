![Festplatten-Gesundheit](banner.svg)

# Festplatten-Gesundheit

Zustand jedes Laufwerks auf einen Blick: Temperatur, Abnutzung, Lese- und Schreibfehler und Betriebsstunden (S.M.A.R.T.). Meldet sich über Hostwerks Benachrichtigungen, wenn Fehler wachsen, es zu warm wird oder ein Laufwerk verschleißt. Mit Kachel für die Übersicht.

[English](README.md) · Eine offizielle [Hostwerk](https://github.com/Passimoritz/hostwerk-public)-Erweiterung (SDK 2.7, native Erweiterung)

## Was sie kann

- Eine Karte je Laufwerk: Zustand, Temperatur mit Verlauf, Abnutzung (SSD), Betriebszeit und jeder Fehlerzähler, den das Laufwerk verrät
- Probleme in klaren Worten – „Ersetzte Sektoren: von 2 auf 8 gestiegen.“ statt Attributnummern
- Warnt, wenn Fehlerzähler **wachsen** (ersetzte, wartende und unlesbare Sektoren, Medienfehler → gefährdet; Lese-/Schreib- und Kabelfehler → ansehen), wenn ein Laufwerk zu warm oder abgenutzt ist und wenn es selbst ein Problem meldet
- Meldet sich über Hostwerks Benachrichtigungen (Push, Discord, ntfy, Mail – *Livebetrieb → Alarme*), einmal je Problem und erst wieder, wenn es schlimmer wird; steht außerdem unter *Livebetrieb → Wächter*
- Kachel für die Übersicht, das schlechteste Laufwerk zuerst; Rechtsklick auf ein Laufwerk kopiert die Seriennummer oder prüft neu
- Einstellungen unter *Einstellungen → Benachrichtigungen*: Benachrichtigungen an/aus, Grenzen für Temperatur und Abnutzung, wie oft geprüft wird (Standard: alle 30 Minuten)

## Woher die Werte kommen

Nur **lesende** Befehle – an einem Laufwerk wird nie etwas verändert.

| System | Quelle | Ohne Administrator-/root-Rechte |
|---|---|---|
| Windows | `Get-PhysicalDisk` und `Get-StorageReliabilityCounter` (PowerShell) | Zustand und Art; Temperatur, Abnutzung und Zähler gibt es, wenn Hostwerk als Administrator läuft |
| Linux | `smartctl -j -a` (smartmontools) | Laufwerke, die smartctl nicht öffnen darf, kommen aus `/sys/block` (Modell, Größe, SSD/HDD, Temperatur, wo der Kernel sie anbietet, Ein-/Ausgabefehler) |
| Linux ohne smartctl | `/sys/block` | wie oben – die Seite schlägt vor, smartmontools zu installieren |

Was ein System nicht verrät, bleibt „–“ – unbekannt erscheint nie als „keine Fehler“.

## Passt gut zu

[Speicher je Dienst](https://github.com/Passimoritz/hostwerk-ext-disk-usage) – wie voll das Laufwerk ist und wer den Platz belegt; diese Erweiterung zeigt, ob das Laufwerk selbst gesund ist.

## Installieren

In Hostwerk: **Erweiterungen → Entdecken** und „Installieren“ klicken.

Native Erweiterungen laufen als Teil von Hostwerk (eigener Server- und Oberflächen-Teil). Deshalb installiert Hostwerk sie nur aus dem offiziellen Katalog (mit Prüfsumme) oder im Entwickler-Modus.

## Daten

`data/disk-health/state.json` – die letzte Messung, ein kleiner Verlauf je Laufwerk (etwa ein Monat, eine Messung je Stunde oder bei jeder Änderung) und welche Probleme schon gemeldet wurden. Laufwerke, die 90 Tage fehlen, werden vergessen. Beim Entfernen der Erweiterung bleibt die Datei erhalten.

## Entwickeln

```bash
node --test tests/*.test.js          # Tests mit aufgezeichneten Ausgaben von PowerShell, smartctl und /sys
node build-native.js .               # Oberfläche bauen (sdk/build-native.js aus hostwerk-public)
node check.js . --strict             # dieselbe Prüfung wie der Katalog (sdk/check.js)
```

Auswertung in `server/health.js` (ohne Hostwerk testbar), Lesen in `server/probe.js`, Oberfläche in `ui/src`. Texte im Code sind Englisch, Deutsch steht in `locales/de.json`.

## Lizenz

MIT
