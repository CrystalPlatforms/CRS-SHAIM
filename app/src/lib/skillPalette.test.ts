//! Palette math tests (issue #20 S4). The component owns the DOM; these
//! pin the pure logic both composers share — Natural and Agent get the
//! identical rows and navigation because they call the same functions.

import { describe, expect, it } from "vitest";

import { paletteSelection, skillRows, type PaletteSkill } from "./skillPalette";

const LIBRARY: PaletteSkill[] = [
  { id: 1, name: "reviewer", description: "Reviews code like a staff engineer", enabled: true },
  { id: 2, name: "translator", description: "Translates replies to Polish", enabled: true },
  { id: 3, name: "gopher", description: "Writes Go like a gopher", enabled: true },
  { id: 4, name: "ghost", description: "Disabled — invisible and unavailable", enabled: false },
];

describe("skillRows", () => {
  it("lists every ENABLED skill with its /name label and one-shot skillId", () => {
    expect(skillRows(LIBRARY, "")).toEqual([
      { label: "/reviewer", hint: "Reviews code like a staff engineer", skillId: 1 },
      { label: "/translator", hint: "Translates replies to Polish", skillId: 2 },
      { label: "/gopher", hint: "Writes Go like a gopher", skillId: 3 },
    ]);
  });

  it("never offers a disabled skill — invisible in every query", () => {
    expect(skillRows(LIBRARY, "ghost")).toEqual([]);
    expect(skillRows(LIBRARY, "unavailable")).toEqual([]);
  });

  it("filters by the query across name and description, case-insensitively", () => {
    expect(skillRows(LIBRARY, "trans").map((row) => row.label)).toEqual(["/translator"]);
    expect(skillRows(LIBRARY, "POLISH").map((row) => row.label)).toEqual(["/translator"]);
    expect(skillRows(LIBRARY, "go").map((row) => row.label)).toEqual(["/gopher"]);
  });

  it("narrows to nothing for an unknown query", () => {
    expect(skillRows(LIBRARY, "kubernetes")).toEqual([]);
  });

  it("marks rows as one-shot attachments — they never insert text", () => {
    for (const row of skillRows(LIBRARY, "")) {
      expect("insert" in row).toBe(false);
    }
  });
});

describe("paletteSelection", () => {
  it("moves down and wraps past the last row", () => {
    expect(paletteSelection("ArrowDown", 0, 3)).toBe(1);
    expect(paletteSelection("ArrowDown", 2, 3)).toBe(0);
  });

  it("moves up and wraps past the first row", () => {
    expect(paletteSelection("ArrowUp", 1, 3)).toBe(0);
    expect(paletteSelection("ArrowUp", 0, 3)).toBe(2);
  });

  it("picks the highlighted row on Enter and Tab", () => {
    expect(paletteSelection("Enter", 1, 3)).toBe(1);
    expect(paletteSelection("Tab", 2, 3)).toBe(2);
  });

  it("ignores every other key and guards an empty palette", () => {
    expect(paletteSelection("Escape", 0, 3)).toBeNull();
    expect(paletteSelection("a", 0, 3)).toBeNull();
    expect(paletteSelection("ArrowDown", 0, 0)).toBeNull();
  });
});
