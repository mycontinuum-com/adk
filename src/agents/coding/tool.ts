/**
 * Coding Tool Utilities
 *
 * Helper functions for working with coding agents as tools. Since CodingAgent now implements
 * FunctionTool directly, most use cases don't need these utilities.
 *
 * @module
 */

import type { FunctionTool } from '../../types/runnables'
import type { StateSchema } from '../../types/schema'
import type { CodingResult, CodingOutput, CodingToolInput } from './types'

import { codingToolInputSchema } from './types'

/**
 * Creates a no-op coding tool for testing. Immediately returns a completed CodingResult without
 * doing anything.
 *
 * @example
 *   ;```typescript
 *   import { coding } from '@animahealth/adk'
 *
 *   const noopTool = coding.noop({ name: 'code' })
 *
 *   const agent = app.agent({
 *     tools: [noopTool],
 *   })
 *   ```
 */
export function createNoopTool<S extends StateSchema = StateSchema>(
  options: { name?: string; description?: string } = {},
): FunctionTool<CodingToolInput, CodingResult, never, S> {
  const { name = 'coding', description = 'A no-op coding tool for testing.' } = options

  return {
    name,
    description,
    schema: codingToolInputSchema,

    async execute(): Promise<CodingResult> {
      const outputValue: CodingOutput = {
        modifiedFiles: [],
      }

      return {
        status: 'completed',
        sessionId: `noop-${Date.now()}`,
        durationMs: 0,
        output: {
          text: 'No-op execution completed.',
          value: outputValue,
          items: [],
        },
        usage: {
          models: [],
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalCachedTokens: 0,
          totalReasoningTokens: 0,
          totalAudioInputTokens: 0,
          totalAudioOutputTokens: 0,
          modelCalls: 0,
        },
      }
    },
  }
}

// Re-export the schema
export { codingToolInputSchema }
