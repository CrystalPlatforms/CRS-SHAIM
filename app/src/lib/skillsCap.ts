//! Cap-warning math for Settings → Skills. The heavy lifting (size
//! accounting) lives in the Rust SkillStore; this is the pure presentation
//! logic the tab renders from.

import type { StoredSkill } from "@/types";

/** Total content budget (bytes) for enabled skills before Settings warns.
 * Kept in sync with `skills::SIZE_CAP_BYTES` (32 KiB) — the owner's chosen
 * prompt budget for server-model conversations. */
export const SKILL_SIZE_CAP_BYTES = 32 * 1024;

/** Sum of content sizes across the enabled set only. */
export function enabledTotalSize(skills: StoredSkill[]): number {
  return skills
    .filter((skill) => skill.enabled)
    .reduce((total, skill) => total + skill.size_bytes, 0);
}

/** Exceeding the cap warns; sitting exactly at it is fine. */
export function isOverCap(totalBytes: number, cap = SKILL_SIZE_CAP_BYTES): boolean {
  return totalBytes > cap;
}

/** Human-readable size: bytes below 1 KiB, KiB with one decimal above. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  return `${(bytes / 1024).toFixed(1)} KiB`;
}
