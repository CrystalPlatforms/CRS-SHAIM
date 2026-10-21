//! Anonymous launch counter (issue #31).
//!
//! Assumptions these tests encode:
//! - Only a packaged launch inside the Tauri shell counts: dev builds and
//!   unit tests (Vite `DEV`) and plain-browser runs (no `__TAURI_INTERNALS__`)
//!   stay silent.
//! - An empty API key keeps analytics off entirely (counterapi v2 needs a
//!   key; the app must run fine without one).
//! - One running session counts at most once, even if the hook fires twice,
//!   and the key travels as a Bearer header.
//! - A failing network never throws — analytics is fire-and-forget.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as Analytics from "./analytics";

const APP_OPEN_URL = "https://api.counterapi.dev/v2/crystals-team-5978/klepai/up";
const TAURI = "__TAURI_INTERNALS__";

/** Fresh module per test so the one-shot launch guard resets. */
const load = () => import("./analytics") as Promise<typeof Analytics>;

/** Tauri v2 injects its marker global straight onto the window object. */
const windowBag = () => window as unknown as Record<string, unknown>;

describe("trackAppOpen", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 200 })));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    delete windowBag()[TAURI];
  });

  it("stays silent in dev builds (tauri dev, unit tests)", async () => {
    const { trackAppOpen } = await load();
    trackAppOpen("test-key");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stays silent outside the Tauri shell (plain browser tab)", async () => {
    vi.stubEnv("DEV", false);
    const { trackAppOpen } = await load();
    trackAppOpen("test-key");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stays off until an API key is configured", async () => {
    vi.stubEnv("DEV", false);
    windowBag()[TAURI] = {};
    const { trackAppOpen } = await load();
    trackAppOpen("");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("counts exactly one app_open with the key as a Bearer header", async () => {
    vi.stubEnv("DEV", false);
    windowBag()[TAURI] = {};
    const { trackAppOpen } = await load();
    trackAppOpen("test-key");
    trackAppOpen("test-key");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      APP_OPEN_URL,
      expect.objectContaining({
        cache: "no-store",
        headers: { Authorization: "Bearer test-key" },
      }),
    );
  });

  it("swallows network failures quietly", async () => {
    vi.stubEnv("DEV", false);
    windowBag()[TAURI] = {};
    fetchMock.mockReturnValue(Promise.reject(new Error("offline")));
    const { trackAppOpen } = await load();
    expect(() => trackAppOpen("test-key")).not.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
