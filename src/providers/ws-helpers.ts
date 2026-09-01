/** Minimal WebSocket interface to avoid a hard dependency on the `ws` package types. */
export interface WebSocketLike {
  readyState: number
  send(data: string): void
  close(): void
  on(event: string, listener: (...args: any[]) => void): void
  off(event: string, listener: (...args: any[]) => void): void
  once(event: string, listener: (...args: any[]) => void): void
}

export type WSConstructor = new (
  url: string,
  opts: { headers: Record<string, string> },
) => WebSocketLike

export function loadWebSocket(injected?: WSConstructor): WSConstructor {
  if (injected) return injected
  try {
    return require('ws') as WSConstructor
  } catch {
    throw new Error(
      'The "ws" package is required for realtime adapters. ' +
        'It is normally installed as a dependency of "openai". ' +
        'Ensure "openai" is installed: pnpm add openai',
    )
  }
}

export function send(ws: WebSocketLike, payload: Record<string, unknown>): void {
  ws.send(JSON.stringify(payload))
}

export function waitForOpen(ws: WebSocketLike): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === 1 /* OPEN */) return resolve()
    ws.once('open', () => resolve())
    ws.once('error', (err: Error) => reject(err))
  })
}

/**
 * Wait for a single message matching `predicate`, with a timeout. Rejects if the WebSocket closes,
 * errors, or the timeout elapses.
 */
export function waitForMessage(
  ws: WebSocketLike,
  predicate: (msg: Record<string, unknown>) => boolean,
  timeoutMs = 15_000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`Timed out waiting for WebSocket message (${timeoutMs}ms)`))
    }, timeoutMs)
    const cleanup = () => {
      clearTimeout(timer)
      ws.off('message', onMessage)
      ws.off('error', onError)
      ws.off('close', onClose)
    }
    const onMessage = (data: any) => {
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(String(data)) as Record<string, unknown>
      } catch {
        return // Skip non-parseable messages – they won't match the predicate anyway.
      }
      if (predicate(msg)) {
        cleanup()
        resolve(msg)
      }
    }
    const onError = (err: Error) => {
      cleanup()
      reject(err)
    }
    const onClose = () => {
      cleanup()
      reject(new Error('WebSocket closed before expected message received.'))
    }
    ws.on('message', onMessage)
    ws.on('error', onError)
    ws.on('close', onClose)
  })
}

export async function* receiveEvents(ws: WebSocketLike): AsyncGenerator<Record<string, unknown>> {
  const queue: Record<string, unknown>[] = []
  let waiting: ((value: void) => void) | null = null
  let closed = false
  let wsError: Error | null = null

  const wake = () => {
    if (waiting) {
      waiting()
      waiting = null
    }
  }
  const onMessage = (data: any) => {
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(String(data)) as Record<string, unknown>
    } catch {
      console.warn('receiveEvents: skipping malformed WebSocket message')
      return
    }
    queue.push(msg)
    wake()
  }
  const onClose = () => {
    closed = true
    wake()
  }
  const onError = (err: Error) => {
    wsError = err
    closed = true
    wake()
  }

  ws.on('message', onMessage)
  ws.on('close', onClose)
  ws.on('error', onError)

  try {
    while (true) {
      while (queue.length > 0) {
        yield queue.shift()!
      }
      if (wsError) throw wsError
      if (closed) return
      await new Promise<void>((r) => {
        waiting = r
      })
    }
  } finally {
    ws.off('message', onMessage)
    ws.off('close', onClose)
    ws.off('error', onError)
  }
}
