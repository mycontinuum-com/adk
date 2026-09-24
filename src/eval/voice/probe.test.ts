import { afterEach, describe, expect, it, vi } from 'vitest'

import type { VoiceProbeConnection, VoiceProbeDriver, VoiceProbeOptions } from './probe'

import { executeVoiceProbe } from './probe'

const options: VoiceProbeOptions = {
  agentName: 'isolated-test-worker',
  room: { url: 'ws://localhost:7880' },
  input: { pcm16: new Int16Array([300, -300]), sampleRate: 16000 },
  initialSilenceMs: 20,
  durationMs: 60,
}

function fixture(overrides: Partial<VoiceProbeDriver> = {}) {
  const frames: Int16Array[] = []
  const driver: VoiceProbeDriver = {
    start: vi.fn<VoiceProbeDriver['start']>(async () => {}),
    dispatch: vi.fn<VoiceProbeDriver['dispatch']>(async () => {}),
    sendFrame: vi.fn<VoiceProbeDriver['sendFrame']>(async (frame) => {
      frames.push(frame)
    }),
    observeRpc: vi.fn<VoiceProbeDriver['observeRpc']>(async () => ''),
    close: vi.fn<VoiceProbeDriver['close']>(async () => {}),
    ...overrides,
  }
  return { driver, frames }
}

afterEach(() => vi.useRealTimers())

describe('runVoiceProbe lifecycle', () => {
  it('retains observations and stops frames before RPC when remote disconnect is allowed', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1000)
    const { driver, frames } = fixture()
    const run = executeVoiceProbe(
      {
        ...options,
        observeData: { topic: 'fixture-state' },
        allowRemoteDisconnect: true,
        observeRpc: { method: 'snapshot' },
      },
      async (connection) => {
        driver.sendFrame = async (frame) => {
          frames.push(frame)
          if (frames.length === 2) {
            vi.setSystemTime(1020)
            connection.onData('  {"ended":true}\n')
            connection.onRemoteDisconnect('ROOM_DELETED')
          }
        }
        driver.close = async () => {
          connection.onData('late cleanup observation')
          connection.onRemoteDisconnect('CLIENT_INITIATED')
        }
        return driver
      },
    )
    await vi.advanceTimersByTimeAsync(60)
    expect(await run).toMatchObject({
      status: 'completed',
      observations: [{ receivedAtMs: 20, payload: '  {"ended":true}\n' }],
      remoteDisconnect: { atMs: 20, reason: 'ROOM_DELETED' },
    })
    expect(frames).toHaveLength(2)
    expect(driver.observeRpc).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps remote disconnect an error by default and preserves its reason', async () => {
    const { driver } = fixture()
    const result = await executeVoiceProbe(options, async (connection) => {
      driver.dispatch = async () => connection.onRemoteDisconnect('ROOM_DELETED')
      return driver
    })
    expect(result).toMatchObject({
      status: 'error',
      error: 'Voice probe error during dispatch',
      remoteDisconnect: { reason: 'ROOM_DELETED' },
    })
    expect(driver.sendFrame).not.toHaveBeenCalled()
  })

  it('does not report local cleanup as remote termination', async () => {
    vi.useFakeTimers()
    const { driver } = fixture()
    const run = executeVoiceProbe(
      { ...options, allowRemoteDisconnect: true },
      async (connection) => {
        driver.close = async () => connection.onRemoteDisconnect('CLIENT_INITIATED')
        return driver
      },
    )
    await vi.advanceTimersByTimeAsync(60)
    expect(await run).toMatchObject({ status: 'completed', assistantTranscripts: [] })
    expect((await run).remoteDisconnect).toBeUndefined()
  })

  it('cancels the observation deadline when the remote room closes during RPC', async () => {
    vi.useFakeTimers()
    const { driver } = fixture()
    const run = executeVoiceProbe(
      {
        ...options,
        allowRemoteDisconnect: true,
        observeData: { topic: 'state' },
        observeRpc: { method: 'snapshot' },
      },
      async (connection) => {
        driver.observeRpc = async () => {
          connection.onData('{"ended":true}')
          connection.onRemoteDisconnect('ROOM_DELETED')
          return new Promise(() => {})
        }
        return driver
      },
    )
    await vi.advanceTimersByTimeAsync(60)
    expect(await run).toMatchObject({
      status: 'completed',
      observations: [{ payload: '{"ended":true}' }],
      remoteDisconnect: { reason: 'ROOM_DELETED' },
    })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('records non-silent sent and received frames on the host clock without storing audio', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1000)
    const { driver } = fixture()
    let frameIndex = 0
    const run = executeVoiceProbe(
      { ...options, observeAudioActivity: true },
      async (connection) => {
        driver.sendFrame = async (frame) => {
          vi.setSystemTime(1000 + frameIndex++ * 20)
          connection.onAudio(frame, 16000)
        }
        return driver
      },
    )
    await vi.advanceTimersByTimeAsync(60)
    const result = await run
    expect(result.audioActivity).toEqual({
      startedAt: 1000,
      caller: [{ start: 1020, end: 1040 }],
      agent: [{ start: 1020, end: 1040 }],
    })
  })

  it('sends silence, the complete fixture and trailing silence while collecting observations', async () => {
    vi.useFakeTimers()
    const { driver, frames } = fixture()
    const callbacks: VoiceProbeConnection[] = []
    const run = executeVoiceProbe(options, async (connection) => {
      callbacks.push(connection)
      driver.dispatch = async () => {
        connection.onAudio(new Int16Array(320), 16000)
        connection.onAudio(new Int16Array(320).fill(100), 16000)
        connection.onTranscript('This is a synthetic test.', 'segment-1')
      }
      return driver
    })
    await vi.advanceTimersByTimeAsync(60)
    const result = await run
    expect(result).toMatchObject({
      status: 'completed',
      receivedAudioMs: 40,
      receivedNonSilentAudioMs: 20,
      assistantTranscripts: ['This is a synthetic test.'],
    })
    expect(frames).toHaveLength(3)
    expect(frames[0]).toEqual(new Int16Array(320))
    expect(frames[1]?.slice(0, 4)).toEqual(new Int16Array([300, -300, 0, 0]))
    expect(frames[2]).toEqual(new Int16Array(320))
    expect(driver.close).toHaveBeenCalledTimes(1)
    expect(driver.observeRpc).not.toHaveBeenCalled()
    expect(result.rpcResponse).toBeUndefined()
    for (const callback of callbacks) callback.onTranscript('late event', 'segment-2')
    expect(result.assistantTranscripts).toEqual(['This is a synthetic test.'])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not turn a completed silent observation into a successful speech assertion', async () => {
    vi.useFakeTimers()
    const { driver } = fixture()
    const run = executeVoiceProbe(options, async () => driver)
    await vi.advanceTimersByTimeAsync(60)
    expect(await run).toMatchObject({
      status: 'completed',
      receivedAudioMs: 0,
      receivedNonSilentAudioMs: 0,
      assistantTranscripts: [],
    })
  })

  it('preserves the opaque RPC response after the complete audio window', async () => {
    vi.useFakeTimers()
    const response = '  {"stage":"synthetic-example","revision":4}\n'
    const { driver, frames } = fixture({
      observeRpc: vi.fn<VoiceProbeDriver['observeRpc']>(async () => {
        expect(frames).toHaveLength(3)
        return response
      }),
    })
    const request = { method: 'test-observation', payload: '{"include":"state"}' }
    const run = executeVoiceProbe({ ...options, observeRpc: request }, async () => driver)
    await vi.advanceTimersByTimeAsync(60)
    expect(await run).toMatchObject({ status: 'completed', rpcResponse: response })
    expect(driver.observeRpc).toHaveBeenCalledWith(request)
    expect(driver.close).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reports a sanitized observation error and cleans up when RPC fails', async () => {
    vi.useFakeTimers()
    const { driver } = fixture({
      observeRpc: async () => {
        throw new Error('private-worker-response')
      },
    })
    const run = executeVoiceProbe(
      { ...options, observeRpc: { method: 'test-observation' } },
      async () => driver,
    )
    await vi.advanceTimersByTimeAsync(60)
    const result = await run
    expect(result).toMatchObject({ status: 'error', error: 'Voice probe error during observation' })
    expect(result.rpcResponse).toBeUndefined()
    expect(JSON.stringify(result)).not.toContain('private-worker-response')
    expect(driver.close).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds a stalled RPC to five seconds and ignores its late response', async () => {
    vi.useFakeTimers()
    const resolvers: ((response: string) => void)[] = []
    const { driver } = fixture()
    const rpcStarted = new Promise<void>((started) => {
      driver.observeRpc = () => {
        started()
        return new Promise((resolve) => {
          resolvers.push(resolve)
        })
      }
    })
    const run = executeVoiceProbe(
      { ...options, observeRpc: { method: 'test-observation' } },
      async () => driver,
    )
    await vi.advanceTimersByTimeAsync(60)
    await rpcStarted
    await vi.advanceTimersByTimeAsync(5_000)
    const result = await run
    expect(result).toMatchObject({
      status: 'timeout',
      error: 'Voice probe timeout during observation',
    })
    expect(driver.close).toHaveBeenCalledTimes(1)
    for (const resolve of resolvers) resolve('late observation')
    await vi.advanceTimersByTimeAsync(0)
    expect(result.rpcResponse).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds a stalled dispatch and always closes the caller/room driver', async () => {
    vi.useFakeTimers()
    const { driver } = fixture({ dispatch: () => new Promise(() => {}) })
    const run = executeVoiceProbe(options, async () => driver)
    await vi.advanceTimersByTimeAsync(15_060)
    expect(await run).toMatchObject({
      status: 'timeout',
      error: 'Voice probe timeout during dispatch',
    })
    expect(driver.close).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('sanitizes setup failures and still closes allocated resources', async () => {
    const { driver } = fixture({
      start: async () => {
        throw new Error('secret-provider-payload')
      },
    })
    const result = await executeVoiceProbe(options, async () => driver)
    expect(result).toMatchObject({ status: 'error', error: 'Voice probe error during connection' })
    expect(JSON.stringify(result)).not.toContain('secret-provider-payload')
    expect(driver.close).toHaveBeenCalledTimes(1)
  })

  it('stops on an asynchronous transport failure', async () => {
    const { driver } = fixture()
    const result = await executeVoiceProbe(options, async (connection) => {
      driver.dispatch = async () => connection.onError()
      return driver
    })
    expect(result.status).toBe('error')
    expect(driver.sendFrame).not.toHaveBeenCalled()
    expect(driver.close).toHaveBeenCalledTimes(1)
  })

  it('bounds cleanup rather than leaving a completed probe waiting forever', async () => {
    vi.useFakeTimers()
    const { driver } = fixture({
      start: async () => {
        throw new Error('Setup failed')
      },
      close: () => new Promise(() => {}),
    })
    const run = executeVoiceProbe(options, async () => driver)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(await run).toMatchObject({ status: 'error', error: 'Voice probe cleanup failed' })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('validates duration and complete fixture fit before allocating a driver', async () => {
    const createDriver = vi.fn<Parameters<typeof executeVoiceProbe>[1]>(async () => fixture().driver)
    await expect(
      executeVoiceProbe({ ...options, durationMs: 120_020 }, createDriver),
    ).rejects.toThrow('durationMs')
    await expect(
      executeVoiceProbe({ ...options, initialSilenceMs: 60 }, createDriver),
    ).rejects.toThrow('complete PCM fixture')
    await expect(
      executeVoiceProbe({ ...options, observeRpc: { method: ' ' } }, createDriver),
    ).rejects.toThrow('RPC method')
    await expect(
      executeVoiceProbe({ ...options, observeData: { topic: ' ' } }, createDriver),
    ).rejects.toThrow('data topic')
    expect(createDriver).not.toHaveBeenCalled()
  })

  it('retains a delayed reply after sixty seconds in a longer observation window', async () => {
    vi.useFakeTimers()
    const { driver } = fixture()
    const run = executeVoiceProbe({ ...options, durationMs: 110_000 }, async (connection) => {
      driver.dispatch = async () => {
        setTimeout(
          () => connection.onTranscript('The corrected test check is complete.', 'late-reply'),
          105_000,
        )
      }
      return driver
    })
    await vi.advanceTimersByTimeAsync(110_000)
    expect(await run).toMatchObject({
      status: 'completed',
      assistantTranscripts: ['The corrected test check is complete.'],
    })
    expect(driver.close).toHaveBeenCalledTimes(1)
  })
})
