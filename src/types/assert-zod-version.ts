/**
 * Refuse a zod 4 schema at the door, loudly.
 *
 * The ADK's schema layer reads zod 3 internals — the coercion parser, the CLI's schema-input
 * inspector, context rendering and provider schema normalization all dispatch on
 * `_def.typeName`, and every provider and voice tool schema is converted by `zod-to-json-schema`.
 * zod 4 removed `_def.typeName` and carries `_zod` instead, and `zod-to-json-schema` does not read
 * v4 schemas.
 *
 * Handed a v4 schema, none of that throws. The coercion parser finds no `typeName` and falls
 * through, so `'5'` never becomes `5`; the JSON-schema conversion falls back to a bare `any`, so
 * every tool reaches the model with its parameters erased. The run completes, the agent is quietly
 * worse, and nothing in the output says why. An installed-but-wrong zod is easy to arrive at:
 * pnpm's `autoInstallPeers` links one for you when another dependency (an agent SDK, say) asks for
 * zod 4.
 *
 * So this is checked once, where a schema enters — never on a per-call path.
 */
const isZod4Schema = (value: unknown): boolean =>
  typeof value === 'object' && value !== null && '_zod' in value && !('typeName' in ((value as { _def?: object })._def ?? {}))

/** Throws when `schema` is a zod 4 schema. `where` names the call the user made. */
export function assertZod3Schema(schema: unknown, where: string): void {
  if (!isZod4Schema(schema)) return
  throw new Error(
    `${where} received a zod 4 schema. This package is built against zod 3 and reads internals ` +
      `zod 4 does not have: coercion would silently stop, and tools would reach the model with ` +
      `no parameters. Install zod ^3.25 for the app that builds these schemas. ` +
      `If a dependency pulled zod 4 in, declare "zod": "^3.25.0" explicitly so both resolve.`,
  )
}

/** Throws when any field of a state schema is a zod 4 schema. */
export function assertZod3StateSchema(schema: object | undefined, where: string): void {
  if (!schema) return
  for (const scope of Object.values(schema)) {
    if (typeof scope !== 'object' || scope === null) continue
    for (const field of Object.values(scope as Record<string, unknown>)) {
      assertZod3Schema(field, where)
    }
  }
}
