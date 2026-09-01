import type { FetchPageOptions, FetchPageResult, FetchPipeline } from './types'

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36'

const MAX_IMAGE_DIMENSION = 1280
const DEFAULT_MAX_PDF_PAGES = 10

const PDF_EXTENSIONS = ['.pdf']
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']

async function truncatePdf(
  pdfBuffer: Buffer,
  maxPages: number,
): Promise<{ buffer: Buffer; truncated: boolean; totalPages: number }> {
  try {
    const { PDFDocument } = await import('pdf-lib' as string)
    const pdfDoc = await PDFDocument.load(pdfBuffer, {
      ignoreEncryption: true,
    })
    const totalPages = pdfDoc.getPageCount()

    if (totalPages <= maxPages) {
      return { buffer: pdfBuffer, truncated: false, totalPages }
    }

    const newDoc = await PDFDocument.create()
    const pages = await newDoc.copyPages(
      pdfDoc,
      Array.from({ length: maxPages }, (_, i) => i),
    )
    for (const page of pages) {
      newDoc.addPage(page)
    }

    const truncatedBytes = await newDoc.save()
    return {
      buffer: Buffer.from(truncatedBytes),
      truncated: true,
      totalPages,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes("Cannot find package 'pdf-lib'")) {
      console.warn(
        '[truncatePdf] pdf-lib not installed, returning full PDF. Install with: npm install pdf-lib',
      )
      return { buffer: pdfBuffer, truncated: false, totalPages: -1 }
    }
    console.warn('[truncatePdf] Failed to truncate PDF:', message)
    return { buffer: pdfBuffer, truncated: false, totalPages: -1 }
  }
}

function getFileType(url: string, contentType?: string): 'pdf' | 'image' | 'html' {
  const urlLower = url.toLowerCase().split('?')[0]

  if (contentType) {
    if (contentType.includes('application/pdf')) return 'pdf'
    if (contentType.startsWith('image/')) return 'image'
    if (contentType.includes('text/html') || contentType.includes('application/xhtml'))
      return 'html'
  }

  if (PDF_EXTENSIONS.some((ext) => urlLower.endsWith(ext))) return 'pdf'
  if (IMAGE_EXTENSIONS.some((ext) => urlLower.endsWith(ext))) return 'image'

  return 'html'
}

export interface FetchWithPipelinesOptions extends FetchPageOptions {
  pipelines?: FetchPipeline[]
  concurrency?: number
}

export async function fetchPage(
  url: string,
  options?: FetchWithPipelinesOptions,
): Promise<FetchPageResult> {
  for (const pipeline of options?.pipelines ?? []) {
    const matches = pipeline.patterns.some((p) => p.test(url))
    if (matches) {
      const result = await pipeline.fetch(url, options)
      if (result.success) return result
    }
  }

  const urlFileType = getFileType(url)
  if (urlFileType === 'pdf' || urlFileType === 'image') {
    return fetchWithHttp(url, options)
  }

  if (options?.render) {
    return fetchWithBrowser(url, options)
  }
  return fetchWithHttp(url, options)
}

async function fetchWithBrowser(url: string, options?: FetchPageOptions): Promise<FetchPageResult> {
  const timeout = options?.timeout ?? 30000

  try {
    const { renderPage } = await import('./browser.js')

    const result = await renderPage(url, {
      proxy: options?.proxy,
      timeout,
    })

    const extracted = await extractContent(result.html, result.url, {
      includeSelectors: options?.includeSelectors,
    })

    return {
      success: true,
      url: result.url,
      title: extracted.title || result.title,
      content: extracted.content,
      wordCount: extracted.content.split(/\s+/).length,
    }
  } catch (error) {
    if (error instanceof MissingHtmlExtractionPeersError) {
      return missingPeersResult(url, error)
    }

    const message = error instanceof Error ? error.message : String(error)

    if (message.includes("Executable doesn't exist") || message.includes('browserType.launch')) {
      throw new Error(
        `Playwright browser not installed.

The fetchPage tool with render:true requires Playwright browsers.
Run this command to install them:

    npx playwright install

Or set render:false if you don't need JavaScript rendering.`,
        { cause: error },
      )
    }

    if (message.includes('Download is starting')) {
      return fetchWithHttp(url, options)
    }

    console.error(`[fetchWithBrowser] ${url}:`, message)

    if (message.includes('timeout') || message.includes('Timeout')) {
      return { success: false, url, error: 'timeout' }
    }
    if (message.includes('net::ERR_')) {
      return { success: false, url, error: 'network_error' }
    }
    if (message.includes('blocked') || message.includes('403') || message.includes('captcha')) {
      return { success: false, url, error: 'blocked' }
    }
    return { success: false, url, error: 'network_error' }
  }
}

async function fetchWithHttp(url: string, options?: FetchPageOptions): Promise<FetchPageResult> {
  const timeout = options?.timeout ?? 30000
  const userAgent = options?.userAgent ?? DEFAULT_USER_AGENT

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeout)

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': userAgent,
        Accept: '*/*',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      signal: controller.signal,
    })

    clearTimeout(timeoutId)

    if (!response.ok) {
      return {
        success: false,
        url,
        httpStatus: response.status,
        error: response.status === 404 ? 'not_found' : 'network_error',
      }
    }

    const contentType = response.headers.get('content-type') ?? ''
    const fileType = getFileType(url, contentType)

    if (fileType === 'pdf') {
      const arrayBuffer = await response.arrayBuffer()
      let buffer = Buffer.from(arrayBuffer)

      const maxPages = options?.maxPdfPages ?? DEFAULT_MAX_PDF_PAGES
      const { buffer: finalBuffer, truncated, totalPages } = await truncatePdf(buffer, maxPages)

      const data = finalBuffer.toString('base64')
      return {
        success: true,
        url,
        httpStatus: response.status,
        title: truncated ? `[PDF truncated to ${maxPages} of ${totalPages} pages]` : undefined,
        media: {
          type: 'document',
          mimeType: 'application/pdf',
          data,
        },
      }
    }

    if (fileType === 'image') {
      return fetchImageContent(response, url)
    }

    const html = await response.text()
    const extracted = await extractContent(html, url, {
      includeSelectors: options?.includeSelectors,
    })

    return {
      success: true,
      url,
      title: extracted.title,
      content: extracted.content,
      wordCount: extracted.content.split(/\s+/).length,
      httpStatus: response.status,
    }
  } catch (error) {
    clearTimeout(timeoutId)

    if (error instanceof Error && error.name === 'AbortError') {
      return { success: false, url, error: 'timeout' }
    }

    if (error instanceof MissingHtmlExtractionPeersError) {
      return missingPeersResult(url, error)
    }

    const message = error instanceof Error ? error.message : String(error)
    console.error(`[fetchWithHttp] ${url}:`, message)
    return { success: false, url, error: 'network_error' }
  }
}

async function fetchImageContent(response: Response, url: string): Promise<FetchPageResult> {
  const arrayBuffer = await response.arrayBuffer()
  let buffer: Buffer<ArrayBufferLike> = Buffer.from(arrayBuffer)

  try {
    const sharpModule = await import('sharp' as string)
    const sharp = sharpModule.default as (input: Buffer) => {
      metadata(): Promise<{
        width?: number
        height?: number
        format?: string
      }>
      resize(w: number, h: number): { toBuffer(): Promise<Buffer<ArrayBufferLike>> }
    }

    const metadata = await sharp(buffer).metadata()
    let { width = 0, height = 0 } = metadata
    const mimeType = `image/${metadata.format ?? 'jpeg'}`

    if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) {
      const scale = Math.min(MAX_IMAGE_DIMENSION / width, MAX_IMAGE_DIMENSION / height)
      const newWidth = Math.round(width * scale)
      const newHeight = Math.round(height * scale)
      buffer = await sharp(buffer).resize(newWidth, newHeight).toBuffer()
      width = newWidth
      height = newHeight
    }

    return {
      success: true,
      url,
      httpStatus: response.status,
      media: {
        type: 'image',
        mimeType,
        data: buffer.toString('base64'),
        width,
        height,
      },
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes("Cannot find package 'sharp'")) {
      const contentType = response.headers.get('content-type') ?? 'image/jpeg'
      return {
        success: true,
        url,
        httpStatus: response.status,
        media: {
          type: 'image',
          mimeType: contentType.split(';')[0],
          data: buffer.toString('base64'),
        },
      }
    }
    throw error
  }
}

function stripStyleTags(html: string): string {
  return html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
}

interface ExtractOptions {
  includeSelectors?: boolean
}

const SELECTOR_ELEMENTS = new Set([
  'section',
  'article',
  'nav',
  'header',
  'footer',
  'main',
  'aside',
  'figure',
  'img',
  'video',
  'form',
])

function getSelector(element: Element): string | null {
  if (element.id) {
    return `#${element.id}`
  }

  const tagName = element.tagName.toLowerCase()
  const classList = Array.from(element.classList).filter((c) => !c.match(/^(js-|is-|has-|--)/))

  if (classList.length > 0) {
    const shortList = classList.slice(0, 2)
    return `${tagName}.${shortList.join('.')}`
  }

  if (SELECTOR_ELEMENTS.has(tagName)) {
    return tagName
  }

  return null
}

function annotateHtmlWithSelectors(html: string, JSDOM: typeof import('jsdom').JSDOM): string {
  const dom = new JSDOM(html)
  const doc = dom.window.document

  const elementsToAnnotate = doc.querySelectorAll(
    Array.from(SELECTOR_ELEMENTS).join(',') + ',[id],[class]',
  )

  const annotations = new Map<Element, string>()

  elementsToAnnotate.forEach((el: Element) => {
    const selector = getSelector(el)
    if (selector && !annotations.has(el)) {
      const hasSubstantialContent =
        (el.textContent?.trim().length ?? 0) > 50 ||
        el.tagName.toLowerCase() === 'img' ||
        el.tagName.toLowerCase() === 'figure'

      if (hasSubstantialContent) {
        el.setAttribute('data-sel', selector)
        annotations.set(el, selector)
      }
    }
  })

  return doc.body.innerHTML
}

const HTML_EXTRACTION_PEERS = ['jsdom', '@mozilla/readability', 'turndown'] as const

/**
 * Thrown when the optional HTML-extraction peers are absent. It exists so the fetch paths can tell
 * "this page could not be reached" apart from "this installation cannot read any page": reported as
 * a network failure, the second one reads to a model as a broken site and it retries forever.
 */
export class MissingHtmlExtractionPeersError extends Error {
  readonly packages = HTML_EXTRACTION_PEERS

  constructor(cause: unknown) {
    super(
      `HTML extraction dependencies not found. Install them with: npm install ${HTML_EXTRACTION_PEERS.join(' ')}`,
      { cause },
    )
    this.name = 'MissingHtmlExtractionPeersError'
  }
}

// Each helper's try wraps nothing but its imports, so the substituted error can only ever stand in
// for a resolution failure.
async function importDomPeers() {
  try {
    const [readability, jsdom] = await Promise.all([
      import('@mozilla/readability'),
      import('jsdom'),
    ])
    return {
      Readability: readability.Readability,
      JSDOM: jsdom.JSDOM,
      VirtualConsole: jsdom.VirtualConsole,
    }
  } catch (error) {
    throw new MissingHtmlExtractionPeersError(error)
  }
}

async function importTurndown() {
  try {
    return (await import('turndown')).default
  } catch (error) {
    throw new MissingHtmlExtractionPeersError(error)
  }
}

function missingPeersResult(url: string, error: MissingHtmlExtractionPeersError): FetchPageResult {
  console.error(`[fetchPage] ${url}: ${error.message}`)
  return { success: false, url, error: 'missing_dependency', errorMessage: error.message }
}

async function extractContent(
  html: string,
  url: string,
  options?: ExtractOptions,
): Promise<{ title: string; content: string }> {
  const { Readability, JSDOM, VirtualConsole } = await importDomPeers()

  const virtualConsole = new VirtualConsole()
  virtualConsole.on('error', () => {})

  let dom: InstanceType<typeof JSDOM>
  try {
    dom = new JSDOM(html, { url, virtualConsole })
  } catch {
    const cleanedHtml = stripStyleTags(html)
    dom = new JSDOM(cleanedHtml, { url, virtualConsole })
  }
  const document = dom.window.document

  const title = document.querySelector('title')?.textContent?.trim() ?? ''

  const reader = new Readability(document)
  const article = reader.parse()

  if (!article) {
    return { title, content: document.body.textContent ?? '' }
  }

  let contentHtml = article.content
  if (options?.includeSelectors) {
    contentHtml = annotateHtmlWithSelectors(contentHtml, JSDOM)
  }

  const TurndownService = await importTurndown()
  const turndown = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
  })

  if (options?.includeSelectors) {
    turndown.addRule('selectorAnnotation', {
      filter: (node: HTMLElement) => !!node.getAttribute?.('data-sel'),
      replacement: (content: string, node: HTMLElement) => {
        const selector = node.getAttribute('data-sel')
        const tagName = node.tagName?.toLowerCase() ?? ''

        if (tagName === 'img') {
          const alt = node.getAttribute('alt') || ''
          const src = node.getAttribute('src') || ''
          return `[@${selector}] ![${alt}](${src})\n`
        }

        if (['section', 'article', 'main', 'aside', 'nav'].includes(tagName)) {
          return `[@${selector}]\n${content}\n`
        }

        return `[@${selector}] ${content}`
      },
    })
  }

  const markdown = turndown.turndown(contentHtml)
  const cleaned = cleanMarkdown(markdown)

  return {
    title: article.title,
    content: cleaned,
  }
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
    .trim()

  return cleaned
}

export async function fetchPages(
  urls: string[],
  options?: FetchWithPipelinesOptions & { concurrency?: number },
): Promise<FetchPageResult[]> {
  const concurrency = options?.concurrency ?? 5
  const results: FetchPageResult[] = []

  for (let i = 0; i < urls.length; i += concurrency) {
    const batch = urls.slice(i, i + concurrency)
    const batchResults = await Promise.all(batch.map((url) => fetchPage(url, options)))
    results.push(...batchResults)
  }

  return results
}
