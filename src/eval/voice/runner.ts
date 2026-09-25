import { randomUUID } from 'node:crypto'

import type { Event } from '../../types/events'
import type { Agent, RealtimeModelConfig } from '../../types/runnables'
import type { UsageSummary } from '../../types/runtime'
import type { StateSchema } from '../../types/schema'
import type { Session, SessionService } from '../../types/session'
import type { LiveVoiceAppContext } from '../../voice/live-handler'
import type { LifecycleHookContext, VoiceEvent, VoiceHook } from '../../voice/types'
import type { CaseWriter } from './case-writer'
import type { RecorderHandle } from './recorder'
import type {
  VoiceEvalCase,
  VoiceEvalOptions,
  VoiceRoomConfig,
  VoiceRunResult,
  VoiceRunStatus,
  TimingEntry,
  TranscriptEntry,
} from './types'

import { buildContextAsync } from '../../context/build'
import { createStateAccessor } from '../../context/state'
import { createRunHandler } from '../../core/orchestration'
import { composeHooks } from '../../hook/compose'
import { isRealtimeConfig, getModelName, getModelProvider } from '../../providers/models'
import { calculateCost, formatCost, isPriceable, loadPricing } from '../../providers/pricing'
import { seedState } from '../../session'
import { createEventId, BaseSession } from '../../session'
import { isSystemEvent } from '../../types/events'
import {
  createForcedToolGate,
  ForcedToolCallError,
  renderToolRequiredInstructions,
} from '../../voice/forced-tool-gate'
import {
  wireEventListeners,
  collectOnEnterHooks,
  runComposedLifecycleHook,
} from '../../voice/handler'
import { createInactivityTimer, type InactivityTimer } from '../../voice/inactivity'
import { createLifecycle } from '../../voice/lifecycle'
import { createLiveKitAgent } from '../../voice/livekit-agent'
import { createLiveKitModel } from '../../voice/livekit-model'
import { convertTools } from '../../voice/livekit-tools'
import {
  createOutputToolCompletion,
  OutputToolCompletionError,
} from '../../voice/output-tool-completion'
import { sanitize } from '../../voice/recording'
import { LiveKitVoiceSession } from '../../voice/session'
import { interceptTools } from '../interceptTools'
import { createEvalSession } from '../session'
import { withTimeout } from '../suite-runner'
import { requireLiveKit } from './livekit-sdk'
import { connectRecorder } from './recorder'
import { emptyTiming } from './speaker-tracker'

interface TranscriptSource {
  text: string
  createdAt: number
  speechStartMs?: number
  speechEndMs?: number
}

function getOutputToolName(agent: Agent): string | undefined {
  const output = (agent as any).output
  if (!output) return undefined
  return typeof output === 'object' && 'name' in output ? output.name : undefined
}

function getVoiceReplyPlayout(reply: unknown): Promise<void> | undefined {
  if (!reply || typeof reply !== 'object') return undefined
  const waitForPlayout = (reply as { waitForPlayout?: unknown }).waitForPlayout
  if (typeof waitForPlayout !== 'function') return undefined
  return waitForPlayout.call(reply)
}

// ---------------------------------------------------------------------------
// Minimal session service for wireEventListeners
// ---------------------------------------------------------------------------

function createEvalSessionService(
  session: BaseSession,
  startMs: number,
  writer?: CaseWriter,
  getSpeechTiming?: (role: 'agent' | 'user') => {
    startMs?: number
    endMs?: number
  },
): SessionService {
  const pendingToolCalls = new Map<
    string,
    { name: string; args: Record<string, unknown>; ms: number }
  >()

  return {
    appendEvent: async (_sess: Session, event: Event) => {
      session.pushEvent(event)
      if (!writer) return

      const ts = ((event.createdAt ?? Date.now()) - startMs) / 1000

      if (event.type === 'user' || event.type === 'assistant') {
        // Skip agent-STT user transcripts — the user agent's own transcript
        // is written directly from the userLkSession listener instead.
        if (event.type === 'user' && 'source' in event && event.source === 'transcript') {
          return
        }
        const text = 'text' in event ? (event.text ?? '') : ''
        if (text) {
          const role = event.type === 'assistant' ? 'agent' : 'user'
          const timing = getSpeechTiming?.(role)
          const startTs =
            timing?.startMs != null ? ((timing.startMs - startMs) / 1000).toFixed(1) : null
          const endTs =
            timing?.endMs != null ? ((timing.endMs - startMs) / 1000).toFixed(1) : ts.toFixed(1)
          const prefix = startTs ? `${startTs}s–${endTs}s` : `${endTs}s`
          writer.appendLine(`${prefix} **${role}**: ${text}`)
        }
      } else if (event.type === 'tool_call') {
        pendingToolCalls.set(event.callId, {
          name: event.name,
          args: event.args,
          ms: ts,
        })
      } else if (event.type === 'tool_result') {
        const call = pendingToolCalls.get(event.callId)
        pendingToolCalls.delete(event.callId)
        const name = call?.name ?? event.name
        const argsStr = call ? JSON.stringify(call.args) : ''
        const resultStr = event.error
          ? `error: ${event.error}`
          : JSON.stringify(event.result ?? null)
        const callTs = call?.ms ?? ts
        writer.appendLine(`${callTs.toFixed(1)}s \`${name}(${argsStr})\` → \`${resultStr}\``)
      } else if (event.type === 'model_end') {
        const dur = event.durationMs ? `${(event.durationMs / 1000).toFixed(1)}s` : '?'
        const u = event.usage
        if (u) {
          const parts: string[] = []
          const uncachedText = Math.max(0, u.inputTokens - (u.cachedTokens ?? 0))
          parts.push(`${uncachedText} text in`)
          if (u.cachedTokens) parts.push(`${u.cachedTokens} text cached`)
          parts.push(`${u.outputTokens} text out`)
          if (u.audioInputTokens || u.audioCachedTokens) {
            const uncachedAudio = Math.max(
              0,
              (u.audioInputTokens ?? 0) - (u.audioCachedTokens ?? 0),
            )
            parts.push(`${uncachedAudio} audio in`)
            if (u.audioCachedTokens) parts.push(`${u.audioCachedTokens} audio cached`)
          }
          if (u.audioOutputTokens) parts.push(`${u.audioOutputTokens} audio out`)
          if (u.reasoningTokens) parts.push(`${u.reasoningTokens} reasoning`)
          const cost = isPriceable(u) ? calculateCost(u, await loadPricing()) : null
          if (cost) parts.push(formatCost(cost.totalCost))
          writer.appendLine(`${ts.toFixed(1)}s model (${dur}, ${parts.join(', ')})`)
        } else {
          writer.appendLine(`${ts.toFixed(1)}s model (${dur})`)
        }
      }
    },
    createSession: async () => session as Session,
    getSession: async () => session as Session,
    deleteSession: async () => {},
    getScopedState: async () => ({}),
    setScopedState: async () => {},
    commitSession: async () => ({ ok: true as const, version: 0 }),
    mergeSession: async () => ({ ok: true as const, version: 0 }),
    listSessions: async () => [],
  }
}

// ---------------------------------------------------------------------------
// Session-level response time tracker
// ---------------------------------------------------------------------------
// Room-level activeSpeakersChanged events include the VAD commit delay,
// which is artificially inflated (3-5s) in AI-to-AI audio paths. The agent's
// own session events reflect real processing latency: time from
// user_state:speaking→listening (VAD commits) to agent_state:→speaking
// (TTS begins). This matches what a human caller would experience.
// ---------------------------------------------------------------------------

interface SessionResponseTracker {
  getResponseTimes(): TimingEntry[]
  getTimeToFirstSpeech(): number | undefined
}

function wireSessionResponseTracker(lkSession: any): SessionResponseTracker {
  const responseTimes: TimingEntry[] = []
  let firstSpeechMs: number | undefined
  let sessionReadyMs: number | undefined
  let userStoppedMs: number | undefined
  let turnIndex = 0
  let agentSpeaking = false

  lkSession.on('user_state_changed', (ev: any) => {
    if (ev.newState === 'listening' && ev.oldState === 'speaking') {
      userStoppedMs = Date.now()
    }
  })

  lkSession.on('agent_state_changed', (ev: any) => {
    if (sessionReadyMs == null) {
      sessionReadyMs = Date.now()
    }

    const wasSpeaking = agentSpeaking
    agentSpeaking = ev.newState === 'speaking'

    if (agentSpeaking && !wasSpeaking) {
      if (firstSpeechMs == null) {
        firstSpeechMs = Date.now() - sessionReadyMs
      }
      if (userStoppedMs != null) {
        responseTimes.push({
          ms: Date.now() - userStoppedMs,
          afterTurnIndex: turnIndex++,
          speaker: 'agent',
        })
        userStoppedMs = undefined
      }
    }
  })

  return {
    getResponseTimes: () => [...responseTimes],
    getTimeToFirstSpeech: () => firstSpeechMs,
  }
}

// ---------------------------------------------------------------------------
// Main case runner
// ---------------------------------------------------------------------------

export async function runVoiceCase<S extends StateSchema>(
  evalCase: VoiceEvalCase<S>,
  options: VoiceEvalOptions<S> & { room: VoiceRoomConfig },
  writer?: CaseWriter,
  recordingDir?: string,
  appContext?: LiveVoiceAppContext<S>,
): Promise<VoiceRunResult<S>> {
  if (evalCase.backend) {
    if (!appContext) throw new Error('Live voice evals require app.evaluate.voice')
    const { runLiveVoiceCase } = require('./live-runner') as typeof import('./live-runner')
    return runLiveVoiceCase(evalCase, options, appContext, writer, recordingDir)
  }
  const startMs = Date.now()

  if (!isRealtimeConfig(evalCase.agent.model)) {
    throw new Error(
      `[adk/voice-eval] Agent "${evalCase.agent.name}" must have a realtime model config`,
    )
  }
  if (!isRealtimeConfig(evalCase.userAgent.model)) {
    throw new Error(
      `[adk/voice-eval] User agent "${evalCase.userAgent.name}" must have a realtime model config`,
    )
  }

  const { serverSdk, lk, rtc } = requireLiveKit()

  // --- Room config ---
  const { url, apiKey, apiSecret } = options.room
  const roomName = `voice-eval-${sanitize(evalCase.name)}-${randomUUID().slice(0, 8)}`

  const agentIdentity = `__voice-eval-agent-${sanitize(evalCase.name)}`
  const userIdentity = `__voice-eval-user-${sanitize(evalCase.name)}`
  const recorderIdentity = `__voice-eval-recorder`

  // --- Create room ---
  const svc = new serverSdk.RoomServiceClient(url, apiKey, apiSecret)
  await svc.createRoom({
    name: roomName,
    emptyTimeout: 120,
    departureTimeout: 30,
  })

  let recorder: RecorderHandle | undefined
  let agentRoom: any
  let userRoom: any
  let status: VoiceRunStatus = 'completed'
  let error: { message: string; stack?: string } | undefined
  let recordingPath = ''
  let usageSummary: UsageSummary | undefined
  let unbindEvalControl: (() => void) | undefined
  let timing = emptyTiming()
  const userAgentTranscript: TranscriptSource[] = []
  const agentTranscript: TranscriptSource[] = []
  let agentSpeechStartMs: number | undefined
  let agentSpeechEndMs: number | undefined
  let userSpeechStartMs: number | undefined
  let userSpeechEndMs: number | undefined
  let roomDisconnectedDuringEval = false
  const voiceEvents: Array<VoiceEvent & { createdAt: number }> = []
  let voiceEventHooks: Array<NonNullable<VoiceHook['onVoiceEvent']>> = []
  const emitVoiceEvent = (event: VoiceEvent) => {
    voiceEvents.push({ ...event, createdAt: Date.now() })
    for (const fn of voiceEventHooks) fn(event)
  }

  const session = createEvalSession() as BaseSession
  const sessionService = createEvalSessionService(session, startMs, writer, (role) =>
    role === 'agent'
      ? { startMs: agentSpeechStartMs, endMs: agentSpeechEndMs }
      : { startMs: userSpeechStartMs, endMs: userSpeechEndMs },
  )

  try {
    // --- Seed state ---
    if (evalCase.initialState) {
      seedState(session, evalCase.initialState, options.schema)
    }

    // --- Generate tokens ---
    const makeToken = async (identity: string, grants: Record<string, unknown>) => {
      const at = new serverSdk.AccessToken(apiKey, apiSecret, {
        identity,
        ttl: '5m',
      })
      at.addGrant({ room: roomName, roomJoin: true, ...grants })
      return await at.toJwt()
    }

    const [agentToken, userToken, recorderToken] = await Promise.all([
      makeToken(agentIdentity, { canPublish: true, canSubscribe: true }),
      makeToken(userIdentity, { canPublish: true, canSubscribe: true }),
      makeToken(recorderIdentity, {
        canPublish: false,
        canSubscribe: true,
        hidden: true,
      }),
    ])

    // --- Build main agent ---
    const agent = evalCase.toolMocks
      ? (interceptTools(evalCase.agent, evalCase.toolMocks) as Agent)
      : evalCase.agent

    const invocationId = `inv_voice_eval_${createEventId()}`
    const renderCtx = await buildContextAsync(session as Session, agent, invocationId)
    const instructions = renderCtx.events
      .filter(isSystemEvent)
      .map((e) => e.text)
      .join('\n')

    const lkModel = createLiveKitModel(agent.model as RealtimeModelConfig)
    const functionTools = renderCtx.functionTools

    // Lifecycle for termination coordination
    const lifecycle = createLifecycle()
    let resolveTermination!: () => void
    const terminationPromise = new Promise<void>((r) => {
      resolveTermination = r
    })
    lifecycle.onEnding(() => resolveTermination())
    let pendingOutputToolCompletion:
      | {
          toolName: string
          complete: () => void
          promise: Promise<void>
        }
      | undefined

    // Create agent LiveKit session
    const lkSession = new lk.voice.AgentSession({})
    let voiceSession!: LiveKitVoiceSession
    const forcedToolGate = createForcedToolGate({
      generateReply: (replyOptions) => voiceSession.generateReplyDirect(replyOptions),
      onVoiceEvent: emitVoiceEvent,
    })

    const waitForOutputTool = async (
      toolName: string,
      trigger: () => Promise<unknown>,
    ): Promise<void> => {
      if (pendingOutputToolCompletion?.toolName === toolName) {
        return pendingOutputToolCompletion.promise
      }

      const completion = createOutputToolCompletion({
        intendedToolName: toolName,
        source: 'output_tool_completion',
        timeoutMs: 60_000,
        onVoiceEvent: emitVoiceEvent,
      })
      const completed = completion.wait()
      const pending = {
        toolName,
        complete: () => completion.complete(),
        promise: Promise.resolve(),
      }
      pending.promise = (async () => {
        try {
          let reply
          try {
            voiceSession.interrupt()
            reply = await forcedToolGate.forceReply(
              { toolChoice: { name: toolName } },
              () => trigger() as Promise<Awaited<ReturnType<typeof voiceSession.generateReply>>>,
              'output_tool_completion',
            )
          } catch (err) {
            throw completion.fail(
              err instanceof ForcedToolCallError && err.reason !== 'generation_failed'
                ? 'forced_tool'
                : 'generation',
              err,
            )
          }
          await completed
          voiceSession.interrupt()
          void getVoiceReplyPlayout(reply)?.catch(() => {})
        } catch (err) {
          if (err instanceof OutputToolCompletionError) throw err
          throw completion.fail('tool', err)
        } finally {
          if (pendingOutputToolCompletion === pending) {
            pendingOutputToolCompletion = undefined
          }
          forcedToolGate.cancel(toolName)
        }
      })()
      pendingOutputToolCompletion = pending
      return pending.promise
    }
    let lifecycleEndRequested = false
    const requestLifecycleEnd = (finalize?: () => Promise<void>) => {
      if (lifecycleEndRequested || lifecycle.state !== 'active') return
      lifecycleEndRequested = true
      setTimeout(() => {
        void (async () => {
          try {
            await finalize?.()
          } catch (err) {
            status = 'error'
            error = {
              message: err instanceof Error ? err.message : String(err),
              stack: err instanceof Error ? err.stack : undefined,
            }
          } finally {
            lifecycle.tryEnd('completed')
          }
        })()
      }, 0)
    }

    voiceSession = new LiveKitVoiceSession(lkSession, {
      onGenerateReply: (replyOptions, generate) =>
        forcedToolGate.forceReply(replyOptions, generate),
    })

    // --- Tool timing: detect overlap between agent speech and tool execution ---
    let agentAudioActive = false
    interface ToolOverlapEntry {
      toolStartOffsetMs: number
      toolEndOffsetMs: number
      agentSpeakingAtStart: boolean
    }
    const toolOverlaps: ToolOverlapEntry[] = []
    let currentToolStartMs: number | undefined
    let currentToolAgentSpeaking = false

    const lkTools = convertTools(functionTools, () => ({
      session: session as Session,
      sessionService,
      invocationId,
      agentName: agent.name,
      agent,
      voiceSession,
      onOutput: () => {
        const pending = pendingOutputToolCompletion
        if (pending && pending.toolName === getOutputToolName(agent)) {
          pending.complete()
          return
        }
        voiceSession.interrupt()
        lifecycle.tryEnd('completed')
      },
      onEnd: requestLifecycleEnd,
      waitForOutputTool,
      forcedToolGate,
      onTransfer: async () => {
        throw new Error('[adk/voice-eval] Agent transfers are not supported in voice eval')
      },
      onToolStart: () => {
        currentToolStartMs = Date.now()
        currentToolAgentSpeaking = agentAudioActive
      },
      onToolEnd: () => {
        if (currentToolStartMs !== undefined) {
          const endMs = Date.now()
          toolOverlaps.push({
            toolStartOffsetMs: currentToolStartMs - startMs,
            toolEndOffsetMs: endMs - startMs,
            agentSpeakingAtStart: currentToolAgentSpeaking,
          })
          currentToolStartMs = undefined
        }
      },
    }))

    const onEnterFns = collectOnEnterHooks(agent.hooks, options.hooks)
    const onEnter =
      onEnterFns.length > 0
        ? async () => {
            const hookCtx: LifecycleHookContext = {
              session: session as Session,
              state: (session as Session).state,
              voice: voiceSession,
              inactivityCount: 0,
            }
            for (const fn of onEnterFns) {
              try {
                await fn(hookCtx)
              } catch (err) {
                console.warn('[adk/voice-eval] onEnter hook error:', err)
              }
            }
          }
        : undefined

    const lkAgent = createLiveKitAgent(
      agent,
      instructions,
      lkTools,
      session as Session,
      lkModel,
      onEnter,
    )

    // --- Build user agent (no tools, no ADK wiring) ---
    const userRenderCtx = await buildContextAsync(
      session as Session,
      evalCase.userAgent,
      `inv_voice_eval_user_${createEventId()}`,
    )
    const userInstructions = userRenderCtx.events
      .filter(isSystemEvent)
      .map((e) => e.text)
      .join('\n')
    const userLkModel = createLiveKitModel(evalCase.userAgent.model as RealtimeModelConfig)
    const userLkAgent = createLiveKitAgent(
      evalCase.userAgent,
      userInstructions,
      {},
      session as Session,
      userLkModel,
    )

    // --- Connect rooms + recorder in parallel ---
    agentRoom = new rtc.Room()
    userRoom = new rtc.Room()

    {
      const connects: Promise<any>[] = [
        agentRoom.connect(url, agentToken, { autoSubscribe: true }),
        userRoom.connect(url, userToken, { autoSubscribe: true }),
      ]
      if (options.output && recordingDir) {
        connects.push(
          connectRecorder(
            {
              roomUrl: url,
              token: recorderToken,
              agentIdentity,
              userIdentity,
              recordingDir,
              caseName: evalCase.name,
            },
            rtc,
          ).then((r) => {
            recorder = r
          }),
        )
      }
      await Promise.all(connects)
    }

    agentRoom.on('activeSpeakersChanged', (speakers: any[]) => {
      agentAudioActive = speakers.some(
        (s: any) => s.identity === agentRoom.localParticipant?.identity,
      )
    })

    // --- Track speech start/end times for transcript timing ---
    // Reset endMs when a new segment starts so mid-speech reads get
    // undefined (falls back to createdAt) instead of a stale value
    // from the previous segment.
    lkSession.on('agent_state_changed', (ev: any) => {
      if (ev.newState === 'speaking' && ev.oldState !== 'speaking') {
        agentSpeechStartMs = Date.now()
        agentSpeechEndMs = undefined
      } else if (ev.oldState === 'speaking' && ev.newState !== 'speaking') {
        agentSpeechEndMs = Date.now()
      }
    })
    lkSession.on('user_state_changed', (ev: any) => {
      if (ev.newState === 'speaking' && ev.oldState !== 'speaking') {
        userSpeechStartMs = Date.now()
        userSpeechEndMs = undefined
      } else if (ev.oldState === 'speaking' && ev.newState !== 'speaking') {
        userSpeechEndMs = Date.now()
      }
    })

    // --- Wire event listeners on main agent ---
    const composedHook = composeHooks([...(agent.hooks ?? []), ...(options.hooks ?? [])])
    const allHooks = [
      ...((agent.hooks ?? []) as VoiceHook[]),
      ...((options.hooks ?? []) as VoiceHook[]),
    ]
    voiceEventHooks = allHooks.map((h) => h.onVoiceEvent).filter((fn) => fn != null)
    const transcriptFns = allHooks.map((h) => h.onTranscript).filter((fn) => fn != null)
    const fireTranscriptHooks =
      transcriptFns.length > 0
        ? (event: Event, snapshotInvocationId: string) => {
            if (event.type !== 'user' && event.type !== 'assistant') return
            void (async () => {
              const run = createRunHandler({
                session: session as Session,
                sessionService,
                invocationId: snapshotInvocationId,
              })
              for (const fn of transcriptFns) {
                try {
                  await fn({
                    session: session as Session,
                    state: createStateAccessor(session as Session, snapshotInvocationId),
                    voice: voiceSession,
                    event,
                    run: run as any,
                  })
                } catch {
                  /* best-effort */
                }
              }
            })()
          }
        : undefined
    const agentState = {
      agent,
      invocationId,
      composedHook,
      composedErrorHandler: undefined as any,
      functionTools,
    }

    const tracker = wireEventListeners({
      lkSession,
      sessionService,
      session: session as Session,
      getAgentState: () => agentState,
      onVoiceEvent: emitVoiceEvent,
      onAssistantMessage: async () => {
        const handled = await forcedToolGate.handleAssistantMessage()
        if (handled) voiceSession.interrupt()
        return handled
      },
      onTranscript: fireTranscriptHooks as any,
    })

    // Collect agent transcript with speech start times for eval reports.
    lkSession.on('conversation_item_added', (ev: any) => {
      const item = ev.item
      if (!item || item.role !== 'assistant') return
      const text = item.textContent ?? ''
      if (!text) return
      agentTranscript.push({
        text,
        createdAt: item.createdAt || Date.now(),
        speechStartMs: agentSpeechStartMs,
        speechEndMs: agentSpeechEndMs,
      })
    })

    // --- Session-level response tracking on main agent ---
    const sessionTracker = wireSessionResponseTracker(lkSession)

    // --- Start both agent sessions in parallel ---
    const userLkSession = new lk.voice.AgentSession({})

    // Agent-level timeouts and lifecycle helpers mirror the production voice handler.
    let inactivity: InactivityTimer | undefined
    let expiryTimer: ReturnType<typeof setTimeout> | undefined
    const agentTimeouts = evalCase.agent.timeouts
    const triggerOutputTool = (userInput: string) => (): Promise<void> | undefined => {
      if (lifecycle.state !== 'active') return undefined
      if (voiceSession.turnCount === 0) return undefined
      const toolName = getOutputToolName(agent)
      if (!toolName) return undefined
      return (async () => {
        const trigger = () =>
          voiceSession.generateReply({
            toolChoice: 'required',
            userInput,
            instructions: renderToolRequiredInstructions(toolName),
          })
        try {
          await waitForOutputTool(toolName, trigger)
        } catch (err) {
          status = 'error'
          error = {
            message: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
          }
          throw err
        }
      })()
    }

    const handleParticipantLeft = () => {
      if (lifecycle.state !== 'active') return
      roomDisconnectedDuringEval = true
      status = 'participant_left'
      runComposedLifecycleHook(
        allHooks,
        'onDisconnect',
        lifecycle,
        'participant_left',
        {
          session: session as Session,
          state: (session as Session).state,
          voice: voiceSession,
          inactivityCount: 0,
        },
        triggerOutputTool('*The participant disconnected*'),
        emitVoiceEvent,
      )
    }

    if (evalCase.evalControl) {
      unbindEvalControl = evalCase.evalControl.bind({
        disconnectUser: async (controlOptions) => {
          if (lifecycle.state !== 'active') return
          if (controlOptions?.mode === 'lifecycle') {
            handleParticipantLeft()
          } else {
            await userRoom.disconnect()
          }
        },
        muteUser: (muted) => userLkSession.output.setAudioEnabled(!muted),
      })
    }

    // Collect user agent's own transcript as ground truth for eval reports.
    // The user agent's `conversation_item_added` with role='assistant'
    // is what it actually spoke — more accurate than the main agent's STT.
    // Stored separately so the agent's session/context is unaffected.
    userLkSession.on('conversation_item_added', (ev: any) => {
      const item = ev.item
      if (!item || item.role !== 'assistant') return
      const text = item.textContent ?? ''
      if (!text) return
      const createdAt = item.createdAt || Date.now()
      const speechStart = userSpeechStartMs
      const speechEnd = userSpeechEndMs
      userAgentTranscript.push({
        text,
        createdAt,
        speechStartMs: speechStart,
        speechEndMs: speechEnd,
      })
      if (writer) {
        const endMs = speechEnd ?? createdAt
        const endTs = ((endMs - startMs) / 1000).toFixed(1)
        const startTs = speechStart != null ? ((speechStart - startMs) / 1000).toFixed(1) : null
        const prefix = startTs ? `${startTs}s–${endTs}s` : `${endTs}s`
        writer.appendLine(`${prefix} **user**: ${text}`)
      }
    })

    lifecycle.activate()

    await Promise.all([
      lkSession.start({ agent: lkAgent, room: agentRoom }),
      userLkSession.start({ agent: userLkAgent, room: userRoom }),
    ])

    // --- Set up timeouts ---
    const caseTimeout = evalCase.timeout ?? 300_000
    const timeoutTimer = setTimeout(() => {
      status = 'timeout'
      lifecycle.tryEnd('completed')
    }, caseTimeout)

    if (agentTimeouts?.inactivity) {
      const inactivityMs = agentTimeouts.inactivity
      const timer = createInactivityTimer({
        timeoutMs: () => inactivityMs,
        isActive: () => lifecycle.state === 'active',
        onTimeout: (inactivityCount) =>
          runComposedLifecycleHook(
            allHooks,
            'onInactivity',
            lifecycle,
            'inactivity_timeout',
            {
              session: session as Session,
              state: (session as Session).state,
              voice: voiceSession,
              inactivityCount,
            },
            () => {
              status = 'inactivity_timeout'
              return triggerOutputTool('*The session is ending due to inactivity*')?.()
            },
            emitVoiceEvent,
          ),
        emit: emitVoiceEvent,
      })
      inactivity = timer

      tracker.onUserSpeechStarted(() => {
        voiceSession.turnCount++
        timer.callerStartedSpeaking()
      })
      tracker.onUserSpeechEnded(() => timer.callerStoppedSpeaking())
      tracker.onAgentActive(() => timer.agentBecameActive())
      tracker.onAgentIdle(() => timer.agentWentIdle())
      lkSession.on('speech_created', () => timer.agentReplyCreated())
    }

    const expiryMs = agentTimeouts?.expiry ?? agentTimeouts?.maxDuration
    if (expiryMs) {
      expiryTimer = setTimeout(() => {
        if (lifecycle.state !== 'active') return
        runComposedLifecycleHook(
          allHooks,
          'onExpiry',
          lifecycle,
          'max_duration',
          {
            session: session as Session,
            state: (session as Session).state,
            voice: voiceSession,
            inactivityCount: 0,
          },
          () => {
            status = 'max_duration'
            return triggerOutputTool('*The session time limit has been reached*')?.()
          },
          emitVoiceEvent,
        )
      }, expiryMs)
    }

    // Room disconnect handling
    agentRoom.on('disconnected', () => {
      if (lifecycle.state === 'active') {
        roomDisconnectedDuringEval = true
        status = 'disconnected'
        lifecycle.tryEnd('disconnected')
      }
    })
    agentRoom.on('participantDisconnected', (participant: any) => {
      if (participant.identity === userIdentity && lifecycle.state === 'active') {
        handleParticipantLeft()
      }
    })

    // --- Wait for termination ---
    await terminationPromise

    // Cleanup timers
    clearTimeout(timeoutTimer)
    inactivity?.stop()
    if (expiryTimer) clearTimeout(expiryTimer)

    // Flush pending events
    await withTimeout(tracker.flush(), 5000)

    // Shutdown voice sessions. When the eval intentionally disconnects a participant, LiveKit may
    // already have torn down RoomIO streams; final room disconnect/delete below owns cleanup.
    if (!roomDisconnectedDuringEval) {
      try {
        await withTimeout(lkSession.close(), 5000)
      } catch {
        /* ignore — WritableStream may already be closed */
      }
      try {
        await withTimeout(userLkSession.close(), 5000)
      } catch {
        /* ignore */
      }
    }

    // --- Collect results ---
    if (recorder) {
      recordingPath = await withTimeout(recorder.stop(), 5000)
      const roomTiming = recorder.tracker.finalize()
      timing = {
        ...roomTiming,
        responseTimes: sessionTracker.getResponseTimes(),
        timeToFirstSpeechMs:
          sessionTracker.getTimeToFirstSpeech() ?? roomTiming.timeToFirstSpeechMs,
      }
    } else {
      timing = {
        ...emptyTiming(),
        responseTimes: sessionTracker.getResponseTimes(),
        timeToFirstSpeechMs: sessionTracker.getTimeToFirstSpeech(),
      }
    }

    const usage = tracker.getUsage()
    if (usage) {
      const modelName = getModelName(agent.model) ?? usage.modelName ?? 'unknown'
      const cost =
        calculateCost(
          {
            provider: getModelProvider(agent.model),
            modelName,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cachedTokens: usage.cachedTokens,
            reasoningTokens: usage.reasoningTokens,
            audioInputTokens: usage.audioInputTokens,
            audioOutputTokens: usage.audioOutputTokens,
            audioCachedTokens: usage.audioCachedTokens,
          },
          await loadPricing(),
        ) ?? undefined
      usageSummary = {
        models: [
          {
            modelName,
            calls: usage.modelCalls,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cachedTokens: usage.cachedTokens,
            reasoningTokens: usage.reasoningTokens,
            audioInputTokens: usage.audioInputTokens,
            audioOutputTokens: usage.audioOutputTokens,
            cost,
          },
        ],
        totalInputTokens: usage.inputTokens,
        totalOutputTokens: usage.outputTokens,
        totalCachedTokens: usage.cachedTokens,
        totalReasoningTokens: usage.reasoningTokens,
        totalAudioInputTokens: usage.audioInputTokens,
        totalAudioOutputTokens: usage.audioOutputTokens,
        modelCalls: usage.modelCalls,
        cost,
      }
    }
  } catch (err) {
    status = 'error'
    error = {
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    }
    if (recorder) {
      try {
        recordingPath = await withTimeout(recorder.stop(), 5000)
      } catch {
        /* ignore */
      }
    }
  } finally {
    // --- Teardown ---
    unbindEvalControl?.()
    if (recorder) {
      try {
        await withTimeout(recorder.disconnect(), 5000)
      } catch {
        /* ignore */
      }
    }
    if (agentRoom) {
      try {
        await withTimeout(agentRoom.disconnect(), 5000)
      } catch {
        /* ignore */
      }
    }
    if (userRoom) {
      try {
        await withTimeout(userRoom.disconnect(), 5000)
      } catch {
        /* ignore */
      }
    }

    // Delete room — best-effort with timeout
    try {
      await withTimeout(svc.deleteRoom(roomName), 5000)
    } catch {
      /* best-effort — departureTimeout is the safety net */
    }
  }

  return {
    status,
    startedAtMs: startMs,
    session: session as Session<S>,
    events: session.events,
    voiceEvents,
    transcript: buildTranscript(startMs, agentTranscript, userAgentTranscript, session.events),
    timing,
    recording: { path: recordingPath },
    usage: usageSummary,
    error,
    durationMs: Date.now() - startMs,
  }
}

// ---------------------------------------------------------------------------
// Transcript builder — from session events
// ---------------------------------------------------------------------------

function buildTranscript(
  roomStartMs: number,
  agentEntries: TranscriptSource[],
  userEntries: TranscriptSource[],
  fallbackEvents: readonly Event[],
): TranscriptEntry[] {
  // Prefer transcript sources collected from conversation_item_added listeners.
  // Fall back to session events only when no source arrays are available.
  type Entry = {
    role: 'assistant' | 'user'
    text: string
    createdAt: number
    speechStartMs?: number
    speechEndMs?: number
  }
  const entries: Entry[] = []

  if (agentEntries.length) {
    for (const e of agentEntries) entries.push({ role: 'assistant', ...e })
  }

  if (userEntries.length) {
    for (const e of userEntries) entries.push({ role: 'user', ...e })
  }

  // Fall back to session events when transcript sources are empty
  if (!agentEntries.length || !userEntries.length) {
    for (const event of fallbackEvents) {
      if (event.type === 'assistant' && !agentEntries.length) {
        const text = 'text' in event ? (event.text ?? '') : ''
        if (text)
          entries.push({
            role: 'assistant',
            text,
            createdAt: event.createdAt ?? 0,
          })
      } else if (event.type === 'user' && !userEntries.length) {
        const text = 'text' in event ? (event.text ?? '') : ''
        if (text) entries.push({ role: 'user', text, createdAt: event.createdAt ?? 0 })
      }
    }
  }

  entries.sort((a, b) => (a.speechStartMs ?? a.createdAt) - (b.speechStartMs ?? b.createdAt))

  const transcript: TranscriptEntry[] = []
  let turnIndex = 0
  let lastRole: 'assistant' | 'user' | undefined

  for (const entry of entries) {
    if (lastRole && entry.role !== lastRole) turnIndex++
    lastRole = entry.role
    transcript.push({
      role: entry.role,
      text: entry.text,
      startMs: entry.speechStartMs != null ? entry.speechStartMs - roomStartMs : undefined,
      endMs:
        (entry.speechEndMs ?? entry.createdAt)
          ? (entry.speechEndMs ?? entry.createdAt) - roomStartMs
          : undefined,
      turnIndex,
    })
  }

  return transcript
}
