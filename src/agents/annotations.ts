/**
 * Annotation wrapper helpers for use in app.step bodies and, when bound as globals, in CC-loader
 * workflow files.
 *
 * `phase(ctx, title)` is a thin wrapper over `ctx.note(title, { kind: 'phase' })`. `log(ctx,
 * message)` is a thin wrapper over `ctx.note(message)` (default kind 'log').
 *
 * The produced AnnotationEvent is field-for-field identical to the corresponding explicit ctx.note
 * call — the wrappers add no second event shape.
 */

import type { NoteOpts, OrchestrationContext } from '../types/runnables'
import type { StateSchema } from '../types/schema'

/**
 * Emit a phase annotation event. Sugar over `ctx.note(title, { kind: 'phase' })`. The emitted
 * AnnotationEvent is field-for-field identical to the explicit ctx.note control.
 */
export function phase<S extends StateSchema = StateSchema>(
  ctx: Pick<OrchestrationContext<S>, 'note'>,
  title: string,
  opts?: Omit<NoteOpts, 'kind'>,
): void {
  ctx.note(title, { ...opts, kind: 'phase' })
}

/**
 * Emit a log annotation event. Sugar over `ctx.note(message)` (default kind 'log'). The emitted
 * AnnotationEvent is field-for-field identical to the explicit ctx.note control.
 */
export function log<S extends StateSchema = StateSchema>(
  ctx: Pick<OrchestrationContext<S>, 'note'>,
  message: string,
  opts?: Omit<NoteOpts, 'kind'>,
): void {
  ctx.note(message, opts ? { ...opts } : undefined)
}
