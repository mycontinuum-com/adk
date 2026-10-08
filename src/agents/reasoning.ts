import type { EventChannel } from '../channels/types'
import type { ComposedErrorHandler, ErrorRecovery } from '../errors/types'
import type {
  Agent,
  ToolResultEvent,
  ToolResultEventBase,
  ToolCallEvent,
  ToolYieldEvent,
  ToolInputEvent,
  ToolExecutionContext,
  RunResult,
  RunResultBase,
  InvocationContext,
  ToolContext,
  AssistantEvent,
  StreamEvent,
  ErrorContext,
  InvocationOutcome,
  FunctionTool,
  Hook,
  Runnable,
  HandoffTarget,
  TransferTarget,
  ParsedOutput,
  MediaPart,
  ModelAdapter,
  ModelStepResult,
} from '../types'
import type { Session } from '../types'
import type { InternalRunConfig } from '../types/runtime'
import type { AgentRunnerConfig } from './config'

import {
  buildContext,
  createStartEvent,
  createEndEvent,
  offeredFunctionTools,
} from '../context/build'
import { DEFAULT_MAX_STEPS, MAX_TOOL_RETRY_ATTEMPTS } from '../core/constants'
import { createEventId } from '../core/constants'
import { createInvocationContext, createToolContext } from '../core/ctx'
import {
  withInvocationBoundary,
  createInvocationId,
  type InvocationBoundaryOptions,
  type ResumeContext,
} from '../core/invocation'
import { withRetry } from '../core/retry'
import { isYieldSignal, isRunnable } from '../core/tools'
import {
  isFunctionTool,
  expandMCPTools,
  partitionTools,
  isOutputSignal,
  isEndSignal,
  safeParseToolArgs,
} from '../core/tools'
import { composeErrorHandlers } from '../errors/compose'
import { OutputParseError } from '../errors/types'
import { composeHooks } from '../hook/compose'
import { createParser } from '../parser/parser'
import { getModelName, getModelProvider, getInnerModel } from '../providers/models'

function enrichToolCallsWithYieldFlag(toolCalls: ToolCallEvent[], tools: FunctionTool[]): void {
  const yieldingToolNames = new Set(tools.flatMap((t) => (t.yieldSchema ? [t.name] : [])))
  for (const toolCall of toolCalls) {
    if (yieldingToolNames.has(toolCall.name)) {
      toolCall.yields = true
    }
  }
}

interface AgentResult extends Omit<RunResultBase, 'runnable' | 'output'> {
  runnable: Agent
  outcome: InvocationOutcome | null
  yieldIndex: number
  error?: string
  output?: unknown
  yieldedTools?: ToolYieldEvent[]
  transfer?: TransferTarget
}

async function withToolTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  errorMessage: string,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined

  const timeoutPromise = new Promise<T>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(errorMessage)), timeoutMs)
  })

  try {
    return await Promise.race([promise, timeoutPromise])
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
  }
}

function textToAssistantEvent(
  text: string,
  invocationId: string,
  agentName: string,
): AssistantEvent {
  return {
    id: createEventId(),
    type: 'assistant',
    createdAt: Date.now(),
    text,
    invocationId,
    agentName,
  }
}

function getLastAssistantText(session: Session): string {
  const last = [...session.events].toReversed().find((e) => e.type === 'assistant')
  return last?.type === 'assistant' ? last.text : ''
}

interface HandleErrorResult {
  recovery: ErrorRecovery
  context: ErrorContext
}

async function handleError(
  error: Error,
  ctx: InvocationContext,
  phase: ErrorContext['phase'],
  attempt: number,
  errorHandler: ComposedErrorHandler,
  options?: { toolName?: string; callId?: string; invocationStack?: string[] },
): Promise<HandleErrorResult> {
  const errorCtx: ErrorContext = {
    invocationId: ctx.invocationId,
    agent: ctx.runnable,
    phase,
    attempt,
    error,
    toolName: options?.toolName,
    callId: options?.callId,
    invocationStack: options?.invocationStack,
    timestamp: Date.now(),
  }

  const recovery = await errorHandler.handle(errorCtx)

  return { recovery, context: errorCtx }
}

async function applyAfterTool(
  composedHook: Hook,
  toolCtx: ToolContext,
  result: ToolResultEvent,
): Promise<ToolResultEvent> {
  return (await composedHook.afterTool?.(toolCtx, result)) ?? result
}

async function* processResumedYields(
  agent: Agent,
  session: Session,
  ctx: InvocationContext,
  runnerConfig: AgentRunnerConfig,
): AsyncGenerator<StreamEvent, void> {
  const toolYields = session.events.filter(
    (e): e is ToolYieldEvent => e.type === 'tool_yield' && e.invocationId === ctx.invocationId,
  )

  for (const yieldEvent of toolYields) {
    const existingResult = session.events.find(
      (e): e is ToolResultEvent => e.type === 'tool_result' && e.callId === yieldEvent.callId,
    )
    if (existingResult) continue

    const inputEvent = session.events.find(
      (e): e is ToolInputEvent => e.type === 'tool_input' && e.callId === yieldEvent.callId,
    )
    if (!inputEvent) continue

    const toolCall = session.events.find(
      (e): e is ToolCallEvent => e.type === 'tool_call' && e.callId === yieldEvent.callId,
    )
    if (!toolCall) continue

    const tool = functionToolsOf(agent).find((t) => t.name === yieldEvent.name)
    if (!tool) continue

    const baseToolCtx = createToolContext(
      ctx,
      toolCall,
      ctx.session,
      runnerConfig.sessionService,
      runnerConfig.subRunner,
      runnerConfig.signal,
      runnerConfig.channel,
    )
    const startTime = Date.now()

    let userInput = inputEvent.input
    if (tool.yieldSchema) {
      const parsed = safeParseToolArgs(userInput, tool.yieldSchema)
      if (!parsed.success) {
        const errorResult: ToolResultEvent = {
          id: createEventId(),
          type: 'tool_result',
          createdAt: Date.now(),
          callId: yieldEvent.callId,
          name: yieldEvent.name,
          error: `Invalid input: ${parsed.error.message}`,
          durationMs: Date.now() - startTime,
          invocationId: toolCall.invocationId,
          agentName: toolCall.agentName,
          providerContext: toolCall.providerContext,
        }
        await runnerConfig.sessionService.appendEvent(session, errorResult)
        yield errorResult
        continue
      }
      userInput = parsed.data
    }

    const hookCtx: ToolExecutionContext = {
      ...baseToolCtx,
      args: yieldEvent.args,
      input: userInput,
    }

    let result: unknown
    try {
      if (tool.execute) {
        result = await tool.execute(hookCtx)
      } else {
        result = userInput
      }

      if (tool.finalize) {
        const finalizeCtx: ToolExecutionContext = { ...hookCtx, result }
        const finalized = await tool.finalize(finalizeCtx)
        if (finalized !== undefined) {
          result = finalized
        }
      }

      const resultEvent: ToolResultEvent = {
        id: createEventId(),
        type: 'tool_result',
        createdAt: Date.now(),
        callId: yieldEvent.callId,
        name: yieldEvent.name,
        result,
        durationMs: Date.now() - startTime,
        invocationId: toolCall.invocationId,
        agentName: toolCall.agentName,
        providerContext: toolCall.providerContext,
      }
      await runnerConfig.sessionService.appendEvent(session, resultEvent)
      yield resultEvent
    } catch (error) {
      const errorResult: ToolResultEvent = {
        id: createEventId(),
        type: 'tool_result',
        createdAt: Date.now(),
        callId: yieldEvent.callId,
        name: yieldEvent.name,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startTime,
        invocationId: toolCall.invocationId,
        agentName: toolCall.agentName,
        providerContext: toolCall.providerContext,
      }
      await runnerConfig.sessionService.appendEvent(session, errorResult)
      yield errorResult
    }
  }
}

interface DelegateYieldInfo {
  invocationId: string
  yieldedTools: ToolYieldEvent[]
  inputRequired?: boolean
}

interface TransferInfo {
  agent: Runnable
}

interface OutputInfo {
  value: unknown
}

interface ExecuteToolResult {
  event: ToolResultEvent
  abort?: boolean
  delegateYielded?: DelegateYieldInfo
  transfer?: TransferInfo
  outputSignal?: OutputInfo
}

function retryCountFor(attempt: number): number | undefined {
  return attempt > 1 ? attempt : undefined
}

/** Shared state for turning one tool call's outcome into its result event. */
interface ToolResultScope {
  base: ToolResultEventBase
  startTime: number
  composedHook: Hook
  toolCtx: ToolContext
}

/** Handles control-flow signals a tool can return in place of a result. */
async function resultForToolSignal(
  output: unknown,
  scope: ToolResultScope,
  attempt: number,
): Promise<ExecuteToolResult | undefined> {
  const { base, startTime, composedHook, toolCtx } = scope
  if (isOutputSignal(output)) {
    return {
      event: await applyAfterTool(composedHook, toolCtx, {
        ...base,
        result: output.value,
        output: true,
        durationMs: Date.now() - startTime,
        retryCount: retryCountFor(attempt),
      }),
      outputSignal: { value: output.value },
    }
  }

  if (isEndSignal(output)) {
    toolCtx.endInvocation = true
    return {
      event: await applyAfterTool(composedHook, toolCtx, {
        ...base,
        result: 'Session ending',
        durationMs: Date.now() - startTime,
        retryCount: retryCountFor(attempt),
      }),
    }
  }

  if (isYieldSignal(output)) {
    return {
      event: await applyAfterTool(composedHook, toolCtx, {
        ...base,
        result: { yielded: true, invocationId: output.invocationId },
        durationMs: Date.now() - startTime,
        retryCount: retryCountFor(attempt),
      }),
      delegateYielded: {
        invocationId: output.invocationId,
        yieldedTools: output.yieldedTools,
        inputRequired: output.status === 'yielded_message',
      },
    }
  }

  if (isRunnable(output)) {
    return {
      event: await applyAfterTool(composedHook, toolCtx, {
        ...base,
        result: {
          transfer: true,
          agent: output.name,
        },
        durationMs: Date.now() - startTime,
        retryCount: retryCountFor(attempt),
      }),
      transfer: {
        agent: output,
      },
    }
  }

  return undefined
}

function splitToolMedia(output: unknown): { output: unknown; media: MediaPart[] | undefined } {
  let media: MediaPart[] | undefined
  if (output && typeof output === 'object' && '__media' in output) {
    const outputWithMedia = output as {
      __media?: MediaPart[]
      [key: string]: unknown
    }
    media = outputWithMedia.__media
    const { __media: _, ...rest } = outputWithMedia
    output = rest
  }
  return { output, media }
}

async function runToolOnce(
  tool: FunctionTool,
  hookCtx: ToolExecutionContext,
  toolCtx: ToolContext,
  channel: EventChannel | undefined,
): Promise<unknown> {
  const executeTool = async () => {
    toolCtx.signal?.throwIfAborted()
    return await tool.execute!(hookCtx)
  }

  const complete = channel?.registerOperation()
  let execution = (async () => {
    try {
      return await (tool.retry ? withRetry(executeTool, tool.retry) : executeTool())
    } finally {
      complete?.()
    }
  })()

  if (tool.timeout) {
    execution = withToolTimeout(
      execution,
      tool.timeout,
      `Tool '${tool.name}' timed out after ${tool.timeout}ms`,
    )
  }

  return await execution
}

async function finalizeToolOutput(
  tool: FunctionTool,
  hookCtx: ToolExecutionContext,
  output: unknown,
): Promise<unknown> {
  if (tool.finalize) {
    const finalizeCtx: ToolExecutionContext = {
      ...hookCtx,
      result: output,
    }
    const finalized = await tool.finalize(finalizeCtx)
    if (finalized !== undefined) {
      output = finalized
    }
  }
  return output
}

/**
 * Applies the error handler's recovery for a failed tool attempt. Returns the result to report, or
 * undefined when the attempt should be retried.
 */
async function recoverFromToolError(
  lastError: Error,
  attempt: number,
  scope: ToolResultScope,
  toolCall: ToolCallEvent,
  errorHandler: ComposedErrorHandler,
): Promise<ExecuteToolResult | undefined> {
  const { base, startTime, composedHook, toolCtx } = scope
  const errorMessage = lastError.message
  const timedOut = errorMessage.includes('timed out')

  const { recovery } = await handleError(lastError, toolCtx, 'tool', attempt, errorHandler, {
    toolName: toolCall.name,
    callId: toolCall.callId,
  })

  switch (recovery.action) {
    case 'throw':
      throw lastError

    case 'abort':
      return {
        event: await applyAfterTool(composedHook, toolCtx, {
          ...base,
          error: errorMessage,
          durationMs: Date.now() - startTime,
          retryCount: retryCountFor(attempt),
          timedOut: timedOut || undefined,
        }),
        abort: true,
      }

    case 'retry':
      if (recovery.delay) {
        await sleep(recovery.delay)
      }
      return undefined

    case 'fallback':
      return {
        event: await applyAfterTool(composedHook, toolCtx, {
          ...base,
          result: recovery.result,
          durationMs: Date.now() - startTime,
          retryCount: retryCountFor(attempt),
        }),
      }

    case 'skip':
    case 'pass':
    default:
      return {
        event: await applyAfterTool(composedHook, toolCtx, {
          ...base,
          error: errorMessage,
          durationMs: Date.now() - startTime,
          retryCount: retryCountFor(attempt),
          timedOut: timedOut || undefined,
        }),
      }
  }
}

async function executeToolCall(
  toolCall: ToolCallEvent,
  agent: Agent,
  composedHook: Hook,
  toolCtx: ToolContext,
  errorHandler: ComposedErrorHandler,
  channel?: EventChannel,
): Promise<ExecuteToolResult> {
  toolCtx.signal?.throwIfAborted()
  const skipTool = await composedHook.beforeTool?.(toolCtx, toolCall)
  toolCtx.signal?.throwIfAborted()
  if (skipTool) return { event: skipTool }

  const startTime = Date.now()
  const base: ToolResultEventBase = {
    id: createEventId(),
    type: 'tool_result',
    createdAt: startTime,
    callId: toolCall.callId,
    name: toolCall.name,
    providerContext: toolCall.providerContext,
    invocationId: toolCtx.invocationId,
    agentName: agent.name,
  }
  const scope: ToolResultScope = { base, startTime, composedHook, toolCtx }

  const tool = functionToolsOf(agent).find((t) => t.name === toolCall.name)
  if (!tool) {
    return {
      event: await applyAfterTool(composedHook, toolCtx, {
        ...base,
        error: `Unknown tool: ${toolCall.name}`,
        durationMs: Date.now() - startTime,
      }),
    }
  }

  const parseResult = safeParseToolArgs(toolCall.args, tool.schema)
  if (!parseResult.success) {
    return {
      event: await applyAfterTool(composedHook, toolCtx, {
        ...base,
        error: `Invalid arguments: ${parseResult.error.message}`,
        durationMs: Date.now() - startTime,
      }),
    }
  }

  let preparedArgs = parseResult.data
  const hookCtx: ToolExecutionContext = { ...toolCtx, args: preparedArgs }

  if (tool.prepare) {
    const prepared = await tool.prepare(hookCtx)
    if (prepared !== undefined) {
      preparedArgs = prepared
      ;(hookCtx as { args: unknown }).args = preparedArgs
    }
  }

  if (!tool.execute) {
    return {
      event: await applyAfterTool(composedHook, toolCtx, {
        ...base,
        error: `Tool '${tool.name}' has no execute function`,
        durationMs: Date.now() - startTime,
      }),
    }
  }

  let attempt = 0

  while (attempt < MAX_TOOL_RETRY_ATTEMPTS) {
    toolCtx.signal?.throwIfAborted()
    attempt++

    try {
      const executed = await runToolOnce(tool, hookCtx, toolCtx, channel)

      const signalled = await resultForToolSignal(executed, scope, attempt)
      if (signalled) return signalled

      const { output, media } = splitToolMedia(await finalizeToolOutput(tool, hookCtx, executed))

      return {
        event: await applyAfterTool(composedHook, toolCtx, {
          ...base,
          result: output,
          media,
          durationMs: Date.now() - startTime,
          retryCount: retryCountFor(attempt),
        }),
      }
    } catch (error) {
      const recovered = await recoverFromToolError(
        error as Error,
        attempt,
        scope,
        toolCall,
        errorHandler,
      )
      if (recovered) return recovered
    }
  }

  return {
    event: await applyAfterTool(composedHook, toolCtx, {
      ...base,
      error: `Tool '${tool.name}' exceeded maximum retry attempts (${MAX_TOOL_RETRY_ATTEMPTS})`,
      durationMs: Date.now() - startTime,
      retryCount: attempt,
    }),
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

interface ModelStepContext {
  agent: Agent
  composedHook: Hook
  session: Session
  invocationId: string
  iterations: number
  ctx: InvocationContext
  runnerConfig: AgentRunnerConfig
  config: InternalRunConfig | undefined
  errorHandler: ComposedErrorHandler
}

interface ModelStepOutcome {
  stepResult: import('../types').ModelStepResult | null
  modelError?: string
  shouldAbort: boolean
  transfer?: TransferInfo
  synthetic?: boolean
}

async function* modelStepBesideHook(
  callModel: (signal: AbortSignal) => ReturnType<ModelAdapter['step']>,
  askHook: (signal: AbortSignal) => Promise<ModelStepResult | void> | undefined,
  signal: AbortSignal,
): AsyncGenerator<StreamEvent, { step: ModelStepResult; synthetic: boolean }> {
  const modelCall = new AbortController()
  const hookCall = new AbortController()
  const stream = callModel(AbortSignal.any([signal, modelCall.signal]))
  let next = stream.next()
  let answer = askHook(AbortSignal.any([signal, hookCall.signal]))?.then(
    (step) => ({ step: step || undefined }),
    () => ({ step: undefined }),
  )
  const heldUntilHookSettles: StreamEvent[] = []
  try {
    for (;;) {
      const settled = await (answer ? Promise.race([answer, next]) : next)
      if ('step' in settled) {
        answer = undefined
        if (settled.step) {
          modelCall.abort()
          void stream.return(settled.step).catch(() => {})
          signal.throwIfAborted()
          return { step: settled.step, synthetic: true }
        }
        yield* heldUntilHookSettles.splice(0)
      } else if (settled.done) {
        if (answer) hookCall.abort()
        yield* heldUntilHookSettles.splice(0)
        return { step: settled.value, synthetic: false }
      } else {
        if (answer) heldUntilHookSettles.push(settled.value)
        else yield settled.value
        next = stream.next()
      }
    }
  } finally {
    if (answer) hookCall.abort()
  }
}

async function* executeModelStep(
  mctx: ModelStepContext,
  renderCtx: import('../types').RenderContext,
  stepStartTime: number,
  signal: AbortSignal,
): AsyncGenerator<StreamEvent, ModelStepOutcome> {
  const { agent, composedHook, runnerConfig, ctx, errorHandler, invocationId, iterations } = mctx
  const adapter = await runnerConfig.getAdapter(agent.model)

  signal.throwIfAborted()
  // react-doctor-disable-next-line react-doctor/server-sequential-independent-await -- beforeModel hooks run only after the adapter resolves, so misconfiguration fails before hook side effects
  const skipModel = await composedHook.beforeModel?.(ctx, renderCtx)
  signal.throwIfAborted()
  if (isRunnable(skipModel)) {
    return {
      stepResult: null,
      shouldAbort: false,
      transfer: { agent: skipModel },
    }
  }
  if (skipModel) {
    return { stepResult: skipModel, shouldAbort: false, synthetic: true }
  }

  let modelAttempt = 0
  let stepResult: import('../types').ModelStepResult | null = null
  let modelError: string | undefined
  let shouldAbort = false

  while (stepResult === null && !shouldAbort) {
    signal.throwIfAborted()
    modelAttempt++
    try {
      const raced = yield* modelStepBesideHook(
        (callSignal) => adapter.step(renderCtx, getInnerModel(agent.model), callSignal),
        (hookSignal) =>
          modelAttempt === 1 ? composedHook.duringModel?.(ctx, renderCtx, hookSignal) : undefined,
        signal,
      )
      if (raced.synthetic) return { stepResult: raced.step, shouldAbort: false, synthetic: true }
      stepResult = raced.step
      if (!stepResult) {
        throw new Error('No step result from adapter')
      }
    } catch (err) {
      const { recovery } = await handleError(err as Error, ctx, 'model', modelAttempt, errorHandler)

      switch (recovery.action) {
        case 'throw': {
          const endEvent = createEndEvent({
            invocationId,
            agentName: agent.name,
            stepIndex: iterations,
            durationMs: Date.now() - stepStartTime,
            finishReason: 'error',
            error: (err as Error).message,
          })
          await runnerConfig.sessionService.appendEvent(mctx.session, endEvent)
          yield endEvent
          throw err
        }
        case 'abort':
          shouldAbort = true
          modelError = (err as Error).message
          break
        case 'retry':
          if (recovery.delay) {
            await sleep(recovery.delay)
          }
          break
        case 'skip':
        case 'pass':
        default:
          modelError = (err as Error).message
          stepResult = null
          break
      }
    }
  }

  return { stepResult, modelError, shouldAbort }
}

interface ToolExecutionResult {
  abort: boolean
  delegateYieldInfo?: DelegateYieldInfo
  transferInfo?: TransferInfo
  outputInfo?: OutputInfo
}

async function* processToolCalls(
  toolCalls: ToolCallEvent[],
  agent: Agent,
  composedHook: Hook,
  ctx: InvocationContext,
  runnerConfig: AgentRunnerConfig,
  config: InternalRunConfig | undefined,
  errorHandler: ComposedErrorHandler,
  session: Session,
): AsyncGenerator<StreamEvent, ToolExecutionResult> {
  for (const [index, toolCall] of toolCalls.entries()) {
    const toolCtx = createToolContext(
      ctx,
      toolCall,
      ctx.session,
      runnerConfig.sessionService,
      runnerConfig.subRunner,
      runnerConfig.signal,
      runnerConfig.channel,
    )
    const {
      event: resultEvent,
      abort,
      delegateYielded,
      transfer,
      outputSignal,
    } = await executeToolCall(
      toolCall,
      agent,
      composedHook,
      toolCtx,
      errorHandler,
      runnerConfig.channel,
    )

    await runnerConfig.sessionService.appendEvent(session, resultEvent)
    yield resultEvent
    config?.onStep?.([resultEvent], session, agent)

    if (delegateYielded) {
      return { abort: false, delegateYieldInfo: delegateYielded }
    }
    if (transfer || outputSignal || abort) {
      const skipped = toolCalls.slice(index + 1)
      yield* answerCutOffCalls(skipped, toolCall.name, agent, runnerConfig, config, session)
      if (abort) return { abort: true }
      return transfer
        ? { abort: false, transferInfo: transfer }
        : { abort: false, outputInfo: outputSignal }
    }
  }

  return { abort: false }
}

/**
 * Providers reject a history with a call that has no result, so the calls a turn-ending call cut
 * off are answered without being run.
 */
async function* answerCutOffCalls(
  skipped: ToolCallEvent[],
  endedBy: string,
  agent: Agent,
  runnerConfig: AgentRunnerConfig,
  config: InternalRunConfig | undefined,
  session: Session,
): AsyncGenerator<StreamEvent, void> {
  for (const call of skipped) {
    const skippedEvent: ToolResultEvent = {
      id: createEventId(),
      type: 'tool_result',
      createdAt: Date.now(),
      callId: call.callId,
      name: call.name,
      providerContext: call.providerContext,
      invocationId: call.invocationId,
      agentName: call.agentName,
      error: `Not run: ${endedBy} ended the turn first.`,
    }
    await runnerConfig.sessionService.appendEvent(session, skippedEvent)
    yield skippedEvent
    config?.onStep?.([skippedEvent], session, agent)
  }
}

interface ProcessedOutput {
  value: unknown
  parsed?: ParsedOutput
}

function processAgentOutput(
  agent: Agent,
  rawOutput: string,
  session: Session,
  invocationId: string,
): ProcessedOutput {
  if (!agent.output || !rawOutput) {
    return { value: rawOutput || undefined }
  }

  const outputConfig = agent.output

  if ('name' in outputConfig && 'description' in outputConfig) {
    return { value: rawOutput || undefined }
  }

  const state = session.boundState(invocationId)

  const dynamicState = state as Record<string, unknown>

  if (typeof outputConfig === 'string') {
    dynamicState[outputConfig] = rawOutput
    return { value: rawOutput }
  }

  if ('schema' in outputConfig) {
    const direct = createParser(outputConfig.schema, { coerceTypes: false }).parse(rawOutput)
    if (direct.success) {
      if (outputConfig.key) dynamicState[outputConfig.key] = direct.value
      return {
        value: direct.value,
        parsed: {
          value: direct.value,
          corrections: direct.corrections,
          totalScore: direct.totalScore,
        },
      }
    }

    const result = createParser(outputConfig.schema).parse(rawOutput)
    const partial = result.success ? result.value : result.partial
    const validation = outputConfig.schema.safeParse(partial)
    if (validation.success) {
      if (outputConfig.key) dynamicState[outputConfig.key] = validation.data
      return {
        value: validation.data,
        parsed: {
          value: validation.data,
          corrections: result.corrections,
          totalScore: result.totalScore,
        },
      }
    }

    throw new OutputParseError(
      rawOutput,
      outputConfig.schema,
      validation.error.issues.map((issue) => ({
        stage: 'validation',
        message: issue.message,
        path: issue.path.map(String),
      })),
      partial,
      result.corrections,
    )
  }

  dynamicState[outputConfig.key] = rawOutput
  return { value: rawOutput }
}

/** Invocation-wide values shared by every iteration of the agent loop. */
interface AgentLoopScope {
  agent: Agent
  effectiveAgent: Agent
  composedHook: Hook
  session: Session
  config: InternalRunConfig | undefined
  invocationId: string
  runnerConfig: AgentRunnerConfig
  errorHandler: ComposedErrorHandler
  ctx: InvocationContext
  mctx: ModelStepContext
  maxSteps: number
  effectiveYields: boolean
  currentYieldIndex: number
  effectiveSignal: AbortSignal
}

type IterationOutcome =
  | { type: 'continue' }
  | { type: 'break'; outcome?: InvocationOutcome }
  | { type: 'return'; result: AgentResult }

type InvocationTimeoutReason = 'max_duration' | 'inactivity_timeout'

interface InvocationTimeout {
  signal: AbortSignal
  state: { reason?: InvocationTimeoutReason; timer?: ReturnType<typeof setTimeout> }
}

// maxDuration: wall-clock timer from invocation start. Creates a child
// AbortController that fires when the timeout expires. The main loop
// checks `timeoutSignal.aborted` and maps to the correct outcome.
function armInvocationTimeout(agent: Agent, signal: AbortSignal): InvocationTimeout {
  const state: InvocationTimeout['state'] = {}
  const timeoutController = new AbortController()

  // Chain parent signal → child abort
  if (signal.aborted) {
    timeoutController.abort()
  } else {
    const onParentAbort = () => timeoutController.abort()
    signal.addEventListener('abort', onParentAbort, { once: true })
  }

  if (agent.timeouts?.maxDuration) {
    state.timer = setTimeout(() => {
      state.reason = 'max_duration'
      timeoutController.abort()
    }, agent.timeouts.maxDuration)
  }

  return { signal: timeoutController.signal, state }
}

async function withExpandedMCPTools(agent: Agent): Promise<Agent> {
  const { mcpTools } = partitionTools(agent.tools)
  if (mcpTools.length === 0) return agent
  const { functionTools, providerTools } = await expandMCPTools(agent.tools)
  return {
    ...agent,
    tools: [...functionTools, ...providerTools],
  }
}

/** Runs the beforeAgent hook; returns a result when the hook replaces the agent run. */
async function* beforeAgentResult(
  agent: Agent,
  composedHook: Hook,
  session: Session,
  config: InternalRunConfig | undefined,
  invocationId: string,
  runnerConfig: AgentRunnerConfig,
  ctx: InvocationContext,
  currentYieldIndex: number,
): AsyncGenerator<StreamEvent, AgentResult | undefined> {
  const skipAgent = await composedHook.beforeAgent?.(ctx)
  if (isRunnable(skipAgent)) {
    return {
      session,
      state: session.state,
      iterations: 0,
      runnable: agent,
      outcome: 'transferred',
      yieldIndex: currentYieldIndex,
      transfer: {
        invocationId: createInvocationId(),
        agent: skipAgent,
      },
    }
  }
  if (typeof skipAgent === 'string') {
    const skipEvent = textToAssistantEvent(skipAgent, invocationId, agent.name)
    await runnerConfig.sessionService.appendEvent(session, skipEvent)
    yield skipEvent
    config?.onStep?.([skipEvent], session, agent)
    return {
      session,
      state: session.state,
      iterations: 0,
      runnable: agent,
      outcome: 'completed',
      yieldIndex: currentYieldIndex,
    }
  }
  return undefined
}

async function* executeNonYieldingToolCalls(
  scope: AgentLoopScope,
  toolCalls: ToolCallEvent[],
): AsyncGenerator<StreamEvent, void> {
  const { agent, composedHook, session, config, runnerConfig, errorHandler, ctx } = scope
  const nonYieldingCalls: ToolCallEvent[] = toolCalls.filter((tc) => tc.yields !== true)

  for (const toolCall of nonYieldingCalls) {
    const toolCtx = createToolContext(
      ctx,
      toolCall,
      ctx.session,
      runnerConfig.sessionService,
      runnerConfig.subRunner,
      runnerConfig.signal,
      runnerConfig.channel,
    )
    // react-doctor-disable-next-line react-doctor/async-await-in-loop -- non-yielding tool calls execute and persist sequentially in model order
    const { event: resultEvent } = await executeToolCall(
      toolCall,
      agent,
      composedHook,
      toolCtx,
      errorHandler,
      runnerConfig.channel,
    )
    await runnerConfig.sessionService.appendEvent(session, resultEvent)
    yield resultEvent
    config?.onStep?.([resultEvent], session, agent)
  }
}

/** Emits a tool_yield (or an argument error) for one yielding tool call. */
async function* yieldToolCall(
  scope: AgentLoopScope,
  toolCall: ToolCallEvent,
): AsyncGenerator<StreamEvent, ToolYieldEvent | undefined> {
  const { agent, session, runnerConfig, ctx } = scope
  const tool = functionToolsOf(agent).find((t) => t.name === toolCall.name)
  if (!tool) return undefined

  const baseToolCtx = createToolContext(
    ctx,
    toolCall,
    ctx.session,
    runnerConfig.sessionService,
    runnerConfig.subRunner,
    runnerConfig.signal,
    runnerConfig.channel,
  )

  const parseResult = safeParseToolArgs(toolCall.args, tool.schema)
  if (!parseResult.success) {
    const errorResultEvent: ToolResultEvent = {
      id: createEventId(),
      type: 'tool_result',
      createdAt: Date.now(),
      callId: toolCall.callId,
      name: toolCall.name,
      error: `Invalid arguments for yielding tool '${toolCall.name}': ${parseResult.error.message}. Please retry with corrected arguments.`,
      invocationId: toolCall.invocationId,
      agentName: toolCall.agentName,
      durationMs: 0,
    }
    await runnerConfig.sessionService.appendEvent(session, errorResultEvent)
    yield errorResultEvent
    return undefined
  }

  let preparedArgs = parseResult.data
  if (tool.prepare) {
    const hookCtx: ToolExecutionContext = {
      ...baseToolCtx,
      args: preparedArgs,
    }
    const prepared = await tool.prepare(hookCtx)
    if (prepared !== undefined) {
      preparedArgs = prepared
    }
  }

  const yieldEvent: ToolYieldEvent = {
    id: createEventId(),
    type: 'tool_yield',
    createdAt: Date.now(),
    callId: toolCall.callId,
    name: toolCall.name,
    args: preparedArgs,
    invocationId: toolCall.invocationId,
    agentName: toolCall.agentName,
  }
  await runnerConfig.sessionService.appendEvent(session, yieldEvent)
  yield yieldEvent
  return yieldEvent
}

async function* runYieldingToolCalls(
  scope: AgentLoopScope,
  yieldedTools: ToolCallEvent[],
  modelToolCalls: ToolCallEvent[],
  iterations: number,
): AsyncGenerator<StreamEvent, AgentResult | undefined> {
  if (yieldedTools.length === 0) return undefined

  yield* executeNonYieldingToolCalls(scope, modelToolCalls)

  const yieldEvents: ToolYieldEvent[] = []
  for (const toolCall of yieldedTools) {
    const yieldEvent = yield* yieldToolCall(scope, toolCall)
    if (yieldEvent) yieldEvents.push(yieldEvent)
  }

  if (yieldEvents.length > 0) {
    return {
      runnable: scope.agent,
      session: scope.session,
      state: scope.session.state,
      iterations,
      outcome: 'yielded',
      yieldIndex: scope.currentYieldIndex,
      yieldedTools: yieldEvents,
    } satisfies AgentResult
  }
  return undefined
}

async function toolExecutionOutcome(
  scope: AgentLoopScope,
  toolResult: ToolExecutionResult,
  iterations: number,
): Promise<IterationOutcome | undefined> {
  const { agent, session, composedHook, ctx, currentYieldIndex } = scope
  if (toolResult.delegateYieldInfo) {
    return {
      type: 'return',
      result: {
        runnable: agent,
        session,
        state: session.state,
        iterations,
        outcome: 'yielded',
        yieldIndex: currentYieldIndex,
        yieldedTools: toolResult.delegateYieldInfo.yieldedTools,
      } satisfies AgentResult,
    }
  }

  if (toolResult.transferInfo) {
    return {
      type: 'return',
      result: {
        runnable: agent,
        session,
        state: session.state,
        iterations,
        outcome: 'transferred',
        yieldIndex: currentYieldIndex,
        transfer: {
          invocationId: createInvocationId(),
          agent: toolResult.transferInfo.agent,
        },
      } satisfies AgentResult,
    }
  }

  if (toolResult.outputInfo) {
    let output: unknown = toolResult.outputInfo.value
    const modified = await composedHook.afterAgent?.(ctx, output)
    if (modified !== undefined) output = modified
    return {
      type: 'return',
      result: {
        runnable: agent,
        session,
        state: session.state,
        iterations,
        outcome: 'completed',
        yieldIndex: currentYieldIndex,
        output,
      } satisfies AgentResult,
    }
  }

  if (toolResult.abort) {
    return { type: 'break', outcome: 'aborted' }
  }
  return undefined
}

function usageWithModelDefaults(
  stepResult: import('../types').ModelStepResult,
  agent: Agent,
): import('../types').ModelStepResult['usage'] {
  return stepResult.usage
    ? {
        ...stepResult.usage,
        provider: stepResult.usage.provider ?? getModelProvider(agent.model),
        modelName: stepResult.usage.modelName ?? getModelName(agent.model),
      }
    : undefined
}

/** Persists a completed model step, then runs or yields its tool calls. */
async function* completeModelStep(
  scope: AgentLoopScope,
  stepResult: import('../types').ModelStepResult,
  iterations: number,
  stepStartTime: number,
): AsyncGenerator<StreamEvent, IterationOutcome> {
  const { agent, composedHook, session, config, invocationId, runnerConfig, ctx, mctx } = scope

  let finalStepResult = stepResult
  const modifiedResult = await composedHook.afterModel?.(ctx, stepResult)
  if (isRunnable(modifiedResult)) {
    return {
      type: 'return',
      result: {
        session,
        state: session.state,
        iterations,
        runnable: agent,
        outcome: 'transferred',
        yieldIndex: scope.currentYieldIndex,
        transfer: {
          invocationId: createInvocationId(),
          agent: modifiedResult,
        },
      },
    }
  }
  if (modifiedResult) finalStepResult = modifiedResult

  const endEvent = createEndEvent({
    invocationId,
    agentName: agent.name,
    stepIndex: iterations,
    durationMs: Date.now() - stepStartTime,
    usage: usageWithModelDefaults(finalStepResult, agent),
    finishReason: finalStepResult.finishReason,
  })
  await runnerConfig.sessionService.appendEvent(session, endEvent)
  yield endEvent

  enrichToolCallsWithYieldFlag(finalStepResult.toolCalls, functionToolsOf(agent))

  for (const event of finalStepResult.stepEvents) {
    // react-doctor-disable-next-line react-doctor/async-await-in-loop -- step events are persisted and streamed in order
    await runnerConfig.sessionService.appendEvent(session, event)
    yield event
  }

  config?.onStep?.(finalStepResult.stepEvents, session, agent)

  if (finalStepResult.terminal) {
    if (scope.effectiveYields) {
      return {
        type: 'return',
        result: {
          runnable: agent,
          session,
          state: session.state,
          iterations,
          outcome: 'yielded',
          yieldIndex: scope.currentYieldIndex,
        } satisfies AgentResult,
      }
    }
    return { type: 'break' }
  }

  const yieldedTools = finalStepResult.toolCalls.filter((tc) => tc.yields === true)
  const yieldedResult = yield* runYieldingToolCalls(
    scope,
    yieldedTools,
    stepResult.toolCalls,
    iterations,
  )
  if (yieldedResult) return { type: 'return', result: yieldedResult }

  const toolResult = yield* processToolCalls(
    finalStepResult.toolCalls,
    mctx.agent,
    composedHook,
    ctx,
    runnerConfig,
    config,
    scope.errorHandler,
    session,
  )

  return (await toolExecutionOutcome(scope, toolResult, iterations)) ?? { type: 'continue' }
}

async function* runAgentIteration(
  scope: AgentLoopScope,
  loop: { iterations: number },
): AsyncGenerator<StreamEvent, IterationOutcome> {
  const { agent, effectiveAgent, session, invocationId, runnerConfig, mctx } = scope
  const renderCtx = buildContext(session, effectiveAgent, invocationId)
  const stepStartTime = Date.now()

  const startEvent = createStartEvent(renderCtx, loop.iterations + 1, invocationId)
  await runnerConfig.sessionService.appendEvent(session, startEvent)
  yield startEvent

  const { stepResult, modelError, shouldAbort, transfer, synthetic } = yield* executeModelStep(
    mctx,
    renderCtx,
    stepStartTime,
    scope.effectiveSignal,
  )

  if (!synthetic) {
    loop.iterations++
    mctx.iterations = loop.iterations
  }
  const iterations = loop.iterations

  if (iterations >= scope.maxSteps) {
    return { type: 'break', outcome: 'max_steps' }
  }

  if (transfer) {
    return {
      type: 'return',
      result: {
        session,
        state: session.state,
        iterations,
        runnable: agent,
        outcome: 'transferred',
        yieldIndex: scope.currentYieldIndex,
        transfer: {
          invocationId: createInvocationId(),
          agent: transfer.agent,
        },
      },
    }
  }

  if (shouldAbort || !stepResult) {
    const endEvent = createEndEvent({
      invocationId,
      agentName: agent.name,
      stepIndex: iterations,
      durationMs: Date.now() - stepStartTime,
      finishReason: 'error',
      error: modelError,
    })
    await runnerConfig.sessionService.appendEvent(session, endEvent)
    yield endEvent
    return shouldAbort ? { type: 'break', outcome: 'aborted' } : { type: 'continue' }
  }

  return yield* completeModelStep(scope, stepResult, iterations, stepStartTime)
}

function yieldBudget(
  agent: Agent,
  resumeContext: ResumeContext | undefined,
): { currentYieldIndex: number; effectiveYields: boolean; turnsExhausted: boolean } {
  const currentYieldIndex = resumeContext ? resumeContext.yieldIndex + 1 : 0
  const effectiveYields =
    agent.yields ?? ('realtime' in agent.model && agent.model.realtime === true)
  const maxTurns = agent.maxTurns ?? 100
  return {
    currentYieldIndex,
    effectiveYields,
    turnsExhausted: effectiveYields && currentYieldIndex >= maxTurns,
  }
}

async function finalAgentOutput(
  agent: Agent,
  composedHook: Hook,
  session: Session,
  invocationId: string,
  ctx: InvocationContext,
): Promise<unknown> {
  const finalOutput = getLastAssistantText(session)
  const hookResult = await composedHook.afterAgent?.(ctx, finalOutput)

  if (hookResult !== undefined && typeof hookResult !== 'string') {
    return hookResult
  }
  const rawOutput = typeof hookResult === 'string' ? hookResult : finalOutput
  return processAgentOutput(agent, rawOutput, session, invocationId).value
}

async function* executeAgentLoop(
  agent: Agent,
  composedHook: Hook,
  session: Session,
  config: InternalRunConfig | undefined,
  signal: AbortSignal,
  invocationId: string,
  parentInvocationId: string | undefined,
  runnerConfig: AgentRunnerConfig,
  errorHandler: ComposedErrorHandler,
  resumeContext?: ResumeContext,
): AsyncGenerator<StreamEvent, AgentResult> {
  const maxSteps = agent.maxSteps ?? DEFAULT_MAX_STEPS
  const ctx = createInvocationContext(
    session,
    runnerConfig.sessionService,
    invocationId,
    agent,
    parentInvocationId,
    runnerConfig.subRunner,
    runnerConfig.signal,
    runnerConfig.channel,
    config?.voice,
  )

  const { currentYieldIndex, effectiveYields, turnsExhausted } = yieldBudget(agent, resumeContext)

  if (turnsExhausted) {
    return {
      session,
      state: session.state,
      iterations: 0,
      runnable: agent,
      outcome: 'max_turns',
      yieldIndex: currentYieldIndex,
    }
  }

  if (resumeContext) {
    yield* processResumedYields(agent, session, ctx, runnerConfig)
  }

  const skipped = yield* beforeAgentResult(
    agent,
    composedHook,
    session,
    config,
    invocationId,
    runnerConfig,
    ctx,
    currentYieldIndex,
  )
  if (skipped) return skipped

  const effectiveAgent = await withExpandedMCPTools(agent)

  // --- Timeout enforcement ---
  const timeout = armInvocationTimeout(agent, signal)
  const effectiveSignal = timeout.signal

  const mctx: ModelStepContext = {
    agent: effectiveAgent,
    composedHook,
    session,
    invocationId,
    iterations: 0,
    ctx,
    runnerConfig,
    config,
    errorHandler,
  }

  const scope: AgentLoopScope = {
    agent,
    effectiveAgent,
    composedHook,
    session,
    config,
    invocationId,
    runnerConfig,
    errorHandler,
    ctx,
    mctx,
    maxSteps,
    effectiveYields,
    currentYieldIndex,
    effectiveSignal,
  }
  const loop = { iterations: 0 }
  let outcome: InvocationOutcome | null = 'completed'
  let error: string | undefined

  try {
    while (true) {
      if (effectiveSignal.aborted) {
        outcome = timeout.state.reason ?? 'aborted'
        break
      }
      if (ctx.endInvocation) break

      const next = yield* runAgentIteration(scope, loop)
      if (next.type === 'return') return next.result
      if (next.type === 'break') {
        if (next.outcome) outcome = next.outcome
        break
      }
    }
  } catch (err) {
    // If the error is due to a timeout abort, map to the timeout outcome
    // instead of propagating as an error.
    if (effectiveSignal.aborted && timeout.state.reason) {
      outcome = timeout.state.reason
    } else {
      outcome = 'error'
      error = err instanceof Error ? err.message : String(err)
      throw err
    }
  } finally {
    if (timeout.state.timer) clearTimeout(timeout.state.timer)
  }

  const output = await finalAgentOutput(agent, composedHook, session, invocationId, ctx)

  return {
    session,
    state: session.state,
    iterations: loop.iterations,
    runnable: agent,
    outcome,
    yieldIndex: currentYieldIndex,
    error,
    output,
  }
}

/** The function tools the model is offered, so the ones the loop runs: the output tool too. */
function functionToolsOf(agent: Agent): FunctionTool[] {
  return offeredFunctionTools(agent, agent.tools.filter(isFunctionTool))
}

/**
 * Lets the agent's adapter release what it kept for an invocation that has ended. A step that calls
 * tools can leave a Realtime socket open for their results; an invocation that ends on one of those
 * tools (an output tool, a transfer, an error) takes no further step to close it.
 */
async function endAdapterInvocation(
  runnerConfig: AgentRunnerConfig,
  agent: Agent,
  invocationId: string,
): Promise<void> {
  try {
    const adapter = await runnerConfig.getAdapter(agent.model)
    adapter.endInvocation?.(invocationId)
  } catch {
    // The invocation's own outcome stands; releasing is best effort.
  }
}

/** Runs an invocation, then lets its adapter release what it kept, unless it yielded to resume. */
async function* releasingAdapterAtEnd(
  run: AsyncGenerator<StreamEvent, AgentResult>,
  runnerConfig: AgentRunnerConfig,
  agent: Agent,
  invocationId: string,
): AsyncGenerator<StreamEvent, AgentResult> {
  let result: AgentResult | undefined
  try {
    result = yield* run
    return result
  } finally {
    // A yielded invocation is resumed later, on what its adapter kept.
    if (result?.outcome !== 'yielded') await endAdapterInvocation(runnerConfig, agent, invocationId)
  }
}

function composeAgentHandlers(
  agent: Agent,
  config: InternalRunConfig | undefined,
  runnerConfig: AgentRunnerConfig,
): { composedHooks: Hook; composedErrorHandler: ComposedErrorHandler } {
  const composedHooks = composeHooks([
    ...(runnerConfig.runnerHooks ?? []),
    ...(agent.hooks ?? []),
    ...(config?.hooks ?? []),
  ])

  const composedErrorHandler = composeErrorHandlers(
    runnerConfig.runnerErrorHandlers ?? [],
    agent.errorHandlers ?? [],
    config?.errorHandlers ?? [],
  )

  return { composedHooks, composedErrorHandler }
}

export async function* runAgent(
  agent: Agent,
  session: Session,
  config: InternalRunConfig | undefined,
  signal: AbortSignal,
  parentInvocationId: string | undefined,
  runnerConfig: AgentRunnerConfig,
  resumeContext?: ResumeContext,
): AsyncGenerator<StreamEvent, RunResult> {
  const invocationId = resumeContext?.invocationId ?? createInvocationId()

  const { composedHooks, composedErrorHandler } = composeAgentHandlers(agent, config, runnerConfig)

  const options: InvocationBoundaryOptions<AgentResult> = {
    getIterations: (r) => r.iterations,
    getEndReason: (r) => (r.outcome === 'yielded' ? 'completed' : (r.outcome ?? 'completed')),
    getError: (r) => r.error,
    getHandoffTarget: (r): HandoffTarget | undefined =>
      r.transfer
        ? {
            invocationId: r.transfer.invocationId,
            agentName: r.transfer.agent.name,
          }
        : undefined,
    isYielded: (r) => r.outcome === 'yielded',
    getYieldInfo: (r) => ({
      yieldedToolIds: r.yieldedTools?.map((c) => c.callId) ?? [],
      yieldIndex: r.yieldIndex,
      awaitingInput: !r.yieldedTools || r.yieldedTools.length === 0,
    }),
    managed: runnerConfig.managed,
    handoffOrigin: runnerConfig.handoffOrigin,
    fingerprint: runnerConfig.fingerprint,
    signal,
  }

  const result = yield* releasingAdapterAtEnd(
    withInvocationBoundary(
      agent,
      invocationId,
      parentInvocationId,
      session,
      runnerConfig.sessionService,
      executeAgentLoop(
        agent,
        composedHooks,
        session,
        config,
        signal,
        invocationId,
        parentInvocationId,
        runnerConfig,
        composedErrorHandler,
        resumeContext,
      ),
      options,
      resumeContext,
    ),
    runnerConfig,
    agent,
    invocationId,
  )

  const assistantEvents = session.events.filter((e): e is AssistantEvent => e.type === 'assistant')
  const lastAssistant = assistantEvents[assistantEvents.length - 1]
  const allMedia = assistantEvents.flatMap((e) => e.media ?? [])
  const output = {
    text: lastAssistant?.text,
    value: result.output,
    items: assistantEvents,
    media: allMedia.length > 0 ? allMedia : undefined,
  }
  const base = {
    runnable: agent,
    session: result.session,
    state: result.state,
    iterations: result.iterations,
    output,
  }

  switch (result.outcome) {
    case 'yielded': {
      const yieldedTools = result.yieldedTools ?? []
      if (yieldedTools.length === 0) {
        return {
          ...base,
          status: 'yielded_message',
          yieldedInvocationId: invocationId,
        }
      }
      return {
        ...base,
        status: 'yielded_tool',
        yieldedTools,
      }
    }
    case 'completed':
      return { ...base, status: 'completed' }
    case 'error':
      return {
        ...base,
        status: 'error',
        error: result.error ?? 'Unknown error',
      }
    case 'aborted':
      return { ...base, status: 'aborted' }
    case 'max_steps':
      return { ...base, status: 'max_steps' }
    case 'max_turns':
      return { ...base, status: 'max_turns' }
    case 'max_duration':
      return { ...base, status: 'max_duration' }
    case 'inactivity_timeout':
      return { ...base, status: 'inactivity_timeout' }
    case 'transferred':
      return {
        ...base,
        status: 'transferred',
        transfer: result.transfer!,
      }
    default:
      return { ...base, status: 'completed' }
  }
}
