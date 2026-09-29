import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'

import { recordRooms } from './recorder'

interface TestTrack {
  readonly sid: string
}

/** A room with no participants yet; tests emit its LiveKit events. */
class TestRoom extends EventEmitter {
  readonly remoteParticipants = new Map<
    string,
    {
      identity: string
      trackPublications: Map<string, { sid: string; kind: number; track?: TestTrack }>
    }
  >()
}

/** An audio reader that never yields, for a recording that gets no tracks. */
class SilentAudioStream extends ReadableStream<{ data: Int16Array }> {
  constructor(_track: TestTrack) {
    super()
  }
}

test('reports missing audio instead of returning a nonexistent recording', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'adk-recorder-'))
  const room = new TestRoom()
  try {
    const recorder = recordRooms(
      {
        rooms: [room],
        agentIdentity: 'agent',
        userIdentity: 'user',
        recordingDir: directory,
        caseName: 'no-audio',
      },
      { AudioStream: SilentAudioStream },
    )
    await expect(recorder.stop()).rejects.toThrow('received no audio tracks')
    expect(existsSync(join(directory, 'recording.wav'))).toBe(false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('keeps audio from a room whose track closed before the recording stopped', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'adk-hung-up-recorder-'))
  class AudioStream extends ReadableStream<{ data: Int16Array }> {
    constructor(track: TestTrack) {
      super({
        start(controller) {
          controller.enqueue({ data: new Int16Array([track.sid === 'agent-track' ? 700 : 300]) })
          // The caller's room left the call: LiveKit ends the agent track it was subscribed to.
          if (track.sid === 'agent-track') controller.close()
        },
      })
    }
  }
  const agentRoom = new TestRoom()
  const callerRoom = new TestRoom()
  try {
    const recorder = recordRooms(
      {
        rooms: [agentRoom, callerRoom],
        agentIdentity: 'agent',
        userIdentity: 'user',
        recordingDir: directory,
        caseName: 'hung-up',
      },
      { AudioStream },
    )
    agentRoom.emit(
      'trackSubscribed',
      { sid: 'user-track' },
      { sid: 'user-track', kind: 1 },
      { identity: 'user' },
    )
    callerRoom.emit(
      'trackSubscribed',
      { sid: 'agent-track' },
      { sid: 'agent-track', kind: 1 },
      { identity: 'agent' },
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    const wav = readFileSync(await recorder.stop())
    expect(wav.readInt16LE(44)).toBe(1000)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('records existing and newly subscribed remote tracks once without owning their rooms', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'adk-borrowed-recorder-'))
  const disconnect = vi.fn<() => Promise<void>>(async () => {})
  const canceled = vi.fn<() => void>()
  const frames = new Map<string, number>([
    ['user-track', 300],
    ['agent-track', 700],
  ])
  const created: string[] = []
  class AudioStream extends ReadableStream<{ data: Int16Array }> {
    constructor(track: TestTrack) {
      created.push(track.sid)
      super({
        start(controller) {
          controller.enqueue({ data: new Int16Array([frames.get(track.sid)!]) })
        },
        cancel: canceled,
      })
    }
  }
  class Room extends TestRoom {
    disconnect = disconnect
  }
  const agentRoom = new Room()
  const callerRoom = new Room()
  const userTrack = { sid: 'user-track' }
  const userPub = { sid: 'user-track', kind: 1, track: userTrack }
  agentRoom.remoteParticipants.set('user', {
    identity: 'user',
    trackPublications: new Map([['user-track', userPub]]),
  })
  let clock = 0
  const now = vi.spyOn(Date, 'now').mockImplementation(() => clock)
  try {
    const recorder = recordRooms(
      {
        rooms: [agentRoom, callerRoom],
        agentIdentity: 'agent',
        userIdentity: 'user',
        recordingDir: directory,
        caseName: 'borrowed',
      },
      { AudioStream },
    )
    agentRoom.emit('trackSubscribed', userTrack, userPub, { identity: 'user' })
    clock = 1_000
    callerRoom.emit(
      'trackSubscribed',
      { sid: 'agent-track' },
      { sid: 'agent-track', kind: 1 },
      { identity: 'agent' },
    )
    callerRoom.emit(
      'trackSubscribed',
      { sid: 'irrelevant' },
      { sid: 'irrelevant', kind: 1 },
      { identity: 'unrelated' },
    )
    clock = 1_500
    agentRoom.emit('activeSpeakersChanged', [{ identity: 'agent' }])
    callerRoom.emit('activeSpeakersChanged', [{ identity: 'user' }])
    await Promise.resolve()
    const path = await recorder.stop()
    expect(await recorder.stop()).toBe(path)
    expect(created).toEqual(['user-track', 'agent-track'])
    expect(canceled).toHaveBeenCalledTimes(2)
    expect(disconnect).not.toHaveBeenCalled()
    expect(agentRoom.listenerCount('trackSubscribed')).toBe(0)
    expect(callerRoom.listenerCount('trackSubscribed')).toBe(0)
    expect(agentRoom.listenerCount('activeSpeakersChanged')).toBe(0)
    expect(recorder.tracker.finalize()).toMatchObject({
      timeToFirstSpeechMs: 500,
      interruptions: { count: 0 },
    })
    const wav = readFileSync(path)
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF')
    expect(wav.readInt16LE(44)).toBe(1000)
  } finally {
    now.mockRestore()
    rmSync(directory, { recursive: true, force: true })
  }
})
