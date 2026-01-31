export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  position: number;
  date?: string;
  content?: string;
}

export interface SearchOptions {
  numResults?: number;
  country?: string;
  searchType?: 'web' | 'news' | 'images';
}

export interface SearchProvider {
  name: string;
  search(query: string, options?: SearchOptions): Promise<SearchResult[]>;
}

export interface ProxyConfig {
  host: string;
  port: number;
  username?: string;
  password?: string;
}

export interface FetchPageOptions {
  timeout?: number;
  extractMode?: 'markdown' | 'text' | 'readability';
  userAgent?: string;
  render?: boolean;
  proxy?: ProxyConfig;
}

export interface FetchPageResult {
  success: boolean;
  url: string;
  title?: string;
  content?: string;
  wordCount?: number;
  error?: 'timeout' | 'blocked' | 'not_found' | 'network_error' | 'api_error';
  httpStatus?: number;
  pipeline?: string;
  raw?: unknown;
}

export interface FetchPipeline {
  name: string;
  patterns: RegExp[];
  fetch(url: string, options?: FetchPageOptions): Promise<FetchPageResult>;
}
