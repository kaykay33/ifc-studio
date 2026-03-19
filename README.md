# IFC-Studio

Browser-basierter BIM-Viewer mit exakter IFC-Geometrie — läuft komplett im Browser, kein Server nötig.

## Features

- IFC2x3 / IFC4 / IFC4x3 laden (per Datei-Dialog oder Drag & Drop)
- 3D-Ansicht mit Three.js und web-ifc WASM
- Räumliche Struktur, Typen und Geschosse als Baumansicht
- Attribute und Property Sets je Element
- Auswahl, Ausblenden, Isolieren von Elementen
- IFC-Export

## Deployment

Der Build läuft automatisch via GitHub Actions bei jedem Push auf `main` und wird auf **GitHub Pages** veröffentlicht.

```
https://<username>.github.io/ifc-studio/
```

## Lokale Entwicklung

```bash
npm install
npm run dev
```
