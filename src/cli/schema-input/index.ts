export { inspectSchema, estimateFormHeight } from './inspect'
export { JsonSchemaForm } from './JsonSchemaForm'

import type { Runnable, Agent } from '../../types'
import type { AnyZodSchema } from '../../types/zod'

import { isFunctionTool } from '../../core/tools'

export function extractYieldSchemas(runnable: Runnable): Map<string, AnyZodSchema> {
  const schemas = new Map<string, AnyZodSchema>()

  function walk(r: Runnable): void {
    if (r.kind === 'agent') {
      for (const tool of (r as Agent).tools.filter(isFunctionTool)) {
        if (tool.yieldSchema) {
          schemas.set(tool.name, tool.yieldSchema)
        }
      }
    } else if (r.kind === 'sequence' || r.kind === 'parallel') {
      for (const child of (r as { runnables: Runnable[] }).runnables) {
        walk(child)
      }
    } else if (r.kind === 'loop') {
      walk((r as { runnable: Runnable }).runnable)
    }
  }

  walk(runnable)
  return schemas
}
