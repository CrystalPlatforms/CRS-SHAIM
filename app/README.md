# Shaim — desktop app

Tauri v2: React + TypeScript + Tailwind (frontend) w `src/`, Rust core w `src-tauri/`.

## Uruchamianie

```bash
cd app
npm install            # tylko pierwszy raz
npm run tauri dev      # aplikacja z hot-reloadem UI
npm run tauri build    # produkcyjny bundle macOS (.app + .dmg w src-tauri/target/release/bundle/)
```

Frontend samodzielnie: `npm run dev` (Vite) / `npm run build` (typy + `dist/`).

## Testy Rust

```bash
cd app/src-tauri
cargo test
```

## Dane

SQLite leży w katalogu app-data macOS: `~/Library/Application Support/com.crystalplatforms.shaim/shaim.db`.

## Ikona

Źródło: `assets/shaim-icon.PNG` → kwadrat 1024 → kształt macOS (squircle 824 na przezroczystym płótnie 1024) → ikony wszystkich platform.

```bash
cd app
sips --resampleHeightWidthMax 1024 ../assets/shaim-icon.PNG --out /tmp/shaim-fit.png
sips --padToHeightWidth 1024 1024 --padColor 0A0A0A /tmp/shaim-fit.png --out icon-source.png
swift scripts/make-icon.swift icon-source.png icon-source-rounded.png
npx tauri icon icon-source-rounded.png   # odświeża src-tauri/icons/ (macOS/Windows/Linux)
```
