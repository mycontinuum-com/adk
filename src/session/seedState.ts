import type { StateSchema, InferScope } from '../types/schema'
import type { BaseSession } from './base'

import { applySchemaDefaults } from '../types/schema'

export type StateChanges<S extends StateSchema = StateSchema> = {
  session?: Partial<InferScope<S['session']>>
  user?: Partial<InferScope<S['user']>>
  patient?: Partial<InferScope<S['patient']>>
  practice?: Partial<InferScope<S['practice']>>
  org?: Partial<InferScope<S['org']>>
  team?: Partial<InferScope<S['team']>>
}

export function seedState(session: BaseSession, changes: StateChanges, schema?: StateSchema): void {
  if (changes.session) session.state.update(applySchemaDefaults(changes.session, schema?.session))
  for (const scope of ['user', 'patient', 'practice', 'org', 'team'] as const) {
    if (changes[scope])
      (session.state as any)[scope]?.update?.(applySchemaDefaults(changes[scope]!, schema?.[scope]))
  }
}
