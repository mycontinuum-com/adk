import { realtime } from '@livekit/agents-plugin-openai'

import { calculateCost, calculateSessionCost, sumCosts } from '../providers/pricing'
import {
  backendModelCalls,
  isRealtimeMetrics,
  LiveVoiceMeter,
  realtimeTokenUsage,
} from './live-usage'

/**
 * Drives the installed plugin's private usage handler, which converts cumulative `usage.seconds`
 * into `realtime_model_metrics` deltas and resets on reconnect.
 */
function pluginConnection(meter: LiveVoiceMeter) {
  const state = {
    usageSeconds: 0,
    _sessionId: 'connection-one',
    duplexModel: { label: () => 'gpt-live', model: 'gpt-live-1', provider: 'openai' },
    emit: (_event: string, metrics: unknown) => meter.observeMetrics(metrics),
  }
  const handleUsage: unknown = Reflect.get(realtime.GPTLiveSession.prototype, 'handleUsage')
  if (typeof handleUsage !== 'function') throw new Error('Plugin usage handler not found')
  return {
    usage: (seconds: number) => handleUsage.call(state, seconds),
    closed: (seconds: number) => {
      meter.observeServerEvent({ type: 'session.closed' }, state._sessionId)
      handleUsage.call(state, seconds)
    },
    reconnect: (sessionId: string) => {
      state.usageSeconds = 0
      state._sessionId = sessionId
    },
  }
}

describe('GPT Live session pricing', () => {
  test('charges $0.05 per minute, per second', () => {
    expect(calculateSessionCost('gpt-live-1', 90)).toBe(0.075)
    expect(calculateSessionCost('gpt-live-1', 60)).toBe(0.05)
    expect(calculateSessionCost('gpt-live-1', 1)).toBeCloseTo(0.05 / 60, 12)
    expect(calculateSessionCost('gpt-live-1-2026-09-01', 120)).toBe(0.1)
    expect(calculateSessionCost('gpt-live-10', 90)).toBeNull()
    expect(calculateSessionCost('gpt-realtime', 90)).toBeNull()
  })
})

describe('Live voice meter', () => {
  test('cumulative updates of 12 then 15 seconds bill 15 seconds, not 27', () => {
    const meter = new LiveVoiceMeter('gpt-live-1')
    const connection = pluginConnection(meter)
    connection.usage(12)
    connection.closed(15)
    expect(meter.usage()).toEqual({
      modelName: 'gpt-live-1',
      seconds: 15,
      cost: { basis: 'reported', totalCost: 0.0125, currency: 'USD' },
    })
  })

  test('sums provider sessions across a reconnect', () => {
    const meter = new LiveVoiceMeter('gpt-live-1')
    const connection = pluginConnection(meter)
    connection.usage(12)
    connection.closed(20)
    connection.reconnect('connection-two')
    connection.usage(5)
    connection.closed(10)
    expect(meter.usage()).toEqual({
      modelName: 'gpt-live-1',
      seconds: 30,
      cost: { basis: 'reported', totalCost: 0.025, currency: 'USD' },
    })
  })

  test('a connection that dropped before reporting keeps the call estimated', () => {
    let clock = 0
    const meter = new LiveVoiceMeter('gpt-live-1', () => clock)
    const connection = pluginConnection(meter)
    meter.start()
    meter.observeConnection('connection-one')
    connection.reconnect('connection-two')
    meter.observeServerEvent(
      { type: 'session.started', session: { id: 'connection-two' } },
      undefined,
    )
    connection.closed(10)
    clock = 135_000
    meter.stop()
    expect(meter.usage()).toEqual({
      modelName: 'gpt-live-1',
      seconds: 135,
      cost: { basis: 'estimated', totalCost: 0.1125, currency: 'USD' },
    })
  })

  test('estimates from connection time when no usage arrives', () => {
    let clock = 5_000
    const meter = new LiveVoiceMeter('gpt-live-1', () => clock)
    meter.start()
    clock += 90_000
    meter.stop()
    expect(meter.usage()).toEqual({
      modelName: 'gpt-live-1',
      seconds: 90,
      cost: { basis: 'estimated', totalCost: 0.075, currency: 'USD' },
    })
  })

  test('estimates when a connection ends without session.closed', () => {
    let clock = 0
    const meter = new LiveVoiceMeter('gpt-live-1', () => clock)
    const connection = pluginConnection(meter)
    meter.start()
    connection.usage(48)
    clock = 30_000
    meter.stop()
    expect(meter.usage()).toEqual({
      modelName: 'gpt-live-1',
      seconds: 48,
      cost: { basis: 'estimated', totalCost: 0.04, currency: 'USD' },
    })

    const later = new LiveVoiceMeter('gpt-live-1', () => clock)
    const dropped = pluginConnection(later)
    clock = 0
    later.start()
    dropped.usage(40)
    clock = 60_000
    later.stop()
    expect(later.usage().seconds).toBe(60)
    expect(later.usage().cost).toEqual({ basis: 'estimated', totalCost: 0.05, currency: 'USD' })
  })

  test('reports unavailable, not zero, when nothing was measured', () => {
    const meter = new LiveVoiceMeter('gpt-live-1')
    meter.stop()
    expect(meter.usage()).toEqual({ modelName: 'gpt-live-1', cost: { basis: 'unavailable' } })
  })

  test('keeps measured seconds but no cost for an unpriced voice model', () => {
    const meter = new LiveVoiceMeter('unpriced-live')
    meter.observeMetrics({
      type: 'realtime_model_metrics',
      requestId: 'c',
      sessionDurationMs: 9_000,
    })
    meter.observeServerEvent({ type: 'session.closed' }, 'c')
    expect(meter.usage()).toEqual({
      modelName: 'unpriced-live',
      seconds: 9,
      cost: { basis: 'unavailable' },
    })
  })
})

describe('backend model calls', () => {
  const start = (invocationId: string) => ({
    id: `${invocationId}-start`,
    type: 'model_start' as const,
    createdAt: 0,
    invocationId,
    agentName: 'backend',
    stepIndex: 1,
    messageCount: 0,
    tools: [],
  })
  const end = (invocationId: string, inputTokens?: number) => ({
    id: `${invocationId}-end`,
    type: 'model_end' as const,
    createdAt: 0,
    invocationId,
    agentName: 'backend',
    stepIndex: 1,
    durationMs: 1,
    ...(inputTokens !== undefined && {
      usage: { modelName: 'gpt-4o-mini', inputTokens, outputTokens: 0 },
    }),
  })

  test('a call that started without a recorded end has unknown usage', () => {
    expect(
      backendModelCalls([start('a'), end('a', 10), start('a'), end('a'), start('a'), start('b')]),
    ).toEqual([
      { modelName: 'gpt-4o-mini', inputTokens: 10, outputTokens: 0 },
      undefined,
      undefined,
      undefined,
    ])
  })
})

describe('cost totals', () => {
  test('a total is only as strong as its weakest component', () => {
    const reported = { basis: 'reported', totalCost: 0.15, currency: 'USD' } as const
    const estimated = { basis: 'estimated', totalCost: 0.075, currency: 'USD' } as const
    expect(sumCosts([reported, reported])).toEqual({
      basis: 'reported',
      totalCost: 0.3,
      currency: 'USD',
    })
    const mixed = sumCosts([reported, estimated])
    expect(mixed.basis).toBe('estimated')
    expect(mixed.basis !== 'unavailable' && mixed.totalCost).toBeCloseTo(0.225, 12)
    expect(sumCosts([reported, { basis: 'unavailable' }])).toEqual({ basis: 'unavailable' })
  })
})

describe('simulated caller usage', () => {
  test('prices gpt-realtime text and audio tokens at their own rates', () => {
    const usage = realtimeTokenUsage(
      {
        type: 'realtime_model_metrics',
        inputTokens: 11_000,
        outputTokens: 5_500,
        inputTokenDetails: {
          audioTokens: 10_000,
          textTokens: 1_000,
          imageTokens: 0,
          cachedTokens: 2_000,
          cachedTokensDetails: { audioTokens: 2_000, textTokens: 0, imageTokens: 0 },
        },
        outputTokenDetails: { textTokens: 500, audioTokens: 5_000, imageTokens: 0 },
      },
      'gpt-realtime',
    )
    expect(usage).toEqual({
      provider: 'openai',
      modelName: 'gpt-realtime',
      inputTokens: 11_000,
      cachedTokens: 2_000,
      outputTokens: 5_500,
      audioInputTokens: 10_000,
      audioCachedTokens: 2_000,
      audioOutputTokens: 5_000,
    })
    expect(calculateCost(usage!)!.totalCost).toBeCloseTo(0.004 + 0.256 + 0.0008 + 0.008 + 0.32, 12)
  })

  test('a response without reported tokens has unknown usage, not zero', () => {
    const metrics = { type: 'realtime_model_metrics', inputTokens: 0, outputTokens: 0 }
    expect(isRealtimeMetrics(metrics)).toBe(true)
    expect(realtimeTokenUsage(metrics, 'gpt-realtime')).toBeUndefined()
    expect(isRealtimeMetrics({ type: 'vad_metrics' })).toBe(false)
  })
})
