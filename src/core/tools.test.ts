import { vi } from 'vitest'
import { z } from 'zod'

import type { ToolContext, ToolExecutionContext, FunctionTool } from '../types'

import { adk } from '../api'
import { createStateAccessor } from '../context'
import { BaseSession } from '../session'
import { safeParseToolArgs } from './tools'

const app = adk()

async function runToolWithLifecycle<TInput, TOutput>(
  t: FunctionTool<TInput, TOutput>,
  args: TInput,
  ctx: ToolContext,
): Promise<TOutput> {
  let preparedArgs = args
  const hookCtx: ToolExecutionContext<TInput> = {
    ...ctx,
    args: preparedArgs,
  }

  if (t.prepare) {
    const prepared = await t.prepare(hookCtx)
    if (prepared !== undefined) {
      preparedArgs = prepared
      ;(hookCtx as { args: TInput }).args = preparedArgs
    }
  }

  if (!t.execute) {
    throw new Error('Tool has no execute function')
  }

  let output = await t.execute(hookCtx as ToolExecutionContext<TInput, never>)

  if (t.finalize) {
    const finalizeCtx = {
      ...hookCtx,
      input: undefined as never,
      result: output,
    } as ToolExecutionContext<TInput, never, TOutput>
    const finalized = await t.finalize(finalizeCtx)
    if (finalized !== undefined) {
      output = finalized
    }
  }

  return output
}

describe('tool', () => {
  const mockCtx = (session = new BaseSession('app', { id: 'test' })): ToolContext =>
    ({
      session,
      state: createStateAccessor(session, 'inv-123'),
      invocationId: 'inv-123',
      callId: 'call-123',
    }) as unknown as ToolContext

  test('creates tool with all properties', () => {
    const myTool = app.tool({
      name: 'test_tool',
      description: 'A test tool',
      schema: z.object({ input: z.string() }),
      execute: (ctx) => ({ output: ctx.args.input }),
      timeout: 5000,
      retry: {
        maxAttempts: 3,
        initialDelayMs: 100,
        maxDelayMs: 1000,
        backoffMultiplier: 2,
      },
    })

    expect(myTool.name).toBe('test_tool')
    expect(myTool.description).toBe('A test tool')
    expect(myTool.timeout).toBe(5000)
    expect(myTool.retry?.maxAttempts).toBe(3)
  })

  test('execute receives ctx with args', async () => {
    const executeMock = vi
      .fn<(...args: unknown[]) => unknown>()
      .mockReturnValue({ result: 'success' })
    const myTool = app.tool({
      name: 'test',
      description: 'Test',
      schema: z.object({ a: z.number() }),
      execute: executeMock,
    })

    const hookCtx = { ...mockCtx(), args: { a: 1 } } as ToolExecutionContext<{ a: number }, never>
    await myTool.execute!(hookCtx)
    expect(executeMock).toHaveBeenCalledWith(
      expect.objectContaining({ args: { a: 1 }, invocationId: 'inv-123' }),
    )
  })

  test('execute can modify session state', async () => {
    const myTool = app.tool({
      name: 'stateful',
      description: 'Modifies state',
      schema: z.object({ value: z.number() }),
      execute: (ctx) => {
        ctx.state['computed'] = ctx.args.value * 2
        return { stored: true }
      },
    })

    const session = new BaseSession('app', { id: 'test' })
    const hookCtx = {
      ...mockCtx(session),
      args: { value: 21 },
    } as ToolExecutionContext<{ value: number }, never>
    await myTool.execute!(hookCtx)
    expect(session.state['computed']).toBe(42)
  })

  test('schema validates input', () => {
    const myTool = app.tool({
      name: 'validated',
      description: 'Strict schema',
      schema: z.object({
        email: z.string().email(),
        count: z.number().positive(),
      }),
      execute: (ctx) => ctx.args,
    })

    expect(() => myTool.schema.parse({ email: 'invalid', count: 1 })).toThrow()
    expect(() => myTool.schema.parse({ email: 'test@example.com', count: 5 })).not.toThrow()
  })
})

describe('tool schema patterns', () => {
  test('optional and default fields', () => {
    const myTool = app.tool({
      name: 'test',
      description: 'Test',
      schema: z.object({
        required: z.string(),
        withDefault: z.number().default(10),
      }),
      execute: (ctx) => ctx.args,
    })
    expect(myTool.schema.parse({ required: 'value' })).toEqual({
      required: 'value',
      withDefault: 10,
    })
  })

  test('nested objects and arrays', () => {
    const myTool = app.tool({
      name: 'test',
      description: 'Test',
      schema: z.object({
        user: z.object({ name: z.string() }),
        tags: z.array(z.string()),
      }),
      execute: (ctx) => ctx.args,
    })
    const result = myTool.schema.parse({
      user: { name: 'Alice' },
      tags: ['a'],
    })
    expect(result.user.name).toBe('Alice')
    expect(result.tags).toEqual(['a'])
  })

  test('enums and unions', () => {
    const enumTool = app.tool({
      name: 'enum',
      description: 'Test',
      schema: z.object({ status: z.enum(['a', 'b']) }),
      execute: (ctx) => ctx.args,
    })
    expect(() => enumTool.schema.parse({ status: 'a' })).not.toThrow()
    expect(() => enumTool.schema.parse({ status: 'x' })).toThrow()

    const unionTool = app.tool({
      name: 'union',
      description: 'Test',
      schema: z.object({ id: z.union([z.string(), z.number()]) }),
      execute: (ctx) => ctx.args,
    })
    expect(unionTool.schema.parse({ id: 'abc' })).toEqual({ id: 'abc' })
    expect(unionTool.schema.parse({ id: 123 })).toEqual({ id: 123 })
  })
})

describe('tool lifecycle hooks', () => {
  const mockCtx = (session = new BaseSession('app', { id: 'test' })): ToolContext =>
    ({
      session,
      state: createStateAccessor(session, 'inv-123'),
      invocationId: 'inv-123',
      callId: 'call-123',
    }) as unknown as ToolContext

  test('prepare hook transforms args before execute', async () => {
    const myTool = app.tool({
      name: 'test',
      description: 'Test',
      schema: z.object({ value: z.number() }),
      prepare: (ctx) => ({ value: ctx.args.value * 2 }),
      execute: (ctx) => ({ result: ctx.args.value }),
    })

    const result = await runToolWithLifecycle(myTool, { value: 5 }, mockCtx())
    expect(result).toEqual({ result: 10 })
  })

  test('prepare hook can return void to keep original args', async () => {
    const prepareMock = vi.fn<(...args: unknown[]) => unknown>()
    const myTool = app.tool({
      name: 'test',
      description: 'Test',
      schema: z.object({ value: z.number() }),
      prepare: (ctx) => {
        prepareMock(ctx.args)
        return undefined
      },
      execute: (ctx) => ({ result: ctx.args.value }),
    })

    const result = await runToolWithLifecycle(myTool, { value: 5 }, mockCtx())
    expect(prepareMock).toHaveBeenCalledWith({ value: 5 })
    expect(result).toEqual({ result: 5 })
  })

  test('finalize hook transforms result after execute', async () => {
    const myTool = app.tool({
      name: 'test',
      description: 'Test',
      schema: z.object({ value: z.number() }),
      execute: (ctx) => ({ result: ctx.args.value }),
      finalize: (ctx) => ({ ...ctx.result!, finalized: true }),
    })

    const result = await runToolWithLifecycle(myTool, { value: 5 }, mockCtx())
    expect(result).toEqual({ result: 5, finalized: true })
  })

  test('finalize hook can return void to keep original result', async () => {
    const session = new BaseSession('app', { id: 'test' })
    const myTool = app.tool({
      name: 'test',
      description: 'Test',
      schema: z.object({ value: z.number() }),
      execute: (ctx) => ({ result: ctx.args.value }),
      finalize: (ctx) => {
        ctx.state['logged'] = ctx.result!.result
      },
    })

    const result = await runToolWithLifecycle(myTool, { value: 42 }, mockCtx(session))
    expect(result).toEqual({ result: 42 })
    expect(session.state['logged']).toBe(42)
  })

  test('prepare and finalize hooks work together', async () => {
    const myTool = app.tool({
      name: 'test',
      description: 'Test',
      schema: z.object({ value: z.number() }),
      prepare: (ctx) => ({ value: ctx.args.value + 10 }),
      execute: (ctx) => ({ computed: ctx.args.value * 2 }),
      finalize: (ctx) => ({ ...ctx.result!, done: true }),
    })

    const result = await runToolWithLifecycle(myTool, { value: 5 }, mockCtx())
    expect(result).toEqual({ computed: 30, done: true })
  })

  test('finalize receives prepared args', async () => {
    let receivedArgs: { value: number } | null = null
    const myTool = app.tool({
      name: 'test',
      description: 'Test',
      schema: z.object({ value: z.number() }),
      prepare: (ctx) => ({ value: ctx.args.value * 3 }),
      execute: (ctx) => ({ result: ctx.args.value }),
      finalize: (ctx) => {
        receivedArgs = ctx.args
        return ctx.result
      },
    })

    await runToolWithLifecycle(myTool, { value: 7 }, mockCtx())
    expect(receivedArgs).toEqual({ value: 21 })
  })
})

describe('safeParseToolArgs', () => {
  test('passes through valid args unchanged', () => {
    const schema = z.object({ message: z.string(), key: z.string().optional() })
    const result = safeParseToolArgs({ message: 'hello', key: 'abc' }, schema)
    expect(result.success).toBe(true)
    expect(result.success && result.data).toEqual({ message: 'hello', key: 'abc' })
  })

  test('coerces {} on optional string field to undefined', () => {
    const schema = z.object({ message: z.string(), key: z.string().optional() })
    const rawResult = schema.safeParse({ message: 'hello', key: {} })
    expect(rawResult.success).toBe(false)

    const result = safeParseToolArgs({ message: 'hello', key: {} }, schema)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.message).toBe('hello')
      expect(result.data.key).toBeUndefined()
    }
  })

  test('coerces null on optional string field to undefined', () => {
    const schema = z.object({ message: z.string(), key: z.string().optional() })
    const result = safeParseToolArgs({ message: 'hello', key: null }, schema)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.key).toBeUndefined()
    }
  })

  test('does not treat {} as absent for optional object fields', () => {
    const schema = z.object({ meta: z.object({ tag: z.string() }).optional() })
    const result = safeParseToolArgs({ meta: {} }, schema)
    expect(result.success).toBe(false)
  })

  test('coerces number to string for string field', () => {
    const schema = z.object({ query: z.string() })
    const result = safeParseToolArgs({ query: 42 }, schema)
    expect(result.success).toBe(true)
    expect(result.success && result.data.query).toBe('42')
  })

  test('coerces string number to number field', () => {
    const schema = z.object({ count: z.number() })
    const result = safeParseToolArgs({ count: '5' }, schema)
    expect(result.success).toBe(true)
    expect(result.success && result.data.count).toBe(5)
  })

  test('coerces string boolean to boolean field', () => {
    const schema = z.object({ confirm: z.boolean() })
    const result = safeParseToolArgs({ confirm: 'true' }, schema)
    expect(result.success).toBe(true)
    expect(result.success && result.data.confirm).toBe(true)
  })

  test('falls back to safeParse error for genuinely invalid args', () => {
    const schema = z.object({ email: z.string().email() })
    const result = safeParseToolArgs({ email: 'not-an-email' }, schema)
    expect(result.success).toBe(false)
  })

  test('handles already-valid args without coercion', () => {
    const schema = z.object({ a: z.number(), b: z.boolean() })
    const result = safeParseToolArgs({ a: 1, b: true }, schema)
    expect(result.success).toBe(true)
    expect(result.success && result.data).toEqual({ a: 1, b: true })
  })

  test('normalizes null on optional enum field', () => {
    const schema = z.object({ status: z.enum(['a', 'b']).optional() })
    const result = safeParseToolArgs({ status: null }, schema)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.status).toBeUndefined()
    }
  })

  test('normalizes {} on optional number field', () => {
    const schema = z.object({ count: z.number().optional() })
    const result = safeParseToolArgs({ count: {} }, schema)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.count).toBeUndefined()
    }
  })

  test('normalizes null on optional boolean field', () => {
    const schema = z.object({ flag: z.boolean().optional() })
    const result = safeParseToolArgs({ flag: null }, schema)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.flag).toBeUndefined()
    }
  })
})
