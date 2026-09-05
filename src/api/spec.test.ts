import { z } from 'zod'

import type { StateSchema } from '../types/schema'

import { openai } from '../providers'
import { adk } from './app'
import { spec } from './spec'

const testSchema = {
  session: {
    mode: z.enum(['triage', 'consultation', 'followup']),
    count: z.number(),
  },
} satisfies StateSchema

describe('spec.tool', () => {
  it('creates stateless tool spec', () => {
    const calc = spec.tool()({
      name: 'calc',
      description: 'Calculate',
      schema: z.object({ x: z.number() }),
      execute: (ctx) => ctx.args.x * 2,
    })

    const app = adk()

    expect(app.use(calc).name).toBe('calc')
  })

  it('creates stateful tool spec with typed state', () => {
    const counter = spec.tool(testSchema)({
      name: 'increment',
      description: 'Increment',
      schema: z.object({ amount: z.number() }),
      execute: (ctx) => {
        ctx.state.count = (ctx.state.count ?? 0) + ctx.args.amount
        return ctx.state.count
      },
    })

    const app = adk({ schema: testSchema })
    expect(app.use(counter).name).toBe('increment')
  })
})

describe('spec.step', () => {
  it('creates stateless step spec', () => {
    const logStep = spec.step()((_app) => ({
      name: 'log',
      execute: () => console.log('executed'),
    }))

    const app = adk()

    expect(app.use(logStep).name).toBe('log')
  })

  it('creates stateful step spec', () => {
    const setMode = spec.step(testSchema)((_app) => ({
      name: 'set_mode',
      execute: (ctx) => {
        ctx.state.mode = 'consultation'
      },
    }))

    const app = adk({ schema: testSchema })
    expect(app.use(setMode).name).toBe('set_mode')
  })

  it('can return agents from execute', () => {
    const Inner = spec.agent()((_app) => ({
      name: 'inner',
      model: openai('gpt-4o-mini'),
      context: [],
    }))

    const Router = spec.step()((_app) => ({
      name: 'router',
      execute: () => _app.use(Inner),
    }))

    const myApp = adk()
    expect(myApp.use(Router).name).toBe('router')
  })

  it('stateful step can return stateful agents', () => {
    const Inner = spec.agent(testSchema)((_app) => ({
      name: 'inner',
      model: openai('gpt-4o-mini'),
      context: [],
    }))

    const Router = spec.step(testSchema)((_app) => ({
      name: 'router',
      execute: (ctx) => {
        if (ctx.state.mode === 'triage') {
          return _app.use(Inner)
        }
      },
    }))

    const myApp = adk({ schema: testSchema })
    expect(myApp.use(Router).name).toBe('router')
  })
})

describe('spec.context', () => {
  it('creates stateless context spec', () => {
    const timestamp = spec.context()((ctx) => ({
      ...ctx,
      events: [
        ...ctx.events,
        {
          type: 'system' as const,
          id: 'ts',
          invocationId: ctx.invocationId,
          agentName: ctx.agentName,
          createdAt: Date.now(),
          text: new Date().toISOString(),
        },
      ],
    }))

    const app = adk()

    expect(typeof app.use(timestamp)).toBe('function')
  })

  it('creates stateful context spec', () => {
    const modeContext = spec.context(testSchema)((ctx) => ({
      ...ctx,
      events: [
        ...ctx.events,
        {
          type: 'system' as const,
          id: 'mode',
          invocationId: ctx.invocationId,
          agentName: ctx.agentName,
          createdAt: Date.now(),
          text: `Mode: ${ctx.state.mode}`,
        },
      ],
    }))

    const app = adk({ schema: testSchema })
    expect(typeof app.use(modeContext)).toBe('function')
  })
})

describe('spec.agent', () => {
  it('creates stateless agent spec', () => {
    const Helper = spec.agent()((_app) => ({
      name: 'helper',
      model: openai('gpt-4o-mini'),
      context: [app.context.system('I help'), app.context.history()],
    }))

    const app = adk()

    expect(app.use(Helper).name).toBe('helper')
  })

  it('creates stateful agent spec with typed state in context', () => {
    const Helper = spec.agent(testSchema)((_app) => ({
      name: 'helper',
      model: openai('gpt-4o-mini'),
      context: [app.context.system((ctx) => `Mode: ${ctx.state.mode}`), app.context.history()],
    }))

    const app = adk({ schema: testSchema })
    expect(app.use(Helper).name).toBe('helper')
  })

  it('config can include output key shorthand with schema', () => {
    const schema = {
      session: {
        diagnosis: z.object({ condition: z.string() }),
      },
    } satisfies StateSchema

    const Diagnoser = spec.agent(schema)((_app) => ({
      name: 'diagnoser',
      model: openai('gpt-4o'),
      context: [],
      output: 'diagnosis',
    }))

    const app = adk({ schema })
    expect(app.use(Diagnoser).output).toBeDefined()
  })

  it('keeps an optional or defaulted primitive session key as a raw-text output key', () => {
    const schema = {
      session: {
        reply: z.string().optional(),
        score: z.number().nullable().default(null),
        report: z.object({ summary: z.string() }).optional(),
      },
    } satisfies StateSchema

    const app = adk({ schema })
    const agentFor = (output: 'reply' | 'score' | 'report') =>
      app.use(
        spec.agent(schema)((_app) => ({
          name: `agent-${output}`,
          model: openai('gpt-4o'),
          context: [],
          output,
        })),
      )

    // A wrapped primitive must not fall through to the schema path, which parses prose as a value.
    expect(agentFor('reply').output).toEqual({ key: 'reply' })
    expect(agentFor('score').output).toEqual({ key: 'score' })
    expect(agentFor('report').output).toMatchObject({ key: 'report', mode: 'native' })
  })
})

describe('spec.sequence', () => {
  it('creates stateless sequence spec', () => {
    const Pipeline = spec.sequence()((_app) => ({
      name: 'pipeline',
      runnables: [],
    }))

    const app = adk()
    expect(app.use(Pipeline).kind).toBe('sequence')
  })

  it('creates stateful sequence spec', () => {
    const Pipeline = spec.sequence(testSchema)((_app) => ({
      name: 'pipeline',
      runnables: [],
    }))

    const app = adk({ schema: testSchema })
    expect(app.use(Pipeline).kind).toBe('sequence')
  })
})

describe('spec.parallel', () => {
  it('creates stateless parallel spec', () => {
    const Fanout = spec.parallel()((_app) => ({
      name: 'fanout',
      runnables: [],
    }))

    const app = adk()
    expect(app.use(Fanout).kind).toBe('parallel')
  })

  it('creates stateful parallel spec', () => {
    const Fanout = spec.parallel(testSchema)((_app) => ({
      name: 'fanout',
      runnables: [],
    }))

    const app = adk({ schema: testSchema })
    expect(app.use(Fanout).kind).toBe('parallel')
  })
})

describe('spec.loop', () => {
  it('creates stateless loop spec', () => {
    const agent = spec.agent()((_app) => ({
      name: 'inner',
      model: openai('gpt-4o-mini'),
      context: [],
    }))

    const Chat = spec.loop()((_app) => ({
      name: 'chat',
      maxIterations: 10,
      runnable: _app.use(agent),
      while: () => true,
    }))

    const myApp = adk()
    expect(myApp.use(Chat).kind).toBe('loop')
  })

  it('creates stateful loop spec with typed while condition', () => {
    const Inner = spec.agent(testSchema)((_app) => ({
      name: 'inner',
      model: openai('gpt-4o-mini'),
      context: [],
    }))

    const Chat = spec.loop(testSchema)((_app) => ({
      name: 'chat',
      maxIterations: 100,
      runnable: _app.use(Inner),
      while: (ctx) => ctx.state.mode !== 'followup',
    }))

    const app = adk({ schema: testSchema })
    expect(app.use(Chat).kind).toBe('loop')
  })
})

describe('composition', () => {
  it('stateless tool in stateless agent', () => {
    const calc = spec.tool()({
      name: 'calc',
      description: 'Calculate',
      schema: z.object({ x: z.number() }),
      execute: (ctx) => ctx.args.x * 2,
    })

    const Helper = spec.agent()((_app) => ({
      name: 'helper',
      model: openai('gpt-4o-mini'),
      context: [],
      tools: [_app.use(calc)],
    }))

    const app = adk()
    const helper = app.use(Helper)
    expect(helper.tools).toHaveLength(1)
  })

  it('stateful tool in stateful agent', () => {
    const counter = spec.tool(testSchema)({
      name: 'increment',
      description: 'Increment',
      schema: z.object({ amount: z.number() }),
      execute: (ctx) => ctx.state.count ?? 0,
    })

    const Helper = spec.agent(testSchema)((_app) => ({
      name: 'helper',
      model: openai('gpt-4o-mini'),
      context: [],
      tools: [_app.use(counter)],
    }))

    const app = adk({ schema: testSchema })
    expect(app.use(Helper).tools).toHaveLength(1)
  })

  it('nested sequences and agents', () => {
    const A1 = spec.agent()((_app) => ({
      name: 'a1',
      model: openai('gpt-4o-mini'),
      context: [],
    }))

    const A2 = spec.agent()((_app) => ({
      name: 'a2',
      model: openai('gpt-4o-mini'),
      context: [],
    }))

    const Inner = spec.sequence()((_app) => ({
      name: 'inner',
      runnables: [_app.use(A1), _app.use(A2)],
    }))

    const Outer = spec.parallel()((_app) => ({
      name: 'outer',
      runnables: [_app.use(Inner)],
    }))

    const app = adk()
    expect(app.use(Outer).runnables).toHaveLength(1)
    expect(app.use(Outer).runnables[0].kind).toBe('sequence')
  })
})
