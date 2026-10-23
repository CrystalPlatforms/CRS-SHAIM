// Landing page tests — issue #2 (PRD stories 38–39).
//
// Assumptions encoded by these tests (stated before RED):
// - Copy is English (PRD: "UI copy in English").
// - Hero copy: "Klepai — self-hosted LLM manager" (PRD story 38, em dash).
// - The three features (PRD story 38 / issue body):
//     1. connect Ollama & any OpenAI-compatible server
//     2. rich chat — code blocks, thinking
//     3. agents in chat — Alpha
// - Footer: "by CrystalPlatforms".
// - Dark CRS-Theme palette, re-branded gold (owner decision 2026-10-23):
//   primary #d4af37 (electric gold, slightly deepened) with dark ink
//   #262009 on it; dark neutrals unchanged (background #0a0a0a, card
//   #1a1a1a, border #262626, muted-foreground #a3a3a3), ring #ecd28c.
// - Header brand is the sign image (assets/transparent/klepai-sign-trans.png)
//   — the FIRST <img> on the page; the hero logo
//   (assets/transparent/klepai-logo-trans.png) follows in the hero.
// - NOT tested in this iteration: responsive pixel-perfection, < 2 s load and
//   zero console errors on klepai.pages.dev (HITL after owner deploy).
//
// Tests exercise the public interface: the page served over HTTP, exactly as
// a browser or Cloudflare Pages would fetch it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.png': 'image/png',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

// Minimal static file server — stands in for `python3 -m http.server` and
// for the Cloudflare Pages origin: serves repo files from disk over HTTP.
function startServer() {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const path = url.pathname === '/' ? '/index.html' : url.pathname;
      const file = join(ROOT, path);
      if (!file.startsWith(ROOT)) {
        res.writeHead(403);
        res.end();
        return;
      }
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

let server;
let base;

test.before(async () => {
  server = await startServer();
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  server?.close();
});

async function fetchPage() {
  const res = await fetch(`${base}/`);
  const html = await res.text();
  return { res, html };
}

// --- Cycle 1: tracer bullet — the page is served -------------------------

test('landing page is served over HTTP: 200 + text/html', async () => {
  const { res, html } = await fetchPage();
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/html/);
  assert.match(html, /<!doctype html>/i, 'served body is an HTML document');
});

// --- Cycle 7: hero call-to-action buttons ----------------------------------

test('hero actions link to the repo and Crystal Studio, opening in a new tab', async () => {
  const { html } = await fetchPage();
  const anchors = [...html.matchAll(/<a\b[^>]*href=["']([^"']*)["'][^>]*>/gi)].map((m) => ({
    tag: m[0],
    href: m[1],
  }));
  const repo = anchors.find((a) =>
    /^https:\/\/github\.com\/CrystalPlatforms\/klepai\/?$/i.test(a.href)
  );
  const studio = anchors.find((a) => /^https:\/\/crystal-studio\.dev\/?$/i.test(a.href));
  assert.ok(repo, 'there is a link to the GitHub repo');
  assert.ok(studio, 'there is a link to crystal-studio.dev');
  for (const a of [repo, studio]) {
    assert.match(a.tag, /target=["']_blank["']/i, `${a.href} opens in a new tab`);
    assert.match(a.tag, /rel=["'][^"']*noopener[^"']*["']/i, `${a.href} uses rel=noopener`);
  }
});

// --- Cycle 6b: CRS-Theme palette (characterization — locks the theme
// contract that already ships in the style block) ---------------------------

// Relative luminance of the hex color defined by `--background` in the page's
// inline CSS; null when the variable is missing or not a 6-digit hex.
function backgroundLuminance(html) {
  const m = html.match(/--background\s*:\s*#([0-9a-f]{6})/i);
  if (!m) return null;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

test('CRS-Theme palette: primary #d4af37 gold on a dark background', async () => {
  const { html } = await fetchPage();
  assert.match(html, /--primary\s*:\s*#d4af37/i, 'primary gold is the Klepai brand color');
  const lum = backgroundLuminance(html);
  assert.ok(lum !== null, '--background is defined as a hex color');
  assert.ok(lum < 0.2, `background is dark (luminance ${lum.toFixed(3)}, CRS-Theme dark-first)`);
});

// --- Cycle 6: logo ----------------------------------------------------------

test('Klepai header sign and hero logo are visible and actually served', async () => {
  const { html } = await fetchPage();
  const imgs = [...html.matchAll(/<img[^>]+>/gi)].map((m) => m[0]);
  assert.ok(imgs.length >= 2, 'page has the header sign and the hero logo');
  assert.match(imgs[0], /src=["']assets\/transparent\/klepai-sign-trans\.png["']/i, 'header brand is the sign image');
  assert.match(imgs[0], /alt=["'][^"']*klepai[^"']*["']/i, 'sign has a Klepai alt text');
  const logo = imgs.find((t) => /klepai-logo-trans\.png/i.test(t));
  assert.ok(logo, 'hero logo is present');
  assert.match(logo, /alt=["'][^"']*klepai[^"']*["']/i, 'logo has a Klepai alt text');
  const sign = await fetch(`${base}/assets/transparent/klepai-sign-trans.png`);
  assert.equal(sign.status, 200, 'sign file exists and is served');
  assert.match(sign.headers.get('content-type') ?? '', /image\/png/);
  const logoFile = await fetch(`${base}/assets/transparent/klepai-logo-trans.png`);
  assert.equal(logoFile.status, 200, 'logo file exists and is served');
  assert.match(logoFile.headers.get('content-type') ?? '', /image\/png/);
});

// --- Cycle 5: self-contained static file ----------------------------------

test('page is self-contained: inline CSS, no external scripts or stylesheets', async () => {
  const { html } = await fetchPage();
  assert.match(html, /<style[\s>]/i, 'CSS lives inline in a <style> block');
  assert.doesNotMatch(html, /<link[^>]+rel=["']?stylesheet/i, 'no external stylesheets');
  assert.doesNotMatch(html, /<script[\s>]/i, 'no scripts at all (pure static page)');
});

// --- Cycle 4: footer ------------------------------------------------------

test('footer credits "by CrystalPlatforms"', async () => {
  const { html } = await fetchPage();
  const footer = html.match(/<footer[^>]*>([\s\S]*?)<\/footer>/);
  assert.ok(footer, 'page has a <footer>');
  const text = footer[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  assert.match(text, /by CrystalPlatforms/i);
});

// --- Cycle 2: hero --------------------------------------------------------

test('hero states "Klepai — self-hosted LLM manager"', async () => {
  const { html } = await fetchPage();
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
  assert.ok(h1, 'page has an <h1> hero heading');
  const text = h1[1].replace(/\s+/g, ' ').trim();
  assert.match(text, /^Klepai\s*—\s*self-hosted LLM manager$/i);
});

// --- Cycle 3: feature list ------------------------------------------------

test('feature list describes the three Alpha capabilities in PRD order', async () => {
  const { html } = await fetchPage();
  const list = html.match(/<ul[^>]*id="features"[^>]*>([\s\S]*?)<\/ul>/);
  assert.ok(list, 'page has a <ul id="features">');
  const items = [...list[1].matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map((m) =>
    m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  );
  assert.equal(items.length, 3, 'exactly three features (PRD story 38)');
  assert.match(items[0], /connect.*Ollama.*OpenAI-compatible/i, 'feature 1: model servers');
  assert.match(items[1], /rich chat.*code blocks.*thinking/i, 'feature 2: rich chat');
  assert.match(items[2], /agents in chat.*Alpha/i, 'feature 3: agents (Alpha)');
});
