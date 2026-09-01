# Agentic Offinger Web

Web-Version der iPad-App [agentic-offinger](https://github.com/bernhardkreminski/agentic-offinger):
3D-Visualisierung von BTLX-Dateien für die Arbeitsvorbereitung im Holzbau.

**Live:** https://bernhardkreminski.github.io/agentic-offinger-web/

## Funktionen

Funktionsgleich mit der iPad-App:

- **BTLX-Import** — über den Dateidialog oder per Drag & Drop. Die mitgelieferte
  `data/testfile.btlx` wird beim Laden der Seite automatisch geöffnet.
- **3D-Ansicht** — Orbit/Pan/Zoom, Standardansichten (Iso, Ansicht, Rückseite,
  Draufsicht, Seitlich), Kantendarstellung, Einpassen.
- **Schichten** — aus der Bauteillage entlang der Elementnormale abgeleitet:
  `RW` (Rahmenwerk), `BS1…` (Beplankung Seite 1 …), `IS1…` (Innenseite …).
  Mehrere Schichten gleichzeitig sichtbar, einzeln isolierbar, ausgeblendete Schichten
  optional als Geist, Schichten stufenlos auseinanderziehbar.
- **Bemaßung** — Maßketten mit einem Teilstrich an jeder Bauteilkante, Gesamtmaße und
  eine Beschriftung je Bauteil (Positionsnummer, Bezeichnung, Ansichtsfläche). Die Ketten
  leiten sich aus den *sichtbaren* Schichten ab und ändern sich beim Umschalten mit.
- **Bauteilinfo** — Klick im 3D-Modell oder Auswahl in der Schichtliste zeigt alle
  Attribute: Produktionslisten-Nr., Bezeichnung, Material, Elementnummer, Baugruppe,
  Auftragsnummer, Geschoss, Stückzahl, Abmessungen, Gewicht, Lage/Achsen, Schwerpunkt,
  Bounding Box, GUID und sämtliche Bearbeitungen mit Parametern.

## Technik

Statische Seite ohne Build-Schritt — reines ES-Modul-JavaScript. Einzige
Fremdbibliothek ist **three.js r169** (MIT), fest im Repository unter `vendor/`
abgelegt, damit die Seite ohne CDN und ohne Netzwerkabhängigkeit läuft. Auf dem Web gibt
es keine Entsprechung zu SceneKit; alles Übrige ist eigener Code.

| Bereich | Datei |
| --- | --- |
| BTLX-Parser | `js/btlx-parser.js` |
| Schichtableitung | `js/layer-classifier.js` |
| Mesh-Aufbereitung | `js/geometry-factory.js` |
| Bemaßung | `js/dimension-overlay.js` |
| Szene und Kamera | `js/model-scene.js` |
| Oberfläche | `js/ui.js`, `js/app.js` |

BTLX ist millimeterbasiert und Z-oben, three.js metrisch und Y-oben. Beide Umrechnungen
sitzen auf einem einzigen Orientierungsknoten, damit die Bauteil-Meshes ihre originale
BTLX-Transformation behalten und direkt mit den Zahlen im Inspektor vergleichbar bleiben.

## Lokal starten

Die Seite braucht einen HTTP-Server, weil sie ES-Module und `fetch` verwendet:

```
python3 -m http.server 4173
```

Dann http://localhost:4173 öffnen.
