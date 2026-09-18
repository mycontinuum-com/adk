import { z } from 'zod/v4'

export { normalizeEnumValue, coerceToEnum } from '../shared/enums'

export function getEnumValues(schema: z.ZodEnum): string[] {
  return schema.options.filter((value): value is string => typeof value === 'string')
}
