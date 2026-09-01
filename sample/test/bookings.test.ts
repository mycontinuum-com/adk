/**
 * The same agent, no key and no SQLite.
 *
 * `runTest` swaps only the model for a script: the tools still run, the ledger still accrues, the
 * event history is the real one. That is what makes the yield testable — the pause is a property of
 * the run, not of the CLI wrapped around it.
 */

import { beforeEach, describe, expect, test } from 'vitest'

import type { Runnable } from '@animahealth/adk'
import { getToolCalls, getToolResults, input, model, runTest, user } from '@animahealth/adk/testing'

import { bookingAgent } from '../src/bookings.js'
import { isBooked, openSlots, resetClinic } from '../src/clinic.js'

/**
 * `runTest` is typed against the schema-erased `Runnable`, so an agent built on an app that
 * declares a state schema needs this cast. Types only — at runtime it is the same object
 * `app.run()` takes.
 */
const agent = bookingAgent as unknown as Runnable

beforeEach(resetClinic)

describe('search_slots', () => {
  test('the model picks the filter; the tool decides the answer', async () => {
    const run = await runTest(agent, [
      user('What physio have you got on Tuesday?'),
      model({
        toolCalls: [{ name: 'search_slots', args: { service: 'physiotherapy', day: 'Tuesday' } }],
      }),
      model('14:30 with R. Ellis, or 16:00 with J. Okafor.'),
    ])

    expect(run.status).toBe('completed')
    expect(getToolCalls(run.events)[0]?.name).toBe('search_slots')
    expect(getToolResults(run.events)[0]?.result).toEqual({
      slots: openSlots({ service: 'physiotherapy', day: 'Tuesday' }),
    })
  })
})

describe('book_slot yields', () => {
  test('the run stops at the call and nothing is booked', async () => {
    const run = await runTest(agent, [
      user('Book slot-02 for Alex Doe.'),
      model({
        toolCalls: [{ name: 'book_slot', args: { slotId: 'slot-02', bookedFor: 'Alex Doe' } }],
      }),
    ])

    expect(run.status).toBe('yielded_tool')
    expect(run.session.yieldedTools).toHaveLength(1)
    expect(run.session.yieldedTools[0]?.name).toBe('book_slot')

    // The pause is real: execute() has not run, so the world is untouched.
    expect(isBooked('slot-02')).toBe(false)
    expect(run.session.state.confirmation).toBeUndefined()
  })
})

describe('resume', () => {
  test('approval executes the booking and returns a typed confirmation', async () => {
    const run = await runTest(agent, [
      user('Book slot-02 for Alex Doe.'),
      model({
        toolCalls: [{ name: 'book_slot', args: { slotId: 'slot-02', bookedFor: 'Alex Doe' } }],
      }),
      // The human's answer, shaped by the tool's yieldSchema. In the CLI this arrives from a
      // separate process, minutes or days later.
      input({ book_slot: { approved: true } }),
      model('Booked — Tuesday 14:30 with R. Ellis.'),
    ])

    expect(run.status).toBe('completed')
    expect(isBooked('slot-02')).toBe(true)
    expect(run.session.state.confirmation).toEqual({
      reference: 'CLINIC-001',
      slotId: 'slot-02',
      service: 'physiotherapy',
      clinician: 'R. Ellis',
      day: 'Tuesday',
      time: '14:30',
      bookedFor: 'Alex Doe',
    })
  })

  test('a refusal leaves the slot open and hands the reason back to the agent', async () => {
    const run = await runTest(agent, [
      user('Book slot-02 for Alex Doe.'),
      model({
        toolCalls: [{ name: 'book_slot', args: { slotId: 'slot-02', bookedFor: 'Alex Doe' } }],
      }),
      input({ book_slot: { approved: false, note: 'Alex cannot do afternoons.' } }),
      model('Understood — 09:15 on Monday is the other physio slot. Shall I take it?'),
    ])

    expect(run.status).toBe('completed')
    expect(isBooked('slot-02')).toBe(false)
    expect(run.session.state.confirmation).toBeUndefined()
    expect(getToolResults(run.events)[0]?.result).toEqual({
      booked: false,
      reason: 'Alex cannot do afternoons.',
    })
  })
})
