import type { ComposedErrorHandler } from '../errors/types'
import type { Hook } from '../hook/types'
import type { ToolCallEvent, ToolResultEvent, Event, ErrorContext } from '../types/events'
import type {
  FunctionTool as ADKFunctionTool,
  ToolContext,
  Agent as ADKAgent,
  Runnable,
  SubRunner,
} from '../types/runnables'
import type { Session, SessionService } from '../types/session'
import type { ForcedToolGate } from './forced-tool-gate'
import type { VoiceDeps } from './livekit-types'
import type { VoiceSession } from './types'

import { createStateAccessor } from '../context'
import { createEventId, MAX_TOOL_RETRY_ATTEMPTS } from '../core/constants'
import { createOrchestrationContext } from '../core/orchestration'
import {
  signalOutput,
  signalEnd,
  isOutputSignal,
  isEndSignal,
  isRunnable,
  safeParseToolArgs,
} from '../core/tools'
import { zodToToolSchema } from '../providers/zodToJsonSchema'
import { createCallId } from '../session'
import { renderToolRequiredInstructions } from './forced-tool-gate'
import { defaultVoiceDeps } from './livekit-types'

function isZodSchema(value: unknown): boolean {
  return value != null && typeof value === 'object' && ('_def' in value || '_zod' in value)
}

export interface ToolBridgeContext {
  session: Session
  sessionService: SessionService
  invocationId: string
  agentName: string
  agent: ADKAgent<any>
  voiceSession: VoiceSession
  hook?: Hook
  errorHandler?: ComposedErrorHandler
  subRunner?: SubRunner
  onOutput?: (value: unknown) => void
  onEnd?: (finalize?: () => Promise<void>) => void
  waitForOutputTool?: (toolName: string, trigger: () => Promise<unknown>) => Promise<void>
  forcedToolGate?: ForcedToolGate
  /** Build a new LiveKit Agent from the target and return llm.handoff(). */
  onTransfer?: (target: Runnable) => Promise<unknown>
  enqueueEvents?: (events: Event[]) => Promise<void>
  onToolStart?: () => void
  onToolEnd?: () => void
}

export function convertTools(
  adkTools: readonly ADKFunctionTool[],
  getBridgeCtx: () => ToolBridgeContext,
  deps: VoiceDeps = defaultVoiceDeps,
): Record<string, unknown> {
  const lk = deps.agents()
  const result: Record<string, unknown> = {}
  for (const adkTool of adkTools) {
    result[adkTool.name] = lk.llm.tool({
      description: adkTool.description,
      parameters: isZodSchema(adkTool.schema)
        ? zodToToolSchema(adkTool.name, adkTool.description, adkTool.schema).parameters
        : adkTool.schema,
      execute: createToolExecutor(adkTool, getBridgeCtx),
    })
  }
  return result
}

function createToolExecutor(tool: ADKFunctionTool, getBridgeCtx: () => ToolBridgeContext) {
  return async (args: Record<string, unknown>, lkRunCtx: unknown): Promise<unknown> => {
    const bridgeCtx = getBridgeCtx()
    const callId = createCallId()
    const waitForPlayout = extractWaitForPlayout(lkRunCtx)

    const toolCallEvent: ToolCallEvent = {
      id: createEventId(),
      type: 'tool_call',
      createdAt: Date.now(),
      invocationId: bridgeCtx.invocationId,
      agentName: bridgeCtx.agentName,
      callId,
      name: tool.name,
      args,
    }

    const parseResult = isZodSchema(tool.schema) ? safeParseToolArgs(args, tool.schema) : undefined
    let currentArgs = parseResult?.success ? (parseResult.data as Record<string, unknown>) : args
    let ctx = buildContext(bridgeCtx, tool.name, currentArgs, callId, waitForPlayout)

    const forcedToolInterception = await bridgeCtx.forcedToolGate?.interceptToolCall(toolCallEvent)
    if (forcedToolInterception) {
      await appendEvents(bridgeCtx, [toolCallEvent, forcedToolInterception.result])
      if (forcedToolInterception.afterResult) {
        setTimeout(forcedToolInterception.afterResult, 0)
      }
      return (
        forcedToolInterception.result.error ?? serializeResult(forcedToolInterception.result.result)
      )
    }

    if (bridgeCtx.hook?.beforeTool) {
      const intercepted = await bridgeCtx.hook.beforeTool(ctx, toolCallEvent)
      if (intercepted) {
        await appendEvents(bridgeCtx, [toolCallEvent, intercepted])
        return intercepted.error ?? intercepted.result
      }
    }

    if (parseResult && !parseResult.success) {
      const error = `Invalid arguments: ${parseResult.error.message}`
      bridgeCtx.forcedToolGate?.completeToolCall(tool.name, new Error(error))
      const errorEvent: ToolResultEvent = {
        id: createEventId(),
        type: 'tool_result',
        createdAt: Date.now(),
        callId,
        name: tool.name,
        error,
        invocationId: bridgeCtx.invocationId,
        agentName: bridgeCtx.agentName,
        durationMs: 0,
      }
      await appendEvents(bridgeCtx, [toolCallEvent, errorEvent])
      return `Error: ${error}`
    }

    const startMs = Date.now()

    if (tool.prepare) {
      const prepared = await tool.prepare(ctx)
      if (prepared !== undefined) {
        currentArgs = prepared as Record<string, unknown>
        ctx = buildContext(bridgeCtx, tool.name, currentArgs, callId, waitForPlayout)
      }
    }

    let attempt = 0
    let lastError: Error | undefined

    while (attempt < MAX_TOOL_RETRY_ATTEMPTS) {
      attempt++
      let result: unknown
      let error: string | undefined

      try {
        if (tool.execute) {
          if (waitForPlayout) {
            const playoutDone = waitForPlayout().catch(() => {})
            playoutDone.then(() => bridgeCtx.onToolStart?.())
            try {
              result = await tool.execute(ctx)
            } finally {
              await playoutDone
              bridgeCtx.onToolEnd?.()
            }
          } else {
            bridgeCtx.onToolStart?.()
            try {
              result = await tool.execute(ctx)
            } finally {
              bridgeCtx.onToolEnd?.()
            }
          }
        }

        bridgeCtx.forcedToolGate?.completeToolCall(tool.name)

        // Finalize on success (before control signal detection, matching text-mode
        // order for normal results; output signals and runnables skip finalize
        // just like in the text-mode runner)
        if (isOutputSignal(result)) {
          const outputValue = result.value
          const evt = makeToolResult(
            bridgeCtx,
            callId,
            tool.name,
            outputValue,
            undefined,
            Date.now() - startMs,
            true,
          )
          await appendEvents(bridgeCtx, [toolCallEvent, await applyAfterTool(bridgeCtx, ctx, evt)])
          bridgeCtx.onOutput?.(outputValue)
          return undefined
        }

        if (isEndSignal(result)) {
          const outputToolName = getOutputToolName(bridgeCtx.agent)
          const evt = makeToolResult(
            bridgeCtx,
            callId,
            tool.name,
            'Session ending',
            undefined,
            Date.now() - startMs,
          )
          await appendEvents(bridgeCtx, [toolCallEvent, await applyAfterTool(bridgeCtx, ctx, evt)])
          if (outputToolName && outputToolName !== tool.name) {
            const triggerOutputTool = () =>
              bridgeCtx.voiceSession.generateReply({
                toolChoice: 'required',
                instructions: renderToolRequiredInstructions(outputToolName),
              })
            bridgeCtx.onEnd?.(async () => {
              if (bridgeCtx.waitForOutputTool) {
                await bridgeCtx.waitForOutputTool(outputToolName, triggerOutputTool)
              } else {
                await triggerOutputTool()
              }
            })
          } else {
            bridgeCtx.onEnd?.()
          }
          return 'Session ending'
        }

        if (isRunnable(result)) {
          const target = result as Runnable
          const msg = `Transferring to agent '${target.name}'`
          const evt = makeToolResult(
            bridgeCtx,
            callId,
            tool.name,
            msg,
            undefined,
            Date.now() - startMs,
          )
          await appendEvents(bridgeCtx, [toolCallEvent, await applyAfterTool(bridgeCtx, ctx, evt)])
          if (bridgeCtx.onTransfer) {
            return await bridgeCtx.onTransfer(target)
          }
          console.warn(
            `[adk/voice] Agent transfer to '${target.name}' ` +
              'is not supported in this context. The tool result was returned as text.',
          )
          return msg
        }

        if (tool.finalize) {
          const finalized = await tool.finalize({ ...ctx, result })
          if (finalized !== undefined) result = finalized
        }

        // Normal success
        const evt = makeToolResult(
          bridgeCtx,
          callId,
          tool.name,
          result,
          undefined,
          Date.now() - startMs,
        )
        const final = await applyAfterTool(bridgeCtx, ctx, evt)
        await appendEvents(bridgeCtx, [toolCallEvent, final])
        return final.error ?? serializeResult(final.result)
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err))
        error = lastError.message
        bridgeCtx.forcedToolGate?.completeToolCall(tool.name, lastError)

        // Invoke error handler if available (retry, rate-limit, fallback, etc.)
        if (bridgeCtx.errorHandler) {
          const errorCtx: ErrorContext = {
            invocationId: bridgeCtx.invocationId,
            agent: bridgeCtx.agent,
            phase: 'tool',
            attempt,
            error: lastError,
            toolName: tool.name,
            callId,
            timestamp: Date.now(),
          }
          const recovery = await bridgeCtx.errorHandler.handle(errorCtx)

          switch (recovery.action) {
            case 'retry':
              if (recovery.delay) await sleep(recovery.delay)
              continue

            case 'fallback': {
              const evt = makeToolResult(
                bridgeCtx,
                callId,
                tool.name,
                recovery.result,
                undefined,
                Date.now() - startMs,
              )
              await appendEvents(bridgeCtx, [
                toolCallEvent,
                await applyAfterTool(bridgeCtx, ctx, evt),
              ])
              return serializeResult(recovery.result)
            }

            case 'throw':
              throw lastError

            case 'abort':
            case 'skip':
            case 'pass':
            default:
              // Fall through to return error to the model
              break
          }
        }

        // No retry — return error to the model
        const evt = makeToolResult(
          bridgeCtx,
          callId,
          tool.name,
          undefined,
          error,
          Date.now() - startMs,
        )
        await appendEvents(bridgeCtx, [toolCallEvent, await applyAfterTool(bridgeCtx, ctx, evt)])
        return `Error: ${error}`
      }
    }

    // Exhausted retry attempts
    const error = `Tool '${tool.name}' exceeded maximum retry attempts (${MAX_TOOL_RETRY_ATTEMPTS})`
    const evt = makeToolResult(bridgeCtx, callId, tool.name, undefined, error, Date.now() - startMs)
    await appendEvents(bridgeCtx, [toolCallEvent, await applyAfterTool(bridgeCtx, ctx, evt)])
    return `Error: ${error}`
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function extractWaitForPlayout(lkToolOpts: unknown): (() => Promise<void>) | undefined {
  if (!lkToolOpts || typeof lkToolOpts !== 'object') return undefined
  const opts = lkToolOpts as Record<string, unknown>
  const ctx = opts.ctx
  if (
    ctx &&
    typeof ctx === 'object' &&
    typeof (ctx as Record<string, unknown>).waitForPlayout === 'function'
  ) {
    return () => (ctx as { waitForPlayout(): Promise<void> }).waitForPlayout()
  }
  return undefined
}

// --- Helpers ---

function voiceNotSupported(method: string): never {
  throw new Error(
    `ctx.${method}() is not available in voice mode. ` +
      'Voice tools cannot orchestrate sub-agents inline. ' +
      'Return a Runnable from the tool to transfer, or use text mode for sub-agent orchestration.',
  )
}

function getOutputToolName(agent: ADKAgent<any>): string | undefined {
  const output = agent.output
  if (!output || typeof output === 'string') return undefined
  return 'name' in output ? (output as { name: string }).name : undefined
}

function buildContext(
  bridgeCtx: ToolBridgeContext,
  toolName: string,
  args: Record<string, unknown>,
  callId: string,
  waitForPlayout?: () => Promise<void>,
): ToolContext {
  const outputToolName = getOutputToolName(bridgeCtx.agent)
  const orchestration = bridgeCtx.subRunner
    ? createOrchestrationContext({
        session: bridgeCtx.session,
        sessionService: bridgeCtx.sessionService,
        invocationId: bridgeCtx.invocationId,
        subRunner: bridgeCtx.subRunner,
        callId,
      })
    : {
        run: () => voiceNotSupported('run'),
        call: () => voiceNotSupported('call'),
        spawn: () => voiceNotSupported('spawn'),
        dispatch: () => voiceNotSupported('dispatch'),
      }
  return {
    invocationId: bridgeCtx.invocationId,
    runnable: bridgeCtx.agent,
    session: bridgeCtx.session,
    sessionService: bridgeCtx.sessionService,
    state: createStateAccessor(bridgeCtx.session, bridgeCtx.invocationId),
    endInvocation: false,
    callId,
    toolName,
    args,
    voice: bridgeCtx.voiceSession,
    waitForPlayout,
    output: (value: unknown) => signalOutput(value),
    end: () => {
      if (!outputToolName)
        throw new Error('ctx.end() requires an output tool configured on the agent.')
      return signalEnd()
    },
    ...orchestration,
  } as ToolContext
}

function makeToolResult(
  bridgeCtx: ToolBridgeContext,
  callId: string,
  name: string,
  result: unknown,
  error: string | undefined,
  durationMs: number,
  output?: boolean,
): ToolResultEvent {
  return {
    id: createEventId(),
    type: 'tool_result',
    createdAt: Date.now(),
    invocationId: bridgeCtx.invocationId,
    agentName: bridgeCtx.agentName,
    callId,
    name,
    ...(error ? { error } : { result }),
    durationMs,
    ...(output && { output: true }),
  }
}

async function applyAfterTool(
  bridgeCtx: ToolBridgeContext,
  ctx: ToolContext,
  result: ToolResultEvent,
): Promise<ToolResultEvent> {
  return (await bridgeCtx.hook?.afterTool?.(ctx, result)) ?? result
}

async function appendEvents(bridgeCtx: ToolBridgeContext, events: Event[]): Promise<void> {
  if (bridgeCtx.enqueueEvents) {
    await bridgeCtx.enqueueEvents(events)
    return
  }
  for (const event of events) {
    try {
      await bridgeCtx.sessionService.appendEvent(bridgeCtx.session, event)
    } catch (err) {
      console.error('[adk/voice] Failed to append event:', err)
    }
    bridgeCtx.hook?.onEvent?.(event)
  }
}

function serializeResult(result: unknown): string | undefined {
  if (result === undefined) return undefined
  if (result === null) return ''
  if (typeof result === 'string') return result
  try {
    return JSON.stringify(result)
  } catch {
    return String(result)
  }
}
