import { Future, initializeLogger, voice } from '@livekit/agents'
import { AudioFrame } from '@livekit/rtc-node'
import { vi } from 'vitest'

import type { VoiceEvalUserAudio } from './types'

import { playUserAudio } from './user-audio'

initializeLogger({ pretty: false, level: 'silent' })

function fixture() {
  const interruption = new Future<void>()
  const playout = new Future<void>()
  const handle = voice.SpeechHandle.create({ allowInterruptions: false })
  vi.spyOn(handle, 'waitForPlayout').mockImplementation(() => playout.await)
  vi.spyOn(handle, 'exception').mockReturnValue(undefined)
  const caller = {
    interrupt: vi.fn<voice.AgentSession['interrupt']>(() => interruption),
    say: vi.fn<voice.AgentSession['say']>(() => handle),
  }
  const input: VoiceEvalUserAudio = {
    text: 'No.',
    frames: [
      { data: new Int16Array([1, 2, 3, 4]), sampleRate: 48000, channels: 1, samplesPerChannel: 4 },
    ],
  }
  return { caller, input, interruption, playout, handle }
}

test('waits for caller interruption, plays supplied PCM, and waits for its playout', async () => {
  const f = fixture()
  const done = vi.fn<() => void>()
  const run = playUserAudio(f).then(done)
  expect(f.caller.interrupt).toHaveBeenCalledWith()
  expect(f.caller.say).not.toHaveBeenCalled()
  f.interruption.resolve()
  await vi.waitFor(() =>
    expect(f.caller.say).toHaveBeenCalledWith('No.', {
      audio: expect.anything(),
      allowInterruptions: false,
      addToChatCtx: true,
    }),
  )
  const audio = f.caller.say.mock.calls[0]?.[1]?.audio
  expect(audio).toBeDefined()
  const reader = audio!.getReader()
  const frame = (await reader.read()).value
  expect(frame).toBeInstanceOf(AudioFrame)
  expect(frame).toMatchObject(f.input.frames[0])
  expect((await reader.read()).done).toBe(true)
  expect(done).not.toHaveBeenCalled()
  f.playout.resolve()
  await run
  expect(done).toHaveBeenCalledOnce()
})

test('does not play audio if caller interruption fails', async () => {
  const f = fixture()
  const error = new Error('caller closed')
  const run = playUserAudio(f)
  f.interruption.reject(error)
  await expect(run).rejects.toBe(error)
  expect(f.caller.say).not.toHaveBeenCalled()
})

test('propagates playout failure', async () => {
  const f = fixture()
  const error = new Error('playout failed')
  f.interruption.resolve()
  const run = playUserAudio(f)
  await Promise.resolve()
  f.playout.reject(error)
  await expect(run).rejects.toBe(error)
})

test('does not report an interrupted fixture as completed playout', async () => {
  const f = fixture()
  vi.spyOn(f.handle, 'interrupted', 'get').mockReturnValue(true)
  f.interruption.resolve()
  f.playout.resolve()
  await expect(playUserAudio(f)).rejects.toThrow('Caller fixture audio was interrupted')
})

test('rejects a completed handle that records a playout exception', async () => {
  const f = fixture()
  const error = new Error('audio decoder failed')
  vi.spyOn(f.handle, 'exception').mockReturnValue(error)
  f.interruption.resolve()
  f.playout.resolve()
  await expect(playUserAudio(f)).rejects.toBe(error)
})

test.each([
  { frames: [] },
  { frames: [new AudioFrame(new Int16Array(), 48000, 1, 0)] },
  { frames: [new AudioFrame(new Int16Array(3), 48000, 1, 4)] },
])('rejects invalid fixture frames before touching the caller: %j', async ({ frames }) => {
  const f = fixture()
  await expect(playUserAudio({ caller: f.caller, input: { text: 'No.', frames } })).rejects.toThrow(
    'nonempty valid PCM frames',
  )
  expect(f.caller.interrupt).not.toHaveBeenCalled()
  expect(f.caller.say).not.toHaveBeenCalled()
})
