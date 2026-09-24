/**
 * Smoke test: exercises the CJS → ESM terminal bridge.
 *
 * Simulates what a CJS consumer does: const { adk, openai } = require('@animahealth/adk');
 * app.terminal(someAgent);
 *
 * Usage: node scripts/smoke-test-cjs-terminal.cjs
 */

'use strict'

const path = require('path')

const distIndex = path.resolve(__dirname, '..', 'dist', 'index.js')
console.log('[smoke] Loading ADK from:', distIndex)

const { adk, openai } = require(distIndex)
console.log('[smoke] require(dist/index.js) succeeded ✓')

const app = adk({ name: 'smoke-test' })

const agent = app.agent({
  name: 'smoke_agent',
  model: openai('gpt-4o-mini'),
  context: [app.context.system('You are a helpful assistant. Keep responses brief.')],
  tools: [],
})

// Just launch — Ink keeps the process alive. Ctrl+C to exit.
app.terminal(agent)
