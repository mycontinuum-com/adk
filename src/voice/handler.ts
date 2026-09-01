import type { Hook, TurnContext } from '../hook/types'
import type {
  Event,
  UserEvent,
  AssistantEvent,
  InvocationStartEvent,
  InvocationEndEvent,
  InvocationEndReason,
  ModelStartEvent,
  ModelEndEvent,
  ModelUsage,
} from '../types/events'
import type { Agent, FunctionTool, RealtimeModelConfig, Runnable } from '../types/runnables'
import type { RunResult } from '../types/runtime'
import type { StateSchema } from '../types/schema'
import type { Session, SessionService } from '../types/session'
import type {
  LKAgentSession,
  LKBackgroundAudioPlayer,
  LKPlayHandle,
  LKImports,
  VoiceDeps,
  JobContext,
} from './livekit-types'
import type {
  VoiceHandlerConfig,
  VoiceHandlerHandle,
  VoiceHook,
  VoiceParticipant,
  SessionSetup,
  LifecycleHookContext,
  TranscriptHookContext,
  LifecycleHookResult,
  VoiceEvent,
  NoiseCancellationType,
  CallTerminationConfig,
} from './types'

import { createStateAccessor } from '../context'
import { buildContextAsync } from '../context/build'
import { createEventId } from '../core/constants'
import { createInvocationContext } from '../core/ctx'
import { createRunHandler } from '../core/orchestration'
import { BaseRunner } from '../core/runner'
import { isRunnable } from '../core/tools'
import { composeErrorHandlers } from '../errors/compose'
import { composeHooks } from '../hook/compose'
import { isRealtimeConfig, getModelName } from '../providers/models'
import { calculateCost } from '../providers/pricing'
import { seedState, BaseSession } from '../session'
import { isSystemEvent } from '../types/events'
import { applySchemaDefaults } from '../types/schema'
import {
  createForcedToolGate,
  ForcedToolCallError,
  renderToolRequiredInstructions,
} from './forced-tool-gate'
import { createLifecycle, type VoiceEndReason, type LifecycleStateMachine } from './lifecycle'
import { createLiveKitAgent } from './livekit-agent'
import { createLiveKitModel } from './livekit-model'
import { convertTools, type ToolBridgeContext } from './livekit-tools'
import { defaultVoiceDeps } from './livekit-types'
import { createOutputToolCompletion, OutputToolCompletionError } from './output-tool-completion'
import { startRecordingSession, type RecordingSession } from './recording'
import { LiveKitVoiceSession } from './session'

function noopThinkingSound(): void {}

const OUTPUT_TOOL_COMPLETION_TIMEOUT_MS = 60_000

function getVoiceReplyPlayout(reply: unknown): Promise<void> | undefined {
  if (!reply || typeof reply !== 'object') return
  const waitForPlayout = (reply as { waitForPlayout?: unknown }).waitForPlayout
  if (typeof waitForPlayout !== 'function') return
  return waitForPlayout.call(reply)
}

/**
 * Creates a voice handler that bridges LiveKit's agent system to the ADK. Requires @livekit/agents
 * as a peer dependency.
 */
export function voiceHandler<S extends StateSchema = StateSchema>(
  config: VoiceHandlerConfig<S>,
  deps: VoiceDeps = defaultVoiceDeps,
): VoiceHandlerHandle {
  deps.agents()
  validateAgent(config.agent)

  const entryFn = createEntryFunction(config, deps)

  return {
    entry: entryFn,
    ...(config.prewarm && { prewarm: config.prewarm }),

    start(entryFile: string) {
      if (process.send) return

      const lk = deps.agents()
      const agentObj = config.agent as Agent
      lk.cli.runApp(
        new lk.ServerOptions({
          agent: entryFile,
          agentName: config.name ?? agentObj.name ?? 'adk-voice',
          jobMemoryWarnMB: 1000,
          // Milliseconds. Bounds the worker's force-kill timer for the job process, inside
          // which end-of-invocation finalization (afterTurn → completeCall) must complete on
          // teardown. 60s matches LiveKit's own default; too low silently drops completion.
          shutdownProcessTimeout: 60_000,
          ...config.worker,
        }),
      )
    },
  }
}

// --- Mutable agent state — shared across the session, updated on transfer ---

interface AgentState {
  agent: Agent<any>
  invocationId: string
  composedHook: Hook
  composedErrorHandler: import('../errors/types').ComposedErrorHandler
  functionTools: readonly FunctionTool[]
}

// --- Entry function factory ---

function createEntryFunction<S extends StateSchema>(
  config: VoiceHandlerConfig<S>,
  deps: VoiceDeps,
): (ctx: unknown) => Promise<void> {
  return async (rawCtx: unknown) => {
    if (!config.sessionService) {
      throw new Error('sessionService is required. Pass it or use app.handler.voice().')
    }

    const initialAgent = validateAgent<S>(config.agent)
    const ctx = rawCtx as JobContext
    const lk = deps.agents()
    const sessionService = config.sessionService!

    // Phase 1: Connect to room and create ADK session (once for the entire call)
    const {
      session,
      sessionId,
      recordingKey,
      noiseCancellation: sessionNC,
      participantIdentity,
    } = await connectAndCreateSession(
      ctx,
      sessionService,
      config.appName,
      config.setup,
      config.schema,
    )

    // Recording: start before LiveKit session so early tracks are captured
    let recorder: RecordingSession | undefined
    if (config.recording) {
      recorder = await startRecordingSession(ctx.room, config.recording, sessionId, recordingKey)
    }

    let commitPromise: Promise<void> | undefined
    const commitOnce = (): Promise<void> => {
      if (!commitPromise) {
        commitPromise = sessionService
          .commitSession(session)
          .then(() => {})
          .catch(() => {})
      }
      return commitPromise
    }

    // Finalization must complete inside LiveKit's shutdown barrier: the worker awaits every
    // registered shutdown callback before it reports the job done and exits the process.
    // `onShutdown` starts as a commit-only backstop (covers failures during early setup) and
    // is upgraded below — once the end-of-invocation finalizer is wired — to also run the
    // afterAgent/afterTurn hooks, so finalization can't be outraced by job teardown (e.g. a
    // caller disconnect during a human transfer).
    let onShutdown: () => Promise<void> = () => commitOnce()
    ctx.addShutdownCallback(() => onShutdown())

    // --- Build initial agent components ---
    const initialInvocationId = `inv_voice_${createEventId()}`
    const {
      lkModel: initialLkModel,
      renderCtx: initialRenderCtx,
      instructions: initialInstructions,
    } = await buildAgentComponents(initialAgent as Agent, session, initialInvocationId, deps)

    // --- Create single persistent AgentSession ---
    const lkSession = new lk.voice.AgentSession({})
    let composedOnVoiceEvent: ((event: VoiceEvent) => void) | undefined
    let voiceSession!: LiveKitVoiceSession
    const forcedToolGate = createForcedToolGate({
      generateReply: (options) => voiceSession.generateReplyDirect(options),
      onVoiceEvent: (event) => composedOnVoiceEvent?.(event),
    })
    voiceSession = new LiveKitVoiceSession(lkSession, {
      onGenerateReply: (options, generate) => forcedToolGate.forceReply(options, generate),
    })

    // --- Lifecycle state machine — all shutdown paths go through tryEnd() ---
    const lifecycle = createLifecycle()

    // --- Mutable state ---
    const agentState: AgentState = {
      agent: initialAgent,
      invocationId: initialInvocationId,
      composedHook: composeHooks([...(initialAgent.hooks ?? []), ...(config.hooks ?? [])]),
      composedErrorHandler: composeErrorHandlers(
        config.errorHandlers ?? [],
        initialAgent.errorHandlers ?? [],
      ),
      functionTools: initialRenderCtx.functionTools,
    }
    const activeVoiceHooks = () => [...(agentState.agent.hooks ?? []), ...(config.hooks ?? [])]

    let invocationOutput: unknown
    let inactivityCount = 0
    let currentInactivityMs = initialAgent.timeouts?.inactivity ?? config.timeouts?.inactivity
    let inactivityTimeout: ReturnType<typeof setTimeout> | undefined

    // --- enqueueEvents with upgrade pattern ---
    let enqueueEventsFn: ((events: Event[]) => Promise<void>) | undefined
    const enqueueEvents = (events: Event[]): Promise<void> => {
      if (enqueueEventsFn) return enqueueEventsFn(events)
      return (async () => {
        for (const event of events) {
          try {
            await sessionService.appendEvent(session, event)
          } catch {
            /* best-effort */
          }
        }
      })()
    }

    // --- SubRunner for inline sub-agent orchestration from voice tools ---
    const textRunner = new BaseRunner({ sessionService, adapters: config.adapters })
    const subRunner = {
      run: async function* (subRunnable: Runnable) {
        const result = textRunner.run(subRunnable, session, {})
        for await (const event of result) yield event
        return await result
      },
    }

    // --- Forward-declare handleTransfer and thinking sound helpers ---
    let handleTransfer: (target: Runnable) => Promise<unknown>
    let startThinkingSound: () => void = noopThinkingSound
    let stopThinkingSound: () => void = noopThinkingSound
    let pendingOutputToolCompletion:
      | {
          toolName: string
          complete: () => void
          promise: Promise<void>
        }
      | undefined
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
        timeoutMs: OUTPUT_TOOL_COMPLETION_TIMEOUT_MS,
        onVoiceEvent: composedOnVoiceEvent,
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
          } catch {
            /* output completion failures are emitted through voice events */
          } finally {
            lifecycle.tryEnd('completed')
          }
        })()
      }, 0)
    }

    // --- getBridgeCtx reads from mutable agentState ---
    const getBridgeCtx = (): ToolBridgeContext => ({
      session,
      sessionService,
      invocationId: agentState.invocationId,
      agentName: agentState.agent.name,
      agent: agentState.agent as Agent,
      voiceSession,
      hook: agentState.composedHook,
      errorHandler: agentState.composedErrorHandler,
      subRunner,
      enqueueEvents,
      onOutput: (value: unknown) => {
        if (voiceSession.turnCount > 0) {
          invocationOutput = value
          const pending = pendingOutputToolCompletion
          if (pending && pending.toolName === getOutputToolName(agentState.agent)) {
            pending.complete()
            return
          }
          voiceSession.interrupt()
          lifecycle.tryEnd('completed')
        }
      },
      onEnd: requestLifecycleEnd,
      waitForOutputTool,
      forcedToolGate,
      onTransfer: (target: Runnable) => handleTransfer(target),
      onToolStart: () => startThinkingSound(),
      onToolEnd: () => stopThinkingSound(),
    })

    // --- Convert initial tools and create initial LiveKit Agent ---
    const initialLkTools = convertTools(initialRenderCtx.functionTools, getBridgeCtx, deps)
    const buildOnEnter = () => async () => {
      const fns = collectOnEnterHooks(agentState.agent.hooks, config.hooks)
      if (fns.length === 0) return
      const lifecycleCtx: LifecycleHookContext = {
        session,
        state: session.state,
        voice: voiceSession,
        inactivityCount: 0,
      }
      for (const fn of fns) {
        try {
          await fn(lifecycleCtx)
        } catch {
          /* best-effort */
        }
      }
    }

    let activeLkAgent = createLiveKitAgent(
      initialAgent as Agent,
      initialInstructions,
      initialLkTools,
      session,
      initialLkModel,
      buildOnEnter(),
      deps,
    )
    // --- Compose onVoiceEvent from all hooks ---
    const voiceEventFns = [...(initialAgent.hooks ?? []), ...(config.hooks ?? [])]
      .map((h) => (h as VoiceHook).onVoiceEvent)
      .filter((fn): fn is NonNullable<typeof fn> => fn != null)
    composedOnVoiceEvent =
      voiceEventFns.length > 0
        ? (event: VoiceEvent) => {
            for (const fn of voiceEventFns) fn(event)
          }
        : undefined

    // --- Compose onTranscript from all hooks ---
    const transcriptFns = [...(initialAgent.hooks ?? []), ...(config.hooks ?? [])]
      .map((h) => (h as VoiceHook).onTranscript)
      .filter((fn): fn is NonNullable<typeof fn> => fn != null)
    const transcriptQueue = transcriptFns.length > 0 ? createEventQueue() : undefined

    const fireTranscriptHooks =
      transcriptFns.length > 0
        ? (
            event: UserEvent | AssistantEvent,
            snapshotInvocationId: string,
            _snapshotAgent: Agent,
          ) => {
            transcriptQueue!.push(async () => {
              const run = createRunHandler({
                session,
                sessionService,
                invocationId: snapshotInvocationId,
                subRunner,
              })
              const transcriptCtx: TranscriptHookContext = {
                session,
                state: createStateAccessor(session, snapshotInvocationId),
                voice: voiceSession,
                event,
                run: run as TranscriptHookContext['run'],
              }
              for (const fn of transcriptFns) {
                try {
                  await fn(transcriptCtx)
                } catch {
                  /* best-effort */
                }
              }
            })
          }
        : undefined

    // --- Wire event listeners ONCE ---
    const tracker = wireEventListeners({
      lkSession,
      sessionService,
      session,
      getAgentState: () => agentState,
      onVoiceEvent: composedOnVoiceEvent,
      onAssistantMessage: async () => {
        const handled = await forcedToolGate.handleAssistantMessage()
        if (handled) voiceSession.interrupt()
        return handled
      },
      onTranscript: fireTranscriptHooks,
    })
    tracker.resetUsage(getModelName(initialAgent.model))

    // --- Shared helpers for agent switching ---
    const switchToAgent = async (target: Runnable) => {
      const newAgent = validateAgent<S>(target as Runnable<S>)
      const newInvocationId = `inv_voice_${createEventId()}`
      const { lkModel, renderCtx, instructions } = await buildAgentComponents(
        newAgent as Agent,
        session,
        newInvocationId,
        deps,
      )
      const newLkTools = convertTools(renderCtx.functionTools, getBridgeCtx, deps)

      agentState.agent = newAgent
      agentState.invocationId = newInvocationId
      agentState.composedHook = composeHooks([...(newAgent.hooks ?? []), ...(config.hooks ?? [])])
      agentState.composedErrorHandler = composeErrorHandlers(
        config.errorHandlers ?? [],
        newAgent.errorHandlers ?? [],
      )
      agentState.functionTools = renderCtx.functionTools
      tracker.resetUsage(getModelName(newAgent.model))
      currentInactivityMs = newAgent.timeouts?.inactivity ?? config.timeouts?.inactivity

      const newLkAgent = createLiveKitAgent(
        newAgent as Agent,
        instructions,
        newLkTools,
        session,
        lkModel,
        buildOnEnter(),
        deps,
      )
      return newLkAgent
    }

    const runEndOfInvocationHooks = async (
      reason: VoiceEndReason,
      usage: AggregatedUsage | undefined,
      transferTarget: Runnable | undefined,
    ) => {
      let effectiveOutput = invocationOutput
      if (agentState.composedHook.afterAgent) {
        try {
          const invCtx = createInvocationContext(
            session,
            sessionService,
            agentState.invocationId,
            agentState.agent,
          )
          const modified = await agentState.composedHook.afterAgent(invCtx, invocationOutput)
          if (modified !== undefined) effectiveOutput = modified
        } catch {
          /* best-effort */
        }
      }
      if (agentState.composedHook.afterTurn) {
        try {
          const turnCtx = buildVoiceTurnContext(
            session,
            agentState.agent,
            agentState.invocationId,
            reason,
            effectiveOutput,
            usage,
            transferTarget,
          )
          await agentState.composedHook.afterTurn(turnCtx)
        } catch {
          /* best-effort */
        }
      }
    }

    // Run the terminal end-of-invocation finalization (emit invocation_end + afterAgent/
    // afterTurn hooks) exactly once. Invoked from both the normal post-sessionDone path and
    // the shutdown barrier, so whichever fires first wins and the other is a no-op — this
    // guarantees finalization runs before the worker exits, without ever running twice.
    let finalizePromise: Promise<void> | undefined
    const finalizeInvocationOnce = (): Promise<void> => {
      if (!finalizePromise) {
        finalizePromise = (async () => {
          try {
            await tracker.flush()
          } catch {
            /* best-effort */
          }
          const endReason = lifecycle.endReason
          const invocationEndEvent = makeInvocationEnd(
            agentState.invocationId,
            agentState.agent.name,
            endReason,
          )
          try {
            await sessionService.appendEvent(session, invocationEndEvent)
            agentState.composedHook.onEvent?.(invocationEndEvent)
          } catch {
            /* best-effort */
          }
          await runEndOfInvocationHooks(endReason, tracker.getUsage(), undefined)
        })()
      }
      return finalizePromise
    }

    // Upgrade the shutdown backstop now that the finalizer exists: run the hooks, then commit.
    onShutdown = async () => {
      try {
        await finalizeInvocationOnce()
      } finally {
        await commitOnce()
      }
    }

    // Upgrade enqueueEvents to use the serialised tracker queue
    enqueueEventsFn = (events: Event[]) => {
      return tracker.queue.push(async () => {
        for (const event of events) {
          try {
            await sessionService.appendEvent(session, event)
          } catch {
            /* best-effort */
          }
          agentState.composedHook.onEvent?.(event)
        }
      })
    }

    // --- Define handleTransfer ---
    handleTransfer = async (target: Runnable): Promise<unknown> => {
      // 1. Flush pending model_end events
      await tracker.flush()

      // 2. Emit invocation_end for outgoing agent
      const endEvent = makeInvocationEnd(
        agentState.invocationId,
        agentState.agent.name,
        'transferred',
        { invocationId: '', agentName: target.name },
      )
      await enqueueEvents([endEvent])

      // 3. Run afterAgent / afterTurn hooks for outgoing agent
      await runEndOfInvocationHooks('transferred', tracker.getUsage(), target)

      // 4. Build new agent and update state
      const newLkAgent = await switchToAgent(target)
      inactivityCount = 0
      if (inactivityTimeout) clearTimeout(inactivityTimeout)
      inactivityTimeout = undefined
      invocationOutput = undefined

      // 5. Emit invocation_start for incoming agent
      await enqueueEvents([makeInvocationStart(agentState.invocationId, agentState.agent.name)])

      // 6. Return llm.handoff() — LiveKit swaps the agent in-place
      const msg = `Transferring to agent '${target.name}'`
      return lk.llm.handoff({ agent: newLkAgent, returns: msg })
    }

    // --- Session done promise ---
    let resolveSessionDone!: () => void
    const sessionDone = new Promise<void>((resolve) => {
      resolveSessionDone = resolve
    })
    ctx.addShutdownCallback(async () => {
      resolveSessionDone()
    })
    lkSession.on('close', () => resolveSessionDone())

    let callTerminationRequested = false
    let callTerminationPromise: Promise<void> | undefined
    const terminateCallOnce = () => {
      if (!callTerminationPromise) {
        callTerminationPromise = terminateLiveKitCall({
          config: config.callTermination,
          deps,
          ctx,
          participantIdentity,
          onVoiceEvent: composedOnVoiceEvent,
        })
      }
      return callTerminationPromise
    }

    // When the state machine transitions to ending, stop the realtime session. The LiveKit job
    // shutdown and room termination are deferred until after final hooks and commit.
    lifecycle.onEnding((reason) => {
      callTerminationRequested = true
      voiceSession.shutdown({ reason })
    })

    // --- Auto-trigger output tool on lifecycle events ---
    const triggerOutputTool = (userInput: string) => (): Promise<void> | undefined => {
      if (lifecycle.state !== 'active') return undefined
      if (voiceSession.turnCount === 0) return undefined
      const toolName = getOutputToolName(agentState.agent)
      if (!toolName) return undefined
      return (async () => {
        const trigger = () =>
          voiceSession.generateReply({
            toolChoice: 'required', // cant set tool name for realtime models in Q1 2026
            userInput,
            instructions: renderToolRequiredInstructions(toolName),
          })
        try {
          await waitForOutputTool(toolName, trigger)
        } catch {
          /* best-effort */
        }
      })()
    }

    // --- Room listeners ---
    const onParticipantDisconnected = () => {
      runComposedLifecycleHook(
        activeVoiceHooks(),
        'onDisconnect',
        lifecycle,
        'participant_left',
        {
          session,
          state: session.state,
          voice: voiceSession,
          inactivityCount: 0,
        },
        triggerOutputTool('*The participant disconnected*'),
        composedOnVoiceEvent,
      )
    }
    const onDisconnected = () => {
      lifecycle.tryEnd('disconnected')
    }
    if (ctx.room.on) {
      ctx.room.on('participantDisconnected', onParticipantDisconnected)
      ctx.room.on('disconnected', onDisconnected)
    }

    // --- Emit initial invocation_start ---
    const invocationStartEvent = makeInvocationStart(agentState.invocationId, agentState.agent.name)
    await sessionService.appendEvent(session, invocationStartEvent)
    agentState.composedHook.onEvent?.(invocationStartEvent)

    // --- beforeAgent hook (pre-session, may redirect to a different agent) ---
    let entryAnnouncement: string | undefined
    while (agentState.composedHook.beforeAgent) {
      const invCtx = createInvocationContext(
        session,
        sessionService,
        agentState.invocationId,
        agentState.agent,
      )
      const hookResult = await agentState.composedHook.beforeAgent(invCtx)

      if (isRunnable(hookResult)) {
        const target = hookResult as Runnable
        const endEvent = makeInvocationEnd(
          agentState.invocationId,
          agentState.agent.name,
          'transferred',
          { invocationId: '', agentName: target.name },
        )
        await sessionService.appendEvent(session, endEvent)
        agentState.composedHook.onEvent?.(endEvent)

        // Build redirected agent
        activeLkAgent = await switchToAgent(target)

        const startEvent = makeInvocationStart(agentState.invocationId, agentState.agent.name)
        await sessionService.appendEvent(session, startEvent)
        agentState.composedHook.onEvent?.(startEvent)
        continue
      }

      if (typeof hookResult === 'string') {
        // A beforeAgent hook can short-circuit the agent by returning a string to speak.
        // Defer it to the main session flow below so it shares the one start → teardown →
        // finalize path rather than running a parallel lifecycle here.
        entryAnnouncement = hookResult
      }

      break
    }

    try {
      // --- Start the LiveKit session ---
      const inputOptions: Record<string, unknown> = {
        closeOnDisconnect: false,
      }
      const ncType = sessionNC ?? config.sound?.noiseCancellation
      if (ncType) {
        inputOptions.noiseCancellation = resolveNoiseCancellation(ncType)
      }
      const startOpts: Parameters<typeof lkSession.start>[0] = {
        agent: activeLkAgent,
        room: ctx.room,
        inputOptions,
      }
      await lkSession.start(startOpts)

      // Background audio — thinking sound starts from three triggers:
      //
      //   1. speech_created (generate_reply) + SPEECH_WAIT_MS timeout —
      //      if the model hasn't started speaking within 1s, it's likely
      //      generating tool args. Fills dead air during long arg generation.
      //
      //   2. onToolStart — tool.execute() begins.
      //
      //   3. agent_state_changed → thinking — backup after tool execution.
      //
      // Stopped on state→speaking or state→listening. NOT on onToolEnd so
      // the sound bridges tool completion to follow-up speech.
      const SPEECH_WAIT_MS = 1000

      const thinkingCfg = config.sound?.backgroundAudio?.thinking
      let bgAudio: LKBackgroundAudioPlayer | undefined
      let thinkingHandle: LKPlayHandle | undefined
      let speechWaitTimer: ReturnType<typeof setTimeout> | undefined
      let cachedThinkingFrames: unknown[] | undefined

      if (lk.voice.BackgroundAudioPlayer) {
        try {
          bgAudio = new lk.voice.BackgroundAudioPlayer({})
          await bgAudio.start({ room: ctx.room })
          voiceSession.setBgAudio(bgAudio)
        } catch {
          /* best-effort */
        }
      }

      if (thinkingCfg) {
        cachedThinkingFrames = await preloadAudioFrames(lk, thinkingCfg.source)
      }

      const playThinking = () => {
        if (!bgAudio || !cachedThinkingFrames) return
        if (thinkingHandle && !thinkingHandle.done()) return
        thinkingHandle = bgAudio.play(
          {
            source: loopFrames(cachedThinkingFrames),
            volume: thinkingCfg!.volume ?? 1,
          },
          false,
        )
      }

      const stopThinking = () => {
        thinkingHandle?.stop()
        thinkingHandle = undefined
      }

      const cancelSpeechWait = () => {
        if (speechWaitTimer) {
          clearTimeout(speechWaitTimer)
          speechWaitTimer = undefined
        }
      }

      lkSession.on('agent_state_changed', (ev: any) => {
        if (ev.newState === 'speaking' || ev.newState === 'listening') {
          cancelSpeechWait()
          stopThinking()
        } else if (ev.newState === 'thinking') {
          cancelSpeechWait()
          playThinking()
        }
      })

      lkSession.on('speech_created', (ev: any) => {
        composedOnVoiceEvent?.({
          type: 'speech_created',
          source: ev.source ?? 'unknown',
        })
        if (ev.source === 'generate_reply') {
          cancelSpeechWait()
          speechWaitTimer = setTimeout(() => {
            speechWaitTimer = undefined
            playThinking()
          }, SPEECH_WAIT_MS)
        }
      })

      startThinkingSound = () => {
        playThinking()
      }

      stopThinkingSound = noopThinkingSound

      lifecycle.activate()

      // A beforeAgent hook may short-circuit the agent by returning a string: speak it once
      // as an announcement, then end the call. This flows through the same teardown +
      // finalize path as any other call — no parallel lifecycle, no special finalization.
      if (entryAnnouncement !== undefined) {
        try {
          const reply = await voiceSession.generateReply({
            instructions: entryAnnouncement,
            toolChoice: 'none',
          })
          await reply.waitForPlayout()
        } catch {
          /* best-effort */
        }
        lifecycle.tryEnd('completed')
      }

      // --- Inactivity timer (event-driven, adapts on transfer) ---
      const clearInactivityTimer = (reason: string) => {
        if (!inactivityTimeout) return
        clearTimeout(inactivityTimeout)
        inactivityTimeout = undefined
        composedOnVoiceEvent?.({
          type: 'voice_activity',
          activity: 'inactivity_timer_cleared',
          reason,
        })
      }

      const startInactivityTimer = () => {
        clearInactivityTimer('restart')
        if (!currentInactivityMs) return
        if (lifecycle.state !== 'active') return
        composedOnVoiceEvent?.({
          type: 'voice_activity',
          activity: 'inactivity_timer_started',
          inactivityCount,
          timeoutMs: currentInactivityMs,
        })
        inactivityTimeout = setTimeout(() => {
          if (lifecycle.state !== 'active') return
          const count = inactivityCount++
          composedOnVoiceEvent?.({
            type: 'voice_activity',
            activity: 'inactivity_timeout_fired',
            inactivityCount: count,
            timeoutMs: currentInactivityMs,
          })
          runComposedLifecycleHook(
            activeVoiceHooks(),
            'onInactivity',
            lifecycle,
            'inactivity_timeout',
            {
              session,
              state: session.state,
              voice: voiceSession,
              inactivityCount: count,
            },
            triggerOutputTool('*The session is ending due to inactivity*'),
            composedOnVoiceEvent,
          )
          startInactivityTimer()
        }, currentInactivityMs)
      }

      tracker.onUserSpeechStarted(() => {
        voiceSession.turnCount++
        clearInactivityTimer('user_speech_started')
        inactivityCount = 0
        composedOnVoiceEvent?.({
          type: 'voice_activity',
          activity: 'user_speech_started',
          reason: 'user_speech_started',
        })
      })
      tracker.onAgentActive(() => {
        clearInactivityTimer('agent_active')
        composedOnVoiceEvent?.({
          type: 'voice_activity',
          activity: 'agent_active',
          reason: 'agent_active',
        })
      })
      tracker.onAgentIdle(() => {
        composedOnVoiceEvent?.({
          type: 'voice_activity',
          activity: 'agent_idle',
          reason: 'agent_idle',
        })
        startInactivityTimer()
      })

      // Max duration timeout — uses expiry (with maxDuration fallback)
      const expiryMs =
        initialAgent.timeouts?.expiry ??
        initialAgent.timeouts?.maxDuration ??
        config.timeouts?.expiry ??
        config.timeouts?.maxDuration
      let maxDurationTimer: ReturnType<typeof setTimeout> | undefined
      if (expiryMs) {
        maxDurationTimer = setTimeout(() => {
          runComposedLifecycleHook(
            activeVoiceHooks(),
            'onExpiry',
            lifecycle,
            'max_duration',
            {
              session,
              state: session.state,
              voice: voiceSession,
              inactivityCount: 0,
            },
            triggerOutputTool('*The session time limit has been reached*'),
            composedOnVoiceEvent,
          )
        }, expiryMs)
      }

      // --- Block until the session ends ---
      await sessionDone
      lifecycle.markEnded()

      if (maxDurationTimer) clearTimeout(maxDurationTimer)
      if (inactivityTimeout) clearTimeout(inactivityTimeout)
      cancelSpeechWait()
      stopThinking()

      // Remove room listeners
      if (ctx.room.off) {
        ctx.room.off('participantDisconnected', onParticipantDisconnected)
        ctx.room.off('disconnected', onDisconnected)
      }

      // Finalize: emit invocation_end + run afterAgent/afterTurn hooks. Idempotent and also
      // wired into the shutdown barrier, so it runs exactly once however the session ends.
      await finalizeInvocationOnce()
    } finally {
      if (transcriptQueue) {
        try {
          await Promise.race([
            transcriptQueue.drain(),
            new Promise<void>((resolve) => setTimeout(resolve, 10_000)),
          ])
        } catch {
          /* best-effort */
        }
      }
      if (recorder) {
        try {
          await recorder.stop()
        } catch {
          /* best-effort */
        }
      }
      await commitOnce()
      if (callTerminationRequested) {
        await terminateCallOnce()
      }
    }
  }
}

// --- Helpers ---

function getOutputToolName(agent: Agent): string | undefined {
  const output = agent.output
  if (!output || typeof output === 'string') return undefined
  return 'name' in output ? (output as { name: string }).name : undefined
}

function validateAgent<S extends StateSchema>(runnable: Runnable<S>): Agent<S> {
  if (runnable.kind !== 'agent') {
    throw new Error(`Voice handler requires an agent runnable, got '${runnable.kind}'.`)
  }
  const agent = runnable as Agent<S>
  if (!agent.model || !isRealtimeConfig(agent.model)) {
    throw new Error(
      'Voice handler requires a realtime model config. ' +
        'Use openai.realtime() or gemini.realtime() when defining the agent.',
    )
  }
  return agent
}

type NoiseCancellationFactory = () => unknown
interface NoiseCancellationModule {
  BackgroundVoiceCancellation: NoiseCancellationFactory
  TelephonyBackgroundVoiceCancellation: NoiseCancellationFactory
}
let _nc: NoiseCancellationModule
function getNC(): NoiseCancellationModule {
  return (_nc ??= require('@livekit/noise-cancellation-node') as NoiseCancellationModule)
}

function resolveNoiseCancellation(type: 'telephony' | 'general'): unknown {
  const nc = getNC()
  return type === 'telephony'
    ? nc.TelephonyBackgroundVoiceCancellation()
    : nc.BackgroundVoiceCancellation()
}

async function connectAndCreateSession(
  ctx: JobContext,
  sessionService: SessionService,
  agentName: string,
  setup?: (participant: VoiceParticipant) => SessionSetup | Promise<SessionSetup>,
  schema?: StateSchema,
): Promise<{
  session: Session
  sessionId: string
  recordingKey?: string
  noiseCancellation?: NoiseCancellationType
  participantIdentity?: string
}> {
  await ctx.connect()
  const participant = await ctx.waitForParticipant()

  let sessionConfig: SessionSetup
  if (setup) {
    sessionConfig = await setup(participant)
  } else {
    sessionConfig = {
      sessionId: ctx.room.name ?? `voice-${Date.now()}`,
    }
  }

  let session = await sessionService.getSession(agentName, sessionConfig.sessionId)
  if (!session) {
    session = await sessionService.createSession(agentName, {
      sessionId: sessionConfig.sessionId,
      scopes: sessionConfig.scopes,
    })
  }

  if (schema?.session) {
    session.state.update(applySchemaDefaults(sessionConfig.state ?? {}, schema.session))
  } else if (sessionConfig.state) {
    session.state.update(sessionConfig.state)
  }

  if (sessionConfig.initialState) {
    seedState(session as BaseSession, sessionConfig.initialState, schema)
  }

  return {
    session,
    sessionId: sessionConfig.sessionId,
    recordingKey: sessionConfig.recordingKey,
    noiseCancellation: sessionConfig.noiseCancellation,
    participantIdentity: participant.identity,
  }
}

interface TerminateLiveKitCallOptions {
  config: false | CallTerminationConfig | undefined
  deps: VoiceDeps
  ctx: JobContext
  participantIdentity?: string
  onVoiceEvent?: (event: VoiceEvent) => void
}

async function terminateLiveKitCall(opts: TerminateLiveKitCallOptions): Promise<void> {
  const termination = resolveCallTermination(opts.config)
  if (!termination) return

  try {
    opts.ctx.shutdown?.('Session ended')
  } catch (error) {
    opts.onVoiceEvent?.({ type: 'voice_error', error })
  }

  const roomName = opts.ctx.room.name
  if (!roomName) {
    opts.onVoiceEvent?.({
      type: 'voice_error',
      error: new Error('Cannot terminate LiveKit call: room name is unavailable.'),
    })
    return
  }

  if (termination.strategy === 'removeParticipant' && !opts.participantIdentity) {
    opts.onVoiceEvent?.({
      type: 'voice_error',
      error: new Error('Cannot remove LiveKit participant: participant identity is unavailable.'),
    })
    return
  }

  try {
    const { RoomServiceClient } = opts.deps.livekitServer()
    const client = new RoomServiceClient(
      resolveLiveKitHttpUrl(termination.livekitUrl),
      termination.apiKey ?? process.env.LIVEKIT_API_KEY ?? 'devkey',
      termination.apiSecret ?? process.env.LIVEKIT_API_SECRET ?? 'secret',
    )
    if (termination.strategy === 'removeParticipant') {
      await client.removeParticipant(roomName, opts.participantIdentity!)
    } else {
      await client.deleteRoom(roomName)
    }
  } catch (error) {
    if (isMissingRoomError(error)) return
    opts.onVoiceEvent?.({ type: 'voice_error', error })
  }
}

type ResolvedCallTermination = Required<Pick<CallTerminationConfig, 'strategy'>> &
  Omit<CallTerminationConfig, 'strategy'>

function resolveCallTermination(
  config: false | CallTerminationConfig | undefined,
): ResolvedCallTermination | false {
  if (config === false) return false
  return {
    ...config,
    strategy: config?.strategy ?? 'deleteRoom',
  }
}

function resolveLiveKitHttpUrl(configuredUrl?: string): string {
  const url = configuredUrl ?? process.env.LIVEKIT_URL ?? 'http://127.0.0.1:7880'
  if (url.startsWith('wss://')) return `https://${url.slice('wss://'.length)}`
  if (url.startsWith('ws://')) return `http://${url.slice('ws://'.length)}`
  return url
}

function isMissingRoomError(error: unknown): boolean {
  const status = getErrorStatus(error)
  if (status === 404) return true
  const message = error instanceof Error ? error.message : String(error)
  return /room.*(not found|does not exist)|not found.*room/i.test(message)
}

function getErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined
  const record = error as Record<string, unknown>
  const status = record.status ?? record.statusCode ?? record.code
  if (typeof status === 'number') return status
  if (typeof status === 'string') {
    const parsed = Number(status)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

// --- Agent component builder ---

async function buildAgentComponents(
  agent: Agent,
  session: Session,
  invocationId: string,
  deps: VoiceDeps,
) {
  const renderCtx = await buildContextAsync(session, agent, invocationId)
  const instructions = renderCtx.events
    .filter(isSystemEvent)
    .map((e) => e.text)
    .join('\n')
  const lkModel = createLiveKitModel(agent.model as RealtimeModelConfig, deps)
  return { lkModel, renderCtx, instructions }
}

// --- Event queue — single serialization point for all event writes ---

interface EventQueue {
  push(fn: () => Promise<void>): Promise<void>
  drain(): Promise<void>
}

function createEventQueue(): EventQueue {
  let chain = Promise.resolve()
  return {
    push(fn) {
      const task = chain.then(fn)
      chain = task.then(
        () => {},
        () => {},
      )
      return task
    },
    drain() {
      return chain
    },
  }
}

// --- Event listener wiring ---

interface AggregatedUsage {
  modelName?: string
  modelCalls: number
  inputTokens: number
  outputTokens: number
  cachedTokens: number
  reasoningTokens: number
  audioInputTokens: number
  audioOutputTokens: number
  audioCachedTokens: number
}

interface EventTracker {
  queue: EventQueue
  getUsage(): AggregatedUsage | undefined
  flush(): Promise<void>
  resetUsage(modelName?: string): void
  onUserSpeechStarted(cb: () => void): void
  onAgentActive(cb: () => void): void
  onAgentIdle(cb: () => void): void
}

/** @internal Exported for testing only. */
export function wireEventListeners(opts: {
  lkSession: LKAgentSession
  sessionService: SessionService
  session: Session
  getAgentState: () => AgentState
  onVoiceEvent?: (event: VoiceEvent) => void
  onAssistantMessage?: (text: string) => Promise<boolean>
  onTranscript?: (event: UserEvent | AssistantEvent, invocationId: string, agent: Agent) => void
}): EventTracker {
  const {
    lkSession,
    sessionService,
    session,
    getAgentState,
    onVoiceEvent,
    onAssistantMessage,
    onTranscript,
  } = opts
  const queue = createEventQueue()
  const turnUsage = new Map<number, ModelUsage>()
  let hasMetrics = false
  const aggregated: AggregatedUsage = {
    modelCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    reasoningTokens: 0,
    audioInputTokens: 0,
    audioOutputTokens: 0,
    audioCachedTokens: 0,
  }
  let modelStartTime: number | undefined
  let turnInProgress = false
  const userSpeechStartedCallbacks: Array<() => void> = []
  const agentActiveCallbacks: Array<() => void> = []
  const agentIdleCallbacks: Array<() => void> = []
  let turnIndex = 0

  function parseUsage(m: any): ModelUsage {
    const { agent } = getAgentState()
    const modelName = agent.model ? getModelName(agent.model) : undefined
    return {
      modelName,
      inputTokens: m.inputTokens ?? 0,
      outputTokens: m.outputTokens ?? 0,
      ...(m.inputTokenDetails?.cachedTokens != null && {
        cachedTokens: m.inputTokenDetails.cachedTokens,
      }),
      ...(m.inputTokenDetails?.audioTokens != null && {
        audioInputTokens: m.inputTokenDetails.audioTokens,
      }),
      ...(m.outputTokenDetails?.audioTokens != null && {
        audioOutputTokens: m.outputTokenDetails.audioTokens,
      }),
      ...(m.outputTokenDetails?.reasoningTokens != null && {
        reasoningTokens: m.outputTokenDetails.reasoningTokens,
      }),
      ...(m.inputTokenDetails?.cachedTokensDetails?.audioTokens != null && {
        audioCachedTokens: m.inputTokenDetails.cachedTokensDetails.audioTokens,
      }),
    }
  }

  function addToAggregated(usage: ModelUsage) {
    hasMetrics = true
    aggregated.modelCalls++
    aggregated.inputTokens += usage.inputTokens
    aggregated.outputTokens += usage.outputTokens
    aggregated.cachedTokens += usage.cachedTokens ?? 0
    aggregated.reasoningTokens += usage.reasoningTokens ?? 0
    aggregated.audioInputTokens += usage.audioInputTokens ?? 0
    aggregated.audioOutputTokens += usage.audioOutputTokens ?? 0
    aggregated.audioCachedTokens += usage.audioCachedTokens ?? 0
  }

  async function appendAndNotify(event: Event) {
    await sessionService.appendEvent(session, event)
    getAgentState().composedHook.onEvent?.(event)
  }

  async function emitModelEnd() {
    if (!turnInProgress) return
    turnInProgress = false
    const { invocationId, agent } = getAgentState()
    const event: ModelEndEvent = {
      id: createEventId(),
      type: 'model_end',
      createdAt: Date.now(),
      invocationId,
      agentName: agent.name,
      stepIndex: turnIndex,
      durationMs: modelStartTime ? Date.now() - modelStartTime : 0,
      usage: turnUsage.get(turnIndex),
      finishReason: 'stop',
    }
    await appendAndNotify(event)
    modelStartTime = undefined
    turnIndex++
  }

  function ensureTurnStarted() {
    if (!turnInProgress) {
      turnInProgress = true
      if (!modelStartTime) modelStartTime = Date.now()
    }
  }

  lkSession.on('metrics_collected', (ev: any) => {
    const m = ev.metrics
    if (m?.type !== 'realtime_model_metrics') return
    queue.push(async () => {
      ensureTurnStarted()
      const usage = parseUsage(m)
      turnUsage.set(turnIndex, usage)
      addToAggregated(usage)
      // Emit model_end immediately — metrics_collected is the authoritative
      // signal that a model turn completed, and the usage data is available now.
      // If the agent is still active (speaking), the idle transition will be a
      // no-op since turnInProgress was cleared.
      await emitModelEnd()
    })
  })

  lkSession.on('agent_state_changed', (ev: any) => {
    onVoiceEvent?.({
      type: 'agent_state',
      oldState: ev.oldState,
      newState: ev.newState,
    })
    const wasActive = ev.oldState === 'thinking' || ev.oldState === 'speaking'
    const isActive = ev.newState === 'thinking' || ev.newState === 'speaking'
    if (isActive && !wasActive) {
      for (const cb of agentActiveCallbacks) cb()
    }
    if (wasActive && !isActive) {
      for (const cb of agentIdleCallbacks) cb()
    }
    queue.push(async () => {
      try {
        if (ev.newState === 'thinking' && ev.oldState !== 'thinking') {
          await emitModelEnd()
          turnInProgress = true
          modelStartTime = Date.now()
          const { invocationId, agent, functionTools } = getAgentState()
          const event: ModelStartEvent = {
            id: createEventId(),
            type: 'model_start',
            createdAt: Date.now(),
            invocationId,
            agentName: agent.name,
            stepIndex: turnIndex,
            messageCount: 0,
            tools: functionTools.map((t) => ({
              name: t.name,
              description: t.description,
            })),
          }
          await appendAndNotify(event)
        }
        if (wasActive && !isActive) {
          await emitModelEnd()
        }
      } catch {
        /* best-effort */
      }
    })
  })

  lkSession.on('user_state_changed', (ev: any) => {
    onVoiceEvent?.({
      type: 'user_state',
      oldState: ev.oldState,
      newState: ev.newState,
    })
    if (ev.newState === 'speaking') {
      for (const cb of userSpeechStartedCallbacks) cb()
    }
  })

  lkSession.on('conversation_item_added', (ev: any) => {
    const { invocationId, agent } = getAgentState()
    queue.push(async () => {
      try {
        const item = ev.item
        if (!item) return

        const spokenAt: number = item.createdAt || Date.now()

        if (item.role === 'user') {
          const event: UserEvent = {
            id: createEventId(),
            type: 'user',
            createdAt: spokenAt,
            text: item.textContent ?? '',
            source: 'transcript',
          }
          await appendAndNotify(event)
          onTranscript?.(event, invocationId, agent)
        } else if (item.role === 'assistant') {
          const text = item.textContent ?? ''
          if (text && (await onAssistantMessage?.(text))) return
          const event: AssistantEvent = {
            id: createEventId(),
            type: 'assistant',
            createdAt: spokenAt,
            invocationId,
            agentName: agent.name,
            text,
            source: 'transcript',
          }
          await appendAndNotify(event)
          onTranscript?.(event, invocationId, agent)
        }
      } catch {
        /* best-effort */
      }
    })
  })

  lkSession.on('error', (ev: any) => {
    onVoiceEvent?.({ type: 'voice_error', error: ev.error })
  })

  return {
    queue,
    getUsage: () => (hasMetrics ? { ...aggregated } : undefined),
    flush: async () => {
      await queue.push(async () => {
        await emitModelEnd()
      })
    },
    resetUsage(modelName?: string) {
      hasMetrics = false
      aggregated.modelName = modelName
      aggregated.modelCalls = 0
      aggregated.inputTokens = 0
      aggregated.outputTokens = 0
      aggregated.cachedTokens = 0
      aggregated.reasoningTokens = 0
      aggregated.audioInputTokens = 0
      aggregated.audioOutputTokens = 0
      aggregated.audioCachedTokens = 0
      turnUsage.clear()
      turnIndex = 0
      modelStartTime = undefined
      turnInProgress = false
    },
    onUserSpeechStarted: (cb) => {
      userSpeechStartedCallbacks.push(cb)
    },
    onAgentActive: (cb) => {
      agentActiveCallbacks.push(cb)
    },
    onAgentIdle: (cb) => {
      agentIdleCallbacks.push(cb)
    },
  }
}

// --- Invocation event factories ---

function makeInvocationStart(invocationId: string, agentName: string): InvocationStartEvent {
  return {
    id: createEventId(),
    type: 'invocation_start',
    createdAt: Date.now(),
    invocationId,
    agentName,
    kind: 'agent',
  }
}

function makeInvocationEnd(
  invocationId: string,
  agentName: string,
  reason: InvocationEndReason,
  handoffTarget?: { invocationId: string; agentName: string },
): InvocationEndEvent {
  return {
    id: createEventId(),
    type: 'invocation_end',
    createdAt: Date.now(),
    invocationId,
    agentName,
    kind: 'agent',
    reason,
    ...(handoffTarget && { handoffTarget }),
  }
}

// --- Lifecycle hook helper ---

/** @internal Exported for eval runner. */
export function collectOnEnterHooks(
  agentHooks: readonly import('../hook/types').Hook<any>[] | undefined,
  handlerHooks: VoiceHook<any>[] | undefined,
): ((ctx: LifecycleHookContext) => void | Promise<void>)[] {
  const fns: ((ctx: LifecycleHookContext) => void | Promise<void>)[] = []
  if (agentHooks) {
    for (const h of agentHooks) {
      if ((h as VoiceHook).onEnter) fns.push((h as VoiceHook).onEnter!)
    }
  }
  if (handlerHooks) {
    for (const h of handlerHooks) {
      if (h.onEnter) fns.push(h.onEnter)
    }
  }
  return fns
}

type LifecycleHookName = 'onInactivity' | 'onExpiry' | 'onDisconnect'

/**
 * Runs all lifecycle hooks of the given name from the VoiceHook[] array. Hooks run in order. If ANY
 * hook returns `false`, the session stays alive (any hook can veto the end). If no hooks define the
 * callback, the session ends immediately with the given reason.
 *
 * If `beforeEnd` is provided, it runs after hooks but before `lifecycle.tryEnd`. Used to
 * auto-trigger the agent's output tool on termination when the user engaged.
 */
export function runComposedLifecycleHook(
  hooks: VoiceHook<any>[] | undefined,
  hookName: LifecycleHookName,
  lifecycle: LifecycleStateMachine,
  reason: VoiceEndReason,
  hookCtx: LifecycleHookContext,
  beforeEnd?: () => Promise<void> | undefined,
  onVoiceEvent?: (event: VoiceEvent) => void,
): void {
  const fns = hooks?.map((h) => h[hookName]).filter(Boolean) as
    | ((ctx: LifecycleHookContext) => LifecycleHookResult)[]
    | undefined

  const emitHookStarted = (hookCount: number) =>
    onVoiceEvent?.({
      type: 'lifecycle_hook_started',
      hookName,
      reason,
      inactivityCount: hookCtx.inactivityCount,
      hookCount,
    })
  const emitBeforeEndStarted = () =>
    onVoiceEvent?.({
      type: 'lifecycle_before_end_started',
      hookName,
      reason,
      inactivityCount: hookCtx.inactivityCount,
    })
  const emitBeforeEndCompleted = () =>
    onVoiceEvent?.({
      type: 'lifecycle_before_end_completed',
      hookName,
      reason,
      inactivityCount: hookCtx.inactivityCount,
    })
  const emitBeforeEndFailed = (err: unknown) => {
    const error = err instanceof Error ? err : new Error(String(err))
    onVoiceEvent?.({
      type: 'lifecycle_before_end_failed',
      hookName,
      reason,
      inactivityCount: hookCtx.inactivityCount,
      errorName: error.name,
      errorMessage: error.message,
    })
  }
  const emitHookCompleted = (result: 'keep_alive' | 'end') =>
    onVoiceEvent?.({
      type: 'lifecycle_hook_completed',
      hookName,
      reason,
      inactivityCount: hookCtx.inactivityCount,
      result,
    })
  const runBeforeEnd = (): Promise<void> | undefined => {
    if (!beforeEnd) return
    try {
      const pending = beforeEnd()
      if (!pending) return
      emitBeforeEndStarted()
      return pending.then(
        () => {
          emitBeforeEndCompleted()
        },
        (err) => {
          emitBeforeEndFailed(err)
        },
      )
    } catch (err) {
      emitBeforeEndStarted()
      emitBeforeEndFailed(err)
      return
    }
  }

  if (!fns || fns.length === 0) {
    if (lifecycle.state !== 'active') return
    emitHookStarted(0)
    emitHookCompleted('end')
    const pending = runBeforeEnd()
    if (pending) {
      pending.then(() => lifecycle.tryEnd(reason))
    } else {
      lifecycle.tryEnd(reason)
    }
    return
  }

  ;(async () => {
    let keepAlive = false
    emitHookStarted(fns.length)
    for (const fn of fns) {
      try {
        const result = await fn(hookCtx)
        if (result === false) keepAlive = true
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err))
        onVoiceEvent?.({
          type: 'lifecycle_hook_failed',
          hookName,
          reason,
          inactivityCount: hookCtx.inactivityCount,
          errorName: error.name,
          errorMessage: error.message,
        })
      }
    }
    emitHookCompleted(keepAlive ? 'keep_alive' : 'end')
    if (!keepAlive) {
      if (lifecycle.state !== 'active') return
      await runBeforeEnd()
      lifecycle.tryEnd(reason)
    }
  })()
}

// --- Audio preloading ---

async function preloadAudioFrames(lk: LKImports, source: string): Promise<unknown[] | undefined> {
  try {
    const frames: unknown[] = []
    for await (const frame of lk.audioFramesFromFile(source)) {
      frames.push(frame)
    }
    return frames.length > 0 ? frames : undefined
  } catch {
    return undefined
  }
}

async function* loopFrames(frames: readonly unknown[]): AsyncGenerator<unknown> {
  while (true) {
    for (const frame of frames) {
      yield frame
    }
  }
}

// --- afterTurn helper ---

function buildVoiceTurnContext<S extends StateSchema>(
  session: Session,
  agent: Agent<S>,
  invocationId: string,
  endReason: VoiceEndReason,
  invocationOutput: unknown,
  usage: AggregatedUsage | undefined,
  transferTarget: Runnable | undefined,
): TurnContext {
  const costEstimate = usage ? calculateCost(usage) : null

  const base = {
    runnable: agent as Runnable<any>,
    session,
    state: session.state,
    iterations: 1,
    output: { value: invocationOutput, items: [] as const },
    ...(usage && {
      usage: {
        models: [
          {
            modelName: usage.modelName ?? 'unknown',
            calls: usage.modelCalls,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cachedTokens: usage.cachedTokens,
            reasoningTokens: usage.reasoningTokens,
            audioInputTokens: usage.audioInputTokens,
            audioOutputTokens: usage.audioOutputTokens,
            ...(costEstimate && { cost: costEstimate }),
          },
        ],
        totalInputTokens: usage.inputTokens,
        totalOutputTokens: usage.outputTokens,
        totalCachedTokens: usage.cachedTokens,
        totalReasoningTokens: usage.reasoningTokens,
        totalAudioInputTokens: usage.audioInputTokens,
        totalAudioOutputTokens: usage.audioOutputTokens,
        modelCalls: usage.modelCalls,
        ...(costEstimate && { cost: costEstimate }),
      },
    }),
  }

  let result: RunResult
  if (endReason === 'transferred') {
    result = {
      ...base,
      status: 'transferred',
      transfer: { invocationId: '', agent: transferTarget! },
    }
  } else {
    result = { ...base, status: endReason } as RunResult
  }
  return {
    session,
    state: session.state,
    result,
    runnable: agent as Runnable<any>,
  }
}
