import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractFromHtml, extractMany, extractUrl, resolveChromiumExecutablePath } from '../extractor.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readFixture(name) {
  return readFile(path.join(__dirname, 'fixtures', name), 'utf8');
}

test('extractFromHtml returns clean article fields', async () => {
  const html = await readFixture('sample-article.html');

  const result = extractFromHtml(html, 'https://example.com/post', { maxChars: 5000 });

  assert.equal(result.title, 'Sample Article');
  assert.equal(result.author, 'Open Source Bot');
  assert.equal(result.publishedAt, '2026-03-08');
  assert.match(result.markdown, /## Section One/);
  assert.match(result.markdown, /\[example link\]\(https:\/\/example.com\/ref\)/);
  assert.equal(result.images[0], 'https://example.com/image.png');
  assert.ok(result.plainText.includes('This is the body of the article.'));
  assert.equal(result.debug, undefined);
});

test('extractFromHtml debug mode returns extraction diagnostics', async () => {
  const html = await readFixture('sample-article.html');
  const result = extractFromHtml(html, 'https://example.com/post', { maxChars: 5000, debug: true });

  assert.ok(result.debug);
  assert.ok(['readability', 'selector:article'].includes(result.debug.extraction.selectedStrategy));
  assert.equal(typeof result.debug.extraction.durationMs, 'number');
  assert.equal(result.debug.extraction.truncated, false);
});

test('extractFromHtml uses JSON-LD metadata when standard meta is absent', async () => {
  const html = await readFixture('sample-jsonld-article.html');
  const result = extractFromHtml(html, 'https://news.example.com/post', { maxChars: 5000, debug: true });

  assert.equal(result.title, 'JSON-LD Headline');
  assert.equal(result.author, 'LD Author');
  assert.equal(result.publishedAt, '2026-03-10T07:00:00Z');
  assert.equal(result.debug.extraction.jsonLdMetaDetected, true);
});

test('extractFromHtml applies domain-specific selectors for GitHub pages', async () => {
  const html = await readFixture('sample-github-readme.html');
  const result = extractFromHtml(html, 'https://github.com/covet95/web-extract', { maxChars: 5000, debug: true });

  assert.match(result.markdown, /# web-extract/);
  assert.equal(result.debug.extraction.domainProfile, 'github-readme');
  assert.equal(result.debug.extraction.selectedStrategy, 'selector:.markdown-body');
});

test('extractFromHtml truncates content when maxChars is small', async () => {
  const html = await readFixture('sample-article.html');
  const result = extractFromHtml(html, 'https://example.com/post', { maxChars: 80 });

  assert.match(result.markdown, /\[truncated\]$/);
  assert.ok(result.warnings.some((item) => item.includes('maxChars=80')));
});

test('resolveChromiumExecutablePath prefers configured env path', async () => {
  const resolved = await resolveChromiumExecutablePath({
    env: { PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: '/custom/chrome' },
    fileExistsImpl: async (candidate) => candidate === '/custom/chrome',
    commandLookupImpl: async () => undefined,
    platform: 'darwin',
  });

  assert.equal(resolved, '/custom/chrome');
});

test('resolveChromiumExecutablePath checks platform candidates and command lookup', async () => {
  const resolved = await resolveChromiumExecutablePath({
    env: {},
    fileExistsImpl: async () => false,
    commandLookupImpl: async (command) => command === 'chromium' ? '/usr/bin/chromium' : undefined,
    platform: 'linux',
  });

  assert.equal(resolved, '/usr/bin/chromium');
});

test('extractUrl keeps fetch result when primary content is healthy', async () => {
  const html = await readFixture('sample-article.html');
  let fallbackCalled = false;

  const result = await extractUrl('https://example.com/post', {
    fetchImpl: async () => ({ ok: true, status: 200, finalUrl: 'https://example.com/post', html, contentType: 'text/html; charset=utf-8' }),
    playwrightImpl: async () => {
      fallbackCalled = true;
      throw new Error('should not call playwright');
    },
  });

  assert.equal(fallbackCalled, false);
  assert.match(result.sourceStrategy, /^fetch:/);
  assert.equal(result.title, 'Sample Article');
});

test('extractUrl debug mode returns fetch and fallback diagnostics', async () => {
  const html = await readFixture('sample-article.html');
  const result = await extractUrl('https://example.com/post', {
    debug: true,
    fetchImpl: async () => ({ ok: true, status: 200, finalUrl: 'https://example.com/post', html, contentType: 'text/html; charset=utf-8', bodyTextLength: 220 }),
  });

  assert.ok(result.debug);
  assert.equal(result.debug.fetch.status, 200);
  assert.equal(result.debug.fetch.source, 'fetch');
  assert.equal(result.debug.fallback.triggered, false);
  assert.equal(result.debug.fallback.reason, null);
  assert.equal(typeof result.debug.fetch.durationMs, 'number');
});

test('extractUrl avoids fallback for short but valid pages', async () => {
  const html = await readFixture('sample-short-valid-page.html');
  let fallbackCalled = false;

  const result = await extractUrl('https://example.com/status', {
    debug: true,
    fetchImpl: async () => ({ ok: true, status: 200, finalUrl: 'https://example.com/status', html, contentType: 'text/html; charset=utf-8', bodyTextLength: 30 }),
    playwrightImpl: async () => {
      fallbackCalled = true;
      return { ok: true, status: 200, finalUrl: 'https://example.com/status', html, contentType: 'text/html; charset=utf-8', bodyTextLength: 30 };
    },
  });

  assert.equal(fallbackCalled, false);
  assert.equal(result.debug.fallback.triggered, false);
  assert.equal(result.title, 'Short Update');
  assert.match(result.markdown, /Service restored\./);
});

test('extractUrl falls back to Playwright when fetched page looks JS-gated', async () => {
  const html = await readFixture('sample-article.html');
  let fallbackCalled = false;

  const result = await extractUrl('https://example.com/gated', {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      finalUrl: 'https://example.com/gated',
      html: '<html><head><title>Blocked</title></head><body><main>Please enable JavaScript to continue</main></body></html>',
      contentType: 'text/html; charset=utf-8',
      bodyTextLength: 40,
    }),
    playwrightImpl: async () => {
      fallbackCalled = true;
      return { ok: true, status: 200, finalUrl: 'https://example.com/gated', html, contentType: 'text/html; charset=utf-8', bodyTextLength: 220 };
    },
  });

  assert.equal(fallbackCalled, true);
  assert.match(result.sourceStrategy, /^playwright:/);
  assert.ok(result.warnings.some((item) => item.includes('Playwright fallback')));
  assert.equal(result.title, 'Sample Article');
});

test('extractUrl falls back for shell / placeholder pages', async () => {
  const shellHtml = await readFixture('sample-shell-page.html');
  const fullHtml = await readFixture('sample-article.html');
  let fallbackCalled = false;

  const result = await extractUrl('https://example.com/shell', {
    debug: true,
    fetchImpl: async () => ({ ok: true, status: 200, finalUrl: 'https://example.com/shell', html: shellHtml, contentType: 'text/html; charset=utf-8', bodyTextLength: 90 }),
    playwrightImpl: async () => {
      fallbackCalled = true;
      return { ok: true, status: 200, finalUrl: 'https://example.com/shell', html: fullHtml, contentType: 'text/html; charset=utf-8', bodyTextLength: 220 };
    },
  });

  assert.equal(fallbackCalled, true);
  assert.match(result.debug.fallback.reason, /shell \/ placeholder page/i);
  assert.match(result.sourceStrategy, /^playwright:/);
});

test('extractUrl debug mode records fallback details', async () => {
  const html = await readFixture('sample-article.html');
  const result = await extractUrl('https://example.com/gated', {
    debug: true,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      finalUrl: 'https://example.com/gated',
      html: '<html><head><title>Blocked</title></head><body><main>Please enable JavaScript to continue</main></body></html>',
      contentType: 'text/html; charset=utf-8',
      bodyTextLength: 40,
    }),
    playwrightImpl: async () => ({ ok: true, status: 200, finalUrl: 'https://example.com/gated', html, contentType: 'text/html; charset=utf-8', bodyTextLength: 220 }),
  });

  assert.ok(result.debug);
  assert.equal(result.debug.fallback.triggered, true);
  assert.equal(result.debug.fallback.attempted, true);
  assert.equal(result.debug.fallback.succeeded, true);
  assert.match(result.debug.fallback.reason, /browser rendering|JavaScript|human verification/i);
  assert.equal(typeof result.debug.fallback.durationMs, 'number');
});

test('extractUrl falls back to Playwright when primary fetch fails', async () => {
  const html = await readFixture('sample-article.html');
  const result = await extractUrl('https://example.com/fail', {
    fetchImpl: async () => {
      throw Object.assign(new Error('network down'), { errorCode: 'FETCH_ERROR', errorStage: 'fetch', retryable: true });
    },
    playwrightImpl: async () => ({ ok: true, status: 200, finalUrl: 'https://example.com/fail', html, contentType: 'text/html; charset=utf-8', bodyTextLength: 220 }),
  });

  assert.match(result.sourceStrategy, /^playwright:/);
  assert.ok(result.warnings.some((item) => item.includes('primary fetch failed: network down')));
  assert.equal(result.author, 'Open Source Bot');
});

test('extractUrl rejects non-HTML responses when Playwright fallback is disabled', async () => {
  await assert.rejects(
    extractUrl('https://example.com/data.json', {
      playwrightFallback: false,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        finalUrl: 'https://example.com/data.json',
        html: '{"ok":true}',
        contentType: 'application/json',
      }),
    }),
    (error) => error.errorCode === 'NON_HTML_RESPONSE' && error.errorStage === 'fetch',
  );
});

test('extractMany respects concurrency and keeps result order', async () => {
  let active = 0;
  let maxActive = 0;

  const items = await extractMany([
    'https://example.com/1',
    'https://example.com/2',
    'https://example.com/3',
  ], {
    concurrency: 2,
    fetchImpl: async (url) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await wait(url.endsWith('/1') ? 50 : 10);
      active -= 1;
      return {
        ok: true,
        status: 200,
        finalUrl: url,
        html: `<html><body><article><h1>${url}</h1><p>${url} body content that is long enough for extraction.</p></article></body></html>`,
        contentType: 'text/html; charset=utf-8',
        bodyTextLength: 120,
      };
    },
  });

  assert.equal(maxActive, 2);
  assert.deepEqual(items.map((item) => item.url), [
    'https://example.com/1',
    'https://example.com/2',
    'https://example.com/3',
  ]);
  assert.ok(items.every((item) => item.ok));
});

test('extractMany propagates debug info on successful items', async () => {
  const items = await extractMany(['https://example.com/1'], {
    debug: true,
    fetchImpl: async (url) => ({
      ok: true,
      status: 200,
      finalUrl: url,
      html: `<html><body><article><h1>${url}</h1><p>${url} body content that is long enough for extraction.</p></article></body></html>`,
      contentType: 'text/html; charset=utf-8',
      bodyTextLength: 120,
    }),
  });

  assert.equal(items[0].ok, true);
  assert.ok(items[0].result.debug);
  assert.equal(items[0].result.debug.fetch.status, 200);
});

test('extractMany returns structured error metadata for failed items', async () => {
  const items = await extractMany(['https://example.com/bad'], {
    playwrightFallback: false,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      finalUrl: 'https://example.com/bad',
      html: 'not html data',
      contentType: 'application/pdf',
    }),
  });

  assert.equal(items[0].ok, false);
  assert.equal(items[0].errorCode, 'NON_HTML_RESPONSE');
  assert.equal(items[0].errorStage, 'fetch');
  assert.equal(items[0].retryable, false);
});


test('extractUrl can disable Playwright fallback explicitly', async () => {
  await assert.rejects(
    extractUrl('https://example.com/no-fallback', {
      playwrightFallback: false,
      fetchImpl: async () => {
        throw Object.assign(new Error('network down'), { errorCode: 'FETCH_ERROR', errorStage: 'fetch', retryable: true });
      },
      playwrightImpl: async () => ({
        ok: true,
        status: 200,
        finalUrl: 'https://example.com/no-fallback',
        html: '<html><body><article><h1>unused</h1></article></body></html>',
        contentType: 'text/html; charset=utf-8',
      }),
    }),
    /network down/,
  );
});
