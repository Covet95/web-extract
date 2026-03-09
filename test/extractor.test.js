import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractFromHtml, extractUrl } from '../extractor.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test('extractFromHtml returns clean article fields', async () => {
  const fixturePath = path.join(__dirname, 'fixtures', 'sample-article.html');
  const html = await readFile(fixturePath, 'utf8');

  const result = extractFromHtml(html, 'https://example.com/post', { maxChars: 5000 });

  assert.equal(result.title, 'Sample Article');
  assert.equal(result.author, 'Open Source Bot');
  assert.equal(result.publishedAt, '2026-03-08');
  assert.match(result.markdown, /## Section One/);
  assert.match(result.markdown, /\[example link\]\(https:\/\/example.com\/ref\)/);
  assert.equal(result.images[0], 'https://example.com/image.png');
  assert.ok(result.plainText.includes('This is the body of the article.'));
});

test('extractFromHtml truncates content when maxChars is small', async () => {
  const fixturePath = path.join(__dirname, 'fixtures', 'sample-article.html');
  const html = await readFile(fixturePath, 'utf8');

  const result = extractFromHtml(html, 'https://example.com/post', { maxChars: 80 });

  assert.match(result.markdown, /\[truncated\]$/);
  assert.ok(result.warnings.some((item) => item.includes('maxChars=80')));
});

test('extractUrl keeps fetch result when primary content is healthy', async () => {
  const fixturePath = path.join(__dirname, 'fixtures', 'sample-article.html');
  const html = await readFile(fixturePath, 'utf8');
  let fallbackCalled = false;

  const result = await extractUrl('https://example.com/post', {
    fetchImpl: async () => ({ ok: true, status: 200, finalUrl: 'https://example.com/post', html }),
    playwrightImpl: async () => {
      fallbackCalled = true;
      throw new Error('should not call playwright');
    },
  });

  assert.equal(fallbackCalled, false);
  assert.match(result.sourceStrategy, /^fetch:/);
  assert.equal(result.title, 'Sample Article');
});

test('extractUrl falls back to Playwright when fetched page looks JS-gated', async () => {
  const fixturePath = path.join(__dirname, 'fixtures', 'sample-article.html');
  const html = await readFile(fixturePath, 'utf8');
  let fallbackCalled = false;

  const result = await extractUrl('https://example.com/gated', {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      finalUrl: 'https://example.com/gated',
      html: '<html><head><title>Blocked</title></head><body><main>Please enable JavaScript to continue</main></body></html>',
    }),
    playwrightImpl: async () => {
      fallbackCalled = true;
      return { ok: true, status: 200, finalUrl: 'https://example.com/gated', html };
    },
  });

  assert.equal(fallbackCalled, true);
  assert.match(result.sourceStrategy, /^playwright:/);
  assert.ok(result.warnings.some((item) => item.includes('Playwright fallback')));
  assert.equal(result.title, 'Sample Article');
});

test('extractUrl falls back to Playwright when primary fetch fails', async () => {
  const fixturePath = path.join(__dirname, 'fixtures', 'sample-article.html');
  const html = await readFile(fixturePath, 'utf8');

  const result = await extractUrl('https://example.com/fail', {
    fetchImpl: async () => {
      throw new Error('network down');
    },
    playwrightImpl: async () => ({ ok: true, status: 200, finalUrl: 'https://example.com/fail', html }),
  });

  assert.match(result.sourceStrategy, /^playwright:/);
  assert.ok(result.warnings.some((item) => item.includes('primary fetch failed: network down')));
  assert.equal(result.author, 'Open Source Bot');
});

test('extractUrl can disable Playwright fallback explicitly', async () => {
  await assert.rejects(
    extractUrl('https://example.com/no-fallback', {
      playwrightFallback: false,
      fetchImpl: async () => {
        throw new Error('network down');
      },
      playwrightImpl: async () => ({
        ok: true,
        status: 200,
        finalUrl: 'https://example.com/no-fallback',
        html: '<html><body><article><h1>unused</h1></article></body></html>',
      }),
    }),
    /network down/,
  );
});
