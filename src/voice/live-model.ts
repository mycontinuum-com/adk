import type { LiveAgent, LiveModelConfig } from '../types/runnables'
import type { StateSchema } from '../types/schema'
import type { Session } from '../types/session'
import type { GPTLiveTranscriptSource } from './gpt-live-transcript'

import { buildLiveContextAsync } from '../context/build'
import { resolveOpenAIConnection } from '../providers/openai-endpoints'

type LiveKitLLM = InstanceType<(typeof import('@livekit/agents'))['llm']['LLM']>

/** The members of a GPT Live plugin session that the ADK uses. */
export interface GPTLiveSession extends GPTLiveTranscriptSource {
  appendThinking(text: string, options: { delegationId?: string }): unknown
  appendCommentary(text: string, options: { delegationId?: string }): unknown
  appendInstructions(text: string, options: { delegationId?: string }): unknown
  /** Replace caller audio with silence until `unmuteInput`. */
  muteInput(): void
  unmuteInput(): void
  on(event: 'openai_server_event_received', listener: (event: unknown) => void): unknown
  on(event: 'delegation_created', listener: (event: { id: string }) => void): unknown
}

/**
 * The GPT Live classes of the OpenAI plugin's realtime namespace. Typed structurally so the ADK
 * still compiles against LiveKit plugins older than 1.9, which do not export them.
 */
export interface GPTLiveRealtime {
  GPTLiveModel: new (options: Record<string, unknown>) => LiveKitLLM
  GPTLiveSession: new (...args: never[]) => GPTLiveSession
}

/** The plugin's realtime namespace, checked at runtime for GPT Live support (plugin 1.9+). */
export function requireGPTLive(openai: { realtime: GPTLiveRealtime }): GPTLiveRealtime {
  const { realtime } = openai
  if (!realtime.GPTLiveModel || !realtime.GPTLiveSession)
    throw new Error('openai.live requires LiveKit agents and OpenAI plugin 1.9 or later')
  return realtime
}

/** A GPT Live model with client delegation, configured by `openai.live(...)`. */
export function createGPTLiveModel(realtime: GPTLiveRealtime, config: LiveModelConfig): LiveKitLLM {
  const { name: model, kind: _kind, provider: _provider, ...options } = config
  return new realtime.GPTLiveModel({
    ...resolveOpenAIConnection(),
    ...options,
    model,
    delegation: 'client',
  })
}

/** Render a Live agent's context, which supports system instructions only. */
export async function renderLiveInstructions<S extends StateSchema>(
  session: Session<S>,
  agent: LiveAgent<S>,
  invocationId: string,
): Promise<string> {
  const rendered = await buildLiveContextAsync(session, agent, invocationId)
  if (
    rendered.events.some((event) => event.type !== 'system') ||
    rendered.functionTools.length ||
    rendered.providerTools.length ||
    rendered.outputSchema ||
    rendered.outputMode ||
    rendered.toolChoice ||
    rendered.allowedTools
  )
    throw new Error(
      'Live agent context currently supports system instructions only; conversation history belongs to the backend',
    )
  return rendered.events
    .flatMap((event) => (event.type === 'system' ? [event.text] : []))
    .join('\n')
}
