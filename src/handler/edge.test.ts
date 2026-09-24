import { z } from 'zod'

import type { MockResponseConfig } from '../testing'

import { agent } from '../agents'
import { adk } from '../api'
import { includeHistory } from '../context'
import { mayLeaveProcess } from '../index'
import { openai } from '../providers'
import { MockAdapter } from '../testing'

function edgeApp(responses: MockResponseConfig[]) {
  const app = adk({ name: 'edge-test', adapters: { openai: new MockAdapter({ responses }) } })
  const recordAllergy = app.tool({
    name: 'record_allergy',
    description: 'Record an allergy',
    schema: z.object({ allergy: z.string() }),
    execute: (ctx) => {
      ctx.state.patient.allergy = ctx.args.allergy
      return { recorded: true }
    },
  })
  const askClinician = app.tool({
    name: 'ask_clinician',
    description: 'Ask a clinician',
    schema: z.object({ question: z.string() }),
    yieldSchema: z.object({ answer: z.string() }),
  })
  const myAgent = agent({
    name: 'edge',
    model: openai('gpt-4o-mini'),
    context: [includeHistory()],
    tools: [recordAllergy, askClinician],
  })
  return { app, myAgent }
}

const writesPatientState: MockResponseConfig[] = [
  { toolCalls: [{ name: 'record_allergy', args: { allergy: 'penicillin' } }] },
  { text: 'Recorded.' },
]

const yieldsToClinician: MockResponseConfig[] = [
  { toolCalls: [{ name: 'ask_clinician', args: { question: 'Dose?' } }] },
]

function consultingApp() {
  const { app, myAgent: nurse } = edgeApp([
    { toolCalls: [{ name: 'consult_nurse', args: { allergy: 'penicillin' } }] },
    { toolCalls: [{ name: 'record_allergy', args: { allergy: 'penicillin' } }] },
    { text: 'Nurse recorded it.', streamChunks: true },
    { text: 'All done.', streamChunks: true },
  ])
  const consultNurse = app.tool({
    name: 'consult_nurse',
    description: 'Ask the nurse to record an allergy',
    schema: z.object({ allergy: z.string() }),
    execute: async (ctx) => ({
      reply: (await ctx.run(nurse, `Record ${ctx.args.allergy}`)).output.text,
    }),
  })
  const coordinator = agent({
    name: 'coordinator',
    model: openai('gpt-4o-mini'),
    context: [includeHistory()],
    tools: [consultNurse],
  })
  return { app, myAgent: coordinator }
}

async function aguiTypes(responses: MockResponseConfig[]) {
  const { app, myAgent } = edgeApp(responses)
  const events: Array<{ type: string; name?: string }> = []
  for await (const event of app.handler.agui({ agent: myAgent })({ input: { message: 'Hi' } })) {
    events.push(event as { type: string; name?: string })
  }
  return events.map((e) => (e.name ? `${e.type}:${e.name}` : e.type))
}

async function restEventTypes(responses: MockResponseConfig[]) {
  const { app, myAgent } = edgeApp(responses)
  const response = await app.handler.rest({ agent: myAgent, response: { events: true } })({
    input: { message: 'Hi' },
  })
  return response.events?.map((e) => e.type)
}

describe('external edges', () => {
  it('the package lets in-process callers apply the same edge filter', () => {
    const base = { id: 'evt_1', createdAt: 0, invocationId: 'inv_1', agentName: 'edge' }

    expect(
      mayLeaveProcess({
        ...base,
        type: 'state_change',
        scope: 'patient',
        source: 'mutation',
        changes: [{ key: 'allergy', oldValue: undefined, newValue: 'penicillin' }],
      }),
    ).toBe(false)
    expect(
      mayLeaveProcess({ ...base, type: 'tool_yield', callId: 'call_1', name: 'ask', args: {} }),
    ).toBe(true)
  })

  it('AG-UI emits no state delta for a patient-scope write', async () => {
    expect(await aguiTypes(writesPatientState)).toEqual([
      'RUN_STARTED',
      'STATE_SNAPSHOT',
      'TOOL_CALL_START',
      'TOOL_CALL_ARGS',
      'TOOL_CALL_END',
      'TOOL_CALL_RESULT',
      'RUN_FINISHED',
    ])
  })

  it('AG-UI emits the tool yield before the interrupt', async () => {
    expect((await aguiTypes(yieldsToClinician)).slice(0, 6)).toEqual([
      'RUN_STARTED',
      'STATE_SNAPSHOT',
      'TOOL_CALL_START',
      'TOOL_CALL_ARGS',
      'CUSTOM:TOOL_YIELD',
      'CUSTOM:RUN_INTERRUPTED',
    ])
  })

  it('REST events omit state changes', async () => {
    expect(await restEventTypes(writesPatientState)).toEqual([
      'invocation_start',
      'model_start',
      'model_end',
      'tool_call',
      'tool_result',
      'model_start',
      'model_end',
      'assistant',
      'invocation_end',
    ])
  })

  it('REST events include the tool yield', async () => {
    expect(await restEventTypes(yieldsToClinician)).toEqual([
      'invocation_start',
      'model_start',
      'model_end',
      'tool_call',
      'tool_yield',
      'invocation_yield',
    ])
  })

  it('AG-UI keeps a nested run out of the conversation', async () => {
    const { app, myAgent } = consultingApp()
    const events: Array<{ type: string; delta?: string }> = []
    for await (const event of app.handler.agui({ agent: myAgent })({ input: { message: 'Hi' } })) {
      events.push(event as { type: string; delta?: string })
    }

    expect(events.map((e) => e.type)).toEqual([
      'RUN_STARTED',
      'STATE_SNAPSHOT',
      'TOOL_CALL_START',
      'TOOL_CALL_ARGS',
      'TOOL_CALL_END',
      'TOOL_CALL_RESULT',
      'TEXT_MESSAGE_START',
      'TEXT_MESSAGE_CONTENT',
      'TEXT_MESSAGE_END',
      'RUN_FINISHED',
    ])
    const text = events.filter((e) => e.type === 'TEXT_MESSAGE_CONTENT').map((e) => e.delta)
    expect(text.join('')).toBe('All done.')
  })

  it('REST events include a nested run, without its state changes', async () => {
    const { app, myAgent } = consultingApp()
    const response = await app.handler.rest({ agent: myAgent, response: { events: true } })({
      input: { message: 'Hi' },
    })

    expect(response.events?.map((e) => `${e.type} ${e.agentName}`)).toEqual([
      'invocation_start coordinator',
      'model_start coordinator',
      'model_end coordinator',
      'tool_call coordinator',
      'invocation_start edge',
      'user edge',
      'model_start edge',
      'model_end edge',
      'tool_call edge',
      'tool_result edge',
      'model_start edge',
      'assistant_delta edge',
      'assistant_delta edge',
      'model_end edge',
      'assistant edge',
      'invocation_end edge',
      'tool_result coordinator',
      'model_start coordinator',
      'assistant_delta coordinator',
      'model_end coordinator',
      'assistant coordinator',
      'invocation_end coordinator',
    ])
  })
})
