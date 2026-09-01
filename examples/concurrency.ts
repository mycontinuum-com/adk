/**
 * Session Concurrency — Conflict Resolution Demo
 *
 * Simulates concurrent Lambda invocations processing messages against the same session.
 * `sessions.commit()` detects conflicts and callers can merge.
 *
 * 1. Merged — both executions' events are preserved in the session
 * 2. Clean — no conflict, commit succeeds on first attempt
 *
 * No API keys needed — uses beforeAgent hooks to return canned responses.
 *
 * Run: npx tsx examples/concurrency.ts
 */

import { adk, inMemoryStore } from '@animahealth/adk'
import { openai } from '@animahealth/adk/openai'

const store = inMemoryStore()
const app = adk({ name: 'concurrency-demo', store })
const sessions = app.sessions

function createAgent(responseFn: () => string) {
  return app.agent({
    name: 'assistant',
    model: openai('gpt-4o-mini'),
    context: [app.context.history()],
    hooks: [{ beforeAgent: () => responseFn() }],
  })
}

async function main() {
  // --- Scenario 1: Conflict → Auto-merged ---
  console.log('=== Scenario 1: Two concurrent executions ===')
  console.log('  Lambda A and Lambda B both load the same session at version 1.')
  console.log('  A commits first. B detects conflict and then merges.\n')

  const s1 = await sessions.create({ sessionId: 'session-1' })

  const loadedA = (await sessions.get(s1.id))!
  const loadedB = (await sessions.get(s1.id))!

  await app.run(
    createAgent(() => 'Hi! How can I help you?'),
    { session: loadedA, input: 'hello' },
  )
  await app.run(
    createAgent(() => 'Hey there! What can I do for you?'),
    { session: loadedB, input: 'hello' },
  )

  const resA = await sessions.commit(loadedA)
  console.log(
    `  [Lambda A] commit → ok=${resA.ok}, merged=${resA.ok ? (resA.merged ?? false) : 'n/a'}`,
  )

  const resB = await sessions.commit(loadedB)
  console.log(
    `  [Lambda B] commit → ok=${resB.ok}, merged=${resB.ok ? (resB.merged ?? false) : 'n/a'}`,
  )
  if (!resB.ok) {
    const merged = await sessions.merge(loadedB)
    console.log(
      `  [Lambda B] merge → ok=${merged.ok}, merged=${merged.ok ? (merged.merged ?? false) : 'n/a'}`,
    )
  }

  const final1 = await sessions.get(s1.id)
  console.log(`  Session events after merge: ${final1!.events.length}`)
  console.log(`  Event types: [${final1!.events.map((e) => e.type).join(', ')}]`)
  console.log()

  // --- Scenario 2: No conflict ---
  console.log('=== Scenario 2: Single execution, no conflict ===')
  console.log('  Normal case — one message, one response, clean commit.\n')

  const s2 = await sessions.create({ sessionId: 'session-2' })
  const loaded = (await sessions.get(s2.id))!

  await app.run(
    createAgent(() => "I'm doing great!"),
    { session: loaded, input: 'How are you?' },
  )

  const res = await sessions.commit(loaded)
  console.log(`  commit → ok=${res.ok}, merged=${res.ok ? (res.merged ?? false) : 'n/a'}`)
  console.log()

  // --- Summary ---
  console.log('=== Summary ===')
  console.log('  sessions.commit() detects conflicts on write.')
  console.log('  Callers decide whether to merge based on delivery.')
  console.log('  sessions.merge() appends events after reloading.')
}

main().catch(console.error)
