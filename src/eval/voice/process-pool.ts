/**
 * Process-level isolation for voice evals.
 *
 * When `isolation: 'process'` is set, each eval case runs in its own forked child process with an
 * independent V8 isolate, event loop, and @livekit/rtc-node native thread pool. This eliminates
 * event-loop contention that causes audio stutter and latency spikes at high concurrency.
 *
 * The child re-executes the user's script (process.argv[1]). When `evaluateVoice` detects the
 * worker env var, it runs only the assigned case and sends the result back via IPC.
 */

import { fork } from 'node:child_process'

const WORKER_ENV = '__ADK_VOICE_EVAL_WORKER'
const WORKER_CASE_INDEX_ENV = '__ADK_VOICE_EVAL_CASE_INDEX'

// ---------------------------------------------------------------------------
// Worker-side helpers (run inside the forked child)
// ---------------------------------------------------------------------------

export function isProcessWorker(): boolean {
  return process.env[WORKER_ENV] === '1'
}

export function getWorkerCaseIndex(): number {
  return parseInt(process.env[WORKER_CASE_INDEX_ENV]!, 10)
}

export function sendWorkerResult(caseIndex: number, result: unknown): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (!process.send || !process.connected) {
      resolve()
      return
    }
    process.send({ type: 'voice-eval-result', caseIndex, result }, (err: Error | null) =>
      err ? reject(err) : resolve(),
    )
  })
}

// ---------------------------------------------------------------------------
// Parent-side: fork a single case in a child process
// ---------------------------------------------------------------------------

export function forkCase(caseIndex: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let spawnError: Error | undefined

    const child = fork(process.argv[1], process.argv.slice(2), {
      env: {
        ...process.env,
        [WORKER_ENV]: '1',
        [WORKER_CASE_INDEX_ENV]: String(caseIndex),
      },
      stdio: ['ignore', 'pipe', 'inherit', 'ipc'],
    })

    let result: unknown
    let received = false

    child.on('message', (msg: any) => {
      if (msg?.type === 'voice-eval-result') {
        received = true
        result = msg.result
      }
    })

    child.on('error', (err) => {
      spawnError = err
    })

    child.on('exit', (code) => {
      if (received) {
        resolve(result)
      } else {
        const reason = spawnError
          ? `Worker spawn error: ${spawnError.message}`
          : `Worker exited with code ${code} without producing a result`
        reject(new Error(`[adk/voice-eval] case-${caseIndex}: ${reason}`))
      }
    })
  })
}
