import type { AnyZodSchema } from '../types/zod'

import { isZod3Schema, isZod4Schema } from '../types/zod'
import {
  normalizeSchema as normalizeV3,
  resetNormalizeWarning as resetV3,
} from './zod/normalize-v3'
import {
  normalizeSchema as normalizeV4,
  resetNormalizeWarning as resetV4,
} from './zod/normalize-v4'

export function normalizeSchema(schema: AnyZodSchema, name: string): AnyZodSchema {
  if (isZod4Schema(schema)) return normalizeV4(schema, name)
  if (isZod3Schema(schema)) return normalizeV3(schema, name)
  throw new Error('Unsupported schema')
}

export function resetNormalizeWarning(): void {
  resetV3()
  resetV4()
}
