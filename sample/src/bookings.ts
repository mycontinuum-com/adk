/**
 * Bookings — the agent that stops and asks.
 *
 * The whole program: one app with a typed state schema, two tools, one agent. `search_slots` is
 * ordinary code the model may call. `book_slot` declares a `yieldSchema`, which makes it a
 * _yielding_ tool: calling it suspends the run and writes a `tool_yield` event instead of
 * executing. The session — events, state, the pending call — is a row in SQLite from that moment
 * on. No process waits. A later `session.input.tool({ callId, input })` supplies the human's
 * decision and the run continues from exactly where it stopped.
 */

import { fileURLToPath } from 'node:url'
import { z } from 'zod'

import { adk } from '@animahealth/adk'
import { openai } from '@animahealth/adk/openai'
import { sqliteStore } from '@animahealth/adk/stores/sqlite'

import { SERVICES, bookSlot, findSlot, isBooked, openSlots } from './clinic.js'

/** The sleeping session lives here — one file, created on first use, safe to delete. */
export const DB_PATH = fileURLToPath(new URL('../bookings.db', import.meta.url))

/**
 * What a completed booking looks like. Declaring it in the app schema is what makes
 * `session.state.confirmation` typed everywhere downstream, including after it is read back out of
 * SQLite in a different process.
 */
const confirmation = z.object({
  reference: z.string(),
  slotId: z.string(),
  service: z.string(),
  clinician: z.string(),
  day: z.string(),
  time: z.string(),
  bookedFor: z.string(),
})

export type Confirmation = z.infer<typeof confirmation>

export const app = adk({
  name: 'bookings',
  schema: { session: { confirmation: confirmation.optional() } },
  store: sqliteStore(DB_PATH),
})

/** Deterministic. The model chooses the arguments; this code decides the answer. */
const searchSlots = app.tool({
  name: 'search_slots',
  description: 'List the open appointment slots at the clinic, optionally filtered.',
  schema: z.object({
    service: z.enum(SERVICES).optional().describe('Only slots for this service'),
    day: z.string().optional().describe('Only slots on this weekday, e.g. "Tuesday"'),
  }),
  execute: (ctx) => ({ slots: openSlots(ctx.args) }),
})

/**
 * The yielding tool. `yieldSchema` is the contract for the human's answer; because it is present,
 * ADK suspends the run at the call instead of running `execute`. `execute` runs later, once, with
 * that answer in `ctx.input`.
 */
const bookSlotTool = app.tool({
  name: 'book_slot',
  description:
    'Book one open slot. A human reviews every call to this tool before it takes effect, so propose a single slot and call it once.',
  schema: z.object({
    slotId: z.string().describe('The id of an open slot, from search_slots'),
    bookedFor: z.string().describe('The name the appointment is under'),
  }),
  yieldSchema: z.object({
    approved: z.boolean().describe('true to book the slot, false to decline it'),
    note: z.string().optional().describe('Why it was declined — the agent reads this'),
  }),
  execute: (ctx) => {
    const slot = findSlot(ctx.args.slotId)
    if (!slot) {
      return { booked: false as const, reason: `There is no slot called ${ctx.args.slotId}.` }
    }
    if (isBooked(slot.id)) {
      return { booked: false as const, reason: `${slot.id} has already been booked.` }
    }
    if (!ctx.input?.approved) {
      return {
        booked: false as const,
        reason: ctx.input?.note ?? 'A human declined this booking. Offer a different slot.',
      }
    }

    const booking = bookSlot(slot, ctx.args.bookedFor)
    // Typed, and durable: this write becomes a state_change event, committed to SQLite with the
    // rest of the session, and readable as `session.state.confirmation` forever after.
    ctx.state.confirmation = booking
    return { booked: true as const, ...booking }
  },
})

export const bookingAgent = app.agent({
  name: 'bookings',
  model: openai('gpt-5.6-luna'),
  context: [
    app.context.system(
      [
        'You book appointments for a small clinic.',
        'Call search_slots before you offer anything. Never invent a slot or a time.',
        'Offer one slot at a time, then call book_slot for it. That call pauses for a human.',
        'If a booking is declined, read the note and offer the next best open slot.',
        'Answer in one or two sentences.',
      ].join('\n'),
    ),
    app.context.history(),
  ],
  tools: [searchSlots, bookSlotTool],
})
