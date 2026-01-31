import type { SearchProvider, SearchResult, SearchOptions } from './types';

interface SerperResponse {
  organic?: Array<{
    title: string;
    link: string;
    snippet: string;
    position: number;
    date?: string;
  }>;
  news?: Array<{
    title: string;
    link: string;
    snippet: string;
    date?: string;
  }>;
  images?: Array<{
    title: string;
    link: string;
    imageUrl: string;
  }>;
}

export class SerperProvider implements SearchProvider {
  readonly name = 'serper';
  private apiKey: string;
  private baseUrl = 'https://google.serper.dev';

  constructor(apiKey?: string) {
    this.apiKey = apiKey ?? process.env.SERPER_API_KEY ?? '';
    if (!this.apiKey) {
      throw new Error(
        `No Serper API key configured.

Set the environment variable:
  - SERPER_API_KEY    (Get one at https://serper.dev)

Or pass directly to webSearch:
  webSearch({ provider: new SerperProvider('your-api-key') })`,
      );
    }
  }

  async search(
    query: string,
    options?: SearchOptions,
  ): Promise<SearchResult[]> {
    const searchType = options?.searchType ?? 'web';
    const endpoint = searchType === 'web' ? '/search' : `/${searchType}`;

    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      method: 'POST',
      headers: {
        'X-API-KEY': this.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        q: query,
        num: options?.numResults ?? 10,
        gl: options?.country?.toLowerCase(),
      }),
    });

    if (!response.ok) {
      throw new Error(
        `Serper API error: ${response.status} ${response.statusText}`,
      );
    }

    const data = (await response.json()) as SerperResponse;
    return this.parseResults(data, searchType);
  }

  private parseResults(
    data: SerperResponse,
    searchType: string,
  ): SearchResult[] {
    if (searchType === 'news' && data.news) {
      return data.news.map((item, index) => ({
        title: item.title,
        url: item.link,
        snippet: item.snippet,
        position: index + 1,
        date: item.date,
      }));
    }

    if (searchType === 'images' && data.images) {
      return data.images.map((item, index) => ({
        title: item.title,
        url: item.link,
        snippet: item.imageUrl,
        position: index + 1,
      }));
    }

    return (data.organic ?? []).map((item) => ({
      title: item.title,
      url: item.link,
      snippet: item.snippet,
      position: item.position,
      date: item.date,
    }));
  }
}
