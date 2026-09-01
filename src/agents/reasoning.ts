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
} from '../types'
import type { Session } from '../types'
import type { InternalRunConfig } from '../types/runtime'
import type { AgentRunnerConfig } from './config'

import { buildContext, createStartEvent, createEndEvent } from '../context'
import {
  withRetry,
  withInvocationBoundary,
  createInvocationId,
  isYieldSignal,
  isRunnable,
  createInvocationContext,
  createToolContext,
  type InvocationBoundaryOptions,
  type ResumeContext,
} from '../core'
import { DEFAULT_MAX_STEPS, MAX_TOOL_RETRY_ATTEMPTS } from '../core/constants'
import {
  isFunctionTool,
  expandMCPTools,
  partitionTools,
  isOutputSignal,
  isEndSignal,
  safeParseToolArgs,
} from '../core/tools'
import { composeErrorHandlers } from '../errors'
import { OutputParseError } from '../errors/types'
import { composeHooks } from '../hook'
import { createParser } from '../parser'
import { getModelName, getInnerModel } from '../providers/models'
import { createEventId } from '../session'

function enrichToolCallsWithYieldFlag(toolCalls: ToolCallEvent[], tools: FunctionTool[]): void {
  const yieldingToolNames = new Set(tools.filter((t) => t.yieldSchema).map((t) => t.name))
  for (const toolCall of toolCalls) {
    if (yieldingToolNames.has(toolCall.name)) {
      toolCall.yields = true
    }
  }
}

export interface AgentResult extends Omit<RunResultBase, 'runnable' | 'output'> {
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

async function processResumedYields(
  agent: Agent,
  session: Session,
  ctx: InvocationContext,
  runnerConfig: AgentRunnerConfig,
  onStream?: (event: StreamEvent) => void,
): Promise<void> {
  const toolYields = session.events.filter((e): e is ToolYieldEvent => e.type === 'tool_yield')

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

    const tool = agent.tools.filter(isFunctionTool).find((t) => t.name === yieldEvent.name)
    if (!tool) continue

    const baseToolCtx = createToolContext(
      ctx,
      toolCall,
      ctx.session,
      runnerConfig.sessionService,
      runnerConfig.subRunner,
      onStream,
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
        onStream?.(errorResult)
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
      onStream?.(resultEvent)
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
      onStream?.(errorResult)
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

async function executeToolCall(
  toolCall: ToolCallEvent,
  agent: Agent,
  composedHook: Hook,
  toolCtx: ToolContext,
  errorHandler: ComposedErrorHandler,
): Promise<ExecuteToolResult> {
  const skipTool = await composedHook.beforeTool?.(toolCtx, toolCall)
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

  const tool = agent.tools.filter(isFunctionTool).find((t) => t.name === toolCall.name)
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
  let lastError: Error | undefined

  while (attempt < MAX_TOOL_RETRY_ATTEMPTS) {
    attempt++
    let timedOut = false

    try {
      const executeTool = async () => {
        return await tool.execute!(hookCtx)
      }

      let execution = tool.retry ? withRetry(executeTool, tool.retry) : executeTool()

      if (tool.timeout) {
        execution = withToolTimeout(
          execution,
          tool.timeout,
          `Tool '${tool.name}' timed out after ${tool.timeout}ms`,
        )
      }

      let output = await execution

      if (isOutputSignal(output)) {
        return {
          event: await applyAfterTool(composedHook, toolCtx, {
            ...base,
            result: output.value,
            output: true,
            durationMs: Date.now() - startTime,
            retryCount: attempt > 1 ? attempt : undefined,
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
            retryCount: attempt > 1 ? attempt : undefined,
          }),
        }
      }

      if (isYieldSignal(output)) {
        return {
          event: await applyAfterTool(composedHook, toolCtx, {
            ...base,
            result: { yielded: true, invocationId: output.invocationId },
            durationMs: Date.now() - startTime,
            retryCount: attempt > 1 ? attempt : undefined,
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
            retryCount: attempt > 1 ? attempt : undefined,
          }),
          transfer: {
            agent: output,
          },
        }
      }

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

      return {
        event: await applyAfterTool(composedHook, toolCtx, {
          ...base,
          result: output,
          media,
          durationMs: Date.now() - startTime,
          retryCount: attempt > 1 ? attempt : undefined,
        }),
      }
    } catch (error) {
      lastError = error as Error
      const errorMessage = lastError.message
      timedOut = errorMessage.includes('timed out')

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
              retryCount: attempt > 1 ? attempt : undefined,
              timedOut: timedOut || undefined,
            }),
            abort: true,
          }

        case 'retry':
          if (recovery.delay) {
            await sleep(recovery.delay)
          }
          continue

        case 'fallback':
          return {
            event: await applyAfterTool(composedHook, toolCtx, {
              ...base,
              result: recovery.result,
              durationMs: Date.now() - startTime,
              retryCount: attempt > 1 ? attempt : undefined,
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
              retryCount: attempt > 1 ? attempt : undefined,
              timedOut: timedOut || undefined,
            }),
          }
      }
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

async function* executeModelStep(
  mctx: ModelStepContext,
  renderCtx: import('../types').RenderContext,
  stepStartTime: number,
  signal: AbortSignal,
): AsyncGenerator<StreamEvent, ModelStepOutcome> {
  const { agent, composedHook, runnerConfig, ctx, config, errorHandler, invocationId, iterations } =
    mctx
  const adapter = await runnerConfig.getAdapter(agent.model)

  const skipModel = await composedHook.beforeModel?.(ctx, renderCtx)
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
    modelAttempt++
    try {
      const stream = adapter.step(renderCtx, getInnerModel(agent.model), signal)
      let iterResult = await stream.next()
      while (!iterResult.done) {
        config?.onStream?.(iterResult.value)
        yield iterResult.value
        iterResult = await stream.next()
      }
      stepResult = iterResult.value
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
          config?.onStream?.(endEvent)
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
  for (const toolCall of toolCalls) {
    const toolCtx = createToolContext(
      ctx,
      toolCall,
      ctx.session,
      runnerConfig.sessionService,
      runnerConfig.subRunner,
      config?.onStream,
      runnerConfig.signal,
      runnerConfig.channel,
    )
    const {
      event: resultEvent,
      abort,
      delegateYielded,
      transfer,
      outputSignal,
    } = await executeToolCall(toolCall, agent, composedHook, toolCtx, errorHandler)

    await runnerConfig.sessionService.appendEvent(session, resultEvent)
    config?.onStream?.(resultEvent)
    yield resultEvent
    config?.onStep?.([resultEvent], session, agent)

    if (delegateYielded) {
      return { abort: false, delegateYieldInfo: delegateYielded }
    }
    if (transfer) {
      return { abort: false, transferInfo: transfer }
    }
    if (outputSignal) {
      return { abort: false, outputInfo: outputSignal }
    }
    if (abort) {
      return { abort: true }
    }
  }

  return { abort: false }
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
    const parser = createParser(outputConfig.schema)
    const result = parser.parse(rawOutput)

    if (result.success) {
      if (outputConfig.key) {
        dynamicState[outputConfig.key] = result.value
      }
      return {
        value: result.value,
        parsed: {
          value: result.value,
          corrections: result.corrections,
          totalScore: result.totalScore,
        },
      }
    }

    if (result.partial !== undefined) {
      const validation = outputConfig.schema.safeParse(result.partial)
      if (validation.success) {
        if (outputConfig.key) {
          dynamicState[outputConfig.key] = validation.data
        }
        return {
          value: validation.data,
          parsed: {
            value: validation.data,
            corrections: result.corrections,
            totalScore: result.totalScore,
          },
        }
      }
    }

    throw new OutputParseError(
      rawOutput,
      outputConfig.schema,
      result.errors,
      result.partial,
      result.corrections,
    )
  }

  dynamicState[outputConfig.key] = rawOutput
  return { value: rawOutput }
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
    config?.onStream,
    runnerConfig.signal,
    runnerConfig.channel,
  )

  const currentYieldIndex = resumeContext ? resumeContext.yieldIndex + 1 : 0
  const effectiveYields =
    agent.yields ?? ('realtime' in agent.model && agent.model.realtime === true)
  const maxTurns = agent.maxTurns ?? 100

  if (effectiveYields && currentYieldIndex >= maxTurns) {
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
    await processResumedYields(agent, session, ctx, runnerConfig, config?.onStream)
  }

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

  const { mcpTools } = partitionTools(agent.tools)
  let effectiveAgent = agent

  if (mcpTools.length > 0) {
    const { functionTools, providerTools } = await expandMCPTools(agent.tools)
    effectiveAgent = {
      ...agent,
      tools: [...functionTools, ...providerTools],
    }
  }

  // --- Timeout enforcement ---
  // maxDuration: wall-clock timer from invocation start. Creates a child
  // AbortController that fires when the timeout expires. The main loop
  // checks `timeoutSignal.aborted` and maps to the correct outcome.
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined
  let timeoutReason: 'max_duration' | 'inactivity_timeout' | undefined
  const timeoutController = new AbortController()

  // Chain parent signal → child abort
  if (signal.aborted) {
    timeoutController.abort()
  } else {
    const onParentAbort = () => timeoutController.abort()
    signal.addEventListener('abort', onParentAbort, { once: true })
  }

  if (agent.timeouts?.maxDuration) {
    timeoutTimer = setTimeout(() => {
      timeoutReason = 'max_duration'
      timeoutController.abort()
    }, agent.timeouts.maxDuration)
  }

  const effectiveSignal = timeoutController.signal

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

  let iterations = 0
  let outcome: InvocationOutcome | null = 'completed'
  let error: string | undefined

  try {
    while (true) {
      if (effectiveSignal.aborted) {
        outcome = timeoutReason ?? 'aborted'
        break
      }
      if (ctx.endInvocation) break

      const renderCtx = buildContext(session, effectiveAgent, invocationId)
      const stepStartTime = Date.now()

      const startEvent = createStartEvent(renderCtx, iterations + 1, invocationId)
      await runnerConfig.sessionService.appendEvent(session, startEvent)
      config?.onStream?.(startEvent)
      yield startEvent

      const { stepResult, modelError, shouldAbort, transfer, synthetic } = yield* executeModelStep(
        mctx,
        renderCtx,
        stepStartTime,
        effectiveSignal,
      )

      if (!synthetic) {
        iterations++
        mctx.iterations = iterations
      }

      if (iterations >= maxSteps) {
        outcome = 'max_steps'
        break
      }

      if (transfer) {
        return {
          session,
          state: session.state,
          iterations,
          runnable: agent,
          outcome: 'transferred',
          yieldIndex: currentYieldIndex,
          transfer: {
            invocationId: createInvocationId(),
            agent: transfer.agent,
          },
        }
      }

      if (shouldAbort) {
        outcome = 'aborted'
        const endEvent = createEndEvent({
          invocationId,
          agentName: agent.name,
          stepIndex: iterations,
          durationMs: Date.now() - stepStartTime,
          finishReason: 'error',
          error: modelError,
        })
        await runnerConfig.sessionService.appendEvent(session, endEvent)
        config?.onStream?.(endEvent)
        yield endEvent
        break
      }

      if (!stepResult) {
        const endEvent = createEndEvent({
          invocationId,
          agentName: agent.name,
          stepIndex: iterations,
          durationMs: Date.now() - stepStartTime,
          finishReason: 'error',
          error: modelError,
        })
        await runnerConfig.sessionService.appendEvent(session, endEvent)
        config?.onStream?.(endEvent)
        yield endEvent
        continue
      }

      let finalStepResult = stepResult
      const modifiedResult = await composedHook.afterModel?.(ctx, stepResult)
      if (isRunnable(modifiedResult)) {
        return {
          session,
          state: session.state,
          iterations,
          runnable: agent,
          outcome: 'transferred',
          yieldIndex: currentYieldIndex,
          transfer: {
            invocationId: createInvocationId(),
            agent: modifiedResult,
          },
        }
      }
      if (modifiedResult) finalStepResult = modifiedResult

      const modelName = getModelName(agent.model)
      const usage = finalStepResult.usage ? { ...finalStepResult.usage, modelName } : undefined
      const endEvent = createEndEvent({
        invocationId,
        agentName: agent.name,
        stepIndex: iterations,
        durationMs: Date.now() - stepStartTime,
        usage,
        finishReason: finalStepResult.finishReason,
      })
      await runnerConfig.sessionService.appendEvent(session, endEvent)
      config?.onStream?.(endEvent)
      yield endEvent

      enrichToolCallsWithYieldFlag(finalStepResult.toolCalls, agent.tools.filter(isFunctionTool))

      for (const event of finalStepResult.stepEvents) {
        await runnerConfig.sessionService.appendEvent(session, event)
        config?.onStream?.(event)
        yield event
      }

      config?.onStep?.(finalStepResult.stepEvents, session, agent)

      if (finalStepResult.terminal) {
        if (effectiveYields) {
          return {
            runnable: agent,
            session,
            state: session.state,
            iterations,
            outcome: 'yielded',
            yieldIndex: currentYieldIndex,
          } satisfies AgentResult
        }
        break
      }

      const yieldedTools = finalStepResult.toolCalls.filter((tc) => tc.yields === true)
      if (yieldedTools.length > 0) {
        const nonYieldingCalls: ToolCallEvent[] = stepResult.toolCalls.filter(
          (tc) => tc.yields !== true,
        )

        for (const toolCall of nonYieldingCalls) {
          const toolCtx = createToolContext(
            ctx,
            toolCall,
            ctx.session,
            runnerConfig.sessionService,
            runnerConfig.subRunner,
            config?.onStream,
            runnerConfig.signal,
            runnerConfig.channel,
          )
          const { event: resultEvent } = await executeToolCall(
            toolCall,
            agent,
            composedHook,
            toolCtx,
            errorHandler,
          )
          await runnerConfig.sessionService.appendEvent(session, resultEvent)
          config?.onStream?.(resultEvent)
          yield resultEvent
          config?.onStep?.([resultEvent], session, agent)
        }
      }

      if (yieldedTools.length > 0) {
        const yieldEvents: ToolYieldEvent[] = []
        for (const toolCall of yieldedTools) {
          const tool = agent.tools.filter(isFunctionTool).find((t) => t.name === toolCall.name)
          if (!tool) continue

          const baseToolCtx = createToolContext(
            ctx,
            toolCall,
            ctx.session,
            runnerConfig.sessionService,
            runnerConfig.subRunner,
            config?.onStream,
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
            config?.onStream?.(errorResultEvent)
            yield errorResultEvent
            continue
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
          config?.onStream?.(yieldEvent)
          yieldEvents.push(yieldEvent)
        }

        if (yieldEvents.length > 0) {
          return {
            runnable: agent,
            session,
            state: session.state,
            iterations,
            outcome: 'yielded',
            yieldIndex: currentYieldIndex,
            yieldedTools: yieldEvents,
          } satisfies AgentResult
        }
      }

      const toolResult = yield* processToolCalls(
        finalStepResult.toolCalls,
        mctx.agent,
        composedHook,
        ctx,
        runnerConfig,
        config,
        errorHandler,
        session,
      )

      if (toolResult.delegateYieldInfo) {
        return {
          runnable: agent,
          session,
          state: session.state,
          iterations,
          outcome: 'yielded',
          yieldIndex: currentYieldIndex,
          yieldedTools: toolResult.delegateYieldInfo.yieldedTools,
        } satisfies AgentResult
      }

      if (toolResult.transferInfo) {
        return {
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
        } satisfies AgentResult
      }

      if (toolResult.outputInfo) {
        let output: unknown = toolResult.outputInfo.value
        const modified = await composedHook.afterAgent?.(ctx, output)
        if (modified !== undefined) output = modified
        return {
          runnable: agent,
          session,
          state: session.state,
          iterations,
          outcome: 'completed',
          yieldIndex: currentYieldIndex,
          output,
        } satisfies AgentResult
      }

      if (toolResult.abort) {
        outcome = 'aborted'
        break
      }
    }
  } catch (err) {
    // If the error is due to a timeout abort, map to the timeout outcome
    // instead of propagating as an error.
    if (effectiveSignal.aborted && timeoutReason) {
      outcome = timeoutReason
    } else {
      outcome = 'error'
      error = err instanceof Error ? err.message : String(err)
      throw err
    }
  } finally {
    if (timeoutTimer) clearTimeout(timeoutTimer)
  }

  const finalOutput = getLastAssistantText(session)
  const hookResult = await composedHook.afterAgent?.(ctx, finalOutput)

  let output: unknown
  if (hookResult !== undefined && typeof hookResult !== 'string') {
    output = hookResult
  } else {
    const rawOutput = typeof hookResult === 'string' ? hookResult : finalOutput
    output = processAgentOutput(agent, rawOutput, session, invocationId).value
  }

  return {
    session,
    state: session.state,
    iterations,
    runnable: agent,
    outcome,
    yieldIndex: currentYieldIndex,
    error,
    output,
  }
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

  const options: InvocationBoundaryOptions<AgentResult> = {
    onStream: config?.onStream,
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
  }

  const result = yield* withInvocationBoundary(
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
