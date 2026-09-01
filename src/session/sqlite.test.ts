import { vi } from 'vitest'

import { SQLiteStore } from './sqlite'

// Stands in for what Node throws when the optional peer was never installed. The behaviour with the
// peer present is covered by the SessionStore compliance suite in `compliance.test.ts`.
vi.mock('better-sqlite3', () => {
  const error: NodeJS.ErrnoException = new Error(
    "Cannot find package 'better-sqlite3' imported from /app/node_modules/@animahealth/adk/dist/stores/sqlite.js",
  )
  error.code = 'ERR_MODULE_NOT_FOUND'
  throw error
})

describe('SQLiteStore optional peer', () => {
  test('names the package to install when better-sqlite3 is absent', async () => {
    const store = new SQLiteStore(':memory:')

    await expect(store.load('app', 'session')).rejects.toThrow(
      'better-sqlite3 not found. Install it with: npm install better-sqlite3',
    )
  })
})
