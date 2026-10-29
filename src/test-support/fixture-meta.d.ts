// The `meta` key an ADK Vitest test carries to prove a Fixture of Serenity's feature maps
// (docs/products/README.md#fixtures): `it('<sentence>', { meta: { fixture: '<id>' } }, …)`.
import type { TaskMeta as _TaskMeta } from 'vitest'

declare module 'vitest' {
  interface TaskMeta {
    /** The id of the Fixture the test proves, or the ids when it proves more than one. */
    fixture?: string | readonly string[]
  }
}
