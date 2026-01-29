import { z } from 'zod';
import {
  parse,
  parsePartial,
  createParser,
  parseJsonish,
  parsePartialJson,
  extractJsonFromText,
  getPositionFromOffset,
  coerce,
  coercePartial,
  createStreamParser,
} from './index';

describe('JSONish Parser', () => {
  describe('extractJsonFromText', () => {
    it('should extract JSON from markdown code fences', () => {
      const input = '```json\n{"name": "test"}\n```';
      expect(extractJsonFromText(input)).toBe('{"name": "test"}');
    });

    it('should extract JSON from code fences without language tag', () => {
      const input = '```\n{"name": "test"}\n```';
      expect(extractJsonFromText(input)).toBe('{"name": "test"}');
    });

    it('should extract JSON when preceded by text', () => {
      const input = 'Here is the result: {"name": "test"}';
      expect(extractJsonFromText(input)).toBe('{"name": "test"}');
    });

    it('should extract JSON when followed by text', () => {
      const input = '{"name": "test"} is the output';
      expect(extractJsonFromText(input)).toBe('{"name": "test"}');
    });

    it('should handle arrays', () => {
      const input = 'Result: [1, 2, 3] done';
      expect(extractJsonFromText(input)).toBe('[1, 2, 3]');
    });
  });

  describe('JSON repair via parseJsonish', () => {
    it('should fix trailing commas', () => {
      const input = '{"name": "test",}';
      const result = parseJsonish(input);
      expect(result.success).toBe(true);
      expect(result.value).toEqual({ name: 'test' });
    });

    it('should fix unquoted keys', () => {
      const input = '{name: "test"}';
      const result = parseJsonish(input);
      expect(result.success).toBe(true);
      expect(result.value).toEqual({ name: 'test' });
    });

    it('should fix single quotes', () => {
      const input = "{'name': 'test'}";
      const result = parseJsonish(input);
      expect(result.success).toBe(true);
      expect(result.value).toEqual({ name: 'test' });
    });

    it('should fix newlines in strings', () => {
      const input = '{"text": "line1\nline2"}';
      const result = parseJsonish(input);
      expect(result.success).toBe(true);
      expect(result.value).toEqual({ text: 'line1\nline2' });
    });

    it('should handle multiple issues', () => {
      const input = "{name: 'test', value: 42,}";
      const result = parseJsonish(input);
      expect(result.success).toBe(true);
      expect(result.value).toEqual({ name: 'test', value: 42 });
    });
  });

  describe('parseJsonish', () => {
    it('should parse valid JSON', () => {
      const result = parseJsonish('{"name": "test"}');
      expect(result.success).toBe(true);
      expect(result.value).toEqual({ name: 'test' });
    });

    it('should parse JSON with markdown fences', () => {
      const result = parseJsonish('```json\n{"name": "test"}\n```');
      expect(result.success).toBe(true);
      expect(result.value).toEqual({ name: 'test' });
    });

    it('should repair and parse malformed JSON', () => {
      const result = parseJsonish('{name: "test",}');
      expect(result.success).toBe(true);
      expect(result.value).toEqual({ name: 'test' });
    });

    it('should return string fallback for non-JSON input', () => {
      const result = parseJsonish('not json at all');
      expect(result.success).toBe(true);
      expect(result.value).toBe('not json at all');
    });
  });

  describe('parsePartialJson', () => {
    it('should parse complete JSON', () => {
      const result = parsePartialJson('{"name": "test"}');
      expect(result.success).toBe(true);
      expect(result.value).toEqual({ name: 'test' });
    });

    it('should parse incomplete object', () => {
      const result = parsePartialJson('{"name": "te');
      expect(result.success).toBe(true);
      expect(result.value).toEqual({ name: 'te' });
    });

    it('should parse incomplete array', () => {
      const result = parsePartialJson('[1, 2, 3');
      expect(result.success).toBe(true);
      expect(result.value).toEqual([1, 2, 3]);
    });

    it('should handle nested incomplete structures', () => {
      const result = parsePartialJson('{"user": {"name": "John", "age": 30');
      expect(result.success).toBe(true);
      expect(result.value).toEqual({ user: { name: 'John', age: 30 } });
    });

    it('should handle incomplete string', () => {
      const result = parsePartialJson('{"message": "Hello wor');
      expect(result.success).toBe(true);
      expect(result.value).toEqual({ message: 'Hello wor' });
    });
  });
});

describe('Type Coercion', () => {
  describe('primitive coercion', () => {
    it('should coerce string to number', () => {
      const schema = z.object({ value: z.number() });
      const result = coerce({ value: '42' }, schema);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value.value).toBe(42);
        expect(result.corrections.length).toBe(1);
      }
    });

    it('should coerce number to string', () => {
      const schema = z.object({ value: z.string() });
      const result = coerce({ value: 123 }, schema);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value.value).toBe('123');
      }
    });

    it('should coerce string to boolean', () => {
      const schema = z.object({ active: z.boolean() });

      const trueResult = coerce({ active: 'true' }, schema);
      expect(trueResult.success).toBe(true);
      if (trueResult.success) expect(trueResult.value.active).toBe(true);

      const falseResult = coerce({ active: 'false' }, schema);
      expect(falseResult.success).toBe(true);
      if (falseResult.success) expect(falseResult.value.active).toBe(false);

      const yesResult = coerce({ active: 'yes' }, schema);
      expect(yesResult.success).toBe(true);
      if (yesResult.success) expect(yesResult.value.active).toBe(true);
    });

    it('should coerce to date', () => {
      const schema = z.object({ date: z.date() });
      const result = coerce({ date: '2024-01-15' }, schema);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value.date).toBeInstanceOf(Date);
      }
    });
  });

  describe('enum coercion', () => {
    it('should match enum case-insensitively', () => {
      const schema = z.object({
        status: z.enum(['active', 'inactive', 'pending']),
      });
      const result = coerce({ status: 'ACTIVE' }, schema);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value.status).toBe('active');
      }
    });

    it('should match enum with underscores/spaces normalization', () => {
      const schema = z.object({ type: z.enum(['user_admin', 'user_guest']) });
      const result = coerce({ type: 'user admin' }, schema);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value.type).toBe('user_admin');
      }
    });

    it('should fail on unmatched enum', () => {
      const schema = z.object({ status: z.enum(['active', 'inactive']) });
      const result = coerce({ status: 'unknown' }, schema);
      expect(result.success).toBe(false);
    });
  });

  describe('complex types', () => {
    it('should coerce nested objects', () => {
      const schema = z.object({
        user: z.object({
          name: z.string(),
          age: z.number(),
        }),
      });
      const result = coerce({ user: { name: 'John', age: '30' } }, schema);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value.user.age).toBe(30);
      }
    });

    it('should coerce arrays', () => {
      const schema = z.object({ values: z.array(z.number()) });
      const result = coerce({ values: ['1', '2', '3'] }, schema);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value.values).toEqual([1, 2, 3]);
      }
    });

    it('should handle optional fields', () => {
      const schema = z.object({
        required: z.string(),
        optional: z.string().optional(),
      });
      const result = coerce({ required: 'test' }, schema);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value.required).toBe('test');
        expect(result.value.optional).toBeUndefined();
      }
    });

    it('should handle nullable fields', () => {
      const schema = z.object({ value: z.string().nullable() });
      const result = coerce({ value: null }, schema);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value.value).toBeNull();
      }
    });

    it('should handle default values', () => {
      const schema = z.object({ value: z.string().default('default') });
      const result = coerce({}, schema);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value.value).toBe('default');
      }
    });
  });

  describe('union coercion', () => {
    it('should match first valid union member', () => {
      const schema = z.union([z.number(), z.string()]);
      const result = coerce(42, schema);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value).toBe(42);
      }
    });

    it('should coerce to best matching union member', () => {
      const schema = z.union([z.number(), z.string()]);
      const result = coerce('42', schema);
      expect(result.success).toBe(true);
    });
  });

  describe('discriminated union coercion', () => {
    const schema = z.discriminatedUnion('type', [
      z.object({ type: z.literal('dog'), bark: z.boolean() }),
      z.object({ type: z.literal('cat'), meow: z.boolean() }),
    ]);

    it('should match discriminated union', () => {
      const result = coerce({ type: 'dog', bark: true }, schema);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value).toEqual({ type: 'dog', bark: true });
      }
    });

    it('should match discriminator case-insensitively', () => {
      const result = coerce({ type: 'DOG', bark: 'true' }, schema);
      expect(result.success).toBe(true);
      if (result.success && result.value.type === 'dog') {
        expect(result.value.type).toBe('dog');
        expect(result.value.bark).toBe(true);
      }
    });
  });

  describe('partial coercion', () => {
    it('should allow missing required fields in partial mode', () => {
      const schema = z.object({
        name: z.string(),
        age: z.number(),
      });
      const result = coercePartial({ name: 'John' }, schema);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value.name).toBe('John');
        expect(result.value.age).toBeUndefined();
      }
    });
  });
});

describe('Schema-Aware Parser', () => {
  const userSchema = z.object({
    name: z.string(),
    age: z.number(),
    email: z.string().email().optional(),
    role: z.enum(['admin', 'user', 'guest']),
  });

  describe('parse', () => {
    it('should parse valid JSON with schema', () => {
      const input = '{"name": "John", "age": 30, "role": "admin"}';
      const result = parse(input, userSchema);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value).toEqual({
          name: 'John',
          age: 30,
          role: 'admin',
        });
      }
    });

    it('should parse and coerce types', () => {
      const input = '{"name": "John", "age": "30", "role": "ADMIN"}';
      const result = parse(input, userSchema);
      expect(result.success).toBe(true);
      if (result.success && result.value) {
        expect(result.value.age).toBe(30);
        expect(result.value.role).toBe('admin');
        expect(result.corrections.length).toBeGreaterThan(0);
      }
    });

    it('should parse JSON from markdown', () => {
      const input = `Here's the user:
\`\`\`json
{"name": "John", "age": 30, "role": "user"}
\`\`\`
That's all.`;
      const result = parse(input, userSchema);
      expect(result.success).toBe(true);
    });

    it('should repair and parse malformed JSON', () => {
      const input = '{name: "John", age: 30, role: "user",}';
      const result = parse(input, userSchema);
      expect(result.success).toBe(true);
    });

    it('should handle LLM chain-of-thought output', () => {
      const input = `Let me think about this...
The user data is:
{"name": "John", "age": 30, "role": "user"}
That's the answer.`;
      const result = parse(input, userSchema);
      expect(result.success).toBe(true);
    });

    it('should report errors for invalid data', () => {
      const input = '{"name": "John", "role": "invalid_role"}';
      const result = parse(input, userSchema);
      expect(result.success).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });

  describe('parsePartial', () => {
    it('should parse incomplete JSON', () => {
      const input = '{"name": "John", "age": 30';
      const result = parsePartial(input, userSchema);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value?.name).toBe('John');
        expect(result.value?.age).toBe(30);
      }
    });

    it('should parse streaming JSON progressively', () => {
      const chunks = [
        '{"name": "Jo',
        '{"name": "John", "age": 3',
        '{"name": "John", "age": 30, "role": "admi',
        '{"name": "John", "age": 30, "role": "admin"}',
      ];

      for (const chunk of chunks) {
        const result = parsePartial(chunk, userSchema);
        expect(result.success).toBe(true);
      }
    });
  });

  describe('createParser', () => {
    it('should create a reusable parser', () => {
      const parser = createParser(userSchema);

      const result1 = parser.parse(
        '{"name": "John", "age": 30, "role": "user"}',
      );
      expect(result1.success).toBe(true);

      const result2 = parser.parse(
        '{"name": "Jane", "age": 25, "role": "admin"}',
      );
      expect(result2.success).toBe(true);
    });

    it('should support configuration', () => {
      const parser = createParser(userSchema, {
        coerceTypes: false,
        extractFromMarkdown: false,
      });

      const result = parser.parse(
        '{"name": "John", "age": "30", "role": "user"}',
      );
      expect(result.success).toBe(false);
    });
  });
});

describe('Streaming Parser', () => {
  const schema = z.object({
    title: z.string(),
    items: z.array(z.string()),
  });

  describe('createStreamParser', () => {
    it('should parse incremental chunks', () => {
      const parser = createStreamParser(schema);

      const r1 = parser.push('{"title": "Te');
      expect(r1.partial?.title).toBe('Te');

      const r2 = parser.push('st", "items": ["a"');
      expect(r2.partial?.title).toBe('Test');
      expect(r2.partial?.items).toEqual(['a']);

      const r3 = parser.push(', "b"]}');
      expect(r3.partial?.items).toEqual(['a', 'b']);

      const final = parser.finish();
      expect(final.complete).toBe(true);
      expect(final.partial).toEqual({ title: 'Test', items: ['a', 'b'] });
    });

    it('should track deltas between updates', () => {
      const parser = createStreamParser(schema);

      parser.push('{"title": "He');
      const r2 = parser.push('llo", "items": []');

      expect(r2.delta).toBeDefined();
    });

    it('should reset state', () => {
      const parser = createStreamParser(schema);

      parser.push('{"title": "Test"');
      parser.reset();

      const state = parser.getState();
      expect(state.buffer).toBe('');
      expect(state.current).toBeUndefined();
    });
  });
});

describe('Bug Fixes', () => {
  describe('fixUnquotedKeys inside strings', () => {
    it('should not corrupt colons inside strings', () => {
      const input = '{"message": "key: value", name: "test"}';
      const result = parseJsonish(input);
      expect(result.success).toBe(true);
      expect(result.value).toEqual({ message: 'key: value', name: 'test' });
    });

    it('should handle nested colons in strings', () => {
      const input = '{data: "time: 10:30:00", id: 1}';
      const result = parseJsonish(input);
      expect(result.success).toBe(true);
      expect(result.value).toEqual({ data: 'time: 10:30:00', id: 1 });
    });
  });

  describe('extractJsonFromText primitives', () => {
    it('should extract null', () => {
      const result = extractJsonFromText('The result is: null');
      expect(result).toBe('null');
    });

    it('should extract true/false', () => {
      expect(extractJsonFromText('Result: true')).toBe('true');
      expect(extractJsonFromText('Result: false')).toBe('false');
    });

    it('should extract numbers', () => {
      expect(extractJsonFromText('Count: 42')).toBe('42');
      expect(extractJsonFromText('Value: -3.14')).toBe('-3.14');
      expect(extractJsonFromText('Scientific: 1.5e10')).toBe('1.5e10');
    });

    it('should extract quoted strings', () => {
      expect(extractJsonFromText('Name: "John"')).toBe('"John"');
    });
  });

  describe('case-insensitive key matching', () => {
    it('should match keys case-insensitively', () => {
      const schema = z.object({ name: z.string(), age: z.number() });
      const result = coerce({ Name: 'John', AGE: 30 }, schema);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value).toEqual({ name: 'John', age: 30 });
        expect(result.corrections.length).toBeGreaterThan(0);
      }
    });

    it('should match keys with underscores/hyphens', () => {
      const schema = z.object({ first_name: z.string() });
      const result = coerce({ 'first-name': 'John' }, schema);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value).toEqual({ first_name: 'John' });
      }
    });

    it('should prefer exact match over case-insensitive', () => {
      const schema = z.object({ name: z.string() });
      const result = coerce({ name: 'correct', Name: 'wrong' }, schema);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value.name).toBe('correct');
      }
    });
  });

  describe('enum prefix matching determinism', () => {
    it('should prefer exact normalized match over prefix', () => {
      const schema = z.object({ status: z.enum(['a', 'ab', 'abc']) });
      const result = coerce({ status: 'AB' }, schema);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value.status).toBe('ab');
      }
    });

    it('should prefer longer prefix match', () => {
      const schema = z.object({
        status: z.enum(['active', 'activated', 'inactive']),
      });
      const result = coerce({ status: 'activ' }, schema);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value.status).toBe('activated');
      }
    });
  });

  describe('array coercion index preservation', () => {
    it('should preserve undefined elements in partial mode', () => {
      const schema = z.object({ items: z.array(z.number()) });
      const result = coercePartial({ items: [1, undefined, 3] }, schema);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value.items).toHaveLength(3);
        expect(result.value.items?.[0]).toBe(1);
        expect(result.value.items?.[1]).toBeUndefined();
        expect(result.value.items?.[2]).toBe(3);
      }
    });
  });

  describe('union coercion best match', () => {
    it('should succeed with corrections for best match in partial mode', () => {
      const schema = z.union([
        z.object({ type: z.literal('a'), value: z.number() }),
        z.object({ type: z.literal('b'), value: z.string() }),
      ]);
      const result = coercePartial({ type: 'a', value: '123' }, schema);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value.type).toBe('a');
        expect(result.value.value).toBe(123);
      }
    });
  });

  describe('ZodIntersection handling', () => {
    it('should coerce intersection types', () => {
      const base = z.object({ name: z.string() });
      const extra = z.object({ age: z.number() });
      const schema = z.intersection(base, extra);
      const result = coerce({ name: 'John', age: '30' }, schema);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value).toEqual({ name: 'John', age: 30 });
      }
    });
  });

  describe('parsePartial markdown extraction', () => {
    it('should extract JSON from markdown in partial mode', () => {
      const schema = z.object({ name: z.string(), age: z.number() });
      const input = `Here's the data:
\`\`\`json
{"name": "John", "age": 30
\`\`\``;
      const result = parsePartial(input, schema);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value?.name).toBe('John');
        expect(result.value?.age).toBe(30);
      }
    });
  });
});

describe('Streaming Parser Enhancements', () => {
  const schema = z.object({
    title: z.string(),
    count: z.number(),
  });

  it('should extract markdown during streaming', () => {
    const parser = createStreamParser(schema);

    parser.push('```json\n{"title": "Te');
    const r2 = parser.push('st", "count": 5}\n```');
    const final = parser.finish();

    expect(final.complete).toBe(true);
    expect(final.partial).toEqual({ title: 'Test', count: 5 });
  });

  it('should try complete parsing on finish', () => {
    const parser = createStreamParser(schema);

    parser.push('{"title": "Test", "count": 5}');
    const final = parser.finish();

    expect(final.complete).toBe(true);
    expect(final.partial).toEqual({ title: 'Test', count: 5 });
  });

  it('should coerce types on complete finish', () => {
    const parser = createStreamParser(schema);

    parser.push('{"title": "Test", "count": "5"}');
    const final = parser.finish();

    expect(final.complete).toBe(true);
    expect(final.partial?.count).toBe(5);
    expect(final.corrections.length).toBeGreaterThan(0);
  });

  it('should respect extractFromMarkdown config', () => {
    const parser = createStreamParser(schema, { extractFromMarkdown: false });

    parser.push('```json\n{"title": "Test"}\n```');
    const final = parser.finish();

    expect(final.complete).toBe(false);
  });
});

describe('Real-world LLM Output Examples', () => {
  it('should handle OpenAI-style response with reasoning', () => {
    const schema = z.object({
      diagnosis: z.string(),
      confidence: z.number(),
      followUp: z.array(z.string()),
    });

    const input = `Based on the symptoms described, I'll analyze this carefully.

The patient presents with headache and fatigue, which could indicate several conditions.

\`\`\`json
{
  "diagnosis": "Tension headache with possible sleep disorder",
  "confidence": 0.75,
  "followUp": [
    "Sleep study",
    "Stress assessment",
    "Blood work for thyroid function"
  ]
}
\`\`\`

Please note this is a preliminary assessment.`;

    const result = parse(input, schema);
    expect(result.success).toBe(true);
    if (result.success && result.value) {
      expect(result.value.confidence).toBe(0.75);
      expect(result.value.followUp.length).toBe(3);
    }
  });

  it('should handle messy JSON with common LLM mistakes', () => {
    const schema = z.object({
      action: z.enum(['approve', 'reject', 'escalate']),
      reason: z.string(),
      priority: z.number(),
    });

    const input = `{
      action: 'APPROVE',
      reason: "The request meets all criteria
and has been validated",
      priority: "1",
    }`;

    const result = parse(input, schema);
    expect(result.success).toBe(true);
    if (result.success && result.value) {
      expect(result.value.action).toBe('approve');
      expect(result.value.priority).toBe(1);
    }
  });

  it('should handle nested objects with type coercion', () => {
    const patientSchema = z.object({
      patient: z.object({
        name: z.string(),
        dob: z.date(),
        conditions: z.array(
          z.object({
            name: z.string(),
            severity: z.enum(['mild', 'moderate', 'severe']),
            diagnosed: z.date(),
          }),
        ),
      }),
    });

    const input = `{
      "patient": {
        "name": "John Doe",
        "dob": "1980-05-15",
        "conditions": [
          {
            "name": "Hypertension",
            "severity": "MODERATE",
            "diagnosed": "2020-03-10"
          }
        ]
      }
    }`;

    const result = parse(input, patientSchema);
    expect(result.success).toBe(true);
    if (result.success && result.value) {
      expect(result.value.patient.dob).toBeInstanceOf(Date);
      expect(result.value.patient.conditions[0].severity).toBe('moderate');
    }
  });
});

describe('JSON Repair Features via parseJsonish', () => {
  describe('comment removal', () => {
    it('should remove single-line comments', () => {
      const input = `{
        "name": "test", // this is a comment
        "value": 42
      }`;
      const result = parseJsonish(input);
      expect(result.success).toBe(true);
      expect(result.value).toEqual({ name: 'test', value: 42 });
    });

    it('should remove multi-line comments', () => {
      const input = `{
        "name": "test", /* this is
        a multi-line comment */
        "value": 42
      }`;
      const result = parseJsonish(input);
      expect(result.success).toBe(true);
      expect(result.value).toEqual({ name: 'test', value: 42 });
    });

    it('should not remove comments inside strings', () => {
      const input =
        '{"message": "// not a comment", "url": "https://example.com"}';
      const result = parseJsonish(input);
      expect(result.success).toBe(true);
      expect(result.value).toEqual({
        message: '// not a comment',
        url: 'https://example.com',
      });
    });
  });

  describe('bare value handling', () => {
    it('should handle undefined as unquoted string', () => {
      const input = '{"value": undefined}';
      const result = parseJsonish(input);
      expect(result.success).toBe(true);
      expect(result.value).toEqual({ value: 'undefined' });
    });

    it('should handle NaN as unquoted string', () => {
      const input = '{"value": NaN}';
      const result = parseJsonish(input);
      expect(result.success).toBe(true);
      expect(result.value).toEqual({ value: 'NaN' });
    });

    it('should handle Infinity as number', () => {
      const input = '{"positive": Infinity, "negative": -Infinity}';
      const result = parseJsonish(input);
      expect(result.success).toBe(true);
      expect(result.value).toEqual({ positive: Infinity, negative: -Infinity });
    });

    it('should not modify values inside strings', () => {
      const input = '{"message": "value is undefined"}';
      const result = parseJsonish(input);
      expect(result.success).toBe(true);
      expect(result.value).toEqual({ message: 'value is undefined' });
    });
  });

  describe('comments and bare values combined', () => {
    it('should handle JSON with comments', () => {
      const input = `{
        // User configuration
        "name": "John",
        "age": 30 /* years old */
      }`;
      const result = parseJsonish(input);
      expect(result.success).toBe(true);
      expect(result.value).toEqual({ name: 'John', age: 30 });
    });

    it('should handle JSON with bare values as strings', () => {
      const input = '{"data": undefined, "count": NaN}';
      const result = parseJsonish(input);
      expect(result.success).toBe(true);
      expect(result.value).toEqual({ data: 'undefined', count: 'NaN' });
    });
  });
});

describe('Error Position Reporting', () => {
  describe('getPositionFromOffset', () => {
    it('should calculate correct line and column', () => {
      const content = 'line1\nline2\nline3';
      expect(getPositionFromOffset(content, 0)).toEqual({ line: 1, column: 1 });
      expect(getPositionFromOffset(content, 6)).toEqual({ line: 2, column: 1 });
      expect(getPositionFromOffset(content, 8)).toEqual({ line: 2, column: 3 });
    });
  });

  it('should parse JSON with missing value gracefully', () => {
    const result = parseJsonish('{"invalid": }');
    expect(result.success).toBe(true);
    expect(result.value).toEqual({});
  });
});

describe('Numeric Coercion Edge Cases', () => {
  it('should handle comma-separated thousands', () => {
    const schema = z.object({ amount: z.number() });
    const result = coerce({ amount: '1,000,000' }, schema);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.amount).toBe(1000000);
    }
  });

  it('should extract number from percentage string', () => {
    const schema = z.object({ percent: z.number() });
    const result = coerce({ percent: '75%' }, schema);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.percent).toBe(75);
    }
  });

  it('should extract leading number from mixed string', () => {
    const schema = z.object({ value: z.number() });
    const result = coerce({ value: '42 units' }, schema);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.value).toBe(42);
    }
  });

  it('should handle negative percentages', () => {
    const schema = z.object({ change: z.number() });
    const result = coerce({ change: '-15%' }, schema);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.change).toBe(-15);
    }
  });
});

describe('Array Wrapping', () => {
  it('should wrap single value in array', () => {
    const schema = z.object({ items: z.array(z.string()) });
    const result = coerce({ items: 'single item' }, schema);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.items).toEqual(['single item']);
    }
  });

  it('should wrap single number in array', () => {
    const schema = z.object({ numbers: z.array(z.number()) });
    const result = coerce({ numbers: 42 }, schema);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.numbers).toEqual([42]);
    }
  });

  it('should split comma-separated string into array', () => {
    const schema = z.object({ tags: z.array(z.string()) });
    const result = coerce({ tags: 'red, green, blue' }, schema);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.tags).toEqual(['red', 'green', 'blue']);
    }
  });

  it('should not wrap if value cannot coerce to element type', () => {
    const schema = z.object({ numbers: z.array(z.number()) });
    const result = coerce({ numbers: 'not a number at all' }, schema);
    expect(result.success).toBe(false);
  });
});

describe('ZodCatch Support', () => {
  it('should use catch value on coercion failure', () => {
    const schema = z.object({
      status: z.enum(['active', 'inactive']).catch('inactive'),
    });
    const result = coerce({ status: 'unknown_value' }, schema);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.status).toBe('inactive');
    }
  });

  it('should use catch function value', () => {
    const schema = z.object({
      count: z.number().catch(() => 0),
    });
    const result = coerce({ count: 'not a number' }, schema);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.count).toBe(0);
    }
  });

  it('should pass through valid values without using catch', () => {
    const schema = z.object({
      status: z.enum(['active', 'inactive']).catch('inactive'),
    });
    const result = coerce({ status: 'active' }, schema);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.status).toBe('active');
    }
  });
});

describe('ZodBigInt Support', () => {
  it('should coerce number to bigint', () => {
    const schema = z.object({ id: z.bigint() });
    const result = coerce({ id: 12345 }, schema);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.id).toBe(BigInt(12345));
    }
  });

  it('should coerce string to bigint', () => {
    const schema = z.object({ id: z.bigint() });
    const result = coerce({ id: '9007199254740993' }, schema);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.id).toBe(BigInt('9007199254740993'));
    }
  });

  it('should pass through bigint values', () => {
    const schema = z.object({ id: z.bigint() });
    const result = coerce({ id: BigInt(42) }, schema);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.id).toBe(BigInt(42));
    }
  });
});

describe('ZodMap Support', () => {
  it('should coerce object to Map', () => {
    const schema = z.map(z.string(), z.number());
    const result = coerce({ a: 1, b: 2 }, schema);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value).toBeInstanceOf(Map);
      expect(result.value.get('a')).toBe(1);
      expect(result.value.get('b')).toBe(2);
    }
  });

  it('should coerce array of entries to Map', () => {
    const schema = z.map(z.string(), z.number());
    const result = coerce(
      [
        ['a', 1],
        ['b', 2],
      ],
      schema,
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value).toBeInstanceOf(Map);
      expect(result.value.get('a')).toBe(1);
    }
  });

  it('should pass through Map values', () => {
    const schema = z.map(z.string(), z.number());
    const input = new Map([
      ['x', 10],
      ['y', 20],
    ]);
    const result = coerce(input, schema);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value).toBeInstanceOf(Map);
      expect(result.value.get('x')).toBe(10);
    }
  });
});

describe('ZodSet Support', () => {
  it('should coerce array to Set', () => {
    const schema = z.set(z.number());
    const result = coerce([1, 2, 3], schema);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value).toBeInstanceOf(Set);
      expect(result.value.has(1)).toBe(true);
      expect(result.value.has(2)).toBe(true);
      expect(result.value.has(3)).toBe(true);
    }
  });

  it('should coerce array with type coercion to Set', () => {
    const schema = z.set(z.number());
    const result = coerce(['1', '2', '3'], schema);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value).toBeInstanceOf(Set);
      expect(result.value.has(1)).toBe(true);
    }
  });

  it('should pass through Set values', () => {
    const schema = z.set(z.string());
    const input = new Set(['a', 'b', 'c']);
    const result = coerce(input, schema);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value).toBeInstanceOf(Set);
      expect(result.value.has('a')).toBe(true);
    }
  });
});

describe('String URL Protocol Coercion', () => {
  it('should add https:// to URL without protocol', () => {
    const schema = z.object({ website: z.string().url() });
    const result = coerce({ website: 'example.com' }, schema);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.website).toBe('https://example.com');
    }
  });

  it('should not modify URLs with existing protocol', () => {
    const schema = z.object({ website: z.string().url() });
    const result = coerce({ website: 'http://example.com' }, schema);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.website).toBe('http://example.com');
    }
  });

  it('should handle various protocols', () => {
    const schema = z.object({ link: z.string().url() });
    const result = coerce({ link: 'ftp://files.example.com' }, schema);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.link).toBe('ftp://files.example.com');
    }
  });
});

describe('Streaming Parser Optimizations', () => {
  const schema = z.object({
    title: z.string(),
    count: z.number(),
  });

  it('should handle incremental parsing efficiently', () => {
    const parser = createStreamParser(schema);

    const r1 = parser.push('{"title": "');
    expect(r1.partial?.title).toBe('');

    const r2 = parser.push('Hello');
    expect(r2.partial?.title).toBe('Hello');

    const r3 = parser.push(' World", "count": 42}');
    expect(r3.partial?.title).toBe('Hello World');
    expect(r3.partial?.count).toBe(42);

    const final = parser.finish();
    expect(final.complete).toBe(true);
  });

  it('should track structural changes', () => {
    const parser = createStreamParser(schema);

    parser.push('{"title": "Test"');
    const r2 = parser.push(', "count": ');
    expect(r2.partial?.title).toBe('Test');

    const r3 = parser.push('5}');
    expect(r3.partial?.count).toBe(5);
  });

  it('should reset incremental state on reset', () => {
    const parser = createStreamParser(schema);

    parser.push('{"title": "Test"');
    parser.reset();

    const state = parser.getState();
    expect(state.buffer).toBe('');
    expect(state.current).toBeUndefined();
  });
});

describe('String to Array Unwrapping', () => {
  it('should unwrap single-element array to string', () => {
    const schema = z.object({ name: z.string() });
    const result = coerce({ name: ['John'] }, schema);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.name).toBe('John');
    }
  });

  it('should not unwrap multi-element array to string', () => {
    const schema = z.object({ name: z.string() });
    const result = coerce({ name: ['John', 'Doe'] }, schema);
    expect(result.success).toBe(false);
  });
});

describe('Multi-JSON Extraction', () => {
  it('should extract multiple balanced JSON objects from text', () => {
    const input = `Here's the first result: {"a": 1}
And the second: {"b": 2}`;
    const result = parseJsonish(input);
    expect(result.success).toBe(true);
    expect(result.jsonish?.type).toBe('anyOf');
    if (result.jsonish?.type === 'anyOf') {
      expect(result.jsonish.candidates.length).toBe(2);
    }
  });

  it('should handle single JSON object without anyOf', () => {
    const input = 'Result: {"name": "test"}';
    const result = parseJsonish(input);
    expect(result.success).toBe(true);
    expect(result.value).toEqual({ name: 'test' });
  });

  it('should extract multiple arrays', () => {
    const input = '[1, 2] and also [3, 4]';
    const result = parseJsonish(input);
    expect(result.success).toBe(true);
    expect(result.jsonish?.type).toBe('anyOf');
  });
});

describe('Enhanced Unquoted String Heuristics', () => {
  it('should close unquoted value before trailing comment', () => {
    const input = '{"value": 42 // this is a comment\n}';
    const result = parseJsonish(input);
    expect(result.success).toBe(true);
    expect(result.value).toEqual({ value: 42 });
  });

  it('should close unquoted value before block comment', () => {
    const input = '{"value": 42 /* comment */}';
    const result = parseJsonish(input);
    expect(result.success).toBe(true);
    expect(result.value).toEqual({ value: 42 });
  });

  it('should handle arrays with trailing comments on line', () => {
    const input = '[1, 2, 3] // trailing comment';
    const result = parseJsonish(input);
    expect(result.success).toBe(true);
    expect(result.value).toEqual([1, 2, 3]);
  });
});

describe('Improved Markdown Fence Handling', () => {
  it('should handle basic markdown fences', () => {
    const input = '```json\n{"name": "test"}\n```';
    const result = parseJsonish(input);
    expect(result.success).toBe(true);
    expect(result.value).toEqual({ name: 'test' });
  });

  it('should handle fence-like content inside JSON strings', () => {
    const input = '```json\n{"code": "```js\\nconst x = 1;\\n```"}\n```';
    const result = parseJsonish(input);
    expect(result.success).toBe(true);
  });

  it('should prefer valid JSON parse over incomplete', () => {
    const input = `\`\`\`json
{"status": "ok"}
\`\`\`
Some text after`;
    const result = parseJsonish(input);
    expect(result.success).toBe(true);
    expect(result.value).toEqual({ status: 'ok' });
  });
});

describe('Unicode & Surrogate Pair Handling', () => {
  it('should handle emoji in JSON strings', () => {
    const input = '{"emoji": "Hello 👋 World 🌍"}';
    const result = parseJsonish(input);
    expect(result.success).toBe(true);
    expect(result.value).toEqual({ emoji: 'Hello 👋 World 🌍' });
  });

  it('should handle unicode escape sequences', () => {
    const input = '{"text": "\\u0048\\u0065\\u006C\\u006C\\u006F"}';
    const result = parseJsonish(input);
    expect(result.success).toBe(true);
    expect(result.value).toEqual({ text: 'Hello' });
  });

  it('should handle surrogate pairs via unicode escapes', () => {
    const input = '{"emoji": "\\uD83D\\uDC4B"}';
    const result = parseJsonish(input);
    expect(result.success).toBe(true);
    expect(result.value).toEqual({ emoji: '👋' });
  });

  it('should handle mixed escaped and literal unicode', () => {
    const input = '{"text": "Price: \\u00A3100 💰"}';
    const result = parseJsonish(input);
    expect(result.success).toBe(true);
    expect(result.value).toEqual({ text: 'Price: £100 💰' });
  });
});

describe('Triple-Quoted Strings', () => {
  it('should parse triple-quoted strings with newlines', () => {
    const input = '{"content": """This is\na multi-line\nstring"""}';
    const result = parseJsonish(input);
    expect(result.success).toBe(true);
    const value = result.value as { content: string };
    expect(value.content).toContain('multi-line');
  });

  it('should parse triple-backtick strings', () => {
    const input = '{"code": ```const x = 1;\nconst y = 2;```}';
    const result = parseJsonish(input);
    expect(result.success).toBe(true);
    const value = result.value as { code: string };
    expect(value.code).toContain('const x');
  });
});

describe('ZodTuple Support', () => {
  it('should coerce tuple with correct element types', () => {
    const schema = z.tuple([z.string(), z.number(), z.boolean()]);
    const result = coerce(['hello', '42', 'true'], schema);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value).toEqual(['hello', 42, true]);
    }
  });

  it('should handle partial tuple parsing', () => {
    const schema = z.tuple([z.string(), z.number()]);
    const result = coercePartial(['test', undefined], schema);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value[0]).toBe('test');
    }
  });
});

describe('ZodRecord Support', () => {
  it('should coerce record values', () => {
    const schema = z.record(z.string(), z.number());
    const result = coerce({ a: '1', b: '2', c: '3' }, schema);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value).toEqual({ a: 1, b: 2, c: 3 });
    }
  });

  it('should handle nested records', () => {
    const schema = z.object({
      scores: z.record(z.string(), z.number()),
    });
    const result = coerce({ scores: { math: '95', english: '87' } }, schema);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.scores).toEqual({ math: 95, english: 87 });
    }
  });
});

describe('Fraction Parsing', () => {
  it('should parse simple fractions', () => {
    const schema = z.object({ value: z.number() });
    const result = coerce({ value: '1/2' }, schema);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.value).toBe(0.5);
    }
  });

  it('should parse complex fractions', () => {
    const schema = z.object({ value: z.number() });
    const result = coerce({ value: '3/4' }, schema);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.value).toBe(0.75);
    }
  });

  it('should handle fractions with decimals', () => {
    const schema = z.object({ value: z.number() });
    const result = coerce({ value: '1.5/3' }, schema);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.value).toBe(0.5);
    }
  });
});

describe('Deeply Nested Structures', () => {
  it('should handle deeply nested objects without stack overflow', () => {
    const deepSchema = z.object({
      level1: z.object({
        level2: z.object({
          level3: z.object({
            level4: z.object({
              value: z.number(),
            }),
          }),
        }),
      }),
    });

    const input = {
      level1: {
        level2: {
          level3: {
            level4: {
              value: '42',
            },
          },
        },
      },
    };

    const result = coerce(input, deepSchema);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.level1.level2.level3.level4.value).toBe(42);
    }
  });

  it('should track nested correction paths accurately', () => {
    const schema = z.object({
      user: z.object({
        profile: z.object({
          age: z.number(),
        }),
      }),
    });

    const result = coerce({ user: { profile: { age: '25' } } }, schema);
    expect(result.success).toBe(true);
    if (result.success) {
      const ageCorrection = result.corrections.find(
        (c) => c.path.join('.') === 'user.profile.age',
      );
      expect(ageCorrection).toBeDefined();
      expect(ageCorrection?.type).toBe('stringToNumber');
    }
  });
});

describe('Object Passthrough Mode', () => {
  it('should preserve extra keys with passthrough', () => {
    const schema = z.object({ name: z.string() }).passthrough();
    const result = coerce(
      { name: 'John', extra: 'value', another: 123 },
      schema,
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.name).toBe('John');
      expect((result.value as Record<string, unknown>).extra).toBe('value');
      expect((result.value as Record<string, unknown>).another).toBe(123);
    }
  });
});

describe('Streaming Delta Computation', () => {
  it('should detect string append operations', () => {
    const schema = z.object({ text: z.string() });
    const parser = createStreamParser(schema);

    parser.push('{"text": "Hel');
    const r2 = parser.push('lo World"}');

    const appendDelta = r2.delta?.find(
      (d) => d.operation === 'append' || d.operation === 'set',
    );
    expect(appendDelta).toBeDefined();
  });

  it('should detect array element additions', () => {
    const schema = z.object({ items: z.array(z.string()) });
    const parser = createStreamParser(schema);

    parser.push('{"items": ["a"');
    const r2 = parser.push(', "b", "c"]}');

    expect(r2.partial?.items).toEqual(['a', 'b', 'c']);
  });

  it('should track completion state transitions', () => {
    const schema = z.object({ name: z.string() });
    const parser = createStreamParser(schema);

    parser.push('{"name": "test"');
    expect(parser.isDone()).toBe(false);

    parser.push('}');
    expect(parser.isDone()).toBe(true);
  });
});
