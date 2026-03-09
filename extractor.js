import { access } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import TurndownService from 'turndown';
import { Readability } from '@mozilla/readability';

const DEFAULT_TIMEOUT_MS = 25000;
const DEFAULT_MAX_CHARS = 30000;
const MIN_CONTENT_LENGTH_FOR_FALLBACK = 120;

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

function withWarnings(result, warnings = []) {
  return {
    ...result,
    warnings: [...result.warnings, ...warnings.filter(Boolean)],
  };
}

function detectPlaywrightFallbackReason(fetchResult, extractedResult) {
  if (!fetchResult.ok) {
    return `HTTP status ${fetchResult.status}`;
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

async function resolveChromiumExecutablePath() {
  const configuredCandidates = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    process.env.CHROME_PATH,
    process.env.EDGE_PATH,
  ].filter(Boolean);

  for (const candidate of [...configuredCandidates, ...WINDOWS_BROWSER_CANDIDATES]) {
    if (await fileExists(candidate)) {
      return candidate;
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

    return {
      ok: response.ok,
      status: response.status,
      finalUrl: response.url,
      html: await response.text(),
      headers: Object.fromEntries(response.headers.entries()),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchHtmlWithPlaywright(url, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const { chromium } = await import('playwright-core');
  const executablePath = await resolveChromiumExecutablePath();
  const browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
  });

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
      headers: {},
    };
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
    throw new Error(`无法从页面中提取正文: ${sourceUrl}`);
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

  const extractUsing = async (fetchResult, sourcePrefix, extraWarnings = []) => extractFromHtml(fetchResult.html, sourceUrl, {
    ...options,
    finalUrl: fetchResult.finalUrl,
    status: fetchResult.status,
    fetchOk: fetchResult.ok,
    sourcePrefix,
    extraWarnings,
  });

  const tryPlaywrightFallback = async (reason, primaryResult) => {
    if (!enablePlaywrightFallback) {
      return null;
    }

    try {
      const playwrightResult = await playwrightImpl(sourceUrl, timeoutMs);
      return await extractUsing(playwrightResult, 'playwright', [`Playwright fallback: ${reason}`]);
    } catch (fallbackError) {
      if (!primaryResult) {
        throw fallbackError;
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

export async function extractMany(urls, options = {}) {
  const results = [];
  for (const url of urls) {
    try {
      const result = await extractUrl(url, options);
      results.push({ ok: true, url, result });
    } catch (error) {
      results.push({
        ok: false,
        url,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}
