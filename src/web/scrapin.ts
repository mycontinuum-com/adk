import type { FetchPipeline, FetchPageOptions, FetchPageResult } from './types';

const LINKEDIN_PERSON_PATTERN = /linkedin\.com\/in\/([^/?]+)/;
const LINKEDIN_COMPANY_PATTERN = /linkedin\.com\/company\/([^/?]+)/;

interface ScrapinPersonResponse {
  success: boolean;
  credits_left?: number;
  person?: {
    publicIdentifier: string;
    linkedInUrl: string;
    firstName: string;
    lastName: string;
    headline: string;
    location?: {
      city?: string;
      state?: string;
      country?: string;
    };
    summary?: string;
    positions?: {
      positionsCount: number;
      positionHistory: Array<{
        title: string;
        companyName: string;
        companyLocation?: string;
        description?: string;
        linkedInUrl?: string;
        linkedInId?: string;
        startEndDate: {
          start: { month?: number; year: number };
          end: { month?: number; year: number } | null;
        };
      }>;
    };
    schools?: {
      educationsCount: number;
      educationHistory: Array<{
        schoolName: string;
        degreeName?: string;
        fieldOfStudy?: string;
        startEndDate?: {
          start: { year: number };
          end: { year: number };
        };
      }>;
    };
    skills?: string[];
    languages?: string[];
    certifications?: {
      certificationsCount: number;
      certificationHistory: Array<{
        name: string;
        organizationName?: string;
        issuedDate?: string;
      }>;
    };
  };
  company?: {
    name: string;
    linkedInUrl: string;
    industry?: string;
    employeeCount?: number;
    description?: string;
  };
}

interface ScrapinCompanyResponse {
  success: boolean;
  company?: {
    linkedInId: string;
    name: string;
    linkedInUrl: string;
    websiteUrl?: string;
    tagline?: string;
    description?: string;
    industry?: string;
    employeeCount?: number;
    followerCount?: number;
    employeeCountRange?: { start: number; end: number };
    headquarter?: {
      city?: string;
      country?: string;
    };
    foundedOn?: { year: number };
    specialities?: string[];
  };
}

function formatDate(date: { month?: number; year: number } | null): string {
  if (!date) return 'Present';
  const month = date.month ? `${date.month}/` : '';
  return `${month}${date.year}`;
}

function personToMarkdown(data: ScrapinPersonResponse): string {
  const { person, company } = data;
  if (!person) return '';

  const lines: string[] = [];

  lines.push(`# ${person.firstName} ${person.lastName}`);
  lines.push('');
  if (person.headline) lines.push(`**${person.headline}**`);
  if (person.location) {
    const loc = [
      person.location.city,
      person.location.state,
      person.location.country,
    ]
      .filter(Boolean)
      .join(', ');
    if (loc) lines.push(`Location: ${loc}`);
  }
  lines.push('');

  if (person.summary) {
    lines.push('## About');
    lines.push('');
    lines.push(person.summary);
    lines.push('');
  }

  if (person.positions?.positionHistory?.length) {
    lines.push('## Experience');
    lines.push('');
    for (const pos of person.positions.positionHistory) {
      const dates = `${formatDate(pos.startEndDate.start)} - ${formatDate(pos.startEndDate.end)}`;
      const companyLink = pos.linkedInUrl
        ? `[${pos.companyName}](${pos.linkedInUrl})`
        : pos.companyName;
      lines.push(`### ${pos.title} at ${companyLink}`);
      lines.push(`*${dates}*`);
      if (pos.companyLocation) lines.push(`${pos.companyLocation}`);
      if (pos.description) {
        lines.push('');
        lines.push(pos.description);
      }
      lines.push('');
    }
  }

  if (person.schools?.educationHistory?.length) {
    lines.push('## Education');
    lines.push('');
    for (const edu of person.schools.educationHistory) {
      lines.push(`### ${edu.schoolName}`);
      if (edu.degreeName) lines.push(`${edu.degreeName}`);
      if (edu.fieldOfStudy) lines.push(`Field: ${edu.fieldOfStudy}`);
      if (edu.startEndDate) {
        lines.push(
          `*${edu.startEndDate.start.year} - ${edu.startEndDate.end.year}*`,
        );
      }
      lines.push('');
    }
  }

  if (person.skills?.length) {
    lines.push('## Skills');
    lines.push('');
    lines.push(person.skills.join(', '));
    lines.push('');
  }

  if (person.certifications?.certificationHistory?.length) {
    lines.push('## Certifications');
    lines.push('');
    for (const cert of person.certifications.certificationHistory) {
      lines.push(`- **${cert.name}**`);
      if (cert.organizationName) lines.push(`  ${cert.organizationName}`);
      if (cert.issuedDate) lines.push(`  ${cert.issuedDate}`);
    }
    lines.push('');
  }

  if (person.languages?.length) {
    lines.push('## Languages');
    lines.push('');
    lines.push(person.languages.join(', '));
    lines.push('');
  }

  if (company) {
    lines.push('## Current Company');
    lines.push('');
    const companyLink = company.linkedInUrl
      ? `[${company.name}](${company.linkedInUrl})`
      : company.name;
    lines.push(`**${companyLink}**`);
    if (company.industry) lines.push(`Industry: ${company.industry}`);
    if (company.employeeCount)
      lines.push(`Employees: ~${company.employeeCount}`);
    if (company.description) {
      lines.push('');
      lines.push(company.description);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function companyToMarkdown(data: ScrapinCompanyResponse): string {
  const { company } = data;
  if (!company) return '';

  const lines: string[] = [];

  lines.push(`# ${company.name}`);
  lines.push('');
  if (company.tagline) lines.push(`*${company.tagline}*`);
  lines.push('');

  if (company.industry) lines.push(`**Industry:** ${company.industry}`);
  if (company.websiteUrl) lines.push(`**Website:** ${company.websiteUrl}`);
  if (company.employeeCount) {
    const range = company.employeeCountRange
      ? `(${company.employeeCountRange.start}-${company.employeeCountRange.end})`
      : '';
    lines.push(`**Employees:** ~${company.employeeCount} ${range}`);
  }
  if (company.followerCount) {
    lines.push(`**Followers:** ${company.followerCount.toLocaleString()}`);
  }
  if (company.headquarter) {
    const loc = [company.headquarter.city, company.headquarter.country]
      .filter(Boolean)
      .join(', ');
    if (loc) lines.push(`**Location:** ${loc}`);
  }
  if (company.foundedOn) {
    lines.push(`**Founded:** ${company.foundedOn.year}`);
  }
  lines.push('');

  if (company.description) {
    lines.push('## About');
    lines.push('');
    lines.push(company.description);
    lines.push('');
  }

  if (company.specialities?.length) {
    lines.push('## Specialties');
    lines.push('');
    lines.push(company.specialities.join(', '));
    lines.push('');
  }

  return lines.join('\n');
}

export class ScrapinProvider {
  private apiKey: string;
  private baseUrl = 'https://api.scrapin.io';

  constructor(apiKey?: string) {
    this.apiKey = apiKey ?? process.env.SCRAPIN_API_KEY ?? '';
    if (!this.apiKey) {
      throw new Error(
        `No Scrapin API key configured.

Set the environment variable:
  - SCRAPIN_API_KEY    (Get one at https://scrapin.io)

Or pass directly to the pipeline config.`,
      );
    }
  }

  async fetchPerson(linkedInUrl: string): Promise<ScrapinPersonResponse> {
    const response = await fetch(
      `${this.baseUrl}/v1/enrichment/profile?apikey=${this.apiKey}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          linkedInUrl,
          includes: {
            includeCompany: true,
            includeSummary: true,
            includeFollowersCount: false,
            includeCreationDate: true,
            includeSkills: true,
            includeLanguages: true,
            includeExperience: true,
            includeEducation: true,
            includeCertifications: true,
          },
          cacheDuration: '2d',
        }),
      },
    );

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Scrapin API error: ${response.status} ${text}`);
    }

    return response.json() as Promise<ScrapinPersonResponse>;
  }

  async fetchCompany(linkedInUrl: string): Promise<ScrapinCompanyResponse> {
    const url = new URL(`${this.baseUrl}/v1/company/extract-profile`);
    url.searchParams.set('linkedInUrl', linkedInUrl);
    url.searchParams.set('apikey', this.apiKey);

    const response = await fetch(url.toString(), {
      method: 'GET',
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Scrapin API error: ${response.status} ${text}`);
    }

    return response.json() as Promise<ScrapinCompanyResponse>;
  }
}

export function linkedInPipeline(apiKey?: string): FetchPipeline {
  const provider = new ScrapinProvider(apiKey);

  return {
    name: 'scrapin',
    patterns: [LINKEDIN_PERSON_PATTERN, LINKEDIN_COMPANY_PATTERN],

    async fetch(
      url: string,
      _options?: FetchPageOptions,
    ): Promise<FetchPageResult> {
      const isPerson = LINKEDIN_PERSON_PATTERN.test(url);
      const isCompany = LINKEDIN_COMPANY_PATTERN.test(url);

      try {
        if (isPerson) {
          const data = await provider.fetchPerson(url);
          if (!data.success || !data.person) {
            return {
              success: false,
              url,
              error: 'not_found',
              pipeline: 'scrapin',
            };
          }
          const content = personToMarkdown(data);
          const title = `${data.person.firstName} ${data.person.lastName} - ${data.person.headline || 'LinkedIn'}`;
          return {
            success: true,
            url,
            title,
            content,
            wordCount: content.split(/\s+/).length,
            pipeline: 'scrapin',
            raw: data,
          };
        }

        if (isCompany) {
          const data = await provider.fetchCompany(url);
          if (!data.success || !data.company) {
            return {
              success: false,
              url,
              error: 'not_found',
              pipeline: 'scrapin',
            };
          }
          const content = companyToMarkdown(data);
          const title = `${data.company.name} - LinkedIn`;
          return {
            success: true,
            url,
            title,
            content,
            wordCount: content.split(/\s+/).length,
            pipeline: 'scrapin',
            raw: data,
          };
        }

        return {
          success: false,
          url,
          error: 'not_found',
          pipeline: 'scrapin',
        };
      } catch (error) {
        console.error('[scrapin pipeline]', error);
        return {
          success: false,
          url,
          error: 'api_error',
          pipeline: 'scrapin',
        };
      }
    },
  };
}
