//! Chat export builders (issue #25): turn a conversation's messages into a
//! downloadable document in one of six formats — .md, .txt, .rtf, .odt,
//! .docx, .pdf. Everything is produced here, in plain TypeScript: the odt
//! and docx are STORED (uncompressed) zip packages assembled byte by byte,
//! the pdf is hand-written against the base-14 Helvetica fonts. No runtime
//! dependencies, so the bundle stays lean.

import type { Message } from "@/types";
import { parseActivity } from "@/types";

export type ExportFormat = "md" | "txt" | "rtf" | "odt" | "docx" | "pdf";

export const EXPORT_FORMATS: {
  format: ExportFormat;
  label: string;
  extension: string;
  filterName: string;
}[] = [
  { format: "md", label: "Markdown", extension: "md", filterName: "Markdown" },
  { format: "txt", label: "Plain text", extension: "txt", filterName: "Plain text" },
  { format: "rtf", label: "RTF", extension: "rtf", filterName: "Rich Text (RTF)" },
  { format: "odt", label: "OpenDocument", extension: "odt", filterName: "OpenDocument Text" },
  { format: "docx", label: "Word", extension: "docx", filterName: "Word Document" },
  { format: "pdf", label: "PDF", extension: "pdf", filterName: "PDF" },
];

export interface ExportFile {
  /** Suggested file name, sanitized and extension-complete. */
  filename: string;
  mime: string;
  bytes: Uint8Array;
}

const MIME_BY_FORMAT: Record<ExportFormat, string> = {
  md: "text/markdown",
  txt: "text/plain",
  rtf: "application/rtf",
  odt: "application/vnd.oasis.opendocument.text",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pdf: "application/pdf",
};

// --- shared shaping -------------------------------------------------------

const STAMP = new Intl.DateTimeFormat("en-GB", { dateStyle: "long" });

/** One renderable line block: speaker heading + the body that follows. */
interface Block {
  speaker: string;
  lines: string[];
  /** Tool-role messages render as activity notes, not speech. */
  activity: boolean;
}

function blocksOf(messages: Message[]): Block[] {
  return messages.map((message) => {
    if (message.role === "tool") {
      const activity = parseActivity(message.content);
      return {
        speaker: activity.title,
        lines: activity.detail.split("\n"),
        activity: true,
      };
    }
    return {
      speaker:
        message.role === "user"
          ? "You"
          : message.role === "assistant"
            ? "Assistant"
            : "System",
      lines: message.content.split("\n"),
      activity: false,
    };
  });
}

const PUNCT: Record<string, string> = {
  "‘": "'", "’": "'", "‚": ",", "“": '"', "”": '"',
  "–": "-", "—": "-", "…": "...", " ": " ",
};

const PL_MAP: Record<string, string> = {
  "ą": "a", "ć": "c", "ę": "e", "ł": "l", "ń": "n", "ś": "s", "ź": "z", "ż": "z",
  "Ą": "A", "Ć": "C", "Ę": "E", "Ł": "L", "Ń": "N", "Ś": "S", "Ź": "Z", "Ż": "Z",
};

/** Maps a string to the printable WinAnsi subset the hand-written PDF can
 * show — Polish diacritics transliterate, exotic characters fall back. */
function toPdfText(text: string): string {
  let out = "";
  for (const char of text) {
    if (PUNCT[char] !== undefined) {
      out += PUNCT[char];
    } else if (PL_MAP[char] !== undefined) {
      out += PL_MAP[char];
    } else {
      const code = char.codePointAt(0) ?? 63;
      out += code >= 32 && code <= 126 ? char : code >= 160 && code <= 255 ? char : "?";
    }
  }
  return out;
}

function sanitizeFilename(title: string): string {
  const cleaned = title
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60)
    .trim();
  return cleaned.length > 0 ? cleaned : "chat";
}

function footerLine(date: Date): string {
  return `Exported from Klepai — ${STAMP.format(date)}`;
}

// --- markdown & plain text -------------------------------------------------

function buildMarkdown(title: string, messages: Message[], date: Date): string {
  const parts: string[] = [`# ${title}`, "", `*${footerLine(date)}*`, ""];
  for (const block of blocksOf(messages)) {
    parts.push("---", "");
    if (block.activity) {
      parts.push(`> **${block.speaker}**`, ">", ...block.lines.map((l) => `> ${l}`), "");
    } else {
      parts.push(`**${block.speaker}**`, "", ...block.lines, "");
    }
  }
  return parts.join("\n");
}

function buildPlainText(title: string, messages: Message[], date: Date): string {
  const parts: string[] = [
    title,
    "=".repeat(Math.min(60, Math.max(8, title.length))),
    footerLine(date),
    "",
  ];
  for (const block of blocksOf(messages)) {
    parts.push(
      block.activity ? `[${block.speaker}]` : `[${block.speaker}]`,
      ...block.lines,
      "",
    );
  }
  return parts.join("\n");
}

// --- RTF -------------------------------------------------------------------

/** Escapes a line for an RTF body: braces/backslash literally, everything
 * outside cp1252 as a \uNNNN? unicode escape. */
function rtfEscape(text: string): string {
  let out = "";
  for (const char of text) {
    if (char === "\\" || char === "{" || char === "}") {
      out += `\\${char}`;
      continue;
    }
    const code = char.codePointAt(0) ?? 63;
    if (char === " ") {
      out += "\\~";
    } else if (code >= 32 && code <= 126) {
      out += char;
    } else if (code >= 160 && code <= 255) {
      // Latin-1 range maps 1:1 onto the \ansi default charset.
      out += `\\${code.toString(16)}?`;
    } else if (code > 255) {
      const signed = code > 32767 ? code - 65536 : code;
      out += `\\u${signed}?`;
    }
    // control characters are dropped
  }
  return out;
}

function buildRtf(title: string, messages: Message[], date: Date): string {
  const parts: string[] = [
    "{\\rtf1\\ansi\\ansicpg1252\\deff0{\\fonttbl{\\f0\\fswiss Helvetica;}}",
    "\\f0\\fs24",
    `\\b ${rtfEscape(title)}\\b0\\par`,
    `{\\i\\fs18 ${rtfEscape(footerLine(date))}}\\par`,
    "\\par",
  ];
  for (const block of blocksOf(messages)) {
    parts.push(
      block.activity
        ? `\\pard\\sa120{\\b\\i ${rtfEscape(block.speaker)}}\\par`
        : `\\pard\\sa120\\b ${rtfEscape(block.speaker)}\\b0\\par`,
    );
    for (const line of block.lines) {
      parts.push(`${rtfEscape(line)}\\par`);
    }
    parts.push("\\pard\\sa240\\par");
  }
  parts.push("}");
  return parts.join("\n");
}

// --- zip (STORED) ----------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Assembles a zip package of STORED (uncompressed) entries — enough for
 * the small odt/docx exports, and the only compression-free layout the odt
 * spec requires for its first `mimetype` entry. */
function zipStore(entries: { name: string; data: Uint8Array }[]): Uint8Array {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const crc = crc32(entry.data);
    const local = new Uint8Array(30 + name.length);
    const view = new DataView(local.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true); // version needed
    view.setUint16(6, 0, true); // flags
    view.setUint16(8, 0, true); // method: stored
    view.setUint16(10, 0, true); // mod time
    view.setUint16(12, 0, true); // mod date
    view.setUint32(14, crc, true);
    view.setUint32(18, entry.data.length, true);
    view.setUint32(22, entry.data.length, true);
    view.setUint16(26, name.length, true);
    view.setUint16(28, 0, true); // extra length
    local.set(name, 30);
    locals.push(local, entry.data);

    const central = new Uint8Array(46 + name.length);
    const cview = new DataView(central.buffer);
    cview.setUint32(0, 0x02014b50, true);
    cview.setUint16(4, 20, true); // version made by
    cview.setUint16(6, 20, true); // version needed
    cview.setUint16(8, 0, true); // flags
    cview.setUint16(10, 0, true); // method
    cview.setUint16(12, 0, true); // mod time
    cview.setUint16(14, 0, true); // mod date
    cview.setUint32(16, crc, true);
    cview.setUint32(20, entry.data.length, true);
    cview.setUint32(24, entry.data.length, true);
    cview.setUint16(28, name.length, true);
    cview.setUint32(42, offset, true); // local header offset
    central.set(name, 46);
    centrals.push(central);

    offset += local.length + entry.data.length;
  }

  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const eview = new DataView(end.buffer);
  eview.setUint32(0, 0x06054b50, true);
  eview.setUint16(8, entries.length, true);
  eview.setUint16(10, entries.length, true);
  eview.setUint32(12, centralSize, true);
  eview.setUint32(16, offset, true);

  const total = offset + centralSize + end.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of [...locals, ...centrals, end]) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

// --- ODT -------------------------------------------------------------------

function xmlEscape(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function odtParagraphs(blocks: Block[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    const speaker = block.activity
      ? `<text:p text:style-name="Activity">${xmlEscape(block.speaker)}</text:p>`
      : `<text:p text:style-name="Speaker">${xmlEscape(block.speaker)}</text:p>`;
    parts.push(speaker);
    for (const line of block.lines) {
      parts.push(
        line.length > 0
          ? `<text:p>${xmlEscape(line)}</text:p>`
          : '<text:p/>',
      );
    }
  }
  return parts.join("\n");
}

function buildOdt(title: string, messages: Message[], date: Date): Uint8Array {
  const content = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content
 xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
 xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
 xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"
 xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"
 office:version="1.2">
 <office:automatic-styles>
  <style:style style:name="Title" style:family="paragraph">
   <style:text-properties fo:font-size="18pt" fo:font-weight="bold"/>
  </style:style>
  <style:style style:name="Speaker" style:family="paragraph">
   <style:text-properties fo:font-weight="bold"/>
  </style:style>
  <style:style style:name="Activity" style:family="paragraph">
   <style:text-properties fo:font-style="italic" fo:font-weight="bold"/>
  </style:style>
  <style:style style:name="Footer" style:family="paragraph">
   <style:text-properties fo:font-style="italic" fo:font-size="9pt" fo:color="#808080"/>
  </style:style>
 </office:automatic-styles>
 <office:body>
  <office:text>
   <text:h text:outline-level="1" text:style-name="Title">${xmlEscape(title)}</text:h>
   <text:p text:style-name="Footer">${xmlEscape(footerLine(date))}</text:p>
${odtParagraphs(blocksOf(messages))}
  </office:text>
 </office:body>
</office:document-content>`;
  const styles = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-styles
 xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
 office:version="1.2">
 <office:styles/>
</office:document-styles>`;
  const manifest = `<?xml version="1.0" encoding="UTF-8"?>
<manifest:manifest
 xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"
 manifest:version="1.2">
 <manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/>
 <manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>
 <manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/>
</manifest:manifest>`;
  const encoder = new TextEncoder();
  return zipStore([
    // The mimetype entry must be first, stored, and free of extra fields.
    { name: "mimetype", data: encoder.encode("application/vnd.oasis.opendocument.text") },
    { name: "META-INF/manifest.xml", data: encoder.encode(manifest) },
    { name: "content.xml", data: encoder.encode(content) },
    { name: "styles.xml", data: encoder.encode(styles) },
  ]);
}

// --- DOCX ------------------------------------------------------------------

function docxParagraphs(blocks: Block[]): string {
  const paragraph = (runs: string) => `<w:p>${runs}</w:p>`;
  const text = (value: string, bold = false) =>
    `<w:r>${bold ? "<w:rPr><w:b/></w:rPr>" : ""}<w:t xml:space="preserve">${xmlEscape(value)}</w:t></w:r>`;
  const parts: string[] = [];
  for (const block of blocks) {
    parts.push(
      paragraph(
        text(block.speaker, true) +
          (block.activity ? text("  (activity)", false) : ""),
      ),
    );
    for (const line of block.lines) {
      parts.push(paragraph(line.length > 0 ? text(line) : ""));
    }
  }
  return parts.join("\n");
}

function buildDocx(title: string, messages: Message[], date: Date): Uint8Array {
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
 <w:body>
  <w:p><w:r><w:rPr><w:b/><w:sz w:val="36"/></w:rPr><w:t xml:space="preserve">${xmlEscape(title)}</w:t></w:r></w:p>
  <w:p><w:r><w:rPr><w:i/><w:color w:val="808080"/><w:sz w:val="18"/></w:rPr><w:t xml:space="preserve">${xmlEscape(footerLine(date))}</w:t></w:r></w:p>
${docxParagraphs(blocksOf(messages))}
  <w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>
 </w:body>
</w:document>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="xml" ContentType="application/xml"/>
 <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;
  const encoder = new TextEncoder();
  return zipStore([
    { name: "[Content_Types].xml", data: encoder.encode(contentTypes) },
    { name: "_rels/.rels", data: encoder.encode(rels) },
    { name: "word/document.xml", data: encoder.encode(document) },
  ]);
}

// --- PDF -------------------------------------------------------------------

// Helvetica advance widths (units/1000) for chars 32–126, straight from the
// base-14 AFM metrics — exact wrapping without embedding any font file.
const HELVETICA_WIDTHS = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278,
  278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584,
  584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556,
  833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278,
  278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222,
  500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500,
  500, 334, 260, 334, 584,
];

const helveticaWidth = (char: string, bold: boolean): number => {
  const code = char.charCodeAt(0);
  const base = code >= 32 && code <= 126 ? HELVETICA_WIDTHS[code - 32] : 556;
  return bold ? base * 1.08 : base;
};

const textWidth = (text: string, size: number, bold: boolean): number => {
  let width = 0;
  for (const char of text) width += helveticaWidth(char, bold);
  return (width * size) / 1000;
};

function pdfEscape(text: string): string {
  return text.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
}

/** Word-wraps one body line to the given width; a word longer than the
 * line itself is hard-split by characters. */
function wrapLine(text: string, size: number, bold: boolean, maxWidth: number): string[] {
  const words = text.split(" ");
  const lines: string[] = [];
  let current = "";
  const fits = (candidate: string) =>
    textWidth(candidate, size, bold) <= maxWidth;
  for (const word of words) {
    const candidate = current.length === 0 ? word : `${current} ${word}`;
    if (fits(candidate)) {
      current = candidate;
      continue;
    }
    if (current.length > 0) lines.push(current);
    if (fits(word)) {
      current = word;
      continue;
    }
    // Hard-split an overlong word.
    current = "";
    for (const char of word) {
      if (fits(current + char)) {
        current += char;
      } else {
        lines.push(current);
        current = char;
      }
    }
  }
  if (current.length > 0) lines.push(current);
  return lines.length > 0 ? lines : [""];
}

function buildPdf(title: string, messages: Message[], date: Date): Uint8Array {
  const PAGE_W = 595;
  const PAGE_H = 842;
  const MARGIN = 56;
  const BOTTOM = 56;
  const maxWidth = PAGE_W - MARGIN * 2;

  // Draw list: one entry per line, carried over pages.
  interface DrawLine {
    text: string;
    size: number;
    bold: boolean;
    italicNote?: boolean;
    gapBefore: number;
  }
  const lines: DrawLine[] = [
    ...wrapLine(toPdfText(title), 18, true, maxWidth).map((text) => ({
      text,
      size: 18,
      bold: true,
      gapBefore: 0,
    })),
    {
      text: toPdfText(footerLine(date)),
      size: 9,
      bold: false,
      italicNote: true,
      gapBefore: 8,
    },
  ];
  for (const block of blocksOf(messages)) {
    const speakerText = block.activity
      ? `${toPdfText(block.speaker)} (activity)`
      : toPdfText(block.speaker);
    lines.push({
      text: speakerText,
      size: 11,
      bold: true,
      gapBefore: 18,
    });
    for (const raw of block.lines) {
      for (const wrapped of wrapLine(toPdfText(raw), 10, false, maxWidth)) {
        lines.push({ text: wrapped, size: 10, bold: false, gapBefore: 3 });
      }
    }
  }

  // Flow the lines onto pages.
  const pages: { ops: string[]; y: number }[] = [];
  let page: { ops: string[]; y: number } = { ops: [], y: PAGE_H - MARGIN };
  pages.push(page);
  for (const line of lines) {
    const lineHeight = line.size * 1.35;
    let y = page.y - line.gapBefore;
    if (y - lineHeight < BOTTOM && page.ops.length > 0) {
      page = { ops: [], y: PAGE_H - MARGIN };
      pages.push(page);
      y = page.y - line.gapBefore;
    }
    const font = line.bold ? "F1" : "F2";
    page.ops.push(
      `/${font} ${line.size} Tf 1 0 0 1 ${MARGIN} ${y.toFixed(2)} Tm (${pdfEscape(line.text)}) Tj`,
    );
    page.y = y - lineHeight;
  }

  // Serialize: 1 catalog, 2 pages, 3 bold font, 4 regular font, then a page
  // object and its content stream per page.
  const contents = pages.map((p) => p.ops.join("\n"));
  const pageIds = pages.map((_, i) => 5 + i * 2);
  const objects: string[] = [];
  objects.push(`<< /Type /Catalog /Pages 2 0 R >>`);
  objects.push(
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`,
  );
  objects.push(
    `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>`,
  );
  objects.push(
    `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`,
  );
  pages.forEach((_, i) => {
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${pageIds[i] + 1} 0 R >>`,
    );
    objects.push(`<< /Length ${contents[i].length} >>\nstream\n${contents[i]}\nendstream`);
  });

  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefAt = body.length;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    xref += `${offset.toString().padStart(10, "0")} 00000 n \n`;
  }
  body += `${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  // The body is one byte per character by construction: toPdfText mapped
  // everything into the printable Latin-1 range, so a plain byte dump keeps
  // the xref offsets exact and the strings WinAnsi-clean (TextEncoder would
  // widen ó to two UTF-8 bytes and shift every offset).
  const out = new Uint8Array(body.length);
  for (let i = 0; i < body.length; i++) out[i] = body.charCodeAt(i) & 0xff;
  return out;
}

// --- entry point -----------------------------------------------------------

/** Builds the export document for a conversation. */
export function buildExportFile(
  title: string,
  messages: Message[],
  format: ExportFormat,
  now = new Date(),
): ExportFile {
  const spec = EXPORT_FORMATS.find((entry) => entry.format === format);
  if (!spec) throw new Error(`Unknown export format: ${format}`);
  const base = `${sanitizeFilename(title)}-${now.toISOString().slice(0, 10)}`;
  const bytes =
    format === "md"
      ? new TextEncoder().encode(buildMarkdown(title, messages, now))
      : format === "txt"
        ? new TextEncoder().encode(buildPlainText(title, messages, now))
        : format === "rtf"
          ? new TextEncoder().encode(buildRtf(title, messages, now))
          : format === "odt"
            ? buildOdt(title, messages, now)
            : format === "docx"
              ? buildDocx(title, messages, now)
              : buildPdf(title, messages, now);
  return {
    filename: `${base}.${spec.extension}`,
    mime: MIME_BY_FORMAT[format],
    bytes,
  };
}

/** Base64 of arbitrary bytes — the JSON bridge carries text, so binary
 * export bodies travel encoded (decoded by the Rust `save_export`). */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
