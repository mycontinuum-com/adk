import { randomUUID } from 'node:crypto'

import type { Agent, LiveAgent } from '../../types/runnables'
import type { Session } from '../../types/session'
import type { GPTLiveRealtime } from '../../voice/live-model'
import type { LiveVoiceMeter } from '../../voice/live-usage'

import { buildContextAsync } from '../../context/build'
import { isRealtimeConfig } from '../../providers/models'
import { isSystemEvent } from '../../types/events'
import { createGPTLiveModel, renderLiveInstructions, requireGPTLive } from '../../voice/live-model'
import { createLiveKitAgent } from '../../voice/livekit-agent'
import { createLiveKitModel } from '../../voice/livekit-model'

type LiveKitAgents = typeof import('@livekit/agents')

/**
 * The answer to a simulated caller's own delegation. GPT Live always delegates to someone and has
 * no way to turn it off; the caller has no backend, so it is answered at once, without speech, and
 * the caller carries on. A past fact, as the plugin replays thinking text on a reconnect.
 */
const CALLER_DELEGATION_ANSWER =
  'Nothing was looked up: there is no one else on this call to ask, and you are the caller.'

/**
 * Build the simulated caller from its system instructions. A GPT Live caller has no tools and no
 * backend, so a delegation from it is answered with `CALLER_DELEGATION_ANSWER` and reported through
 * `onDelegation`. Its session time is recorded on `meter`.
 */
export async function createVoiceEvalCaller({
  lk,
  openai,
  agent,
  session,
  meter,
  onDelegation,
}: {
  lk: LiveKitAgents
  openai: () => { realtime: GPTLiveRealtime }
  agent: Agent<any, any> | LiveAgent<any>
  session: Session<any>
  meter?: LiveVoiceMeter
  onDelegation: (id: string) => void
}): Promise<InstanceType<LiveKitAgents['voice']['Agent']>> {
  if (agent.kind === 'live-agent') {
    const realtime = requireGPTLive(openai())
    const instructions = await renderLiveInstructions(session, agent, randomUUID())
    return new (class extends lk.voice.Agent {
      async onEnter() {
        const live: unknown = Reflect.get(this, 'duplexSession')
        if (!(live instanceof realtime.GPTLiveSession)) throw new Error('Expected GPT Live session')
        if (live.sessionId) meter?.observeConnection(live.sessionId)
        live.on('openai_server_event_received', (event) => {
          meter?.observeServerEvent(event, live.sessionId ?? undefined)
        })
        live.on('delegation_created', ({ id }) => {
          live.appendThinking(CALLER_DELEGATION_ANSWER, { delegationId: id })
          onDelegation(id)
        })
      }
    })({ instructions, tools: {}, llm: createGPTLiveModel(realtime, agent.model) })
  }
  if (!isRealtimeConfig(agent.model))
    throw new Error('Voice eval userAgent requires a Realtime or GPT Live model')
  const rendered = await buildContextAsync(session, agent, randomUUID())
  const caller = createLiveKitAgent(
    agent,
    rendered.events.flatMap((event) => (isSystemEvent(event) ? [event.text] : [])).join('\n'),
    {},
    session,
    createLiveKitModel(agent.model),
  )
  if (!(caller instanceof lk.voice.Agent)) throw new Error('Expected LiveKit caller agent')
  return caller
}
