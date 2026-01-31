import type { Browser, Page, BrowserContext } from 'playwright';
import type { ProxyConfig } from './types';

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';

const VIEWPORT = { width: 1920, height: 1080 };

export interface BrowserOptions {
  proxy?: ProxyConfig;
  headless?: boolean;
  timeout?: number;
}

export interface RenderResult {
  html: string;
  url: string;
  title: string;
}

let browserInstance: Browser | null = null;

function getProxyFromEnv(): ProxyConfig | undefined {
  const host = process.env.PROXY_HOST;
  const port = process.env.PROXY_PORT;

  if (!host || !port) return undefined;

  return {
    host,
    port: parseInt(port, 10),
    username: process.env.PROXY_USERNAME,
    password: process.env.PROXY_PASSWORD,
  };
}

async function launchBrowser(options?: BrowserOptions): Promise<Browser> {
  if (browserInstance) return browserInstance;

  const playwright = await import('playwright');

  const proxy = options?.proxy ?? getProxyFromEnv();

  const launchOptions: Parameters<typeof playwright.chromium.launch>[0] = {
    headless: options?.headless ?? true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu',
    ],
  };

  if (proxy) {
    launchOptions.proxy = {
      server: `http://${proxy.host}:${proxy.port}`,
      username: proxy.username,
      password: proxy.password,
    };
  }

  browserInstance = await playwright.chromium.launch(launchOptions);
  return browserInstance;
}

async function createStealthContext(browser: Browser): Promise<BrowserContext> {
  const context = await browser.newContext({
    userAgent: DEFAULT_USER_AGENT,
    viewport: VIEWPORT,
    locale: 'en-US',
    timezoneId: 'America/New_York',
    permissions: ['geolocation'],
    geolocation: { latitude: 40.7128, longitude: -74.006 },
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
      Accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'sec-ch-ua':
        '"Chromium";v="134", "Google Chrome";v="134", "Not:A-Brand";v="99"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"macOS"',
    },
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });

    Object.defineProperty(navigator, 'plugins', {
      get: () => [
        { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer' },
        {
          name: 'Chrome PDF Viewer',
          filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai',
        },
        { name: 'Native Client', filename: 'internal-nacl-plugin' },
      ],
    });

    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-US', 'en'],
    });

    const originalQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (parameters: PermissionDescriptor) => {
      if (parameters.name === 'notifications') {
        return Promise.resolve({ state: 'denied' } as PermissionStatus);
      }
      return originalQuery(parameters);
    };
  });

  return context;
}

async function simulateHumanBehavior(page: Page): Promise<void> {
  await page.mouse.move(
    Math.random() * VIEWPORT.width,
    Math.random() * VIEWPORT.height,
  );

  await page.evaluate(() => {
    window.scrollTo({
      top: Math.random() * 500,
      behavior: 'smooth',
    });
  });

  await new Promise((r) => setTimeout(r, 1000 + Math.random() * 2000));
}

export async function renderPage(
  url: string,
  options?: BrowserOptions,
): Promise<RenderResult> {
  const browser = await launchBrowser(options);
  const context = await createStealthContext(browser);
  const page = await context.newPage();

  const timeout = options?.timeout ?? 30000;

  try {
    page.setDefaultTimeout(timeout);

    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout,
    });

    await simulateHumanBehavior(page);

    await page
      .waitForLoadState('networkidle', { timeout: 10000 })
      .catch(() => {});

    const html = await page.content();
    const title = await page.title();
    const finalUrl = page.url();

    return { html, url: finalUrl, title };
  } finally {
    await page.close();
    await context.close();
  }
}

export async function closeBrowser(): Promise<void> {
  if (browserInstance) {
    await browserInstance.close();
    browserInstance = null;
  }
}
