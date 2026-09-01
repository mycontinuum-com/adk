import type { Browser, Page, BrowserContext } from 'playwright'

import type { ProxyConfig } from './types'

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36'

const VIEWPORT = { width: 1920, height: 1080 }
const MAX_CONCURRENT_BROWSER_OPS = 5

export interface BrowserOptions {
  proxy?: ProxyConfig
  headless?: boolean
  timeout?: number
}

export interface RenderResult {
  html: string
  url: string
  title: string
}

export interface ScreenshotResult {
  success: boolean
  url: string
  title?: string
  image?: {
    mimeType: string
    data: string
    width: number
    height: number
  }
  error?: string
}

let browserInstance: Browser | null = null

class Semaphore {
  private permits: number
  private queue: Array<() => void> = []

  constructor(permits: number) {
    this.permits = permits
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--
      return
    }
    return new Promise((resolve) => this.queue.push(resolve))
  }

  release(): void {
    const next = this.queue.shift()
    if (next) {
      next()
    } else {
      this.permits++
    }
  }
}

const browserSemaphore = new Semaphore(MAX_CONCURRENT_BROWSER_OPS)

function getProxyFromEnv(): ProxyConfig | undefined {
  const host = process.env.PROXY_HOST
  const port = process.env.PROXY_PORT

  if (!host || !port) return undefined

  return {
    host,
    port: parseInt(port, 10),
    username: process.env.PROXY_USERNAME,
    password: process.env.PROXY_PASSWORD,
  }
}

async function launchBrowser(options?: BrowserOptions): Promise<Browser> {
  if (browserInstance) return browserInstance

  const playwright = await import('playwright')

  const proxy = options?.proxy ?? getProxyFromEnv()

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
  }

  if (proxy) {
    launchOptions.proxy = {
      server: `http://${proxy.host}:${proxy.port}`,
      username: proxy.username,
      password: proxy.password,
    }
  }

  browserInstance = await playwright.chromium.launch(launchOptions)
  return browserInstance
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
      'sec-ch-ua': '"Chromium";v="134", "Google Chrome";v="134", "Not:A-Brand";v="99"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"macOS"',
    },
  })

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false })

    Object.defineProperty(navigator, 'plugins', {
      get: () => [
        { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer' },
        {
          name: 'Chrome PDF Viewer',
          filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai',
        },
        { name: 'Native Client', filename: 'internal-nacl-plugin' },
      ],
    })

    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-US', 'en'],
    })

    const originalQuery = window.navigator.permissions.query
    window.navigator.permissions.query = (parameters: PermissionDescriptor) => {
      if (parameters.name === 'notifications') {
        return Promise.resolve({ state: 'denied' } as PermissionStatus)
      }
      return originalQuery(parameters)
    }
  })

  return context
}

async function simulateHumanBehavior(page: Page): Promise<void> {
  await page.mouse.move(Math.random() * VIEWPORT.width, Math.random() * VIEWPORT.height)

  await page.evaluate(() => {
    window.scrollTo({
      top: Math.random() * 500,
      behavior: 'smooth',
    })
  })

  await new Promise((r) => setTimeout(r, 1000 + Math.random() * 2000))
}

export async function renderPage(url: string, options?: BrowserOptions): Promise<RenderResult> {
  await browserSemaphore.acquire()

  try {
    const browser = await launchBrowser(options)
    const context = await createStealthContext(browser)
    const page = await context.newPage()

    const timeout = options?.timeout ?? 30000

    try {
      page.setDefaultTimeout(timeout)

      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout,
      })

      await simulateHumanBehavior(page)

      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {})

      const html = await page.content()
      const title = await page.title()
      const finalUrl = page.url()

      return { html, url: finalUrl, title }
    } finally {
      await page.close()
      await context.close()
    }
  } finally {
    browserSemaphore.release()
  }
}

export interface ScreenshotOptions extends BrowserOptions {
  fullPage?: boolean
  selector?: string
  maxWidth?: number
  maxHeight?: number
}

const MAX_SCREENSHOT_DIMENSION = 1280

export async function screenshotPage(
  url: string,
  options?: ScreenshotOptions,
): Promise<ScreenshotResult> {
  await browserSemaphore.acquire()

  try {
    const browser = await launchBrowser(options)
    const context = await createStealthContext(browser)
    const page = await context.newPage()

    const timeout = options?.timeout ?? 30000
    const fullPage = options?.fullPage ?? true
    const maxWidth = Math.min(
      options?.maxWidth ?? MAX_SCREENSHOT_DIMENSION,
      MAX_SCREENSHOT_DIMENSION,
    )
    const maxHeight = Math.min(
      options?.maxHeight ?? MAX_SCREENSHOT_DIMENSION,
      MAX_SCREENSHOT_DIMENSION,
    )

    const downloadExtensions = ['.pdf', '.zip', '.tar', '.gz', '.exe', '.dmg', '.pkg', '.msi']
    const urlLower = url.toLowerCase()
    const isDownloadUrl = downloadExtensions.some((ext) => urlLower.endsWith(ext))
    if (isDownloadUrl) {
      await context.close()
      return {
        success: false,
        url,
        error: `Cannot screenshot download URL (${url.split('.').pop()?.toUpperCase()} file)`,
      }
    }

    try {
      page.setDefaultTimeout(timeout)

      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout,
      })

      await simulateHumanBehavior(page)

      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {})

      const title = await page.title()
      const finalUrl = page.url()

      let screenshotBuffer: Buffer
      if (options?.selector) {
        const element = page.locator(options.selector).first()
        const isVisible = await element.isVisible().catch(() => false)
        if (isVisible) {
          screenshotBuffer = await element.screenshot({ type: 'png' })
        } else {
          screenshotBuffer = await page.screenshot({
            type: 'png',
            fullPage,
            clip: fullPage
              ? undefined
              : { x: 0, y: 0, width: VIEWPORT.width, height: VIEWPORT.height },
          })
        }
      } else {
        screenshotBuffer = await page.screenshot({
          type: 'png',
          fullPage,
          clip: fullPage
            ? undefined
            : { x: 0, y: 0, width: VIEWPORT.width, height: VIEWPORT.height },
        })
      }

      const sharpModule = await import('sharp' as string)
      const sharp = sharpModule.default as (input: Buffer) => {
        metadata(): Promise<{ width?: number; height?: number }>
        resize(w: number, h: number): { png(): { toBuffer(): Promise<Buffer> } }
      }
      const metadata = await sharp(screenshotBuffer).metadata()
      let { width = VIEWPORT.width, height = VIEWPORT.height } = metadata

      if (width > maxWidth || height > maxHeight) {
        const scale = Math.min(maxWidth / width, maxHeight / height)
        const newWidth = Math.round(width * scale)
        const newHeight = Math.round(height * scale)
        screenshotBuffer = (await sharp(screenshotBuffer)
          .resize(newWidth, newHeight)
          .png()
          .toBuffer()) as Buffer
        width = newWidth
        height = newHeight
      }

      return {
        success: true,
        url: finalUrl,
        title,
        image: {
          mimeType: 'image/png',
          data: screenshotBuffer.toString('base64'),
          width,
          height,
        },
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)

      if (message.includes("Executable doesn't exist") || message.includes('browserType.launch')) {
        throw new Error(
          `Playwright browser not installed.

The screenshot tool requires Playwright browsers.
Run this command to install them:

    npx playwright install

`,
          { cause: error },
        )
      }

      if (message.includes("Cannot find package 'sharp'")) {
        throw new Error(
          `Sharp package not installed.

The screenshot tool requires 'sharp' for image processing.
Run this command to install it:

    npm install sharp

`,
          { cause: error },
        )
      }

      if (message.includes('Download is starting')) {
        return {
          success: false,
          url,
          error: 'Cannot screenshot - URL triggers a file download',
        }
      }

      console.error(`[screenshotPage] ${url}:`, message)
      return { success: false, url, error: message }
    } finally {
      await page.close()
      await context.close()
    }
  } finally {
    browserSemaphore.release()
  }
}

export async function closeBrowser(): Promise<void> {
  if (browserInstance) {
    await browserInstance.close()
    browserInstance = null
  }
}

export async function screenshotPages(
  urls: string[],
  options?: ScreenshotOptions & { concurrency?: number },
): Promise<ScreenshotResult[]> {
  const concurrency = options?.concurrency ?? 3
  const results: ScreenshotResult[] = []

  for (let i = 0; i < urls.length; i += concurrency) {
    const batch = urls.slice(i, i + concurrency)
    const batchResults = await Promise.all(batch.map((url) => screenshotPage(url, options)))
    results.push(...batchResults)
  }

  return results
}
