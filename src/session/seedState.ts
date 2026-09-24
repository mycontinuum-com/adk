import type { StateSchema, InferScope } from '../types/schema'
import type { Session } from '../types/session'

import { applySchemaDefaults } from '../types/schema'

export type StateChanges<S extends StateSchema = StateSchema> = {
  session?: Partial<InferScope<S['session']>>
  user?: Partial<InferScope<S['user']>>
  patient?: Partial<InferScope<S['patient']>>
  practice?: Partial<InferScope<S['practice']>>
  org?: Partial<InferScope<S['org']>>
  team?: Partial<InferScope<S['team']>>
}

/**
 * Writes initial values into each scope of `session` that `changes` names, after applying the
 * schema defaults for that scope. Scopes without a binding on the session are skipped.
 */
export function seedState(session: Session, changes: StateChanges, schema?: StateSchema): void {
  if (changes.session) session.state.update(applySchemaDefaults(changes.session, schema?.session))
  for (const scope of ['user', 'patient', 'practice', 'org', 'team'] as const) {
    const scopeChanges = changes[scope]
    if (scopeChanges) {
      session.state[scope]?.update?.(applySchemaDefaults(scopeChanges, schema?.[scope]))
    }
  }
}
