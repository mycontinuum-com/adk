import { runTest, user, model, testAgent, setupAdkMatchers } from '../testing'
import {
  openai,
  gemini,
  claude,
  realtime,
  isRealtimeConfig,
  getInnerModel,
  getModelProvider,
  getModelName,
} from './models'

await setupAdkMatchers()
describe('model factories', () => {
  test('openai() creates an OpenAI model config', () => {
    const config = openai('gpt-4o')
    expect(config).toEqual({ provider: 'openai', name: 'gpt-4o' })
  })

  test('openai() with options', () => {
    const config = openai('gpt-4o', { temperature: 0.7, maxTokens: 1000 })
    expect(config.provider).toBe('openai')
    expect(config.name).toBe('gpt-4o')
    expect(config.temperature).toBe(0.7)
    expect(config.maxTokens).toBe(1000)
  })

  test('gemini() creates a Gemini model config', () => {
    const config = gemini('gemini-2.0-flash')
    expect(config).toEqual({ provider: 'gemini', name: 'gemini-2.0-flash' })
  })

  test('claude() creates a Claude model config', () => {
    const config = claude('claude-sonnet-4-20250514', {
      vertex: { project: 'test', location: 'us-east5' },
    })
    expect(config.provider).toBe('claude')
    expect(config.name).toBe('claude-sonnet-4-20250514')
    expect(config.vertex.project).toBe('test')
  })
})

describe('realtime() factory', () => {
  test('wraps an OpenAI model config', () => {
    const config = realtime({ model: openai('gpt-4o-realtime') })
    expect(config.realtime).toBe(true)
    expect(config.model).toEqual({ provider: 'openai', name: 'gpt-4o-realtime' })
    expect(config.voice).toBeUndefined()
    expect(config.stt).toBeUndefined()
    expect(config.tts).toBeUndefined()
  })

  test('passes through voice and turn detection config', () => {
    const config = realtime({
      model: openai('gpt-4o-realtime'),
      voice: 'alloy',
      turnDetection: { silenceDurationMs: 500, threshold: 0.6 },
    })
    expect(config.realtime).toBe(true)
    expect(config.voice).toBe('alloy')
    expect(config.turnDetection).toEqual({
      silenceDurationMs: 500,
      threshold: 0.6,
    })
  })

  test('passes through stt and tts for full pipeline mode', () => {
    const mockStt = { type: 'deepgram' }
    const mockTts = { type: 'elevenlabs' }
    const config = realtime({
      model: openai('gpt-4o'),
      stt: mockStt,
      tts: mockTts,
    })
    expect(config.realtime).toBe(true)
    expect(config.stt).toBe(mockStt)
    expect(config.tts).toBe(mockTts)
  })

  test('wraps a Gemini model config', () => {
    const config = realtime({ model: gemini('gemini-2.0-flash-live') })
    expect(config.realtime).toBe(true)
    expect(config.model).toEqual({ provider: 'gemini', name: 'gemini-2.0-flash-live' })
  })
})

describe('openai.realtime() sugar', () => {
  test('creates a RealtimeModelConfig wrapping OpenAI', () => {
    const config = openai.realtime('gpt-4o-realtime')
    expect(config.realtime).toBe(true)
    expect(config.model).toEqual({ provider: 'openai', name: 'gpt-4o-realtime' })
  })

  test('passes through voice and turnDetection', () => {
    const config = openai.realtime('gpt-4o-realtime', {
      voice: 'alloy',
      turnDetection: { type: 'server_vad', silenceDurationMs: 500 },
    })
    expect(config.voice).toBe('alloy')
    expect(config.turnDetection).toEqual({
      type: 'server_vad',
      silenceDurationMs: 500,
    })
  })

  test('passes through temperature to inner model', () => {
    const config = openai.realtime('gpt-4o-realtime', { temperature: 0.8 })
    expect(config.model).toEqual({
      provider: 'openai',
      name: 'gpt-4o-realtime',
      temperature: 0.8,
    })
  })

  test('passes through stt and tts', () => {
    const mockStt = { type: 'deepgram' }
    const mockTts = { type: 'elevenlabs' }
    const config = openai.realtime('gpt-4o', { stt: mockStt, tts: mockTts })
    expect(config.stt).toBe(mockStt)
    expect(config.tts).toBe(mockTts)
  })
})

describe('gemini.realtime() sugar', () => {
  test('creates a RealtimeModelConfig wrapping Gemini', () => {
    const config = gemini.realtime('gemini-2.0-flash-live')
    expect(config.realtime).toBe(true)
    expect(config.model).toEqual({ provider: 'gemini', name: 'gemini-2.0-flash-live' })
  })

  test('passes through voice config', () => {
    const config = gemini.realtime('gemini-2.0-flash-live', { voice: 'Puck' })
    expect(config.voice).toBe('Puck')
  })
})

describe('helper functions', () => {
  test('isRealtimeConfig identifies realtime configs', () => {
    expect(isRealtimeConfig(openai('gpt-4o'))).toBe(false)
    expect(isRealtimeConfig(gemini('gemini-2.0-flash'))).toBe(false)
    expect(isRealtimeConfig(realtime({ model: openai('gpt-4o-realtime') }))).toBe(true)
  })

  test('getInnerModel returns inner model for realtime', () => {
    const inner = openai('gpt-4o-realtime')
    const config = realtime({ model: inner })
    expect(getInnerModel(config)).toBe(inner)
  })

  test('getInnerModel returns itself for non-realtime', () => {
    const config = openai('gpt-4o')
    expect(getInnerModel(config)).toBe(config)
  })

  test('getModelProvider extracts provider from realtime config', () => {
    expect(getModelProvider(realtime({ model: openai('gpt-4o-realtime') }))).toBe('openai')
    expect(getModelProvider(realtime({ model: gemini('gemini-2.0-flash-live') }))).toBe('gemini')
  })

  test('getModelProvider extracts provider from standard config', () => {
    expect(getModelProvider(openai('gpt-4o'))).toBe('openai')
    expect(getModelProvider(gemini('gemini-2.0-flash'))).toBe('gemini')
  })

  test('getModelName extracts name from realtime config', () => {
    expect(getModelName(realtime({ model: openai('gpt-4o-realtime') }))).toBe('gpt-4o-realtime')
  })

  test('getModelName extracts name from standard config', () => {
    expect(getModelName(openai('gpt-4o'))).toBe('gpt-4o')
  })
})

describe('backward compatibility', () => {
  test('openai() call signature unchanged', () => {
    const config = openai('gpt-4o-mini')
    expect(config.provider).toBe('openai')
    expect(config.name).toBe('gpt-4o-mini')
    expect('realtime' in config).toBe(false)
  })

  test('gemini() call signature unchanged', () => {
    const config = gemini('gemini-2.0-flash')
    expect(config.provider).toBe('gemini')
    expect(config.name).toBe('gemini-2.0-flash')
    expect('realtime' in config).toBe(false)
  })
})

describe('realtime agent defaults', () => {
  test('agent with realtime model defaults to yields: true', async () => {
    const { status } = await runTest(testAgent({ model: openai.realtime('gpt-4o-realtime') }), [
      user('Hello'),
      model({ text: 'Hi there!' }),
    ])

    expect(status).toBe('yielded_message')
  })

  test('agent with non-realtime model defaults to yields: false', async () => {
    const { status } = await runTest(testAgent({ model: openai('gpt-4o') }), [
      user('Hello'),
      model({ text: 'Done.' }),
    ])

    expect(status).toBe('completed')
  })

  test('realtime agent with yields: false explicitly disables yielding', async () => {
    const { status } = await runTest(
      testAgent({ model: openai.realtime('gpt-4o-realtime'), yields: false }),
      [user('Hello'), model({ text: 'Done.' })],
    )

    expect(status).toBe('completed')
  })
})
