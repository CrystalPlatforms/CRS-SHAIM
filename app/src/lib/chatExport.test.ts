import { describe, expect, it } from "vitest";

import type { Message } from "@/types";
import {
  EXPORT_FORMATS,
  buildExportFile,
  bytesToBase64,
} from "./chatExport";

const base = (over: Partial<Message>): Message => ({
  id: 1,
  conversation_id: 1,
  role: "user",
  content: "",
  thinking: null,
  images: [],
  skill_name: null,
  created_at: 0,
  ...over,
});

const conversation = (messages: Message[]) => messages;

const TINY = conversation([
  base({ id: 1, role: "user", content: "Cześć, jak masz na imię?" }),
  base({ id: 2, role: "assistant", content: "Nazywam się **Klepai**." }),
]);

describe("buildExportFile", () => {
  it("offers exactly the six requested formats", () => {
    expect(EXPORT_FORMATS.map((f) => f.extension)).toEqual([
      "md", "txt", "rtf", "odt", "docx", "pdf",
    ]);
  });

  it("names the file after the conversation title and date", () => {
    const file = buildExportFile("Plan nedzieli", TINY, "md", new Date("2026-10-19T12:00:00Z"));
    expect(file.filename).toBe("Plan nedzieli-2026-10-19.md");
  });

  it("strips characters that break file names", () => {
    const file = buildExportFile('a/b: c*d?"e<f>g|h', TINY, "txt");
    expect(file.filename).not.toMatch(/[/\\:*?"<>|]/);
  });

  it("renders markdown with speakers and an export footer", () => {
    const md = new TextDecoder().decode(
      buildExportFile("Chat", TINY, "md").bytes,
    );
    expect(md).toContain("# Chat");
    expect(md).toContain("**You**");
    expect(md).toContain("Cześć, jak masz na imię?");
    expect(md).toContain("**Assistant**");
    expect(md).toContain("Exported from Klepai");
  });

  it("renders plain text with bracketed speakers", () => {
    const txt = new TextDecoder().decode(
      buildExportFile("Chat", TINY, "txt").bytes,
    );
    expect(txt).toContain("[You]");
    expect(txt).toContain("[Assistant]");
    expect(txt).toContain("Nazywam się **Klepai**.");
  });

  it("writes a valid RTF header and escapes braces", () => {
    const rtf = new TextDecoder().decode(
      buildExportFile("Chat", [...TINY, base({ content: "code {x} \\ y" })], "rtf").bytes,
    );
    expect(rtf.startsWith("{\\rtf1\\ansi")).toBe(true);
    expect(rtf.endsWith("}")).toBe(true);
    expect(rtf).toContain("\\{x\\}");
    expect(rtf).toContain("\\\\ y");
  });

  it("encodes non-latin characters as RTF unicode escapes", () => {
    const rtf = new TextDecoder().decode(
      buildExportFile("Chat", [base({ content: "łódź" })], "rtf").bytes,
    );
    expect(rtf).toContain("\\u322?"); // ł
    expect(rtf).toContain("\\u378?"); // ź
  });

  it("builds an odt zip whose first entry is the stored mimetype", () => {
    const bytes = buildExportFile("Chat", TINY, "odt").bytes;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getUint32(0, true)).toBe(0x04034b50); // local header first
    expect(view.getUint16(8, true)).toBe(0); // method: stored
    const nameLen = view.getUint16(26, true);
    expect(new TextDecoder().decode(bytes.slice(30, 30 + nameLen))).toBe("mimetype");
    const payloadLen = view.getUint32(18, true);
    const payload = new TextDecoder().decode(
      bytes.slice(30 + nameLen, 30 + nameLen + payloadLen),
    );
    expect(payload).toBe("application/vnd.oasis.opendocument.text");
  });

  it("carries the conversation content in the odt content.xml", () => {
    const raw = new TextDecoder().decode(buildExportFile("Chat", TINY, "odt").bytes);
    expect(raw).toContain("content.xml");
    expect(raw).toContain("office:document-content");
    expect(raw).toContain("Cześć, jak masz na imię?");
  });

  it("builds a docx zip with the OOXML parts", () => {
    const raw = new TextDecoder().decode(buildExportFile("Chat", TINY, "docx").bytes);
    expect(raw).toContain("[Content_Types].xml");
    expect(raw).toContain("word/document.xml");
    expect(raw).toContain("wordprocessingml.document.main+xml");
    expect(raw).toContain("Nazywam się");
  });

  it("writes a PDF with header, fonts and a working xref", () => {
    const bytes = buildExportFile("Chat", TINY, "pdf").bytes;
    const pdf = new TextDecoder("latin1").decode(bytes);
    expect(pdf.startsWith("%PDF-1.4")).toBe(true);
    expect(pdf).toContain("/BaseFont /Helvetica-Bold");
    expect(pdf).toContain("/BaseFont /Helvetica");
    expect(pdf).toContain("%%EOF");
    // The xref offset must point at the xref keyword itself.
    const xrefAt = Number(pdf.match(/startxref\n(\d+)/)?.[1]);
    expect(pdf.slice(xrefAt, xrefAt + 4)).toBe("xref");
  });

  it("transliterates Polish diacritics the PDF cannot encode", () => {
    const pdf = new TextDecoder("latin1").decode(
      buildExportFile("Chat", [base({ content: "ąćęłńóśźż" })], "pdf").bytes,
    );
    // ąćęłń → ascii, ó survives (it exists in WinAnsi/Latin-1), źż → zz.
    expect(pdf).toContain("(acelnószz)");
  });

  it("flows a long conversation onto multiple PDF pages", () => {
    const long = conversation([
      base({ role: "user", content: Array(400).fill("slowo").join(" ") }),
      base({ id: 2, role: "assistant", content: Array(400).fill("answer").join(" ") }),
    ]);
    const pdf = new TextDecoder("latin1").decode(
      buildExportFile("Chat", long, "pdf").bytes,
    );
    const pages = Number(pdf.match(/\/Count (\d+)/)?.[1]);
    expect(pages).toBeGreaterThan(1);
  });

  it("renders tool messages as activity notes", () => {
    const activity = JSON.stringify({ title: "Reading file", detail: "src/app.ts" });
    const md = new TextDecoder().decode(
      buildExportFile("Chat", [base({ role: "tool", content: activity })], "md").bytes,
    );
    expect(md).toContain("**Reading file**");
    expect(md).toContain("> src/app.ts");
  });
});

describe("bytesToBase64", () => {
  it("round-trips binary data through base64", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    const decoded = Uint8Array.from(atob(bytesToBase64(bytes)), (c) =>
      c.charCodeAt(0),
    );
    expect([...decoded]).toEqual([...bytes]);
  });

  it("handles payloads larger than the chunk size", () => {
    const bytes = new Uint8Array(0x8000 * 2 + 7).fill(65);
    const decoded = Uint8Array.from(atob(bytesToBase64(bytes)), (c) =>
      c.charCodeAt(0),
    );
    expect(decoded.length).toBe(bytes.length);
  });
});
