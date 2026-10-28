// The claim keys an ADK Vitest test may carry in its options' `meta`, which makes it a node claim in
// Serenity's knowledge graph (apps/internal/knowledge-graph/docs/spec.md, Claims).
import type { TaskMeta as _TaskMeta } from 'vitest'

declare module 'vitest' {
  interface TaskMeta {
    /** The claim id, `<area>.<slug>`. */
    claim?: string
    /** The node ids the test checks. */
    nodes?: string[]
  }
}
