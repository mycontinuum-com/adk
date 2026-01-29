import { z } from 'zod';
import type { CoercionContext } from './context';
import { addCorrection, addError } from './context';

function sanitizeCharacters(input: string | null | undefined): string {
  if (!input) {
    return '';
  }
  return String(input)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2212]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/\u200B/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeEnumValue(value: string): string {
  return sanitizeCharacters(value)
    .toLowerCase()
    .replace(/[_\s-]/g, '');
}

function stripPunctuation(s: string): string {
  return s.replace(/[^\w\s-]/g, '').trim();
}

interface PrecomputedEnumValue {
  original: string;
  sanitized: string;
  normalized: string;
  stripped: string;
  lower: string;
}

const enumCache = new WeakMap<readonly string[], PrecomputedEnumValue[]>();

function getPrecomputedValues(enumValues: string[]): PrecomputedEnumValue[] {
  const readonlyValues = enumValues as readonly string[];
  let cached = enumCache.get(readonlyValues);
  if (cached) return cached;

  cached = enumValues.map((v) => ({
    original: v,
    sanitized: sanitizeCharacters(v),
    normalized: normalizeEnumValue(v),
    stripped: stripPunctuation(v).toLowerCase(),
    lower: v.toLowerCase(),
  }));
  enumCache.set(readonlyValues, cached);
  return cached;
}

type MatchType =
  | 'exact'
  | 'sanitized'
  | 'normalized'
  | 'stripped'
  | 'prefix'
  | 'substring';

interface MatchResult {
  value: string;
  type: MatchType;
  score: number;
}

function findBestMatch(
  trimmed: string,
  precomputed: PrecomputedEnumValue[],
): MatchResult | undefined {
  const sanitizedInput = sanitizeCharacters(trimmed);
  const normalizedInput = normalizeEnumValue(trimmed);
  const strippedInput = stripPunctuation(trimmed).toLowerCase();
  const lowerInput = trimmed.toLowerCase();

  let bestMatch: MatchResult | undefined;

  for (const pv of precomputed) {
    if (pv.original === trimmed) {
      return { value: pv.original, type: 'exact', score: 0 };
    }

    if (pv.sanitized === sanitizedInput) {
      const candidate: MatchResult = {
        value: pv.original,
        type: 'sanitized',
        score: 1,
      };
      if (!bestMatch || candidate.score < bestMatch.score) {
        bestMatch = candidate;
      }
      continue;
    }

    if (pv.normalized === normalizedInput) {
      const candidate: MatchResult = {
        value: pv.original,
        type: 'normalized',
        score: 2,
      };
      if (!bestMatch || candidate.score < bestMatch.score) {
        bestMatch = candidate;
      }
      continue;
    }

    if (pv.stripped === strippedInput) {
      const candidate: MatchResult = {
        value: pv.original,
        type: 'stripped',
        score: 3,
      };
      if (!bestMatch || candidate.score < bestMatch.score) {
        bestMatch = candidate;
      }
      continue;
    }

    const isPrefixMatch =
      pv.lower === lowerInput ||
      (pv.lower.startsWith(lowerInput) && lowerInput.length >= 2) ||
      (lowerInput.startsWith(pv.lower) && pv.lower.length >= 2);

    if (isPrefixMatch) {
      const candidate: MatchResult = {
        value: pv.original,
        type: 'prefix',
        score: 4 - pv.original.length * 0.001,
      };
      if (!bestMatch || candidate.score < bestMatch.score) {
        bestMatch = candidate;
      }
    }
  }

  return bestMatch;
}

function findSubstringMatch(
  trimmed: string,
  precomputed: PrecomputedEnumValue[],
): MatchResult | undefined {
  const lowerInput = trimmed.toLowerCase();
  let maxCount = 0;
  let maxCandidates: string[] = [];

  for (const pv of precomputed) {
    let count = 0;
    let pos = 0;
    while ((pos = lowerInput.indexOf(pv.lower, pos)) !== -1) {
      count++;
      pos += pv.lower.length;
    }
    if (count > maxCount) {
      maxCount = count;
      maxCandidates = [pv.original];
    } else if (count > 0 && count === maxCount) {
      maxCandidates.push(pv.original);
    }
  }

  if (maxCandidates.length === 1) {
    return { value: maxCandidates[0], type: 'substring', score: 5 };
  }

  return undefined;
}

const matchTypeToCorrection: Record<
  MatchType,
  {
    reason: string;
    type:
      | 'enumAccentNormalized'
      | 'enumCaseNormalized'
      | 'strippedNonAlphanumeric'
      | 'enumPrefixMatch'
      | 'enumSubstringMatch';
  }
> = {
  exact: { reason: '', type: 'enumCaseNormalized' },
  sanitized: {
    reason: 'Matched enum after character normalization',
    type: 'enumAccentNormalized',
  },
  normalized: {
    reason: 'Matched enum value case-insensitively',
    type: 'enumCaseNormalized',
  },
  stripped: {
    reason: 'Matched after stripping punctuation',
    type: 'strippedNonAlphanumeric',
  },
  prefix: { reason: 'Matched enum value by prefix', type: 'enumPrefixMatch' },
  substring: {
    reason: 'Matched enum by substring',
    type: 'enumSubstringMatch',
  },
};

export function coerceToEnum(
  value: unknown,
  enumValues: string[],
  ctx: CoercionContext,
): string | undefined {
  if (value === null || value === undefined) {
    if (ctx.partial) return undefined;
    addError(
      ctx,
      `enum(${enumValues.join('|')})`,
      value,
      'Expected enum value but got null/undefined',
    );
    return undefined;
  }

  if (typeof value !== 'string') {
    addError(
      ctx,
      `enum(${enumValues.join('|')})`,
      value,
      `Cannot coerce ${typeof value} to enum`,
    );
    return undefined;
  }

  const trimmed = value.trim();

  if (enumValues.includes(trimmed)) return trimmed;

  const precomputed = getPrecomputedValues(enumValues);

  let match = findBestMatch(trimmed, precomputed);

  if (!match) {
    match = findSubstringMatch(trimmed, precomputed);
  }

  if (match) {
    if (match.type !== 'exact') {
      const correction = matchTypeToCorrection[match.type];
      addCorrection(
        ctx,
        value,
        match.value,
        correction.reason,
        correction.type,
      );
    }
    return match.value;
  }

  addError(
    ctx,
    `enum(${enumValues.join('|')})`,
    value,
    `Value "${value}" does not match any enum option`,
  );
  return undefined;
}

export function getEnumValues(
  schema: z.ZodEnum<[string, ...string[]]>,
): string[] {
  return schema.options;
}

export function getNativeEnumValues(
  schema: z.ZodNativeEnum<z.EnumLike>,
): string[] {
  const enumObj = schema.enum;
  return Object.values(enumObj).filter(
    (v): v is string => typeof v === 'string',
  );
}
