import { vi } from 'vitest'

import type { Runnable } from '../types/runnables'

import { cli } from './index'

const inkFailure = vi.hoisted(() => ({ mode: 'unresolvable' as 'unresolvable' | 'broken' }))

// The global test setup mocks `ink` with a working stub; this file-scoped mock replaces that stub
// for this file, standing in for the two ways loading the peer can fail.
vi.mock('ink', () => {
  if (inkFailure.mode === 'unresolvable') {
    const error: NodeJS.ErrnoException = new Error(
      "Cannot find package 'ink' imported from /app/node_modules/@animahealth/adk/dist/cli/index.js",
    )
    error.code = 'ERR_MODULE_NOT_FOUND'
    throw error
  }
  throw new Error('ink blew up while initialising')
})

describe('cli optional peers', () => {
  test('names the packages to install when the UI peers are absent', async () => {
    inkFailure.mode = 'unresolvable'
    const runnable = { name: 'test-agent' } as unknown as Runnable<any>

    // `cli()` itself must not throw at the resolution failure: entering the alternate screen before
    // the peers load would hide the message inside a buffer torn down with the process.
    const handle = cli(runnable)

    await expect(Promise.resolve(handle)).rejects.toThrow(
      'CLI dependencies not found. Install them with: npm install ink ink-text-input react',
    )
  })

  test('leaves a failure that is not a missing peer untouched', async () => {
    inkFailure.mode = 'broken'
    vi.resetModules()
    const { cli: freshCli } = await import('./index')
    const runnable = { name: 'test-agent' } as unknown as Runnable<any>

    await expect(Promise.resolve(freshCli(runnable))).rejects.not.toThrow(
      'CLI dependencies not found',
    )
  })
})
