import type { Runnable, FunctionTool, Agent, ToolExecutionContext } from '../types/runnables'
import type { StateSchema } from '../types/schema'
import type { ToolMocks, MockToolContext } from './types'

import { isFunctionTool } from '../core'
import { EvalToolError } from './errors'

export interface InterceptToolsOptions {
  strict?: boolean
}

// Throws by default when a tool has no mock — pass strict: false to allow passthrough
export function interceptTools<S extends StateSchema = StateSchema>(
  runnable: Runnable,
  mocks: ToolMocks<S>,
  options?: InterceptToolsOptions,
): Runnable {
  const strict = options?.strict !== false
  return interceptRunnable(runnable, mocks as ToolMocks, strict)
}

function isRealTool(value: unknown): value is FunctionTool<any, any, any, any> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'schema' in value &&
    'description' in value &&
    'execute' in value &&
    'name' in value
  )
}

function interceptRunnable(runnable: Runnable, mocks: ToolMocks, strict: boolean): Runnable {
  switch (runnable.kind) {
    case 'agent':
      return interceptAgent(runnable, mocks, strict)

    case 'sequence':
      return {
        ...runnable,
        runnables: runnable.runnables.map((r) => interceptRunnable(r, mocks, strict)),
      }

    case 'parallel':
      return {
        ...runnable,
        runnables: runnable.runnables.map((r) => interceptRunnable(r, mocks, strict)),
      }

    case 'loop':
      return {
        ...runnable,
        runnable: interceptRunnable(runnable.runnable, mocks, strict),
      }

    case 'step':
      return runnable

    default:
      return runnable
  }
}

function interceptAgent(agent: Agent, mocks: ToolMocks, strict: boolean): Agent {
  const functionTools = agent.tools.filter(isFunctionTool)
  const providerTools = agent.tools.filter((t) => !isFunctionTool(t))
  const outputIsTool = isRealTool(agent.output)

  if (functionTools.length === 0 && !outputIsTool) {
    return agent
  }

  const interceptedTools = functionTools.map((tool) => interceptTool(tool, mocks, strict))

  const interceptedOutput = outputIsTool
    ? interceptTool(agent.output as FunctionTool, mocks, strict)
    : agent.output

  return {
    ...agent,
    tools: [...interceptedTools, ...providerTools],
    output: interceptedOutput,
  }
}

function interceptTool<TInput, TOutput>(
  originalTool: FunctionTool<TInput, TOutput>,
  mocks: ToolMocks,
  strict: boolean,
): FunctionTool<TInput, TOutput> {
  const mockOrTool = mocks[originalTool.name]

  if (!mockOrTool && !strict) {
    return originalTool
  }

  return {
    ...originalTool,
    execute: async (ctx: ToolExecutionContext<TInput>): Promise<TOutput> => {
      if (!mockOrTool) {
        throw new EvalToolError(originalTool.name, ctx.args)
      }

      if (isRealTool(mockOrTool)) {
        return mockOrTool.execute?.(ctx) as Promise<TOutput>
      }

      const mock = mockOrTool
      const mockCtx: MockToolContext = {
        callId: ctx.callId,
        toolName: ctx.toolName,
        invocationId: ctx.invocationId,
        state: ctx.state,
        voice: ctx.voice,
        waitForPlayout: ctx.waitForPlayout,
        now: () => Date.now(),
        output: (value) => ctx.output(value),
        end: () => ctx.end(),
        run: (agent: any, inputOrOptions?: any) => ctx.run(agent, inputOrOptions),
      }

      return mock.execute(ctx.args, mockCtx) as Promise<TOutput>
    },
  }
}
