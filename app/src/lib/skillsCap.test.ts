//! Cap-warning logic for Settings → Skills.
//!
//! Assumptions these tests encode:
//! - The warning watches the SUM of `size_bytes` across *enabled* skills
//!   only — disabled skills never reach request assembly.
//! - The cap is 32 KiB (owner's choice); hitting it exactly is fine, only
//!   exceeding it warns.
//! - Sizes render in KiB with one decimal (B below 1 KiB).

import { describe, expect, it } from "vitest";

import type { StoredSkill } from "@/types";
import {
  SKILL_SIZE_CAP_BYTES,
  enabledTotalSize,
  formatBytes,
  isOverCap,
} from "@/lib/skillsCap";

function skill(overrides: Partial<StoredSkill>): StoredSkill {
  return {
    id: 1,
    name: "demo",
    description: "",
    kind: "markdown",
    enabled: false,
    path: "/tmp/demo.md",
    size_bytes: 0,
    created_at: 0,
    ...overrides,
  };
}

describe("enabledTotalSize", () => {
  it("sums only enabled skills", () => {
    const skills = [
      skill({ id: 1, enabled: true, size_bytes: 1000 }),
      skill({ id: 2, enabled: false, size_bytes: 5000 }),
      skill({ id: 3, enabled: true, size_bytes: 234 }),
    ];
    expect(enabledTotalSize(skills)).toBe(1234);
  });

  it("is zero for an empty or all-disabled list", () => {
    expect(enabledTotalSize([])).toBe(0);
    expect(enabledTotalSize([skill({ enabled: false, size_bytes: 99 })])).toBe(0);
  });
});

describe("isOverCap", () => {
  it("stays quiet at the cap and warns past it", () => {
    expect(isOverCap(SKILL_SIZE_CAP_BYTES)).toBe(false);
    expect(isOverCap(SKILL_SIZE_CAP_BYTES + 1)).toBe(true);
    expect(isOverCap(0)).toBe(false);
  });
});

describe("formatBytes", () => {
  it("renders B below 1 KiB and KiB above", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KiB");
    expect(formatBytes(32 * 1024)).toBe("32.0 KiB");
  });
});
