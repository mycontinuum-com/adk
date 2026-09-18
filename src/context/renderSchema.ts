import type { AnyZodSchema } from '../types/zod'

import { isZod3Schema, isZod4Schema } from '../types/zod'
import { renderSchema as renderV3 } from './zod/v3'
import { renderSchema as renderV4 } from './zod/v4'

export function renderSchema(schema: AnyZodSchema): string {
  if (isZod4Schema(schema)) return renderV4(schema)
  if (isZod3Schema(schema)) return renderV3(schema)
  throw new Error('Unsupported schema')
}
