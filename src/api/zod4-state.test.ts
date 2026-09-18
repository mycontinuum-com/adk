import { z } from 'zod'

import { safeParseToolArgs } from '../core/tools'
import { adk } from './app'

it('parses input defaults with prefault before running a step', async () => {
  const app = adk({ schema: { session: { label: z.string().trim().prefault(' x ') } } })
  const observed: string[] = []
  const step = app.step({
    name: 'capture',
    execute: (ctx) => {
      observed.push(ctx.state.label)
    },
  })
  await app.run(step, { input: { state: {} } })
  expect(observed).toEqual(['x'])
})

it('rejects an invalid prefault before executing a step', () => {
  const app = adk({ schema: { session: { count: z.number().min(1).prefault(0) } } })
  const execute = vi.fn<() => void>()
  expect(() => app.run(app.step({ name: 'capture', execute }), { input: { state: {} } })).toThrow()
  expect(execute).not.toHaveBeenCalled()
})

it('preserves partial enum-key records when explicitly migrated to partialRecord', () => {
  const schema = z.object({ counts: z.partialRecord(z.enum(['a', 'b']), z.number()) })
  expect(safeParseToolArgs({ counts: { a: '5' } }, schema)).toEqual({
    success: true,
    data: { counts: { a: 5 } },
  })
  const exhaustive = z.object({ counts: z.record(z.enum(['a', 'b']), z.number()) })
  expect(safeParseToolArgs({ counts: { a: '5' } }, exhaustive).success).toBe(false)
})
