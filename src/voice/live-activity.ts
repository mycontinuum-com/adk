/** Quiet that ends a turn, so a line GPT Live says in two bursts counts as one. */
const LINE_SETTLE_MS = 1_000

interface Waiter {
  readonly done: () => boolean
  readonly resolve: (met: boolean) => void
  readonly deadline: ReturnType<typeof setTimeout>
}

/**
 * Who is speaking on a Live call, from AgentSession states alone. A turn is a run of speech, as
 * production counts caller turns.
 */
export class LiveActivity {
  private turns = 0
  private agentTurnsStarted = 0
  private callerSpeaking = false
  private agentSpeaking = false
  private readonly waiting = new Set<Waiter>()
  private settle: ReturnType<typeof setTimeout> | undefined

  /** @param settleMs Agent quiet after which a waited-for condition is checked, and rechecked. */
  constructor(private readonly settleMs = LINE_SETTLE_MS) {}

  /** Caller speech turns so far: each change into `speaking` from any other state is one. */
  get callerTurns(): number {
    return this.turns
  }

  /** Agent speech turns started so far, counted as caller turns are. */
  get agentTurns(): number {
    return this.agentTurnsStarted
  }

  /** Records the caller's AgentSession state. */
  userState(state: string): void {
    const speaking = state === 'speaking'
    if (speaking && !this.callerSpeaking) this.turns++
    this.callerSpeaking = speaking
  }

  /** Records the agent's AgentSession state; waits are checked only once it has been quiet. */
  agentState(state: string): void {
    const speaking = state === 'speaking'
    if (speaking && !this.agentSpeaking) this.agentTurnsStarted++
    this.agentSpeaking = speaking
    clearTimeout(this.settle)
    this.settle = undefined
    if (!this.agentSpeaking) this.scheduleCheck()
  }

  /**
   * Resolves `true` once `done` holds after the agent has been quiet for the settle time, checking
   * again each settle time while it stays quiet, since `done` can change without an agent state
   * change, as when a delegation settles. Resolves `false` after `timeoutMs` if it never does.
   */
  whenQuietAnd(done: () => boolean, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const waiter: Waiter = {
        done,
        resolve,
        deadline: setTimeout(() => {
          this.waiting.delete(waiter)
          resolve(false)
        }, timeoutMs),
      }
      this.waiting.add(waiter)
      if (!this.agentSpeaking && this.settle === undefined) this.check()
    })
  }

  private scheduleCheck(): void {
    this.settle = setTimeout(() => this.check(), this.settleMs)
  }

  private check(): void {
    this.settle = undefined
    if (this.agentSpeaking) return
    for (const waiter of this.waiting)
      if (waiter.done()) {
        this.waiting.delete(waiter)
        clearTimeout(waiter.deadline)
        waiter.resolve(true)
      }
    if (this.waiting.size > 0) this.scheduleCheck()
  }
}
