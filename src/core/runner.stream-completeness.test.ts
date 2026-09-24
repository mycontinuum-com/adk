import { z } from 'zod'

import type { Event, StreamEvent } from '../types/events'
import type { FunctionTool, Runnable } from '../types/runnables'
import type { RunResult } from '../types/runtime'
import type { Session } from '../types/session'

import { agent, loop, parallel, sequence } from '../agents'
import { adk } from '../api'
import { includeHistory } from '../context'
import { openai } from '../providers'
import { BaseSession, createEventId } from '../session'
import { MockAdapter } from '../testing'
import { BaseRunner } from './index'
import { resolveRunResult } from './runner'

const app = adk()

const recordAllergy = app.tool({
  name: 'record_allergy',
  description: 'Record an allergy',
  schema: z.object({ allergy: z.string() }),
  execute: (ctx) => {
    ctx.state.lastRecorded = ctx.args.allergy
    ctx.state.patient.allergy = ctx.args.allergy
    return { recorded: true }
  },
})

const askClinician = app.tool({
  name: 'ask_clinician',
  description: 'Ask a clinician',
  schema: z.object({ question: z.string() }),
  yieldSchema: z.object({ answer: z.string() }),
  finalize: (ctx) => {
    ctx.state.patient.dose = ctx.input!.answer
    return { answer: ctx.input!.answer }
  },
})

const checkChart = app.step({
  name: 'check_chart',
  execute: (ctx) => {
    ctx.note('chart checked', { kind: 'mark' })
  },
})

const noteTool = app.tool({
  name: 'note_tool',
  description: 'Annotate the run',
  schema: z.object({}),
  execute: (ctx) => {
    ctx.note('tool')
    return { ok: true }
  },
})

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function hookedLedgerKeys(hooked: StreamEvent[]): string[] {
  return keys(hooked.filter((e) => e.type !== 'assistant_delta' && e.type !== 'thought_delta'))
}

function recorder(name: string) {
  return agent({
    name,
    model: openai('gpt-4o-mini'),
    context: [includeHistory()],
    tools: [recordAllergy, askClinician],
  })
}

function recordThenReply(allergy: string) {
  return [{ toolCalls: [{ name: 'record_allergy', args: { allergy } }] }, { text: 'Recorded.' }]
}

function newSession() {
  const session = new BaseSession('stream-completeness', { scopes: { patient: 'patient-1' } })
  session.input.message('Please record my allergy')
  return session
}

async function drive(adapter: MockAdapter, runnable: Runnable, session: Session = newSession()) {
  const runner = new BaseRunner({ adapters: { openai: adapter } })
  const eventsBeforeRun = session.events.length
  const hooked: StreamEvent[] = []

  const streamed: StreamEvent[] = []
  let thrown: unknown
  let result
  try {
    const stream = runner.run(runnable, session, { hooks: [{ onEvent: (e) => hooked.push(e) }] })
    const iterator = stream[Symbol.asyncIterator]()
    let next = await iterator.next()
    while (!next.done) {
      streamed.push(next.value)
      next = await iterator.next()
    }
    result = next.value
  } catch (error) {
    thrown = error
  }
  expect(hooked).toEqual(streamed)

  return {
    result,
    thrown,
    session,
    streamedWithDeltas: streamed,
    streamed: keys(
      streamed.filter((e) => e.type !== 'assistant_delta' && e.type !== 'thought_delta'),
    ),
    ledger: keys(session.events.slice(eventsBeforeRun)),
    hooked,
  }
}

function keys(events: readonly (Event | StreamEvent)[]): string[] {
  return events.map((e) => `${e.type}:${e.id}`)
}

function countOf(eventKeys: string[], type: string): number {
  return eventKeys.filter((key) => key.startsWith(`${type}:`)).length
}

describe('a run streams, and its hooks observe, every event its invocations append, in ledger order', () => {
  test('plain agent turn', async () => {
    const adapter = new MockAdapter({ responses: [{ text: 'Hello.' }] })

    const { result, streamed, ledger } = await drive(adapter, recorder('plain'))

    expect(result?.status).toBe('completed')
    expect(streamed).toEqual(ledger)
    expect(ledger.length).toBe(5)
  })

  test('reply short-circuited by beforeAgent', async () => {
    const short = agent({
      name: 'short',
      model: openai('gpt-4o-mini'),
      context: [includeHistory()],
      hooks: [{ beforeAgent: () => 'Handled without the model.' }],
    })

    const { streamed, ledger, hooked } = await drive(new MockAdapter(), short)

    expect(streamed).toEqual(ledger)
    expect(countOf(streamed, 'assistant')).toBe(1)
    expect(hookedLedgerKeys(hooked)).toEqual(ledger)
  })

  test('yielding tool', async () => {
    const adapter = new MockAdapter({
      responses: [{ toolCalls: [{ name: 'ask_clinician', args: { question: 'Dose?' } }] }],
    })

    const { result, streamed, ledger } = await drive(adapter, recorder('yielding'))

    expect(result?.status).toBe('yielded_tool')
    expect(streamed).toEqual(ledger)
    expect(countOf(streamed, 'tool_yield')).toBe(1)
  })

  test('resuming an answered yield', async () => {
    const adapter = new MockAdapter({
      responses: [
        { toolCalls: [{ name: 'ask_clinician', args: { question: 'Dose?' } }] },
        { text: 'Noted.' },
      ],
    })
    const asker = recorder('asker')
    const first = await drive(adapter, asker)
    const yielded = first.session.events.find((e) => e.type === 'tool_yield')!
    first.session.input.tool({
      callId: (yielded as { callId: string }).callId,
      input: { answer: '5mg' },
    })

    const { result, streamed, ledger } = await drive(adapter, asker, first.session)

    expect(result?.status).toBe('completed')
    expect(streamed).toEqual(ledger)
    expect(countOf(streamed, 'tool_result')).toBe(1)
    expect(countOf(streamed, 'state_change')).toBe(1)
  })

  test('tool writing session and patient state', async () => {
    const adapter = new MockAdapter({ responses: recordThenReply('penicillin') })

    const { streamed, ledger } = await drive(adapter, recorder('writer'))

    expect(streamed).toEqual(ledger)
    expect(countOf(streamed, 'state_change')).toBe(2)
  })

  test('step annotating with ctx.note', async () => {
    const { streamed, ledger } = await drive(new MockAdapter(), checkChart)

    expect(streamed).toEqual(ledger)
    expect(countOf(streamed, 'annotation')).toBe(1)
  })

  test('loop', async () => {
    const adapter = new MockAdapter({
      responses: [...recordThenReply('penicillin'), ...recordThenReply('latex')],
    })

    const { streamed, ledger } = await drive(
      adapter,
      loop({
        name: 'repeat',
        runnable: recorder('looped'),
        maxIterations: 2,
        while: (ctx) => ctx.iteration < 2,
      }),
    )

    expect(streamed).toEqual(ledger)
    expect(countOf(streamed, 'state_change')).toBe(4)
  })

  test('sequence', async () => {
    const adapter = new MockAdapter({
      responses: [...recordThenReply('penicillin')],
    })

    const { streamed, ledger } = await drive(
      adapter,
      sequence({ name: 'pipeline', runnables: [recorder('first'), checkChart] }),
    )

    expect(streamed).toEqual(ledger)
    expect(countOf(streamed, 'state_change')).toBe(2)
    expect(countOf(streamed, 'annotation')).toBe(1)
  })

  test('parallel branches and the merge step', async () => {
    const adapter = new MockAdapter()
    adapter.addResponses('agent:left', [
      { toolCalls: [{ name: 'record_allergy', args: { allergy: 'penicillin' } }] },
      { text: 'Recorded left.', streamChunks: true },
    ])
    adapter.addResponses('agent:right', [
      { toolCalls: [{ name: 'record_allergy', args: { allergy: 'latex' } }] },
      { text: 'Recorded right.', streamChunks: true },
    ])

    const { streamed, ledger, streamedWithDeltas, hooked } = await drive(
      adapter,
      parallel({
        name: 'fanout',
        runnables: [recorder('left'), recorder('right')],
        merge: (ctx) => {
          ctx.state.merged = true
          return [
            {
              id: createEventId(),
              type: 'annotation',
              kind: 'mark',
              label: 'merged',
              createdAt: Date.now(),
              invocationId: 'merge',
              agentName: 'fanout',
            },
          ]
        },
      }),
    )

    expect(streamed).toEqual(ledger)
    expect(countOf(streamed, 'state_change')).toBe(5)
    expect(countOf(streamed, 'annotation')).toBe(1)
    expect(hookedLedgerKeys(hooked).toSorted()).toEqual(ledger.toSorted())
    const sequenceOfTypes = streamedWithDeltas.map((e) => `${e.type}(${e.agentName})`).join(' ')
    expect(sequenceOfTypes).toMatch(/assistant_delta\(left\) model_end\(left\)/)
    expect(sequenceOfTypes).toMatch(/assistant_delta\(right\) model_end\(right\)/)
  })

  test('nested parallel', async () => {
    const adapter = new MockAdapter()
    adapter.addResponses('agent:outer_left', recordThenReply('penicillin'))
    adapter.addResponses('agent:inner_left', recordThenReply('latex'))
    adapter.addResponses('agent:inner_right', recordThenReply('aspirin'))

    const { streamed, ledger, hooked } = await drive(
      adapter,
      parallel({
        name: 'outer',
        runnables: [
          recorder('outer_left'),
          parallel({ name: 'inner', runnables: [recorder('inner_left'), recorder('inner_right')] }),
        ],
      }),
    )

    expect(streamed).toEqual(ledger)
    expect(hookedLedgerKeys(hooked).toSorted()).toEqual(ledger.toSorted())
  })

  test('notes from parallel branches reach the stream and hooks once', async () => {
    const stepNoter = app.step({
      name: 'step_noter',
      execute: (ctx) => {
        ctx.note('step')
      },
    })
    const toolNoter = agent({
      name: 'tool_noter',
      model: openai('gpt-4o-mini'),
      context: [includeHistory()],
      tools: [noteTool],
    })
    const adapter = new MockAdapter()
    adapter.addResponses('agent:tool_noter', [
      { toolCalls: [{ name: 'note_tool', args: {} }] },
      { text: 'Noted.' },
    ])

    const { streamed, ledger, hooked } = await drive(
      adapter,
      parallel({ name: 'noting', runnables: [stepNoter, toolNoter] }),
    )

    expect(streamed).toEqual(ledger)
    expect(countOf(ledger, 'annotation')).toBe(2)
    expect(hookedLedgerKeys(hooked).toSorted()).toEqual(ledger.toSorted())
  })

  test('ctx.note from an agent hook, tools, a yielding prepare and its finalize', async () => {
    const askWithNote = app.tool({
      name: 'ask_with_note',
      description: 'Ask a clinician and annotate',
      schema: z.object({ question: z.string() }),
      yieldSchema: z.object({ answer: z.string() }),
      prepare: (ctx) => {
        ctx.note('prepare')
        return ctx.args
      },
      finalize: (ctx) => {
        ctx.note('finalize')
        return { answer: ctx.input!.answer }
      },
    })
    const noter = agent({
      name: 'noter',
      model: openai('gpt-4o-mini'),
      context: [includeHistory()],
      tools: [noteTool, askWithNote],
      hooks: [
        {
          beforeAgent: (ctx) => {
            ctx.note('agent')
          },
        },
      ],
    })
    const adapter = new MockAdapter({
      responses: [
        { toolCalls: [{ name: 'note_tool', args: {} }] },
        {
          toolCalls: [
            { name: 'note_tool', args: {} },
            { name: 'ask_with_note', args: { question: 'Dose?' } },
          ],
        },
        { text: 'Noted.' },
      ],
    })
    const notes = (events: StreamEvent[]) =>
      events.flatMap((e) => (e.type === 'annotation' ? [e.message] : []))

    const first = await drive(adapter, noter)
    const yielded = first.session.events.find((e) => e.type === 'tool_yield')!
    first.session.input.tool({
      callId: (yielded as { callId: string }).callId,
      input: { answer: '5mg' },
    })
    const second = await drive(adapter, noter, first.session)

    expect(first.streamed).toEqual(first.ledger)
    expect(notes(first.streamedWithDeltas)).toEqual(['agent', 'tool', 'tool', 'prepare'])
    expect(notes(first.hooked)).toEqual(['agent', 'tool', 'tool', 'prepare'])
    expect(second.streamed).toEqual(second.ledger)
    expect(notes(second.streamedWithDeltas)).toEqual(['finalize', 'agent'])
    expect(notes(second.hooked)).toEqual(['finalize', 'agent'])
  })

  test('parallel branches resuming yields of the same tool answer only their own', async () => {
    const finalized: string[] = []
    const askShared = app.tool({
      name: 'ask_shared',
      description: 'Ask a clinician',
      schema: z.object({}),
      yieldSchema: z.object({ answer: z.string() }),
      finalize: (ctx) => {
        finalized.push(ctx.callId)
        return { answer: ctx.input!.answer }
      },
    })
    const asker = (name: string) =>
      agent({ name, model: openai('gpt-4o-mini'), context: [includeHistory()], tools: [askShared] })
    const adapter = new MockAdapter()
    adapter.addResponses('agent:left', [
      { toolCalls: [{ name: 'ask_shared', args: {} }] },
      { text: 'Left done.' },
    ])
    adapter.addResponses('agent:right', [
      { toolCalls: [{ name: 'ask_shared', args: {} }] },
      { text: 'Right done.' },
    ])
    const both = parallel({ name: 'both', runnables: [asker('left'), asker('right')] })

    const first = await drive(adapter, both)
    const yielded = first.session.events.flatMap((e) => (e.type === 'tool_yield' ? [e.callId] : []))
    for (const callId of yielded) first.session.input.tool({ callId, input: { answer: 'ok' } })
    const second = await drive(adapter, both, first.session)

    const resultCallIds = second.session.events
      .slice(-second.ledger.length)
      .flatMap((e) => (e.type === 'tool_result' ? [e.callId] : []))
    expect(yielded).toHaveLength(2)
    expect(resultCallIds.toSorted()).toEqual(yielded.toSorted())
    expect(finalized.toSorted()).toEqual(yielded.toSorted())
    expect(second.streamed).toEqual(second.ledger)
  })

  test('parallel with failFast streams what it persists', async () => {
    const adapter = new MockAdapter()
    adapter.addResponses('agent:writer', recordThenReply('penicillin'))
    adapter.addResponses('agent:failing', [{ error: new Error('model exploded'), delayMs: 50 }])

    const { thrown, streamed, ledger } = await drive(
      adapter,
      parallel({
        name: 'strict',
        runnables: [recorder('writer'), recorder('failing')],
        failFast: true,
      }),
    )

    expect((thrown as Error).message).toBe('model exploded')
    expect(streamed).toEqual(ledger)
  })
})

function consultTool(handoff: 'run' | 'spawn' | 'dispatch') {
  return app.tool({
    name: 'consult_nurse',
    description: 'Ask the nurse to record an allergy',
    schema: z.object({ allergy: z.string() }),
    execute: async (ctx) => {
      const nurse = recorder('nurse')
      const task = `Record ${ctx.args.allergy}`
      if (handoff === 'run') return { reply: (await ctx.run(nurse, task)).output.text }
      if (handoff === 'spawn') return { reply: (await ctx.spawn(nurse, task).wait()).output.text }
      return { dispatched: ctx.dispatch(nurse, task).invocationId }
    },
  })
}

function coordinator(consult: FunctionTool<{ allergy: string }, object, never>) {
  return agent({
    name: 'coordinator',
    model: openai('gpt-4o-mini'),
    context: [includeHistory()],
    tools: [consult],
  })
}

function consultThenReply() {
  return [
    { toolCalls: [{ name: 'consult_nurse', args: { allergy: 'penicillin' } }] },
    { text: 'The nurse recorded it.' },
  ]
}

function trace(events: readonly StreamEvent[]): string[] {
  return events.map((e) => `${e.type} ${e.agentName ?? '-'}`)
}

const nurseHandoff = [
  'invocation_start nurse',
  'user nurse',
  'model_start nurse',
  'model_end nurse',
  'tool_call nurse',
  'state_change -',
  'state_change -',
  'tool_result nurse',
  'model_start nurse',
  'model_end nurse',
  'assistant nurse',
  'invocation_end nurse',
]

function byInvocation(events: readonly StreamEvent[]): Record<string, string[]> {
  const grouped: Record<string, string[]> = {}
  for (const event of events) {
    const key = event.invocationId ?? '-'
    ;(grouped[key] ??= []).push(`${event.type}:${event.id}`)
  }
  return grouped
}

describe('a run streams the nested runs it hands off to, in ledger order', () => {
  test.each(['run', 'spawn'] as const)('ctx.%s', async (handoff) => {
    const adapter = new MockAdapter()
    adapter.addResponses('agent:coordinator', consultThenReply())
    adapter.addResponses('agent:nurse', recordThenReply('penicillin'))

    const { streamed, ledger, streamedWithDeltas } = await drive(
      adapter,
      coordinator(consultTool(handoff)),
    )

    expect(streamed).toEqual(ledger)
    const start = streamedWithDeltas.find(
      (e) => e.type === 'invocation_start' && e.agentName === 'nurse',
    )
    expect(start).toMatchObject({ handoffOrigin: { type: handoff } })
    expect(trace(streamedWithDeltas)).toEqual([
      'invocation_start coordinator',
      'model_start coordinator',
      'model_end coordinator',
      'tool_call coordinator',
      ...nurseHandoff,
      'tool_result coordinator',
      'model_start coordinator',
      'model_end coordinator',
      'assistant coordinator',
      'invocation_end coordinator',
    ])
  })

  test('ctx.run that throws still closes its invocation', async () => {
    const adapter = new MockAdapter()
    adapter.addResponses('agent:coordinator', consultThenReply())
    adapter.addResponses('agent:nurse', [{ error: new Error('model exploded') }])

    const { streamed, ledger, streamedWithDeltas } = await drive(
      adapter,
      coordinator(consultTool('run')),
    )

    expect(streamed).toEqual(ledger)
    expect(
      streamedWithDeltas.filter((e) => e.type === 'invocation_end' && e.agentName === 'nurse'),
    ).toMatchObject([{ reason: 'error', error: 'model exploded' }])
  })

  // A dispatched run proceeds alongside its parent, so the two interleave in arrival order. The
  // nurse is slowed so it outlives the coordinator, and the stream must stay open for its end.
  test('ctx.dispatch', async () => {
    const adapter = new MockAdapter()
    adapter.addResponses('agent:coordinator', consultThenReply())
    const [nurseCall, nurseReply] = recordThenReply('penicillin')
    adapter.addResponses('agent:nurse', [{ ...nurseCall, delayMs: 30 }, nurseReply])
    const session = newSession()
    const eventsBeforeRun = session.events.length

    const { streamed, ledger, streamedWithDeltas } = await drive(
      adapter,
      coordinator(consultTool('dispatch')),
      session,
    )

    expect(streamed.toSorted()).toEqual(ledger.toSorted())
    expect(byInvocation(streamedWithDeltas)).toEqual(
      byInvocation(session.events.slice(eventsBeforeRun)),
    )
    const nurseInvocation = streamedWithDeltas.find((e) => e.agentName === 'nurse')!.invocationId
    expect(trace(streamedWithDeltas.filter((e) => e.invocationId === nurseInvocation))).toEqual(
      nurseHandoff,
    )
    expect(trace(streamedWithDeltas).slice(-2)).toEqual(['assistant nurse', 'invocation_end nurse'])
  })

  test('an agent inside a sequence keeps the stream open for its dispatch', async () => {
    const adapter = new MockAdapter()
    adapter.addResponses('agent:coordinator', consultThenReply())
    const [nurseCall, nurseReply] = recordThenReply('penicillin')
    adapter.addResponses('agent:nurse', [{ ...nurseCall, delayMs: 30 }, nurseReply])

    const { streamed, ledger, streamedWithDeltas } = await drive(
      adapter,
      sequence({ name: 'intake', runnables: [coordinator(consultTool('dispatch'))] }),
    )

    expect(streamed.toSorted()).toEqual(ledger.toSorted())
    expect(trace(streamedWithDeltas).slice(-2)).toEqual(['assistant nurse', 'invocation_end nurse'])
  })

  test('a parallel branch streams its handoff once, when the branch settles', async () => {
    const adapter = new MockAdapter()
    adapter.addResponses('agent:coordinator', consultThenReply())
    adapter.addResponses('agent:nurse', recordThenReply('penicillin'))
    adapter.addResponses('agent:solo', [{ text: 'Solo.' }])

    const { streamed, ledger, streamedWithDeltas } = await drive(
      adapter,
      parallel({
        name: 'fanout',
        runnables: [coordinator(consultTool('run')), recorder('solo')],
      }),
    )

    expect(streamed).toEqual(ledger)
    expect(trace(streamedWithDeltas.filter((e) => e.agentName === 'nurse'))).toEqual(
      nurseHandoff.filter((line) => !line.startsWith('state_change')),
    )
  })

  test('a transferred agent hands off too', async () => {
    const adapter = new MockAdapter()
    adapter.addResponses('agent:triage', [
      { toolCalls: [{ name: 'transfer_to_coordinator', args: {} }] },
    ])
    adapter.addResponses('agent:coordinator', consultThenReply())
    adapter.addResponses('agent:nurse', recordThenReply('penicillin'))
    const transfer = app.tool({
      name: 'transfer_to_coordinator',
      description: 'Hand the patient to the coordinator',
      schema: z.object({}),
      execute: () => coordinator(consultTool('spawn')),
    })
    const triage = agent({
      name: 'triage',
      model: openai('gpt-4o-mini'),
      context: [includeHistory()],
      tools: [transfer],
    })

    const { streamed, ledger, streamedWithDeltas } = await drive(adapter, triage)

    expect(streamed).toEqual(ledger)
    expect(trace(streamedWithDeltas.filter((e) => e.agentName === 'nurse'))).toEqual(
      nurseHandoff.filter((line) => !line.startsWith('state_change')),
    )
  })

  test('a separate run a tool starts on the same session keeps its events to itself', async () => {
    const adapter = new MockAdapter()
    adapter.addResponses('agent:coordinator', consultThenReply())
    adapter.addResponses('agent:nurse', recordThenReply('penicillin'))
    const innerStreamed: StreamEvent[] = []
    const consultSeparately = app.tool({
      name: 'consult_nurse',
      description: 'Ask the nurse to record an allergy',
      schema: z.object({ allergy: z.string() }),
      execute: async (ctx) => {
        const inner = new BaseRunner({ adapters: { openai: adapter } })
        for await (const event of inner.run(recorder('nurse'), ctx.session)) {
          innerStreamed.push(event)
        }
        return { recorded: true }
      },
    })

    const { streamedWithDeltas, session } = await drive(adapter, coordinator(consultSeparately))

    expect(streamedWithDeltas.filter((e) => e.agentName === 'nurse')).toEqual([])
    expect(countOf(keys(streamedWithDeltas), 'state_change')).toBe(0)
    expect(countOf(keys(innerStreamed), 'state_change')).toBe(2)
    expect(countOf(keys(session.events), 'state_change')).toBe(2)
  })
})

function listenerCount(session: Session): number {
  return (session as unknown as { stateChangeListeners: Set<unknown> }).stateChangeListeners.size
}

describe('state changes reach the hooks of the run they belong to', () => {
  test('a write outside any invocation reaches no run', async () => {
    const touchSession = app.tool({
      name: 'touch_session',
      description: 'Write session state without an invocation',
      schema: z.object({}),
      execute: (ctx) => {
        ctx.session.state.touched = true
        return { ok: true }
      },
    })
    const toucher = agent({
      name: 'toucher',
      model: openai('gpt-4o-mini'),
      context: [includeHistory()],
      tools: [touchSession],
    })
    const adapter = new MockAdapter({
      responses: [{ toolCalls: [{ name: 'touch_session', args: {} }] }, { text: 'Done.' }],
    })

    const { streamedWithDeltas, session } = await drive(adapter, toucher)

    expect(session.events.filter((e) => e.type === 'state_change')).toMatchObject([
      { invocationId: undefined, changes: [{ key: 'touched', newValue: true }] },
    ])
    expect(streamedWithDeltas.filter((e) => e.type === 'state_change')).toEqual([])
  })

  test('hooks of runs aborted before they were read receive nothing from a later run', async () => {
    const adapter = new MockAdapter()
    adapter.addResponses('agent:later', recordThenReply('penicillin'))
    const runner = new BaseRunner({ adapters: { openai: adapter } })
    const session = newSession()
    const abortedHooks: StreamEvent[] = []

    for (let i = 0; i < 3; i++) {
      const stream = runner.run(recorder('abandoned'), session, {
        hooks: [{ onEvent: (e) => abortedHooks.push(e) }],
      })
      stream.abort()
    }
    expect(listenerCount(session)).toBe(0)
    await sleep(20)
    const later = await drive(adapter, recorder('later'), session)

    expect(countOf(later.ledger, 'state_change')).toBe(2)
    expect(abortedHooks.filter((e) => e.type === 'state_change')).toEqual([])
  })

  test('a run aborted mid-parallel stops forwarding, and a later run never reaches its hooks', async () => {
    const slowWrite = app.tool({
      name: 'slow_write',
      description: 'Write state slowly',
      schema: z.object({}),
      execute: async (ctx) => {
        ctx.state.slowStart = true
        await sleep(60)
        ctx.state.slowEnd = true
        return { ok: true }
      },
    })
    const busy = agent({
      name: 'busy',
      model: openai('gpt-4o-mini'),
      context: [includeHistory()],
      tools: [slowWrite],
    })
    const adapter = new MockAdapter()
    adapter.addResponses('agent:busy', [
      { toolCalls: [{ name: 'slow_write', args: {} }] },
      { text: 'Done.' },
    ])
    adapter.addResponses('agent:fresh', recordThenReply('latex'))
    const runner = new BaseRunner({ adapters: { openai: adapter } })
    const session = newSession()
    const abortedHooks: StreamEvent[] = []

    const first = runner.run(parallel({ name: 'aborted', runnables: [busy] }), session, {
      hooks: [
        {
          onEvent: (e) => {
            abortedHooks.push(e)
            if (e.type === 'tool_call') first.abort()
          },
        },
      ],
    })
    await expect(first).rejects.toThrow('Aborted')
    const seenAtAbort = abortedHooks.length
    session.input.message('Again')
    const second = await drive(adapter, recorder('fresh'), session)
    await sleep(120)

    expect(countOf(second.ledger, 'state_change')).toBe(2)
    expect(abortedHooks.slice(seenAtAbort).filter((e) => e.type === 'state_change')).toEqual([])
  })

  test.each(['spawn', 'dispatch'] as const)(
    'hooks see state written by %s work after the run settles',
    async (kind) => {
      const lateWrite = app.tool({
        name: 'late_write',
        description: 'Write state after a delay',
        schema: z.object({}),
        execute: async (ctx) => {
          await sleep(40)
          ctx.state.late = true
          ctx.state.patient.late = true
          return { ok: true }
        },
      })
      const worker = agent({
        name: `worker_${kind}`,
        model: openai('gpt-4o-mini'),
        context: [includeHistory()],
        tools: [lateWrite],
      })
      const startWorker = app.tool({
        name: 'start_worker',
        description: 'Start background work',
        schema: z.object({}),
        execute: (ctx) => {
          ctx[kind](worker, 'Go')
          return { started: true }
        },
      })
      const starter = agent({
        name: `coordinator_${kind}`,
        model: openai('gpt-4o-mini'),
        context: [includeHistory()],
        tools: [startWorker],
      })
      const adapter = new MockAdapter()
      adapter.addResponses(`agent:coordinator_${kind}`, [
        { toolCalls: [{ name: 'start_worker', args: {} }] },
        { text: 'Started.' },
      ])
      adapter.addResponses(`agent:worker_${kind}`, [
        { toolCalls: [{ name: 'late_write', args: {} }] },
        { text: 'Written.' },
      ])

      const { session, hooked } = await drive(adapter, starter)
      await vi.waitFor(() =>
        expect(session.events.filter((e) => e.type === 'state_change')).toHaveLength(2),
      )

      expect(keys(hooked.filter((e) => e.type === 'state_change'))).toEqual(
        keys(session.events.filter((e) => e.type === 'state_change')),
      )
    },
  )

  test('work beneath a dispatch keeps its state changes after the run settles', async () => {
    const lateWrite = app.tool({
      name: 'late_write',
      description: 'Write state after a delay',
      schema: z.object({}),
      execute: async (ctx) => {
        await sleep(40)
        ctx.state.late = true
        return { ok: true }
      },
    })
    const worker = agent({
      name: 'nested_worker',
      model: openai('gpt-4o-mini'),
      context: [includeHistory()],
      tools: [lateWrite],
    })
    const startWorker = app.tool({
      name: 'start_worker',
      description: 'Start background work',
      schema: z.object({}),
      execute: (ctx) => {
        ctx.dispatch(sequence({ name: 'work', runnables: [worker] }), 'Go')
        return { started: true }
      },
    })
    const adapter = new MockAdapter()
    adapter.addResponses('agent:starter', [
      { toolCalls: [{ name: 'start_worker', args: {} }] },
      { text: 'Started.' },
    ])
    adapter.addResponses('agent:nested_worker', [
      { toolCalls: [{ name: 'late_write', args: {} }] },
      { text: 'Written.' },
    ])
    const starter = agent({
      name: 'starter',
      model: openai('gpt-4o-mini'),
      context: [includeHistory()],
      tools: [startWorker],
    })

    const { streamed, ledger } = await drive(adapter, starter)

    expect(streamed.toSorted()).toEqual(ledger.toSorted())
    expect(countOf(streamed, 'state_change')).toBe(1)
  })

  test('concurrent runs on one session each reach only their own hooks', async () => {
    const adapter = new MockAdapter()
    adapter.addResponses('agent:alpha', recordThenReply('penicillin'))
    adapter.addResponses('agent:beta', recordThenReply('latex'))
    const session = newSession()
    const written = (hooked: StreamEvent[]) =>
      hooked.flatMap((e) => (e.type === 'state_change' ? e.changes.map((c) => c.newValue) : []))

    const [alpha, beta] = await Promise.all([
      drive(adapter, recorder('alpha'), session),
      drive(adapter, recorder('beta'), session),
    ])

    expect(written(alpha.hooked)).toEqual(['penicillin', 'penicillin'])
    expect(written(beta.hooked)).toEqual(['latex', 'latex'])
  })

  test('a finished run leaves no state listener on its session', async () => {
    const spawnWriter = app.tool({
      name: 'spawn_writer',
      description: 'Spawn a writer',
      schema: z.object({}),
      execute: (ctx) => {
        ctx.spawn(recorder('spawned'), 'Record it')
        return { started: true }
      },
    })
    const spawner = agent({
      name: 'spawner',
      model: openai('gpt-4o-mini'),
      context: [includeHistory()],
      tools: [spawnWriter],
    })
    const adapter = new MockAdapter()
    adapter.addResponses('agent:plain', recordThenReply('penicillin'))
    adapter.addResponses('agent:spawner', [
      { toolCalls: [{ name: 'spawn_writer', args: {} }] },
      { text: 'Spawned.' },
    ])
    adapter.addResponses('agent:spawned', recordThenReply('latex'))

    const plain = await drive(adapter, recorder('plain'))
    const spawned = await drive(adapter, spawner)
    await vi.waitFor(() => expect(countOf(keys(spawned.session.events), 'state_change')).toBe(2))

    expect(listenerCount(plain.session)).toBe(0)
    await vi.waitFor(() => expect(listenerCount(spawned.session)).toBe(0))
  })

  test('a resumed run and the dispatch its earlier run left open each reach their own hooks once', async () => {
    const lateWrite = app.tool({
      name: 'late_write',
      description: 'Write state after a delay',
      schema: z.object({}),
      execute: async (ctx) => {
        await sleep(80)
        ctx.state.workerWrite = true
        return { ok: true }
      },
    })
    const worker = agent({
      name: 'resume_worker',
      model: openai('gpt-4o-mini'),
      context: [includeHistory()],
      tools: [lateWrite],
    })
    const startWorker = app.tool({
      name: 'start_worker',
      description: 'Start background work',
      schema: z.object({}),
      execute: (ctx) => {
        ctx.dispatch(worker, 'Go')
        return { started: true }
      },
    })
    const ask = app.tool({
      name: 'ask_dose',
      description: 'Ask for a dose',
      schema: z.object({}),
      yieldSchema: z.object({ answer: z.string() }),
      finalize: (ctx) => {
        ctx.state.answer = ctx.input!.answer
        return { answer: ctx.input!.answer }
      },
    })
    const resumable = agent({
      name: 'resume_coordinator',
      model: openai('gpt-4o-mini'),
      context: [includeHistory()],
      tools: [startWorker, ask],
    })
    const adapter = new MockAdapter()
    adapter.addResponses('agent:resume_coordinator', [
      { toolCalls: [{ name: 'start_worker', args: {} }] },
      { toolCalls: [{ name: 'ask_dose', args: {} }] },
      { text: 'Done.', delayMs: 150 },
    ])
    adapter.addResponses('agent:resume_worker', [
      { toolCalls: [{ name: 'late_write', args: {} }] },
      { text: 'Written.' },
    ])
    const appHooked: string[] = []
    const keyOf = (e: StreamEvent) => (e.type === 'state_change' ? [e.changes[0].key] : [])
    const runner = new BaseRunner({
      adapters: { openai: adapter },
      hooks: [{ onEvent: (e) => appHooked.push(...keyOf(e)) }],
    })
    const session = newSession()
    const firstHooked: string[] = []
    const secondHooked: string[] = []

    const first = await runner.run(resumable, session, {
      hooks: [{ onEvent: (e) => firstHooked.push(...keyOf(e)) }],
    })
    const yielded = session.events.find((e) => e.type === 'tool_yield') as { callId: string }
    session.input.tool({ callId: yielded.callId, input: { answer: '5mg' } })
    await runner.run(resumable, session, {
      hooks: [{ onEvent: (e) => secondHooked.push(...keyOf(e)) }],
    })
    await vi.waitFor(() => expect(appHooked).toContain('workerWrite'))
    await sleep(20)

    expect(first.status).toBe('yielded_tool')
    expect(firstHooked).toEqual(['workerWrite'])
    expect(secondHooked).toEqual(['answer'])
    expect(appHooked.toSorted()).toEqual(['answer', 'workerWrite'])
  })

  test('a consumer that stops reading aborts the run, and its hooks see no later writes', async () => {
    const runner = new BaseRunner({
      adapters: { openai: new MockAdapter({ responses: recordThenReply('penicillin') }) },
    })
    const session = newSession()
    const hooked: string[] = []

    const stream = runner.run(recorder('reader'), session, {
      hooks: [{ onEvent: (e) => hooked.push(e.type) }],
    })
    for await (const event of stream) {
      if (event.type === 'model_start') break
    }
    await stream.settled

    expect(hooked).not.toContain('state_change')
    expect(session.events.filter((e) => e.type === 'invocation_end')).toMatchObject([
      { reason: 'aborted' },
    ])
  })

  test('a branch still running after its run settles no longer reaches the run hooks', async () => {
    let lateWrite: () => void = () => {}
    const written = new Promise<void>((resolve) => {
      lateWrite = resolve
    })
    const slowWrite = app.tool({
      name: 'slow_write',
      description: 'Write state late',
      schema: z.object({}),
      execute: async (ctx) => {
        await new Promise((resolve) => setTimeout(resolve, 60))
        ctx.state.late = true
        lateWrite()
        return { ok: true }
      },
    })
    const adapter = new MockAdapter()
    adapter.addResponses('agent:slow', [{ toolCalls: [{ name: 'slow_write', args: {} }] }])
    adapter.addResponses('agent:failing', [{ error: new Error('model exploded'), delayMs: 10 }])
    const slow = agent({
      name: 'slow',
      model: openai('gpt-4o-mini'),
      context: [includeHistory()],
      tools: [slowWrite],
    })

    const { thrown, hooked } = await drive(
      adapter,
      parallel({ name: 'strict', runnables: [slow, recorder('failing')], failFast: true }),
    )
    await written

    expect((thrown as Error).message).toBe('model exploded')
    expect(hooked.filter((e) => e.type === 'state_change')).toEqual([])
  })
})

describe('run result status', () => {
  test('keeps statuses the runner does not special-case', () => {
    const session = new BaseSession('status')
    const runnable = recorder('status')
    const fields = { runnable, session, state: session.state, iterations: 1, output: { items: [] } }
    const terminated: RunResult = { ...fields, status: 'terminated', terminationReason: 'maxTurns' }
    const participantLeft: RunResult = { ...fields, status: 'participant_left' }

    expect(resolveRunResult(terminated, session, runnable, undefined)).toMatchObject({
      status: 'terminated',
      terminationReason: 'maxTurns',
    })
    expect(resolveRunResult(participantLeft, session, runnable, undefined).status).toBe(
      'participant_left',
    )
  })
})
