import type { voice } from '@livekit/agents'

import { ReadableStream } from 'node:stream/web'

import type { VoiceEvalUserAudio } from './types'

import { requireLiveKit } from './livekit-sdk'

/** Uses the simulated caller's existing microphone path; the tested agent hears only PCM. */
export async function playUserAudio({
  caller,
  input,
}: {
  caller: Pick<voice.AgentSession, 'interrupt' | 'say'>
  input: VoiceEvalUserAudio
}): Promise<void> {
  if (
    input.frames.length === 0 ||
    input.frames.some(
      (frame) =>
        !Number.isInteger(frame.sampleRate) ||
        frame.sampleRate <= 0 ||
        !Number.isInteger(frame.channels) ||
        frame.channels <= 0 ||
        !Number.isInteger(frame.samplesPerChannel) ||
        frame.samplesPerChannel <= 0 ||
        frame.data.length !== frame.samplesPerChannel * frame.channels,
    )
  )
    throw new Error('Caller fixture must contain nonempty valid PCM frames')
  const { rtc } = requireLiveKit()
  let index = 0
  const audio = new ReadableStream({
    pull(controller) {
      const frame = input.frames[index++]
      if (frame)
        controller.enqueue(
          new rtc.AudioFrame(frame.data, frame.sampleRate, frame.channels, frame.samplesPerChannel),
        )
      else controller.close()
    },
  })
  await caller.interrupt().await
  const speech = caller.say(input.text, {
    audio,
    allowInterruptions: false,
    addToChatCtx: true,
  })
  await speech.waitForPlayout()
  const error = speech.exception()
  if (error !== undefined) throw error
  if (speech.interrupted) throw new Error('Caller fixture audio was interrupted')
}
