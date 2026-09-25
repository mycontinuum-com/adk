import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { LiveActivity } from './live-activity'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

const BOUND_MS = 60_000

/** What the wait has resolved to so far: `undefined` while it is still waiting. */
async function settled(promise: Promise<boolean>) {
  let result: boolean | undefined
  void promise.then((value) => {
    result = value
  })
  await vi.advanceTimersByTimeAsync(0)
  return result
}

test('waits for the agent to stay quiet for the settle time before checking the line', async () => {
  const live = new LiveActivity(500)
  let said = false
  const waited = live.whenQuietAnd(() => said, BOUND_MS)
  live.agentState('speaking')
  said = true
  live.agentState('listening')
  live.agentState('speaking')
  live.agentState('listening')
  await vi.advanceTimersByTimeAsync(499)
  expect(await settled(waited)).toBeUndefined()
  await vi.advanceTimersByTimeAsync(1)
  expect(await settled(waited)).toBe(true)
})

test('rechecks while quiet, so evidence that arrives after the audio still ends the wait', async () => {
  const live = new LiveActivity(500)
  let said = false
  const waited = live.whenQuietAnd(() => said, BOUND_MS)
  live.agentState('listening')
  await vi.advanceTimersByTimeAsync(1_000)
  expect(await settled(waited)).toBeUndefined()
  said = true
  await vi.advanceTimersByTimeAsync(500)
  expect(await settled(waited)).toBe(true)
})

test('gives up at the bound and stops checking', async () => {
  const live = new LiveActivity(500)
  const waited = live.whenQuietAnd(() => false, 2_000)
  await vi.advanceTimersByTimeAsync(1_999)
  expect(await settled(waited)).toBeUndefined()
  await vi.advanceTimersByTimeAsync(1)
  expect(await settled(waited)).toBe(false)
  expect(vi.getTimerCount()).toBe(0)
})

test('resolves at once when the line was already said and the agent is settled', async () => {
  const live = new LiveActivity(500)
  expect(await settled(live.whenQuietAnd(() => true, BOUND_MS))).toBe(true)
})

test('counts a caller turn once per run of speech', () => {
  const live = new LiveActivity()
  live.userState('speaking')
  live.userState('speaking')
  live.userState('listening')
  live.userState('speaking')
  expect(live.callerTurns).toBe(2)
})

test('counts an agent turn once per run of speech', () => {
  const live = new LiveActivity()
  live.agentState('speaking')
  live.agentState('speaking')
  live.agentState('listening')
  live.agentState('thinking')
  live.agentState('speaking')
  expect(live.agentTurns).toBe(2)
})
