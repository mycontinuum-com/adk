#!/usr/bin/env node
/**
 * The demo arc, as four commands — `ask`, `pending`, `approve`, `deny`. USAGE below spells them
 * out.
 *
 * `ask` and `approve` are separate invocations of this process on purpose. Nothing is held in
 * memory between them — the session sleeps as a row in bookings.db.
 */

import type { Session } from '@animahealth/adk'

import { app, bookingAgent, DB_PATH } from './bookings.js'

const USAGE = `bookings — an agent that proposes, stops, and resumes

  npx tsx src/cli.ts ask "I need physio on Tuesday afternoon, for Alex Doe"
  npx tsx src/cli.ts pending
  npx tsx src/cli.ts approve <session-id>
  npx tsx src/cli.ts deny <session-id> "too late in the day"

ask/approve/deny call a model and need OPENAI_API_KEY. The test suite needs nothing: npm test`

/** Print what the agent said, and what it is now waiting for. */
function report(session: Session<typeof app.schema>, text: string | undefined): void {
  if (text) console.log(`\nagent  ${text}`)

  const confirmation = session.state.confirmation
  if (confirmation) {
    console.log(
      `booked ${confirmation.reference} — ${confirmation.service} with ${confirmation.clinician}, ` +
        `${confirmation.day} ${confirmation.time}, for ${confirmation.bookedFor}`,
    )
  }

  const [waiting] = session.yieldedTools
  if (waiting) {
    console.log(`\npaused ${waiting.name} ${JSON.stringify(waiting.args)}`)
    console.log(`       npx tsx src/cli.ts approve ${session.id}`)
    console.log(`       npx tsx src/cli.ts deny ${session.id} "why not"`)
  }
}

function requireKey(): void {
  if (process.env.OPENAI_API_KEY) return
  throw new Error('OPENAI_API_KEY is not set. Run `npm test` for the same flow, scripted.')
}

async function ask(text: string): Promise<void> {
  requireKey()
  const session = await app.sessions.create()
  session.input.message(text)
  const result = await app.run(bookingAgent, { session })
  await app.sessions.commit(session)

  console.log(`session ${session.id}`)
  report(session, result.output.text)
}

async function pending(): Promise<void> {
  const sessions = await app.sessions.list()
  let found = 0

  for (const { id } of sessions) {
    const session = await app.sessions.get(id)
    const [waiting] = session?.yieldedTools ?? []
    if (!session || !waiting) continue
    found++
    console.log(`${session.id}  ${waiting.name}  ${JSON.stringify(waiting.args)}`)
  }

  if (found === 0) console.log(`nothing is waiting for a human (${DB_PATH})`)
}

async function decide(sessionId: string, approved: boolean, note?: string): Promise<void> {
  requireKey()
  const session = await app.sessions.get(sessionId)
  if (!session) {
    throw new Error(`No session ${sessionId}. Try: npx tsx src/cli.ts pending`)
  }

  const [waiting] = session.yieldedTools
  if (!waiting) {
    throw new Error(`Session ${sessionId} is not waiting on anything.`)
  }

  // The resume. `callId` ties the answer to the exact suspended call; `input` is validated
  // against the tool's yieldSchema before execute() ever sees it.
  session.input.tool({ callId: waiting.callId, input: { approved, note } })
  const result = await app.run(bookingAgent, { session })
  await app.sessions.commit(session)

  report(session, result.output.text)
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2)

  switch (command) {
    case 'ask':
      if (!args[0]) return console.log(USAGE)
      return ask(args.join(' '))
    case 'pending':
      return pending()
    case 'approve':
      if (!args[0]) return console.log(USAGE)
      return decide(args[0], true)
    case 'deny':
      if (!args[0]) return console.log(USAGE)
      return decide(args[0], false, args.slice(1).join(' ') || undefined)
    default:
      console.log(USAGE)
  }
}

try {
  await main()
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
} finally {
  await app.close()
}
