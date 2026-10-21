/**
 * Anonymous launch counter (issue #31). Each production launch increments
 * one public counter — no identifiers, no content, no cookies, just a
 * number going up so we can tell roughly how many people run Shaim.
 *
 * counterapi.dev v2 needs a key (v1 was retired): create a free account at
 * https://counterapi.dev/signup, generate an API key in the dashboard and
 * paste it into DEFAULT_API_KEY below. An empty key turns analytics off —
 * the app works exactly the same without it.
 *
 * Dev builds (`tauri dev`), unit tests and plain-browser runs never send
 * anything: only a packaged launch inside the Tauri shell counts.
 */

const APP_OPEN_URL = "https://api.counterapi.dev/v2/crystals-team-5978/klepai/up";

/** counterapi.dev API key — see the comment at the top of this file. */
const DEFAULT_API_KEY = "ut_YPPLUOS9GRl769RklGtzR1niZg7Ix1LRzjulndet";

/** Guards against a second count within the same running session. */
let counted = false;

export function trackAppOpen(apiKey: string = DEFAULT_API_KEY): void {
  // No key configured — analytics is simply off.
  if (!apiKey.trim()) return;
  // Vite flags dev server and test runs as DEV — packaged builds only, then.
  if (import.meta.env.DEV) return;
  // And only when the renderer runs inside the Tauri shell, never in a
  // bare browser tab (vite preview etc.).
  if (!("__TAURI_INTERNALS__" in window)) return;
  if (counted) return;
  counted = true;

  // Fire-and-forget: analytics must never delay startup or surface an
  // error — an offline machine just doesn't count.
  fetch(APP_OPEN_URL, {
    cache: "no-store",
    headers: { Authorization: `Bearer ${apiKey.trim()}` },
  }).catch(() => {});
}
