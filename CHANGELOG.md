## 1.3.4

- The package contains only the files of the repository – no leftovers of the test run (the catalog had rejected 1.3.3). / Das Paket enthält nur die Dateien des Repositorys – keine Reste des Testlaufs (der Katalog hatte 1.3.3 abgelehnt).

## 1.3.3

- New animated icon and banner in the common Hostwerk style (isometric block). / Neues animiertes Symbol und Banner im gemeinsamen Hostwerk-Stil (isometrischer Block).

## 1.3.2

- “Show values” and the serial number sit in the card head instead of an own foot line – one line less per drive / „Werte zeigen“ und die Seriennummer stehen im Kartenkopf statt in einer eigenen Fußzeile – eine Zeile weniger je Laufwerk

## 1.3.1

- Page head like every Hostwerk page: one sentence under the title, the longer explanation stays behind ⓘ. / Seitenkopf wie jede Hostwerk-Seite: ein Satz unter dem Titel, die längere Erklärung bleibt hinter ⓘ.

## 1.3.0

- Traces (Hostwerk 3.0+, SDK 3.3): the Windows task `\Hostwerk\DiskHealth` and the folder `%ProgramData%\HostwerkDiskHealth` are reported to Hostwerk – listed in the extension pop-up under "What it set up on your PC" and removed with one administrator prompt when you uninstall the extension (ticked in the uninstall dialog, also in maintenance and "Remove Hostwerk"). Existing set-ups are reported on the next start. The task's own clean-up stays as the fallback for older Hostwerk versions. / Spuren (Hostwerk 3.0+, SDK 3.3): Die Windows-Aufgabe `\Hostwerk\DiskHealth` und der Ordner `%ProgramData%\HostwerkDiskHealth` werden Hostwerk gemeldet – im Erweiterungs-Pop-up unter „Was sie auf deinem PC angelegt hat“ und beim Deinstallieren mit einer Administrator-Rückfrage entfernt (angehakt im Deinstallieren-Dialog, auch in der Wartung und bei „Hostwerk entfernen“). Bestehende Einrichtungen meldet sie beim nächsten Start. Das Selbstaufräumen der Aufgabe bleibt als Rückfall für ältere Hostwerk-Versionen.
- Uninstall hook: when the task is removed along with the extension, the schedule counts as off. / Entfernen-Haken: Wird die Aufgabe beim Deinstallieren mit entfernt, gilt der Zeitplan als aus.

## 1.2.1

- Drive cards in Hostwerk's own style (card head, stat tiles like System → Resources, badges): the grid uses the full width (one drive no longer sits in a 380 px column), key figures arrange themselves in as many columns as fit, labels wrap instead of being cut, the ⓘ sits behind the label, texts like "Too early to say" appear in normal size instead of being split syllable by syllable; the card foot (details, "read …", serial number) wraps cleanly instead of overlapping. / Laufwerkskarten im Hostwerk-Stil (Kartenkopf, Kennzahl-Kacheln wie System → Ressourcen, Abzeichen): das Raster nutzt die ganze Breite (ein Laufwerk steckt nicht mehr in einer 380-px-Spalte), Kennzahlen ordnen sich in so vielen Spalten an, wie Platz ist, Beschriftungen brechen um statt abgeschnitten zu werden, das ⓘ steht hinter der Beschriftung, Texte wie „Noch zu früh für eine Schätzung“ erscheinen in normaler Größe statt silbenweise umgebrochen; die Fußzeile (Details, „gelesen …“, Seriennummer) bricht sauber um statt sich zu überlagern.
- Values Windows does not report for a drive (e.g. power-on hours of many NVMe SSDs) say so – "Windows does not report it", smartmontools can read it – instead of a bare "–". / Werte, die Windows für ein Laufwerk nicht meldet (z. B. Betriebsstunden vieler NVMe-SSDs), sagen das – „Meldet Windows nicht“, smartmontools kann es lesen – statt eines nackten „–“.

## 1.2.0

- Lives where it belongs: System → Drive health and the dashboard tile – no own sidebar entry any more (Hostwerk 3.0+); the full page stays under Extensions → Open and can be pinned in the sidebar settings. / Steckt jetzt dort, wo sie hingehört: System → Laufwerks-Gesundheit und Übersichtskachel – kein eigener Seitenleisten-Eintrag mehr (Hostwerk 3.0+); die ganze Seite bleibt unter Erweiterungen → Öffnen und lässt sich in den Seitenleisten-Einstellungen anheften.

## 1.1.0

- Check with administrator rights: one Windows prompt (Hostwerk's elevatedBatch, Hostwerk 2.12+) reads temperature, wear, power-on hours and every error counter of all drives at once; the values are kept and shown with their time. Linux: smartctl through pkexec, udisks without root. / Mit Administratorrechten prüfen: eine Windows-Rückfrage (Hostwerks elevatedBatch, ab Hostwerk 2.12) liest Temperatur, Abnutzung, Betriebsstunden und jeden Fehlerzähler aller Laufwerke auf einmal; die Werte bleiben gespeichert und erscheinen mit Zeitpunkt. Linux: smartctl über pkexec, udisks ohne root.
- Check regularly (optional, after agreeing in a dialog): Windows task \Hostwerk\DiskHealth (SYSTEM, hourly) that only runs the reading script and writes to %ProgramData%\HostwerkDiskHealth (admin-only folder); switching off removes task and folder, uninstalling makes the task remove itself. / Regelmäßig prüfen (freiwillig, nach Zustimmung im Dialog): Windows-Aufgabe \Hostwerk\DiskHealth (SYSTEM, stündlich), die nur das Lese-Skript ausführt und nach %ProgramData%\HostwerkDiskHealth schreibt (Ordner nur für Administratoren); Abschalten entfernt Aufgabe und Ordner, beim Deinstallieren entfernt sich die Aufgabe selbst.
- smartmontools (optional, separate download, GPL): install through winget on Windows (checksum checked by winget), version 7.0+ from Program Files only – data written, every S.M.A.R.T. attribute, USB drives. / smartmontools (freiwillig, eigener Download, GPL): unter Windows per winget installieren (Prüfsumme prüft winget), nur Version 7.0+ aus „Programme“ – geschriebene Daten, jedes S.M.A.R.T.-Attribut, USB-Laufwerke.
- New interface: status bar with overall state, last/next check and actions; drive cards in a grid with temperature traffic light, wear ring, estimated life left, data written, trends and a details table of every value with explanations; compact hints instead of big banners; explanations as ⓘ pop-ups (the wear explanation no longer opens as a narrow column). / Neue Oberfläche: Statusleiste mit Gesamtzustand, letzter/nächster Prüfung und Aktionen; Laufwerkskarten im Raster mit Temperatur-Ampel, Abnutzungsring, geschätzter Restlebensdauer, geschriebenen Daten, Verlauf und Detailtabelle aller Werte mit Erklärung; kompakte Hinweise statt großer Balken; Erklärungen als ⓘ-Pop-up (die Erklärung zur Abnutzung klappt nicht mehr als schmale Spalte auf).
- Alerts for attributes below the manufacturer's limit; an old temperature from an earlier check is no longer judged. / Meldung bei Attributen unter der Herstellergrenze; eine alte Temperatur aus einer früheren Prüfung wird nicht mehr bewertet.

## 1.0.0

- First release: health, temperature, wear and error counters per drive (Windows: PowerShell storage cmdlets, Linux: smartctl or /sys), alerts through Hostwerk's notifications when errors grow, a drive runs hot or wears out, dashboard tile. / Erste Fassung: Zustand, Temperatur, Abnutzung und Fehlerzähler je Laufwerk (Windows: PowerShell-Speicherbefehle, Linux: smartctl oder /sys), Meldung über Hostwerks Benachrichtigungen bei wachsenden Fehlern, Hitze oder Verschleiß, Kachel für die Übersicht.
