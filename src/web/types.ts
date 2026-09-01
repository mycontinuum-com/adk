export interface SearchResult {
  title: string
  url: string
  snippet: string
  position: number
  date?: string
  content?: string
}

export interface SearchOptions {
  numResults?: number
  country?: string
  searchType?: 'web' | 'news' | 'images'
}

export interface SearchProvider {
  name: string
  search(query: string, options?: SearchOptions): Promise<SearchResult[]>
}

export interface ProxyConfig {
  host: string
  port: number
  username?: string
  password?: string
}

export interface FetchPageOptions {
  timeout?: number
  userAgent?: string
  render?: boolean
  proxy?: ProxyConfig
  includeSelectors?: boolean
  maxPdfPages?: number
}

export interface FetchPageMedia {
  type: 'image' | 'document'
  mimeType: string
  data: string
  width?: number
  height?: number
}

export interface FetchPageResult {
  success: boolean
  url: string
  title?: string
  content?: string
  wordCount?: number
  error?: 'timeout' | 'blocked' | 'not_found' | 'network_error' | 'api_error' | 'missing_dependency'
  /** Human- and model-readable detail for the failure, e.g. which packages to install. */
  errorMessage?: string
  httpStatus?: number
  pipeline?: string
  raw?: unknown
  media?: FetchPageMedia
}

export interface FetchPipeline {
  name: string
  patterns: RegExp[]
  fetch(url: string, options?: FetchPageOptions): Promise<FetchPageResult>
}

export interface PipelineCache<T = FetchPageResult> {
  get(url: string): T | null | Promise<T | null>
  set(url: string, result: T): void | Promise<void>
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
