// updater.test.ts — the update state machine (issue #33).
//
// The UpdaterApi is the system boundary (the Tauri updater/process plugins);
// these tests substitute fakes there and assert on the STATES the UI renders.
// Nothing here touches the network or the real plugins.
//
// Assumptions encoded by the tests (stated before implementation):
//  - The Rust pre-flight (updater_status) settles the check before the plugin
//    is ever called: no-release / unconfigured / offline never reach check().
//  - A missing latest.json (404) is the QUIET no-release state, not an error.
//  - A signature rejection maps to its own 'signature' state — on both the
//    check and the install path.
//  - NOT tested here: the real plugin round-trip (needs a live signed
//    release) and the About tab rendering (HITL).

import { describe, expect, it } from "vitest";
import {
  classifyUpdateError,
  downloadProgressText,
  runCheck,
  runInstall,
  UpdateFlowError,
  type DownloadEvent,
  type PreflightStatus,
  type UpdateResource,
  type UpdaterApi,
} from "./updater";

function fakeUpdate(version: string): UpdateResource {
  return {
    version,
    downloadAndInstall: async () => {},
  };
}

function fakeApi(
  result: Promise<UpdateResource | null>,
  install?: UpdaterApi["install"],
  preflight: PreflightStatus = "ok",
): UpdaterApi {
  return {
    preflight: async () => preflight,
    check: () => result,
    install: install ?? (async () => {}),
    relaunch: () => {},
  };
}

const ERR = (e: unknown) => new Promise<never>((_, reject) => reject(e));

describe("updater runCheck", () => {
  // The pre-flight gate: a verdict that settles the check must never reach
  // the plugin — and a missing feed must read as the QUIET no-release state,
  // not as an error.
  it("maps a preflight no-release (feed not published) to the quiet no-release state", async () => {
    let pluginCalled = false;
    const api: UpdaterApi = {
      preflight: async () => "no-release",
      check: () => {
        pluginCalled = true;
        return new Promise<null>(() => {});
      },
      install: async () => {},
      relaunch: () => {},
    };
    try {
      await runCheck(api);
      expect.unreachable("check must not settle successfully");
    } catch (e) {
      expect((e as UpdateFlowError).state).toEqual({ kind: "no-release" });
      expect(pluginCalled).toBe(false);
    }
  });

  // Pre-signing state: placeholder pubkey → one honest sentence, plugin
  // untouched.
  it("maps a preflight unconfigured verdict to the not-configured state", async () => {
    const api = fakeApi(Promise.resolve(null), undefined, "unconfigured");
    try {
      await runCheck(api);
      expect.unreachable("check must not settle successfully");
    } catch (e) {
      const state = (e as UpdateFlowError).state;
      expect(state).toMatchObject({ kind: "error", errorKind: "not-configured" });
      expect((state as { message: string }).message).toContain("not configured");
    }
  });

  // Offline (transport dead — the ONLY thing that may say offline).
  it("maps a preflight offline verdict to the offline state", async () => {
    const api = fakeApi(Promise.resolve(null), undefined, "offline");
    try {
      await runCheck(api);
      expect.unreachable("check must not settle successfully");
    } catch (e) {
      expect((e as UpdateFlowError).state).toMatchObject({
        kind: "error",
        errorKind: "offline",
      });
    }
  });

  // Up to date: the plugin resolved "no update" (null).
  it("maps a null result to up-to-date with no update handle", async () => {
    const result = await runCheck(fakeApi(Promise.resolve(null)));
    expect(result.state).toEqual({ kind: "up-to-date" });
    expect(result.update).toBeNull();
  });

  // Found: the state carries the new version for the status line.
  it("maps a found update to available with its version", async () => {
    const result = await runCheck(fakeApi(Promise.resolve(fakeUpdate("1.2.3"))));
    expect(result.state).toEqual({ kind: "available", version: "1.2.3" });
    expect(result.update?.version).toBe("1.2.3");
  });

  // Release published without latest.json → graceful no-op, never an error
  // state. GitHub's missing-asset 404 shape.
  it("maps a missing latest.json (404) to the quiet no-release state", async () => {
    const err = new Error("failed to fetch release: status code 404");
    try {
      await runCheck(fakeApi(ERR(err)));
      expect.unreachable("check must fail");
    } catch (e) {
      expect(e).toBeInstanceOf(UpdateFlowError);
      expect((e as UpdateFlowError).state).toEqual({ kind: "no-release" });
    }
  });

  // Offline → a CLEAR message, no crash. The error deliberately embeds the
  // endpoint URL (real transport errors do) — offline must win over the
  // "latest.json" substring that URL contains.
  it("maps a network failure to the offline state with a clear message", async () => {
    const err = new Error(
      "error sending request for url (https://github.com/CrystalPlatforms/klepai/releases/latest/download/latest.json): connection refused",
    );
    try {
      await runCheck(fakeApi(ERR(err)));
      expect.unreachable("check must fail");
    } catch (e) {
      const state = (e as UpdateFlowError).state;
      expect(state).toMatchObject({ kind: "error", errorKind: "offline" });
      expect((state as { message: string }).message).toContain("offline");
    }
  });

  // Signature enforced — a tampered/unsigned bundle is REJECTED. The plugin
  // refuses it; the classification makes the rejection visible.
  it("maps a signature verification failure to the signature state", async () => {
    const err = new Error("signature verification failed: invalid signature");
    try {
      await runCheck(fakeApi(ERR(err)));
      expect.unreachable("check must fail");
    } catch (e) {
      expect((e as UpdateFlowError).state).toMatchObject({
        kind: "error",
        errorKind: "signature",
      });
    }
  });

  // The placeholder pubkey means the updater is not configured.
  it("maps a missing/invalid public key to the not-configured state", async () => {
    const err = new Error("invalid public key");
    try {
      await runCheck(fakeApi(ERR(err)));
      expect.unreachable("check must fail");
    } catch (e) {
      expect((e as UpdateFlowError).state).toMatchObject({
        kind: "error",
        errorKind: "not-configured",
      });
    }
  });

  // Anything unrecognized still renders: generic state carrying the text.
  it("falls back to the unknown state for unrecognized errors", async () => {
    const err = "something entirely new";
    try {
      await runCheck(fakeApi(ERR(err)));
      expect.unreachable("check must fail");
    } catch (e) {
      const state = (e as UpdateFlowError).state;
      expect(state).toMatchObject({ kind: "error", errorKind: "unknown" });
      expect((state as { message: string }).message).toContain("something entirely new");
    }
  });
});

describe("updater runInstall", () => {
  // Progress aggregation: Started sets the total, Progress accumulates.
  it("aggregates Started/Progress events into received/total", async () => {
    const update: UpdateResource = {
      version: "2.0.0",
      downloadAndInstall: async (onEvent) => {
        const events: DownloadEvent[] = [
          { event: "Started", data: { contentLength: 100 } },
          { event: "Progress", data: { chunkLength: 40 } },
          { event: "Progress", data: { chunkLength: 60 } },
          { event: "Finished" },
        ];
        events.forEach((e) => onEvent?.(e));
      },
    };
    const seen: Array<[number, number | null]> = [];
    // The fake api delegates install back to the resource, exactly like the
    // real defaultUpdaterApi does.
    const api: UpdaterApi = {
      ...fakeApi(Promise.resolve(null)),
      install: (u, onEvent) => u.downloadAndInstall(onEvent),
    };
    await runInstall(api, update, (r, t) => seen.push([r, t]));
    expect(seen).toEqual([
      [0, 100],
      [40, 100],
      [100, 100],
    ]);
  });

  // Install path: a bundle rejected at download/verify time surfaces the
  // same signature state — the one-click install fails honestly, never
  // installs a tampered bundle.
  it("surfaces a signature rejection from install as the signature state", async () => {
    const update: UpdateResource = {
      version: "2.0.0",
      downloadAndInstall: async () => {
        throw new Error("signature verification failed");
      },
    };
    try {
      const api: UpdaterApi = {
        ...fakeApi(Promise.resolve(null)),
        install: (u, onEvent) => u.downloadAndInstall(onEvent),
      };
      await runInstall(api, update, () => {});
      expect.unreachable("install must fail");
    } catch (e) {
      expect((e as UpdateFlowError).state).toMatchObject({
        kind: "error",
        errorKind: "signature",
      });
    }
  });
});

describe("classifyUpdateError patterns", () => {
  it("reads DNS/timeout/offline shapes as offline", () => {
    expect(classifyUpdateError("dns error: lookup failed").kind).toBe("offline");
    expect(classifyUpdateError("request timed out after 30s").kind).toBe("offline");
    expect(classifyUpdateError("network appears unreachable").kind).toBe("offline");
  });

  it("reads release-feed 404 shapes as no-release", () => {
    expect(classifyUpdateError("status code 404 Not Found").kind).toBe("no-release");
    expect(classifyUpdateError("no update manifest").kind).toBe("no-release");
  });

  it("never mistakes ordinary fetch wording for no-release (offline wins)", () => {
    // "Could not fetch a valid response" is the plugin's generic network
    // phrasing — it must classify as offline, not as a missing manifest.
    expect(classifyUpdateError("could not fetch a valid response from the endpoint").kind).toBe(
      "offline",
    );
  });
});

describe("downloadProgressText", () => {
  it("shows both sides while the total is known", () => {
    expect(downloadProgressText(128 * 1024 * 1024, 256 * 1024 * 1024)).toBe(
      "128.0 MB of 256.0 MB",
    );
  });

  it("falls back to a bare readout while the total is unknown", () => {
    expect(downloadProgressText(2048 * 1024, null)).toBe("2.0 MB downloaded");
  });
});
