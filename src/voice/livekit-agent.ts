import type { Agent } from '../types/runnables'
import type { Session } from '../types/session'
import type { LiveKitModelResult } from './livekit-model'
import type { LKAgentInstance, VoiceDeps } from './livekit-types'

import { defaultVoiceDeps } from './livekit-types'

export function createLiveKitAgent(
  agent: Agent<any>,
  instructions: string,
  lkTools: Record<string, unknown>,
  session: Session,
  modelComponents?: LiveKitModelResult,
  onEnter?: () => Promise<void>,
  deps: VoiceDeps = defaultVoiceDeps,
): LKAgentInstance {
  const lk = deps.agents()
  const agentOpts: Record<string, unknown> = { instructions, tools: lkTools }
  if (modelComponents?.llm) agentOpts.llm = modelComponents.llm
  if (modelComponents?.stt) agentOpts.stt = modelComponents.stt
  if (modelComponents?.tts) agentOpts.tts = modelComponents.tts
  const lkAgent = new lk.voice.Agent(agentOpts as any)

  if (onEnter) {
    const originalOnEnter = lkAgent.onEnter.bind(lkAgent)
    lkAgent.onEnter = async () => {
      await originalOnEnter()
      await onEnter()
    }
  }

  return lkAgent
}
