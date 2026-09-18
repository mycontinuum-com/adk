import { z } from 'zod/v4'

function normalize(schema: z.core.$ZodType): z.ZodType {
  if (!(schema instanceof z.ZodType)) throw new Error('ADK schemas must use Zod Classic')
  if (schema instanceof z.ZodObject) {
    const shape: Record<string, z.ZodType> = {}
    let changed = false
    for (const [key, value] of Object.entries(schema.shape)) {
      if (!(value instanceof z.ZodType)) throw new Error('Unsupported object field')
      let result = normalize(value)
      if (value instanceof z.ZodOptional && !value.isNullable()) {
        result = normalize(value.unwrap()).nullable().optional()
        if (value.description) result = result.describe(value.description)
      }
      shape[key] = result
      changed ||= result !== value
    }
    return changed ? schema.clone({ ...schema.def, shape }) : schema
  }
  if (schema instanceof z.ZodArray) {
    const element = normalize(schema.element)
    return element === schema.element ? schema : schema.clone({ ...schema.def, element })
  }
  if (schema instanceof z.ZodOptional) {
    const innerType = normalize(schema.unwrap())
    return innerType === schema.unwrap() ? schema : schema.clone({ ...schema.def, innerType })
  }
  if (schema instanceof z.ZodNullable) {
    const innerType = normalize(schema.unwrap())
    return innerType === schema.unwrap() ? schema : schema.clone({ ...schema.def, innerType })
  }
  if (schema instanceof z.ZodDefault) {
    const innerType = normalize(schema.unwrap())
    return innerType === schema.unwrap() ? schema : schema.clone({ ...schema.def, innerType })
  }
  if (schema instanceof z.ZodUnion) {
    const options = schema.options.map(normalize)
    return options.every((value, index) => value === schema.options[index])
      ? schema
      : schema.clone({ ...schema.def, options })
  }
  if (schema instanceof z.ZodRecord) {
    const valueType = normalize(schema.valueType)
    return valueType === schema.valueType ? schema : schema.clone({ ...schema.def, valueType })
  }
  if (schema instanceof z.ZodLazy) {
    return schema.clone({ ...schema.def, getter: () => normalize(schema.unwrap()) })
  }
  return schema
}

let hasWarned = false

export function normalizeSchema(schema: z.ZodType, name: string): z.ZodType {
  const result = normalize(schema)
  if (result !== schema && !hasWarned) {
    hasWarned = true
    console.warn(
      `[adk] Auto-patched Zod schema "${name}" for structured output compatibility: ` +
        `optional fields without .nullable() were wrapped automatically. ` +
        `To remove this warning, use .nullable().optional() instead of .optional().`,
    )
  }
  return result
}

export function resetNormalizeWarning(): void {
  hasWarned = false
}
