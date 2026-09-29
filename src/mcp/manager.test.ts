import { adk } from '../api'
import { createMCPManager } from './manager'

test('an app without an MCP server leaves process signals to its host', async () => {
  const before = process.listenerCount('SIGTERM')
  const app = adk({ name: 'no-mcp' })
  createMCPManager()
  expect(process.listenerCount('SIGTERM')).toBe(before)
  await app.close()
})

test('the first MCP server registers disconnect-at-exit once', () => {
  const before = process.listenerCount('SIGTERM')
  const manager = createMCPManager()
  manager.server({ name: 'one', command: 'synthetic' })
  manager.server({ name: 'two', command: 'synthetic' })
  createMCPManager().server({ name: 'three', command: 'synthetic' })
  expect(process.listenerCount('SIGTERM')).toBe(before + 1)
})
