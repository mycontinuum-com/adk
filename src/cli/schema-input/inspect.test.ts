import { z } from 'zod';
import { inspectSchema, getDefaultValue } from './inspect';

describe('inspectSchema', () => {
  it('inspects a simple boolean schema', () => {
    const result = inspectSchema(z.boolean());
    expect(result.isSimple).toBe(true);
    expect(result.fields).toHaveLength(1);
    expect(result.fields[0]).toMatchObject({
      name: 'value',
      kind: 'boolean',
      required: true,
    });
  });

  it('inspects a string with description', () => {
    const result = inspectSchema(z.string().describe('Your answer'));
    expect(result.fields[0]).toMatchObject({
      kind: 'string',
      description: 'Your answer',
    });
  });

  it('inspects an object schema', () => {
    const result = inspectSchema(
      z.object({
        approved: z.boolean(),
        notes: z.string().optional(),
      }),
    );
    expect(result.isSimple).toBe(true);
    expect(result.fields).toHaveLength(2);
    expect(result.fields[0]).toMatchObject({
      name: 'approved',
      kind: 'boolean',
      required: true,
    });
    expect(result.fields[1]).toMatchObject({
      name: 'notes',
      kind: 'string',
      required: false,
    });
  });

  it('inspects an enum', () => {
    const result = inspectSchema(
      z.object({
        status: z.enum(['pending', 'approved', 'rejected']),
      }),
    );
    expect(result.fields[0]).toMatchObject({
      name: 'status',
      kind: 'enum',
      enumValues: ['pending', 'approved', 'rejected'],
    });
  });

  it('inspects defaults', () => {
    const result = inspectSchema(
      z.object({
        count: z.number().default(10),
        enabled: z.boolean().default(true),
      }),
    );
    expect(result.fields[0]).toMatchObject({
      name: 'count',
      required: false,
      defaultValue: 10,
    });
    expect(result.fields[1]).toMatchObject({
      name: 'enabled',
      required: false,
      defaultValue: true,
    });
  });

  it('marks schema with many fields as not simple', () => {
    const result = inspectSchema(
      z.object({
        a: z.string(),
        b: z.string(),
        c: z.string(),
        d: z.string(),
        e: z.string(),
        f: z.string(),
      }),
    );
    expect(result.isSimple).toBe(false);
  });
});

describe('getDefaultValue', () => {
  it('returns field default if set', () => {
    const { fields } = inspectSchema(z.object({ n: z.number().default(42) }));
    expect(getDefaultValue(fields[0])).toBe(42);
  });

  it('returns type default otherwise', () => {
    const { fields } = inspectSchema(
      z.object({
        s: z.string(),
        n: z.number(),
        b: z.boolean(),
      }),
    );
    expect(getDefaultValue(fields[0])).toBe('');
    expect(getDefaultValue(fields[1])).toBe(0);
    expect(getDefaultValue(fields[2])).toBe(false);
  });
});
