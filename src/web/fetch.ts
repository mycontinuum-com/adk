import type { FetchPageOptions, FetchPageResult, FetchPipeline } from './types';

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';

export interface FetchWithPipelinesOptions extends FetchPageOptions {
  pipelines?: FetchPipeline[];
}

function findMatchingPipeline(
  url: string,
  pipelines?: FetchPipeline[],
): FetchPipeline | undefined {
  if (!pipelines?.length) return undefined;

  for (const pipeline of pipelines) {
    for (const pattern of pipeline.patterns) {
      if (pattern.test(url)) {
        return pipeline;
      }
    }
  }
  return undefined;
}

export async function fetchPage(
  url: string,
  options?: FetchWithPipelinesOptions,
): Promise<FetchPageResult> {
  const matchedPipeline = findMatchingPipeline(url, options?.pipelines);
  if (matchedPipeline) {
    return matchedPipeline.fetch(url, options);
  }

  if (options?.render) {
    return fetchWithBrowser(url, options);
  }
  return fetchWithHttp(url, options);
}

async function fetchWithBrowser(
  url: string,
  options?: FetchPageOptions,
): Promise<FetchPageResult> {
  const timeout = options?.timeout ?? 30000;
  const extractMode = options?.extractMode ?? 'markdown';

  try {
    const { renderPage } = await import('./browser.js');

    const result = await renderPage(url, {
      proxy: options?.proxy,
      timeout,
    });

    const extracted = await extractContent(
      result.html,
      result.url,
      extractMode,
    );

    return {
      success: true,
      url: result.url,
      title: extracted.title || result.title,
      content: extracted.content,
      wordCount: extracted.content.split(/\s+/).length,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (
      message.includes("Executable doesn't exist") ||
      message.includes('browserType.launch')
    ) {
      throw new Error(`Playwright browser not installed.

The fetchPage tool with render:true requires Playwright browsers.
Run this command to install them:

    npx playwright install

Or set render:false if you don't need JavaScript rendering.`);
    }

    console.error(`[fetchWithBrowser] ${url}:`, message);

    if (message.includes('timeout') || message.includes('Timeout')) {
      return { success: false, url, error: 'timeout' };
    }
    if (message.includes('net::ERR_')) {
      return { success: false, url, error: 'network_error' };
    }
    if (
      message.includes('blocked') ||
      message.includes('403') ||
      message.includes('captcha')
    ) {
      return { success: false, url, error: 'blocked' };
    }
    return { success: false, url, error: 'network_error' };
  }
}

async function fetchWithHttp(
  url: string,
  options?: FetchPageOptions,
): Promise<FetchPageResult> {
  const timeout = options?.timeout ?? 30000;
  const extractMode = options?.extractMode ?? 'markdown';
  const userAgent = options?.userAgent ?? DEFAULT_USER_AGENT;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': userAgent,
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return {
        success: false,
        url,
        httpStatus: response.status,
        error: response.status === 404 ? 'not_found' : 'network_error',
      };
    }

    const html = await response.text();
    const extracted = await extractContent(html, url, extractMode);

    return {
      success: true,
      url,
      title: extracted.title,
      content: extracted.content,
      wordCount: extracted.content.split(/\s+/).length,
      httpStatus: response.status,
    };
  } catch (error) {
    clearTimeout(timeoutId);

    if (error instanceof Error && error.name === 'AbortError') {
      return { success: false, url, error: 'timeout' };
    }

    const message = error instanceof Error ? error.message : String(error);
    console.error(`[fetchWithHttp] ${url}:`, message);
    return { success: false, url, error: 'network_error' };
  }
}

async function extractContent(
  html: string,
  url: string,
  mode: 'markdown' | 'text' | 'readability',
): Promise<{ title: string; content: string }> {
  const { Readability } = await import('@mozilla/readability');
  const { JSDOM } = await import('jsdom');

  const dom = new JSDOM(html, { url });
  const document = dom.window.document;

  const title = document.querySelector('title')?.textContent?.trim() ?? '';

  if (mode === 'text') {
    const reader = new Readability(document);
    const article = reader.parse();
    return {
      title: article?.title ?? title,
      content: article?.textContent ?? document.body.textContent ?? '',
    };
  }

  const reader = new Readability(document);
  const article = reader.parse();

  if (!article) {
    return { title, content: document.body.textContent ?? '' };
  }

  if (mode === 'readability') {
    return { title: article.title, content: article.content };
  }

  const TurndownService = (await import('turndown')).default;
  const turndown = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
  });

  const markdown = turndown.turndown(article.content);
  const cleaned = cleanMarkdown(markdown);

  return {
    title: article.title,
    content: cleaned,
  };
}

function cleanMarkdown(content: string): string {
  let cleaned = content
    // Remove image-only links with no alt text: [![](url)](url)
    .replace(/\[!\[\]\([^)]*\)\]\([^)]*\)/g, '')
    // Remove images with no alt text: ![](url)
    .replace(/!\[\]\([^)]*\)/g, '')
    // Remove empty links: [](url)
    .replace(/\[\]\([^)]*\)/g, '')
    // Collapse multiple newlines into max 2
    .replace(/\n{3,}/g, '\n\n')
    // Remove lines that are only whitespace
    .replace(/^\s+$/gm, '')
    .trim();

  return cleaned;
}

export async function fetchPages(
  urls: string[],
  options?: FetchWithPipelinesOptions & { concurrency?: number },
): Promise<FetchPageResult[]> {
  const concurrency = options?.concurrency ?? 5;
  const results: FetchPageResult[] = [];

  for (let i = 0; i < urls.length; i += concurrency) {
    const batch = urls.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map((url) => fetchPage(url, options)),
    );
    results.push(...batchResults);
  }

  return results;
}
