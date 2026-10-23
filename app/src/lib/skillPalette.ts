//! Palette math for the composer's "/" skill palette. Pure logic — the
//! component (ChatPane) owns the DOM; this owns filtering, row shape and
//! keyboard navigation, so the palette behaves identically in Natural and
//! Agent composers.

/** Minimal shape of a Klepai library skill as the palette consumes it. */
export interface PaletteSkill {
  id: number;
  name: string;
  description: string;
  /** Disabled skills stay invisible AND unavailable — the owner decides
   * per skill in Settings; the palette never offers a switched-off one. */
  enabled: boolean;
}

/** One skill row of the palette. `skillId` marks a ONE-SHOT library skill:
 * selecting it attaches the skill to the next outgoing message instead of
 * inserting text (CLI command rows insert text and have no skillId). */
export interface SkillRow {
  label: string;
  hint: string;
  skillId: number;
}

/** Library-skill rows for the palette: enabled skills only, query-filtered.
 * A skill matches when the query (case-insensitive) sits in its name or
 * description; an empty query lists everything. Rows keep library order. */
export function skillRows(skills: PaletteSkill[], query: string): SkillRow[] {
  const q = query.trim().toLowerCase();
  return skills
    .filter((skill) => skill.enabled)
    .filter(
      (skill) =>
        q.length === 0 ||
        skill.name.toLowerCase().includes(q) ||
        skill.description.toLowerCase().includes(q),
    )
    .map((skill) => ({
      label: `/${skill.name}`,
      hint: skill.description,
      skillId: skill.id,
    }));
}

/** Keyboard navigation over the open palette: ArrowDown/ArrowUp return the
 * next selected index (wrapping around), Enter/Tab return the current one
 * (pick), anything else — including Escape, which the component handles —
 * returns null (no selection change). */
export function paletteSelection(
  key: string,
  selected: number,
  count: number,
): number | null {
  if (count === 0) return null;
  switch (key) {
    case "ArrowDown":
      return (selected + 1) % count;
    case "ArrowUp":
      return (selected - 1 + count) % count;
    case "Enter":
    case "Tab":
      return Math.min(selected, count - 1);
    default:
      return null;
  }
}
