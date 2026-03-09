import { access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { JSDOM } from 'jsdom';
import TurndownService from 'turndown';
import { Readability } from '@mozilla/readability';

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 25000;
const DEFAULT_MAX_CHARS = 30000;
const DEFAULT_BATCH_CONCURRENCY = 3;
const MAX_BATCH_CONCURRENCY = 8;
const MIN_CONTENT_LENGTH_FOR_FALLBACK = 120;

const ERROR_CODES = {
  FETCH_ERROR: 'FETCH_ERROR',
  NON_HTML_RESPONSE: 'NON_HTML_RESPONSE',
  EXTRACTION_ERROR: 'EXTRACTION_ERROR',
  PLAYWRIGHT_UNAVAILABLE: 'PLAYWRIGHT_UNAVAILABLE',
  PLAYWRIGHT_FALLBACK_FAILED: 'PLAYWRIGHT_FALLBACK_FAILED',
};

const DEFAULT_HEADERS = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
  'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'cache-control': 'no-cache',
  'pragma': 'no-cache',
};

const MAIN_SELECTORS = [
  '#js_content',
  '.rich_media_content',
  'article',
  'main',
  '.post-content',
  '.entry-content',
  '.article-content',
  '.markdown-body',
  '[class*="article"]',
  '[class*="content"]',
  '[class*="body"]',
];

const PLAYWRIGHT_FALLBACK_PATTERNS = [
  /enable javascript/i,
  /please turn javascript on/i,
  /verify you are human/i,
  /captcha/i,
  /access denied/i,
  /just a moment/i,
  /checking your browser/i,
  /bot check/i,
  /cf-browser-verification/i,
];

const WINDOWS_BROWSER_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
];

const MACOS_BROWSER_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
];

const LINUX_BROWSER_CANDIDATES = [
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/microsoft-edge',
];

function createTurndown() {
  const turndown = new TurndownService({
    codeBlockStyle: 'fenced',
    headingStyle: 'atx',
    bulletListMarker: '-',
    emDelimiter: '_',
  });

  turndown.addRule('keepImages', {
    filter: 'img',
    replacement: (_content, node) => {
      const alt = node.getAttribute('alt') || 'image';
      const src = node.getAttribute('src') || node.getAttribute('data-src') || '';
      return src ? `![${alt}](${src})` : '';
    },
  });

  return turndown;
}

function truncate(text, maxChars) {
  if (!text) return '';
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n\n[truncated]`;
}

function cleanWhitespace(text) {
  return text
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

function absolutizeMediaUrls(root, baseUrl) {
  for (const element of root.querySelectorAll('[href], [src], [data-src]')) {
    for (const attr of ['href', 'src', 'data-src']) {
      const value = element.getAttribute(attr);
      if (!value) continue;

      try {
        element.setAttribute(attr, new URL(value, baseUrl).toString());
      } catch {
      }
    }
  }
}

function removeNoise(root) {
  for (const selector of [
    'script',
    'style',
    'noscript',
    'svg',
    'canvas',
    'iframe',
    'form',
    'nav',
    'footer',
    'aside',
    '[aria-hidden="true"]',
    '.advertisement',
    '.adsbygoogle',
    '.related_posts',
    '.recommend',
  ]) {
    for (const node of root.querySelectorAll(selector)) {
      node.remove();
    }
  }
}

function pickMeta(document, selectors) {
  for (const selector of selectors) {
    const value = document.querySelector(selector)?.getAttribute('content') || document.querySelector(selector)?.textContent;
    if (value && value.trim()) {
      return value.trim();
    }
  }
  return '';
}

function createStructuredError(code, stage, message, options = {}) {
  const error = new Error(message, options.cause ? { cause: options.cause } : undefined);
  error.errorCode = code;
  error.errorStage = stage;
  error.retryable = Boolean(options.retryable);
  return error;
}

function normalizeError(error, fallback = {}) {
  return {
    message: error instanceof Error ? error.message : String(error),
    errorCode: error?.errorCode || fallback.errorCode || 'UNKNOWN_ERROR',
    errorStage: error?.errorStage || fallback.errorStage || 'unknown',
    retryable: typeof error?.retryable === 'boolean' ? error.retryable : Boolean(fallback.retryable),
  };
}

function withWarnings(result, warnings = []) {
  return {
    ...result,
    warnings: [...result.warnings, ...warnings.filter(Boolean)],
  };
}

function isHtmlContentType(contentType = '') {
  const normalized = String(contentType).toLowerCase();
  return normalized.includes('text/html') || normalized.includes('application/xhtml+xml');
}

function getHeader(headers = {}, name) {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) {
    if (String(key).toLowerCase() === target) {
      return value;
    }
  }
  return '';
}

function detectPlaywrightFallbackReason(fetchResult, extractedResult) {
  if (!fetchResult.ok) {
    return `HTTP status ${fetchResult.status}`;
  }

  if (fetchResult.contentType && !isHtmlContentType(fetchResult.contentType)) {
    return `non-HTML response (${fetchResult.contentType})`;
  }

  const htmlSnippet = (fetchResult.html || '').slice(0, 6000);
  if (PLAYWRIGHT_FALLBACK_PATTERNS.some((pattern) => pattern.test(htmlSnippet))) {
    return 'page appears to require browser rendering or human verification';
  }

  if (!extractedResult.markdown || extractedResult.contentLength < MIN_CONTENT_LENGTH_FOR_FALLBACK) {
    return `extracted content too short (${extractedResult.contentLength} chars)`;
  }

  return null;
}

async function fileExists(filePath) {
  if (!filePath) return false;

  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function lookupCommandPath(command, platform = process.platform) {
  const lookupCommand = platform === 'win32' ? 'where' : 'which';

  try {
    const { stdout } = await execFileAsync(lookupCommand, [command]);
    const firstLine = stdout.split(/\r?\n/).find(Boolean)?.trim();
    return firstLine || undefined;
  } catch {
    return undefined;
  }
}

export async function resolveChromiumExecutablePath(options = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const fileExistsImpl = options.fileExistsImpl ?? fileExists;
  const commandLookupImpl = options.commandLookupImpl ?? lookupCommandPath;

  const configuredCandidates = [
    env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    env.CHROME_PATH,
    env.EDGE_PATH,
  ].filter(Boolean);

  const platformCandidates = platform === 'darwin'
    ? MACOS_BROWSER_CANDIDATES
    : platform === 'linux'
      ? LINUX_BROWSER_CANDIDATES
      : WINDOWS_BROWSER_CANDIDATES;

  for (const candidate of [...configuredCandidates, ...platformCandidates]) {
    if (await fileExistsImpl(candidate)) {
      return candidate;
    }
  }

  for (const command of ['google-chrome', 'chromium', 'chromium-browser', 'microsoft-edge']) {
    const resolved = await commandLookupImpl(command, platform);
    if (resolved) {
      return resolved;
    }
  }

  return undefined;
}

function extractBySelector(document, sourceUrl) {
  for (const selector of MAIN_SELECTORS) {
    const element = document.querySelector(selector);
    if (!element) continue;

    const cloned = element.cloneNode(true);
    absolutizeMediaUrls(cloned, sourceUrl);
    removeNoise(cloned);

    const turndown = createTurndown();
    const markdown = cleanWhitespace(turndown.turndown(cloned.innerHTML || cloned.outerHTML || ''));

    if (markdown.length > 100) {
      return {
        strategy: `selector:${selector}`,
        html: cloned.innerHTML || cloned.outerHTML || '',
        markdown,
        text: cleanWhitespace(cloned.textContent || ''),
        images: [...cloned.querySelectorAll('img')]
          .map((img) => img.getAttribute('src') || img.getAttribute('data-src') || '')
          .filter(Boolean),
      };
    }
  }

  return null;
}

function extractWithReadability(document, sourceUrl) {
  const clonedDocument = new JSDOM(document.documentElement.outerHTML, { url: sourceUrl }).window.document;
  removeNoise(clonedDocument);
  absolutizeMediaUrls(clonedDocument, sourceUrl);

  const article = new Readability(clonedDocument, {
    keepClasses: false,
    charThreshold: 80,
  }).parse();

  if (!article?.content) {
    return null;
  }

  const wrapper = new JSDOM(`<article>${article.content}</article>`, { url: sourceUrl }).window.document.body;
  absolutizeMediaUrls(wrapper, sourceUrl);

  const turndown = createTurndown();
  const markdown = cleanWhitespace(turndown.turndown(wrapper.innerHTML || ''));

  return {
    strategy: 'readability',
    html: article.content,
    markdown,
    text: cleanWhitespace(article.textContent || ''),
    images: [...wrapper.querySelectorAll('img')]
      .map((img) => img.getAttribute('src') || img.getAttribute('data-src') || '')
      .filter(Boolean),
  };
}

async function fetchHtml(url, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      headers: {
        ...DEFAULT_HEADERS,
        referer: new URL(url).origin,
      },
      redirect: 'follow',
      signal: controller.signal,
    });

    const headers = Object.fromEntries(response.headers.entries());
    return {
      ok: response.ok,
      status: response.status,
      finalUrl: response.url,
      html: await response.text(),
      headers,
      contentType: getHeader(headers, 'content-type'),
    };
  } catch (error) {
    throw createStructuredError(
      ERROR_CODES.FETCH_ERROR,
      'fetch',
      `Failed to fetch URL: ${error instanceof Error ? error.message : String(error)}`,
      { retryable: true, cause: error },
    );
  } finally {
    clearTimeout(timer);
  }
}

async function fetchHtmlWithPlaywright(url, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const { chromium } = await import('playwright-core');
  const executablePath = await resolveChromiumExecutablePath();

  if (!executablePath) {
    throw createStructuredError(
      ERROR_CODES.PLAYWRIGHT_UNAVAILABLE,
      'playwright',
      'Playwright fallback requires a local Chromium/Chrome/Edge executable. Set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH or install a supported browser.',
      { retryable: false },
    );
  }

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      executablePath,
    });
  } catch (error) {
    throw createStructuredError(
      ERROR_CODES.PLAYWRIGHT_UNAVAILABLE,
      'playwright',
      `Unable to launch Playwright browser: ${error instanceof Error ? error.message : String(error)}`,
      { retryable: false, cause: error },
    );
  }

  try {
    const page = await browser.newPage({
      userAgent: DEFAULT_HEADERS['user-agent'],
      locale: 'zh-CN',
    });

    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: timeoutMs,
    });

    try {
      await page.waitForLoadState('networkidle', {
        timeout: Math.min(5000, Math.max(1500, Math.floor(timeoutMs / 3))),
      });
    } catch {
    }

    const status = response?.status() ?? 200;
    return {
      ok: status >= 200 && status < 400,
      status,
      finalUrl: page.url(),
      html: await page.content(),
      headers: { 'content-type': 'text/html; charset=utf-8' },
      contentType: 'text/html; charset=utf-8',
    };
  } catch (error) {
    throw createStructuredError(
      ERROR_CODES.PLAYWRIGHT_FALLBACK_FAILED,
      'playwright',
      `Playwright fetch failed: ${error instanceof Error ? error.message : String(error)}`,
      { retryable: true, cause: error },
    );
  } finally {
    await browser.close();
  }
}

export function extractFromHtml(html, sourceUrl, options = {}) {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const status = options.status ?? 200;
  const finalUrl = options.finalUrl ?? sourceUrl;
  const fetchOk = options.fetchOk ?? true;
  const sourcePrefix = options.sourcePrefix ? `${options.sourcePrefix}:` : '';
  const extraWarnings = options.extraWarnings ?? [];

  const dom = new JSDOM(html, { url: finalUrl });
  const { document } = dom.window;

  const readabilityResult = extractWithReadability(document, finalUrl);
  const selectorResult = extractBySelector(document, finalUrl);
  const primary = selectorResult && selectorResult.markdown.length > (readabilityResult?.markdown.length || 0) * 0.6
    ? selectorResult
    : (readabilityResult || selectorResult);

  if (!primary) {
    throw createStructuredError(ERROR_CODES.EXTRACTION_ERROR, 'extract', `无法从页面中提取正文: ${sourceUrl}`, { retryable: false });
  }

  return {
    url: sourceUrl,
    finalUrl,
    status,
    title: pickMeta(document, ['meta[property="og:title"]', 'meta[name="twitter:title"]', 'meta[name="title"]', '#activity-name', 'h1', 'title']) || '',
    author: pickMeta(document, ['meta[name="author"]', 'meta[property="article:author"]', '#js_name', '.rich_media_meta_nickname', '.author', '.byline']) || '',
    publishedAt: pickMeta(document, ['meta[property="article:published_time"]', 'meta[name="publishdate"]', '#publish_time', 'time']) || '',
    sourceStrategy: `${sourcePrefix}${primary.strategy}`,
    markdown: truncate(primary.markdown, maxChars),
    plainText: truncate(primary.text, maxChars),
    excerpt: truncate(primary.text, 280),
    images: primary.images.slice(0, 50),
    contentLength: primary.text.length,
    warnings: [
      ...extraWarnings,
      fetchOk ? null : `HTTP status ${status}`,
      primary.markdown.length >= maxChars ? `输出已按 maxChars=${maxChars} 截断` : null,
    ].filter(Boolean),
  };
}

export async function extractUrl(sourceUrl, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetchHtml;
  const playwrightImpl = options.playwrightImpl ?? fetchHtmlWithPlaywright;
  const enablePlaywrightFallback = options.playwrightFallback ?? true;

  const extractUsing = async (fetchResult, sourcePrefix, extraWarnings = []) => {
    if (fetchResult.contentType && !isHtmlContentType(fetchResult.contentType)) {
      throw createStructuredError(
        ERROR_CODES.NON_HTML_RESPONSE,
        sourcePrefix,
        `Response is not HTML (${fetchResult.contentType})`,
        { retryable: false },
      );
    }

    return extractFromHtml(fetchResult.html, sourceUrl, {
      ...options,
      finalUrl: fetchResult.finalUrl,
      status: fetchResult.status,
      fetchOk: fetchResult.ok,
      sourcePrefix,
      extraWarnings,
    });
  };

  const tryPlaywrightFallback = async (reason, primaryResult) => {
    if (!enablePlaywrightFallback) {
      return null;
    }

    try {
      const playwrightResult = await playwrightImpl(sourceUrl, timeoutMs);
      return await extractUsing(playwrightResult, 'playwright', [`Playwright fallback: ${reason}`]);
    } catch (fallbackError) {
      if (!primaryResult) {
        throw createStructuredError(
          ERROR_CODES.PLAYWRIGHT_FALLBACK_FAILED,
          'playwright',
          `Playwright fallback failed: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`,
          { retryable: Boolean(fallbackError?.retryable), cause: fallbackError },
        );
      }

      return withWarnings(primaryResult, [`Playwright fallback failed: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`]);
    }
  };

  try {
    const fetchResult = await fetchImpl(sourceUrl, timeoutMs);
    const primaryResult = await extractUsing(fetchResult, 'fetch');
    const fallbackReason = detectPlaywrightFallbackReason(fetchResult, primaryResult);

    if (!fallbackReason) {
      return primaryResult;
    }

    return (await tryPlaywrightFallback(fallbackReason, primaryResult)) ?? primaryResult;
  } catch (error) {
    const fallbackReason = `primary fetch failed: ${error instanceof Error ? error.message : String(error)}`;
    const fallbackResult = await tryPlaywrightFallback(fallbackReason);
    if (fallbackResult) {
      return fallbackResult;
    }
    throw error;
  }
}

function clampConcurrency(value) {
  const normalized = Number.isInteger(value) ? value : DEFAULT_BATCH_CONCURRENCY;
  return Math.max(1, Math.min(MAX_BATCH_CONCURRENCY, normalized));
}

export async function extractMany(urls, options = {}) {
  const concurrency = clampConcurrency(options.concurrency ?? DEFAULT_BATCH_CONCURRENCY);
  const results = new Array(urls.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= urls.length) {
        return;
      }

      const url = urls[currentIndex];
      try {
        const result = await extractUrl(url, options);
        results[currentIndex] = { ok: true, url, result };
      } catch (error) {
        const normalizedError = normalizeError(error);
        results[currentIndex] = {
          ok: false,
          url,
          error: normalizedError.message,
          errorCode: normalizedError.errorCode,
          errorStage: normalizedError.errorStage,
          retryable: normalizedError.retryable,
        };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, () => worker()));
  return results;
}
