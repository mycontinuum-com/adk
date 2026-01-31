import { SerperProvider } from './serper';
import { linkedInPipeline, ScrapinProvider } from './scrapin';
import { webSearch, fetchPage } from './tools';

describe('URL pattern matching', () => {
  const mockScrapinPipeline = {
    name: 'scrapin',
    patterns: [/linkedin\.com\/in\//, /linkedin\.com\/company\//],
    fetch: jest.fn().mockResolvedValue({
      success: true,
      url: 'https://linkedin.com/in/test',
      content: 'test content',
      pipeline: 'scrapin',
    }),
  };

  test('matches LinkedIn person URLs', () => {
    const urls = [
      'https://www.linkedin.com/in/johndoe',
      'https://linkedin.com/in/jane-doe/',
      'https://www.linkedin.com/in/user123?param=value',
    ];

    for (const url of urls) {
      const matched = mockScrapinPipeline.patterns.some((p) => p.test(url));
      expect(matched).toBe(true);
    }
  });

  test('matches LinkedIn company URLs', () => {
    const urls = [
      'https://www.linkedin.com/company/acme-corp',
      'https://linkedin.com/company/123456/',
      'https://www.linkedin.com/company/my-company?param=value',
    ];

    for (const url of urls) {
      const matched = mockScrapinPipeline.patterns.some((p) => p.test(url));
      expect(matched).toBe(true);
    }
  });

  test('does not match non-LinkedIn URLs', () => {
    const urls = [
      'https://example.com/in/user',
      'https://twitter.com/user',
      'https://github.com/company/repo',
      'https://linkedin.com/feed',
      'https://linkedin.com/jobs/view/123',
    ];

    for (const url of urls) {
      const matched = mockScrapinPipeline.patterns.some((p) => p.test(url));
      expect(matched).toBe(false);
    }
  });
});

describe('Scrapin provider', () => {
  test('fetchPerson returns structured data', async () => {
    const mockPersonData = {
      success: true,
      person: {
        publicIdentifier: 'johndoe',
        linkedInUrl: 'https://linkedin.com/in/johndoe',
        firstName: 'John',
        lastName: 'Doe',
        headline: 'Senior Engineer at Tech Corp',
        location: {
          city: 'San Francisco',
          state: 'California',
          country: 'United States',
        },
        summary: 'Experienced engineer with 10+ years in tech.',
        positions: {
          positionsCount: 2,
          positionHistory: [
            {
              title: 'Senior Engineer',
              companyName: 'Tech Corp',
              description: 'Leading engineering team',
              startEndDate: {
                start: { month: 1, year: 2022 },
                end: null,
              },
            },
            {
              title: 'Engineer',
              companyName: 'Startup Inc',
              startEndDate: {
                start: { month: 6, year: 2018 },
                end: { month: 12, year: 2021 },
              },
            },
          ],
        },
        schools: {
          educationsCount: 1,
          educationHistory: [
            {
              schoolName: 'MIT',
              degreeName: 'Bachelor of Science',
              fieldOfStudy: 'Computer Science',
              startEndDate: {
                start: { year: 2014 },
                end: { year: 2018 },
              },
            },
          ],
        },
        skills: ['JavaScript', 'TypeScript', 'Python'],
      },
    };

    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockPersonData),
    });
    const originalFetch = global.fetch;
    global.fetch = mockFetch as unknown as typeof fetch;

    try {
      const provider = new ScrapinProvider('test-api-key');
      const result = await provider.fetchPerson(
        'https://linkedin.com/in/johndoe',
      );

      expect(result.success).toBe(true);
      expect(result.person?.firstName).toBe('John');
      expect(result.person?.lastName).toBe('Doe');
      expect(result.person?.positions?.positionHistory).toHaveLength(2);
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('fetchCompany returns structured data', async () => {
    const mockCompanyData = {
      success: true,
      company: {
        linkedInId: '12345',
        name: 'Acme Corp',
        linkedInUrl: 'https://linkedin.com/company/acme',
        websiteUrl: 'https://acme.com',
        tagline: 'Building the future',
        description: 'A technology company focused on innovation.',
        industry: 'Technology',
        employeeCount: 500,
        followerCount: 10000,
        headquarter: {
          city: 'New York',
          country: 'US',
        },
        foundedOn: { year: 2010 },
      },
    };

    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockCompanyData),
    });
    const originalFetch = global.fetch;
    global.fetch = mockFetch as unknown as typeof fetch;

    try {
      const provider = new ScrapinProvider('test-api-key');
      const result = await provider.fetchCompany(
        'https://linkedin.com/company/acme',
      );

      expect(result.success).toBe(true);
      expect(result.company?.name).toBe('Acme Corp');
      expect(result.company?.employeeCount).toBe(500);
    } finally {
      global.fetch = originalFetch;
    }
  });
});

describe('Scrapin pipeline markdown output', () => {
  test('pipeline returns markdown content for person', async () => {
    const mockPersonData = {
      success: true,
      person: {
        publicIdentifier: 'johndoe',
        linkedInUrl: 'https://linkedin.com/in/johndoe',
        firstName: 'John',
        lastName: 'Doe',
        headline: 'Senior Engineer',
        summary: 'Experienced engineer.',
        positions: {
          positionsCount: 1,
          positionHistory: [
            {
              title: 'Engineer',
              companyName: 'Acme',
              startEndDate: { start: { year: 2020 }, end: null },
            },
          ],
        },
      },
    };

    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockPersonData),
    });
    const originalFetch = global.fetch;
    global.fetch = mockFetch as unknown as typeof fetch;

    try {
      const pipeline = linkedInPipeline('test-key');
      const result = await pipeline.fetch('https://linkedin.com/in/johndoe');

      expect(result.success).toBe(true);
      expect(result.pipeline).toBe('scrapin');
      expect(result.content).toContain('# John Doe');
      expect(result.content).toContain('**Senior Engineer**');
      expect(result.content).toContain('## Experience');
      expect(result.content).toContain('Engineer at Acme');
    } finally {
      global.fetch = originalFetch;
    }
  });
});

describe('Serper response parsing', () => {
  test('parses organic search results', async () => {
    const mockResponse = {
      organic: [
        {
          title: 'First Result',
          link: 'https://example.com/1',
          snippet: 'This is the first result',
          position: 1,
        },
        {
          title: 'Second Result',
          link: 'https://example.com/2',
          snippet: 'This is the second result',
          position: 2,
          date: '2024-01-15',
        },
      ],
    };

    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    });
    const originalFetch = global.fetch;
    global.fetch = mockFetch as unknown as typeof fetch;

    try {
      const provider = new SerperProvider('test-api-key');
      const results = await provider.search('test query');

      expect(results).toHaveLength(2);
      expect(results[0].title).toBe('First Result');
      expect(results[0].url).toBe('https://example.com/1');
      expect(results[0].position).toBe(1);
      expect(results[1].date).toBe('2024-01-15');
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('parses news search results', async () => {
    const mockResponse = {
      news: [
        {
          title: 'Breaking News',
          link: 'https://news.com/article',
          snippet: 'Important news story',
          date: 'Jan 15, 2024',
        },
      ],
    };

    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    });
    const originalFetch = global.fetch;
    global.fetch = mockFetch as unknown as typeof fetch;

    try {
      const provider = new SerperProvider('test-api-key');
      const results = await provider.search('test', { searchType: 'news' });

      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('Breaking News');
      expect(results[0].date).toBe('Jan 15, 2024');
    } finally {
      global.fetch = originalFetch;
    }
  });
});

describe('Tool configuration', () => {
  const mockProvider = {
    name: 'mock',
    search: jest.fn().mockResolvedValue([]),
  };

  test('webSearch creates tool with correct schema', () => {
    const tool = webSearch({
      numResults: 5,
      country: 'US',
      allowCountryOverride: false,
      provider: mockProvider,
    });

    expect(tool.name).toBe('web_search');
    expect(tool.description).toContain('Search the web');
    expect(tool.schema.safeParse({ query: 'test' }).success).toBe(true);
    expect(tool.schema.safeParse({}).success).toBe(false);
  });

  test('webSearch includes country when allowCountryOverride is true', () => {
    const tool = webSearch({
      allowCountryOverride: true,
      provider: mockProvider,
    });

    expect(
      tool.schema.safeParse({ query: 'test', country: 'US' }).success,
    ).toBe(true);
  });

  test('fetchPage creates tool with correct schema', () => {
    const tool = fetchPage({
      extractMode: 'markdown',
      timeout: 15000,
    });

    expect(tool.name).toBe('fetch_page');
    expect(tool.description).toContain('Fetch and extract content');
    expect(tool.schema.safeParse({ url: 'https://example.com' }).success).toBe(
      true,
    );
    expect(tool.schema.safeParse({}).success).toBe(false);
  });
});

describe('Provider initialization', () => {
  test('SerperProvider throws without API key', () => {
    const originalEnv = process.env.SERPER_API_KEY;
    delete process.env.SERPER_API_KEY;

    try {
      expect(() => new SerperProvider()).toThrow(
        'No Serper API key configured',
      );
    } finally {
      if (originalEnv) process.env.SERPER_API_KEY = originalEnv;
    }
  });

  test('SerperProvider accepts API key parameter', () => {
    const provider = new SerperProvider('test-key');
    expect(provider.name).toBe('serper');
  });

  test('ScrapinProvider throws without API key', () => {
    const originalEnv = process.env.SCRAPIN_API_KEY;
    delete process.env.SCRAPIN_API_KEY;

    try {
      expect(() => new ScrapinProvider()).toThrow(
        'No Scrapin API key configured',
      );
    } finally {
      if (originalEnv) process.env.SCRAPIN_API_KEY = originalEnv;
    }
  });

  test('ScrapinProvider accepts API key parameter', () => {
    const provider = new ScrapinProvider('test-key');
    expect(provider).toBeDefined();
  });

  test('linkedInPipeline creates pipeline with correct patterns', () => {
    const pipeline = linkedInPipeline('test-key');

    expect(pipeline.name).toBe('scrapin');
    expect(pipeline.patterns).toHaveLength(2);
    expect(pipeline.patterns[0].test('https://linkedin.com/in/user')).toBe(
      true,
    );
    expect(pipeline.patterns[1].test('https://linkedin.com/company/corp')).toBe(
      true,
    );
  });
});
