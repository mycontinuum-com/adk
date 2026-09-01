import { z } from 'zod'

import { runTest, user, model, testAgent, setupAdkMatchers } from '../testing'

await setupAdkMatchers()
describe('Agent timeouts', () => {
  describe('maxDuration', () => {
    test('agent terminates with max_duration when timeout expires during model step', async () => {
      const { status } = await runTest(
        testAgent({
          timeouts: { maxDuration: 50 },
        }),
        [
          user('Hello'),
          // Model takes 200ms — exceeds the 50ms maxDuration
          model({ text: 'This takes a while...', delayMs: 200 }),
        ],
      )

      expect(status).toBe('max_duration')
    })

    test('agent completes normally when model finishes before maxDuration', async () => {
      const { status, events } = await runTest(
        testAgent({
          timeouts: { maxDuration: 5000 },
        }),
        [user('Hello'), model({ text: 'Quick response' })],
      )

      expect(status).toBe('completed')
      expect(events).toHaveAssistantText('Quick response')
    })

    test('max_duration timeout produces correct invocation_end event', async () => {
      const { result } = await runTest(
        testAgent({
          timeouts: { maxDuration: 50 },
        }),
        [user('Hello'), model({ text: 'Slow...', delayMs: 200 })],
      )

      expect(result.status).toBe('max_duration')
      const endEvent = result.session.events.find((e) => e.type === 'invocation_end')
      expect(endEvent).toBeDefined()
      if (endEvent && endEvent.type === 'invocation_end') {
        expect(endEvent.reason).toBe('max_duration')
      }
    })

    test('maxDuration works with yielding agents', async () => {
      const { status } = await runTest(
        testAgent({
          yields: true,
          timeouts: { maxDuration: 50 },
        }),
        [
          user('Hello'),
          // First turn completes fast — yields
          model({ text: 'Hi!' }),
          // Second turn is slow — exceeds maxDuration
          user('More'),
          model({ text: 'Slow...', delayMs: 200 }),
        ],
      )

      // The agent should time out on the second turn
      expect(status).toBe('max_duration')
    })

    test('maxDuration does not interfere with tool calls that finish in time', async () => {
      const { status, events } = await runTest(
        testAgent({
          timeouts: { maxDuration: 5000 },
          tools: [
            {
              name: 'fast_tool',
              description: 'A fast tool',
              schema: z.object({ x: z.string() }),
              execute: () => ({ result: 'done' }),
            },
          ],
        }),
        [
          user('Use the tool'),
          model({ toolCalls: [{ name: 'fast_tool', args: { x: 'test' } }] }),
          model({ text: 'Done!' }),
        ],
      )

      expect(status).toBe('completed')
      expect(events).toHaveAssistantText('Done!')
    })
  })
})
