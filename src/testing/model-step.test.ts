/**
 * Testing.model-step — model(string) Scripts A Plain Text Reply
 *
 * `user('hi')` takes a string, so `model('hello')` reads as its natural counterpart — and before
 * this, a string passed where MockResponseConfig was expected produced a response with no `.text`:
 * the adapter emitted nothing, the run "passed", and the reply silently vanished. The first
 * runnable docs page shipped exactly that bug. A string now means `{ text }`.
 *
 * Evidence: behavior
 */
import { describe, expect, it } from 'vitest'

import { getLastAssistantText, mockAgent, model, runTest, user } from './index'

describe('testing.model-step', () => {
  it('model(string) scripts a plain text reply', async () => {
    const run = await runTest(mockAgent('greeter'), [user('hi'), model('scripted reply')])
    expect(getLastAssistantText(run.events)).toBe('scripted reply')
  })

  it('model(config) still passes the full response shape through', async () => {
    const run = await runTest(mockAgent('greeter'), [user('hi'), model({ text: 'from config' })])
    expect(getLastAssistantText(run.events)).toBe('from config')
  })
})
