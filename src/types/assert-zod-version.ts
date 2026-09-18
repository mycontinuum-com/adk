import { isSupportedZodSchema } from './zod'

export function assertSupportedSchema(schema: unknown, where: string): void {
  if (schema === undefined || isSupportedZodSchema(schema)) return
  throw new Error(`${where} requires a Zod 3 or Zod 4 Classic schema.`)
}

export function assertSupportedStateSchema(schema: object | undefined, where: string): void {
  if (!schema) return
  for (const scope of Object.values(schema)) {
    if (typeof scope !== 'object' || scope === null) continue
    for (const field of Object.values(scope)) assertSupportedSchema(field, where)
  }
}
