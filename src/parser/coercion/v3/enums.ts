import { z } from 'zod/v3'

export { normalizeEnumValue, coerceToEnum } from '../shared/enums'

export function getEnumValues(schema: z.ZodEnum<[string, ...string[]]>): string[] {
  return schema.options
}

export function getNativeEnumValues(schema: z.ZodNativeEnum<z.EnumLike>): string[] {
  return Object.values(schema.enum).filter((value): value is string => typeof value === 'string')
}
