# Klepai — desktop app

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

SQLite leży w katalogu app-data macOS: `~/Library/Application Support/com.crystalplatforms.klepai/klepai.db`.

## Ikona

Źródło: `assets/transparent/klepai-icon-trans.png` (przezroczyste tło) → przycięcie pustego paddingu → **tryb `tile`** (ciemny kafel + glif na 80% — kompozycja jak ikona umux) → ikony wszystkich platform.

```bash
cd app
python3 -c "from PIL import Image; img=Image.open('../assets/transparent/klepai-icon-trans.png').convert('RGBA'); t=img.crop(img.getchannel('A').getbbox()); m=round(max(t.size)*0.04); c=Image.new('RGBA',(t.width+2*m,t.height+2*m),(0,0,0,0)); c.paste(t,(m,m)); c.save('/tmp/klepai-trim.png')"
swift scripts/make-icon.swift /tmp/klepai-trim.png icon-source-rounded.png tile
npx tauri icon icon-source-rounded.png   # odświeża src-tauri/icons/ (macOS/Windows/Linux)
```

## Aktualizacje (Updates)

Klepai aktualizuje się przez **GitHub Releases** — nie ma serwera aktualizacji (polityka zero-cost). Przepływ:

1. **Ręczny check.** **Settings → About → Check for updates** pyta feed releases i raportuje uczciwie: aktualna wersja, dostępna aktualizacja, offline, brak feedu ("No update information published yet"), albo — dopóki nie ustawiony jest klucz podpisu — **"Updates are not configured yet"** (oczekiwany stan przed krokiem maintainera; aplikacja nigdy nie myli tego z brakiem internetu).
2. **Instalacja jednym kliknięciem.** Gdy aktualizacja jest dostępna, przycisk **Download & restart** pobiera, aplikuje i restartuje aplikację w nowej wersji.

Weryfikacja podpisu jest **wymuszona**: każdy pakiet aktualizacji jest podpisany, a Klepai odmawia instalacji czegokolwiek, czego podpis nie weryfikuje się wbudowanym kluczem publicznym.

### Maintainer: klucze podpisu i sekrety

Jednorazowy setup (na maszynie, która buduje releasy):

1. Wygeneruj darmowy klucz podpisu:

   ```bash
   npm run tauri signer generate -- -w ~/.tauri/klepai.key
   ```

   Wypisze **klucz publiczny** i zapisze prywatny w `~/.tauri/klepai.key` (obok powstaje `~/.tauri/klepai.key.pub`). Hasło opcjonalne. Ponowne uruchomienie wymaga `--force`.

2. Wklej **klucz publiczny** do `src-tauri/tauri.conf.json` pod `plugins.updater.pubkey` (zastępuje placeholder `PASTE_PUBLIC_KEY_FROM_TAURI_SIGNER_GENERATE`).

3. Dodaj dwa sekrety w repozytorium GitHub (**Settings → Secrets and variables → Actions**):
   - `TAURI_SIGNING_PRIVATE_KEY` — *zawartość* `~/.tauri/klepai.key`
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — hasło (puste jest OK)

   Dopóki ich nie ma, release workflow padnie na kroku podpisywania — to celowe; niepodpisany pakiet aktualizacji zostałby odrzucony przez każdego klienta.

4. **Lokalny `tauri build` też potrzebuje klucza** (bundlowanie produkuje podpisane artefakty aktualizacji):

   ```bash
   export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/klepai.key)"
   export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
   ```

   `npm run tauri dev` nie potrzebuje klucza — development nigdy nie bundluje.

5. **Publikacja feedu**: w releasie na GitHubie musi się znaleźć `latest.json` (generowany przez `tauri build` przy `createUpdaterArtifacts: true`) wraz z podpisanymi artefaktami — wtedy podpięty endpoint `releases/latest/download/latest.json` zacznie odpowiadać.
