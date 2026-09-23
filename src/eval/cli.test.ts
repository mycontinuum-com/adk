import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const fixture = resolve(import.meta.dirname, '../test-support/eval-cli.ts')

async function invoke(args: string[], env: Record<string, string> = {}) {
  try {
    const result = await exec(process.execPath, ['--import', 'tsx', fixture, ...args], {
      env: { ...process.env, ...env },
      timeout: 30_000,
    })
    return { ...result, code: 0 }
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'stdout' in error &&
      'stderr' in error &&
      'code' in error
    ) {
      return { stdout: String(error.stdout), stderr: String(error.stderr), code: error.code }
    }
    throw error
  }
}

it('lists both kinds without opening voice connections or executing text', async () => {
  const result = await invoke(['list'], { EVAL_TEST_MIXED: '1' })
  expect(result.code).toBe(0)
  expect(JSON.parse(result.stdout).cases).toEqual([
    { name: 'greeting/text', kind: 'text' },
    { name: 'greeting/voice', kind: 'voice' },
  ])
  expect(result.stderr).toBe('')
})

it('selects text from a mixed suite, repeats it, and saves matching JSON plus conversation evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'adk-eval-cli-'))
  const result = await invoke(
    ['run', '--case', 'greeting/text', '--repeat', '2', '--output', root],
    { EVAL_TEST_MIXED: '1' },
  )
  expect(result.code).toBe(0)
  const document = JSON.parse(result.stdout)
  expect(document.selected).toEqual(['greeting/text'])
  expect(document.expected).toBe(2)
  expect(document.completed).toBe(2)
  expect(
    document.results.map((item: { status: string; repeatIndex: number }) => [
      item.status,
      item.repeatIndex,
    ]),
  ).toEqual([
    ['passed', 1],
    ['passed', 2],
  ])
  expect(result.stderr).toContain('text diagnostic')
  expect(JSON.parse(await readFile(join(document.directory, 'result.json'), 'utf8'))).toEqual(
    document,
  )
  expect(await readFile(document.results[0].evidence, 'utf8')).toContain('Hello from the text case')
  expect(await readFile(document.report, 'utf8')).toContain('Eval Report')
  const next = await invoke(['run', '--output', root])
  expect(next.code).toBe(0)
  expect(await readdir(root)).toHaveLength(2)
  expect(JSON.parse(await readFile(join(document.directory, 'result.json'), 'utf8'))).toEqual(
    document,
  )
})

it('returns failure for a failed metric and invocation error for an unknown case', async () => {
  const root = await mkdtemp(join(tmpdir(), 'adk-eval-cli-'))
  const failed = await invoke(['run', '--output', root], { EVAL_TEST_FAIL: '1' })
  expect(failed.code).toBe(1)
  expect(JSON.parse(failed.stdout).summary.failed).toBe(1)
  const invalid = await invoke(['run', '--case', 'missing', '--output', root])
  expect(invalid.code).toBe(2)
  expect(JSON.parse(invalid.stdout).error.message).toBe('Unknown case: missing')
})

it('collects a real voice-worker setup failure without executing text again in the worker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'adk-eval-worker-'))
  const counter = join(root, 'counter.txt')
  const result = await invoke(['run', '--output', root], {
    EVAL_TEST_MIXED: '1',
    EVAL_TEST_COUNTER: counter,
  })
  expect(result.code).toBe(1)
  const document = JSON.parse(result.stdout)
  expect(
    document.results.map((item: { name: string; status: string }) => [item.name, item.status]),
  ).toEqual([
    ['greeting/text', 'passed'],
    ['greeting/voice', 'error'],
  ])
  expect(await readFile(counter, 'utf8')).toBe('text\n')
  expect(result.stderr).toContain('must have a realtime model config')
  expect(document.completed).toBe(2)
})
