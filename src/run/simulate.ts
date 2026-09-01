import type { Hook } from '../hook/types'
import type { AssistantEvent, InvocationYieldEvent } from '../types/events'
import type { Runnable } from '../types/runnables'
import type { RunResult, StreamResult, TerminationReason } from '../types/runtime'
import type { Session, MessageInput, Input } from '../types/session'

import { BaseSession } from '../session'

export interface SimulateYieldContext<TArgs = unknown> {
  yieldType: 'tool' | 'loop'
  toolName?: string
  callId?: string
  args?: TArgs
  lastAssistantText?: string
  iteration: number
}

export interface Transform<TArgs = unknown> {
  prepareInput?: (
    session: Session,
    ctx: SimulateYieldContext<TArgs>,
  ) => string | MessageInput | Promise<string | MessageInput>
  processOutput?: (
    output: unknown,
    session: Session,
    ctx: SimulateYieldContext<TArgs>,
  ) => unknown | Promise<unknown>
}

export type Simulator = (runnable: Runnable<any>, options: SimulateOptions) => Promise<RunResult>

export interface SimulateOptions<TArgs = unknown> {
  session?: Session
  input?: string | Input
  userAgent?: Runnable<any>
  toolAgents?: Record<string, Runnable<any>>
  transform?: Transform<TArgs>
  maxTurns?: number
  maxDuration?: number
  stateMatches?: Record<string, unknown>
  hooks?: Hook<any>[]
  timeout?: number
}

export interface SimulateRunFn {
  (
    runnable: Runnable<any>,
    config: {
      session?: Session
      input?: Input
      hooks?: Hook<any>[]
      timeout?: number
    },
  ): StreamResult
}

export async function runSimulateLoop(
  runnable: Runnable<any>,
  run: SimulateRunFn,
  options: SimulateOptions,
): Promise<RunResult> {
  const input = typeof options.input === 'string' ? { message: options.input } : options.input

  const maxTurns = options.maxTurns ?? 100
  const maxDuration = options.maxDuration
  const stateMatches = options.stateMatches
  const startTime = Date.now()

  const prepareInput = options.transform?.prepareInput ?? defaultPrepareInput
  const processOutput = options.transform?.processOutput ?? defaultProcessOutput

  const userAgentSession = options.userAgent
    ? new BaseSession('user-agent', { id: `user-agent-${Date.now()}` })
    : undefined

  const toolSessions = new Map<string, Session>()
  const getToolSession = (name: string): Session => {
    let sess = toolSessions.get(name)
    if (!sess) {
      sess = new BaseSession(`tool-${name}`, {
        id: `tool-${name}-${Date.now()}`,
      })
      toolSessions.set(name, sess)
    }
    return sess
  }

  const runAgent = async (
    agent: Runnable<any>,
    session: Session,
    agentInput: string | MessageInput,
  ): Promise<RunResult> => {
    return run(agent, { session, input: { message: agentInput } })
  }

  let result = await run(runnable, {
    session: options.session,
    input,
    hooks: options.hooks,
    timeout: options.timeout,
  })

  let iteration = 0

  while (
    (result.status === 'yielded_tool' || result.status === 'yielded_message') &&
    iteration < maxTurns
  ) {
    iteration++

    const yieldCtx = buildSimulateYieldContext(result, iteration)

    if (yieldCtx.yieldType === 'tool' && result.status === 'yielded_tool') {
      for (const call of result.yieldedTools) {
        const output = await runToolAgent(
          call.name,
          call.args,
          result.session,
          {
            ...yieldCtx,
            toolName: call.name,
            callId: call.callId,
            args: call.args,
          },
          options.toolAgents,
          getToolSession,
          runAgent,
          prepareInput,
          processOutput,
        )
        result.session.input.tool({ callId: call.callId, input: output })
      }
    } else {
      if (!options.userAgent || !userAgentSession) {
        throw new Error(
          'Agent yielded a message but no userAgent was provided in SimulateOptions. ' +
            'Add a userAgent to handle loop yields, or use toolAgents for tool-only flows.',
        )
      }

      const prompt = await prepareInput(result.session, yieldCtx)
      const simResult = await runAgent(options.userAgent, userAgentSession, prompt)
      const output = await processOutput(
        simResult.output.value ?? simResult.output.text,
        userAgentSession,
        yieldCtx,
      )

      const yieldEvent = [...result.session.events]
        .toReversed()
        .find(
          (e): e is InvocationYieldEvent =>
            e.type === 'invocation_yield' && e.awaitingInput === true,
        )
      result.session.input.message({
        text: String(output ?? ''),
        invocationId: yieldEvent?.invocationId,
      })
    }

    result = await run(runnable, {
      session: result.session,
      hooks: options.hooks,
      timeout: options.timeout,
    })

    const termination = checkTermination(
      result,
      iteration,
      maxTurns,
      startTime,
      maxDuration,
      stateMatches,
    )
    if (termination) {
      return {
        runnable: result.runnable,
        session: result.session,
        state: result.state,
        iterations: result.iterations,
        usage: result.usage,
        output: result.output,
        status: 'terminated' as const,
        terminationReason: termination,
      }
    }
  }

  if (
    iteration >= maxTurns &&
    (result.status === 'yielded_tool' || result.status === 'yielded_message')
  ) {
    return {
      runnable: result.runnable,
      session: result.session,
      state: result.state,
      iterations: result.iterations,
      usage: result.usage,
      output: result.output,
      status: 'terminated' as const,
      terminationReason: 'maxTurns' as const,
    }
  }

  return result
}

function checkTermination(
  result: RunResult,
  iteration: number,
  _maxTurns: number,
  startTime: number,
  maxDuration?: number,
  stateMatches?: Record<string, unknown>,
): TerminationReason | null {
  if (result.status !== 'yielded_tool' && result.status !== 'yielded_message') {
    return null
  }

  if (maxDuration !== undefined) {
    const elapsed = Date.now() - startTime
    if (elapsed >= maxDuration) {
      return 'maxDuration'
    }
  }

  if (stateMatches && matchesStateCondition(result.session, stateMatches)) {
    return 'stateMatches'
  }

  return null
}

function matchesStateCondition(session: Session, condition: Record<string, unknown>): boolean {
  for (const [scope, conditions] of Object.entries(condition)) {
    if (scope !== 'session' && scope !== 'user' && scope !== 'patient' && scope !== 'practice') {
      continue
    }

    const stateAccessor =
      scope === 'session'
        ? session.state
        : (session.state as unknown as Record<string, Record<string, unknown>>)[scope]
    const conditionObj = conditions as Record<string, unknown>

    for (const [key, expected] of Object.entries(conditionObj)) {
      const value = (stateAccessor as Record<string, unknown>)[key]

      if (typeof expected === 'object' && expected !== null) {
        const op = expected as Record<string, unknown>
        if ('$exists' in op) {
          const exists = value !== undefined
          if (op.$exists !== exists) return false
        } else if ('$eq' in op) {
          if (value !== op.$eq) return false
        } else if ('$ne' in op) {
          if (value === op.$ne) return false
        } else if (!deepEqual(value, expected)) {
          return false
        }
      } else if (value !== expected) {
        return false
      }
    }
  }

  return true
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (typeof a !== 'object' || a === null || b === null) return false

  const keysA = Object.keys(a as object)
  const keysB = Object.keys(b as object)
  if (keysA.length !== keysB.length) return false

  for (const key of keysA) {
    if (!deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) {
      return false
    }
  }

  return true
}

async function runToolAgent(
  toolName: string,
  args: unknown,
  mainSession: Session,
  yieldCtx: SimulateYieldContext,
  toolAgents: Record<string, Runnable<any>> | undefined,
  getToolSession: (name: string) => Session,
  runAgent: (
    agent: Runnable<any>,
    session: Session,
    input: string | MessageInput,
  ) => Promise<RunResult>,
  prepareInput: NonNullable<Transform['prepareInput']>,
  processOutput: NonNullable<Transform['processOutput']>,
): Promise<unknown> {
  const toolAgent = toolAgents?.[toolName]
  if (!toolAgent) {
    throw new Error(`No agent for tool '${toolName}'. Add it to the 'toolAgents' option.`)
  }

  const toolSession = getToolSession(toolName)
  const prompt = await prepareInput(mainSession, yieldCtx)
  const toolResult = await runAgent(toolAgent, toolSession, prompt)
  return processOutput(toolResult.output.value ?? toolResult.output.text, toolSession, yieldCtx)
}

function buildSimulateYieldContext(result: RunResult, iteration: number): SimulateYieldContext {
  if (result.status !== 'yielded_tool' && result.status !== 'yielded_message') {
    throw new Error('Expected yielded_tool or yielded_message result')
  }

  const lastAssistant = [...result.session.events]
    .toReversed()
    .find((e): e is AssistantEvent => e.type === 'assistant')

  const firstCall = result.status === 'yielded_tool' ? result.yieldedTools[0] : undefined

  return {
    yieldType: result.status === 'yielded_message' ? 'loop' : 'tool',
    toolName: firstCall?.name,
    callId: firstCall?.callId,
    args: firstCall?.args,
    lastAssistantText: lastAssistant?.text,
    iteration,
  }
}

function defaultPrepareInput(_session: Session, ctx: SimulateYieldContext): string {
  if (ctx.yieldType === 'loop') {
    return ctx.lastAssistantText ?? ''
  }
  return JSON.stringify({ toolName: ctx.toolName, args: ctx.args })
}

function defaultProcessOutput(output: unknown): unknown {
  return output
}
