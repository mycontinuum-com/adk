import type { AnyZodSchema } from '../../types/zod'
import type { FieldDescriptor, SchemaDescriptor } from './zod/v4'

import { isZod3Schema, isZod4Schema } from '../../types/zod'
import * as v3 from './zod/v3'
import * as v4 from './zod/v4'

export type { FieldDescriptor, SchemaDescriptor }

export function inspectSchema(schema: AnyZodSchema): SchemaDescriptor {
  if (isZod4Schema(schema)) return v4.inspectSchema(schema)
  if (isZod3Schema(schema)) return v3.inspectSchema(schema)
  throw new Error('Unsupported schema')
}

export const getDefaultValue = v4.getDefaultValue
export const estimateFormHeight = v4.estimateFormHeight
