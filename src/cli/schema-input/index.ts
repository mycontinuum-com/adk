export { inspectSchema } from './inspect';
export { JsonSchemaForm } from './JsonSchemaForm';

import type { z } from 'zod';
import type { Runnable, Agent } from '../../types';

export function extractYieldSchemas(
  runnable: Runnable,
): Map<string, z.ZodTypeAny> {
  const schemas = new Map<string, z.ZodTypeAny>();

  function walk(r: Runnable): void {
    if (r.kind === 'agent') {
      for (const tool of (r as Agent).tools) {
        if (tool.yieldSchema) {
          schemas.set(tool.name, tool.yieldSchema);
        }
      }
    } else if (r.kind === 'sequence' || r.kind === 'parallel') {
      for (const child of (r as { runnables: Runnable[] }).runnables) {
        walk(child);
      }
    } else if (r.kind === 'loop') {
      walk((r as { runnable: Runnable }).runnable);
    }
  }

  walk(runnable);
  return schemas;
}
