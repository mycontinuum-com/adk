import { z } from 'zod';
import { renderSchema } from './renderSchema';

describe('renderSchema examples', () => {
  test('simple types', () => {
    expect(renderSchema(z.string())).toBe('string');
    expect(renderSchema(z.number())).toBe('number');
    expect(renderSchema(z.boolean())).toBe('boolean');
  });

  test('enum', () => {
    const statusEnum = z.enum(['pending', 'active', 'completed']);
    expect(renderSchema(statusEnum)).toBe('"pending" | "active" | "completed"');
  });

  test('array', () => {
    expect(renderSchema(z.array(z.string()))).toBe('string[]');
  });

  test('optional', () => {
    expect(renderSchema(z.string().optional())).toBe('string');
  });

  test('simple object', () => {
    const schema = z.object({
      name: z.string().describe('The user name'),
      age: z.number().describe('Age in years'),
      active: z.boolean(),
    });
    const rendered = renderSchema(schema);
    console.log('\n=== Simple Object ===\n' + rendered);
    expect(rendered).toContain('// The user name');
    expect(rendered).toContain('name: string');
    expect(rendered).toContain('// Age in years');
    expect(rendered).toContain('age: number');
    expect(rendered).toContain('active: boolean');
  });

  test('object with optional fields', () => {
    const schema = z.object({
      required: z.string().describe('This is required'),
      optional: z.string().optional().describe('This is optional'),
      nullable: z.string().nullable().describe('This can be null'),
    });
    const rendered = renderSchema(schema);
    console.log('\n=== Object with Optional Fields ===\n' + rendered);
    expect(rendered).toContain('// This is required');
    expect(rendered).toContain('required: string');
    expect(rendered).toContain('optional: string');
    expect(rendered).toContain('nullable: string | null');
    expect(rendered).not.toContain('(optional)');
  });

  test('nested object', () => {
    const schema = z.object({
      user: z
        .object({
          name: z.string().describe('Full name'),
          email: z.string().describe('Email address'),
        })
        .describe('User info'),
      settings: z.object({
        theme: z.enum(['light', 'dark']).describe('UI theme'),
        notifications: z.boolean(),
      }),
    });
    const rendered = renderSchema(schema);
    console.log('\n=== Nested Object ===\n' + rendered);
    expect(rendered).toContain('// User info');
    expect(rendered).toContain('user:');
    expect(rendered).toContain('// Full name');
    expect(rendered).toContain('name: string');
  });

  test('deeply nested object', () => {
    const schema = z.object({
      organization: z.object({
        name: z.string().describe('Org name'),
        departments: z.object({
          engineering: z.object({
            headcount: z.number(),
            lead: z.string(),
          }),
        }),
      }),
    });
    const rendered = renderSchema(schema);
    console.log('\n=== Deeply Nested ===\n' + rendered);
    expect(rendered).toContain('organization:');
    expect(rendered).toContain('departments:');
    expect(rendered).toContain('engineering:');
  });

  test('array of objects', () => {
    const schema = z.object({
      users: z
        .array(
          z.object({
            id: z.string().describe('User ID'),
            name: z.string().describe('User name'),
          }),
        )
        .describe('List of users'),
    });
    const rendered = renderSchema(schema);
    console.log('\n=== Array of Objects ===\n' + rendered);
    expect(rendered).toContain('// List of users');
    expect(rendered).toContain('users: Array<{');
    expect(rendered).toContain('id: string');
    expect(rendered).toContain('name: string');
  });

  test('graph-like structure', () => {
    const nodeSchema = z.object({
      id: z.string().describe('Unique node identifier'),
      label: z.string().describe('Display label'),
      children: z.array(z.string()).describe('IDs of child nodes'),
      metadata: z
        .object({
          createdAt: z.string(),
          updatedAt: z.string(),
        })
        .optional()
        .describe('Timestamps'),
    });
    const rendered = renderSchema(nodeSchema);
    console.log('\n=== Graph Node ===\n' + rendered);
    expect(rendered).toContain('// Unique node identifier');
    expect(rendered).toContain('id: string');
    expect(rendered).toContain('// IDs of child nodes');
    expect(rendered).toContain('children: string[]');
  });

  test('clinical example', () => {
    const validationSchema = z.object({
      assessment: z.string().describe('Current clinical assessment'),
      plan: z.string().describe('Recommended next steps'),
      policies: z.array(z.string()).describe('Relevant policy IDs'),
      complete: z.boolean().describe('Whether assessment is complete'),
    });
    const rendered = renderSchema(validationSchema);
    console.log('\n=== Clinical Example ===\n' + rendered);
    expect(rendered).toContain('// Current clinical assessment');
    expect(rendered).toContain('assessment: string');
    expect(rendered).toContain('// Relevant policy IDs');
    expect(rendered).toContain('policies: string[]');
  });

  test('shared schema (reused object)', () => {
    const addressSchema = z.object({
      street: z.string(),
      city: z.string(),
    });
    const schema = z.object({
      homeAddress: addressSchema,
      workAddress: addressSchema,
    });
    const rendered = renderSchema(schema);
    console.log('\n=== Shared Schema ===\n' + rendered);
    expect(rendered).toContain('#T1');
    expect(rendered).toContain('homeAddress: { #T1');
    expect(rendered).toContain('workAddress: T1');
  });

  test('recursive schema (self-referencing)', () => {
    interface TreeNode {
      id: string;
      children: TreeNode[];
    }
    const treeSchema: z.ZodType<TreeNode> = z.lazy(() =>
      z.object({
        id: z.string().describe('Node identifier'),
        children: z.array(treeSchema).describe('Child nodes'),
      }),
    );
    const rendered = renderSchema(treeSchema);
    console.log('\n=== Recursive Schema ===\n' + rendered);
    expect(rendered).toContain('#T1');
    expect(rendered).toContain('id: string');
    expect(rendered).toContain('children: Array<T1>');
  });

  test('deeply nested with shared reference', () => {
    const personSchema = z.object({
      name: z.string(),
      age: z.number(),
    });
    const schema = z.object({
      author: personSchema,
      reviewers: z.array(personSchema).describe('List of reviewers'),
      editor: personSchema.optional().describe('Optional editor'),
    });
    const rendered = renderSchema(schema);
    console.log('\n=== Deeply Nested Shared ===\n' + rendered);
    expect(rendered).toContain('#T1');
    expect(rendered).toContain('author: { #T1');
    expect(rendered).toContain('reviewers: Array<T1>');
    expect(rendered).toContain('editor?: T1');
  });

  test('no reference needed for unique schemas', () => {
    const schema = z.object({
      user: z.object({
        name: z.string(),
      }),
      settings: z.object({
        theme: z.string(),
      }),
    });
    const rendered = renderSchema(schema);
    console.log('\n=== Unique Schemas (no refs) ===\n' + rendered);
    expect(rendered).not.toContain('#T');
    expect(rendered).toContain('user: {');
    expect(rendered).toContain('settings: {');
  });

  test('complex example with descriptions and shared refs', () => {
    const addressSchema = z.object({
      street: z.string().describe('Street address line'),
      city: z.string().describe('City name'),
      zipCode: z.string().describe('Postal code'),
    });

    const personSchema = z.object({
      name: z.string().describe('Full legal name'),
      email: z.string().describe('Primary email address'),
      homeAddress: addressSchema.optional().describe('Home address'),
      workAddress: addressSchema.optional().describe('Work address'),
    });

    const companySchema = z.object({
      name: z.string().describe('Company legal name'),
      headquarters: addressSchema.describe('Main office location'),
      employees: z.array(personSchema).describe('List of employees'),
      ceo: personSchema.describe('Chief executive officer'),
    });

    const rendered = renderSchema(companySchema);
    console.log('\n=== Complex with Descriptions ===\n' + rendered);
    expect(rendered).toContain('#T1');
    expect(rendered).toContain('#T2');
    expect(rendered).toContain('// Main office location');
    expect(rendered).toContain('// Chief executive officer');
  });
});
