import { BaseSession } from '../session'

let evalSessionCounter = 0

export function createEvalSession(): BaseSession {
  return new BaseSession('eval', { id: `eval-${Date.now()}-${evalSessionCounter++}` })
}
