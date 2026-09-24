import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'

import { connectRecorder, recordRooms } from './recorder'

test('reports missing audio instead of returning a nonexistent recording', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'adk-recorder-'))
  const disconnect = vi.fn<() => Promise<void>>(async () => {})
  class Room extends EventEmitter {
    remoteParticipants = new Map()
    async connect() {}
    disconnect = disconnect
  }
  const sdk = { Room } as unknown as NonNullable<Parameters<typeof connectRecorder>[1]>
  try {
    const recorder = await connectRecorder(
      {
        roomUrl: 'wss://test',
        token: 'test-token',
        agentIdentity: 'agent',
        userIdentity: 'user',
        recordingDir: directory,
        caseName: 'no-audio',
      },
      sdk,
    )
    await expect(recorder.stop()).rejects.toThrow('received no audio tracks')
    expect(existsSync(join(directory, 'recording.wav'))).toBe(false)
    await recorder.disconnect()
    expect(disconnect).toHaveBeenCalledOnce()
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
    constructor(track: { sid: string }) {
      created.push(track.sid)
      super({
        start(controller) {
          controller.enqueue({ data: new Int16Array([frames.get(track.sid)!]) })
        },
        cancel: canceled,
      })
    }
  }
  class Room extends EventEmitter {
    remoteParticipants = new Map()
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
  try {
    const recorder = recordRooms(
      {
        rooms: [agentRoom, callerRoom],
        agentIdentity: 'agent',
        userIdentity: 'user',
        recordingDir: directory,
        caseName: 'borrowed',
      } as unknown as Parameters<typeof recordRooms>[0],
      { AudioStream } as unknown as NonNullable<Parameters<typeof recordRooms>[1]>,
    )
    agentRoom.emit('trackSubscribed', userTrack, userPub, { identity: 'user' })
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
    agentRoom.emit('activeSpeakersChanged', [{ identity: 'agent' }])
    callerRoom.emit('activeSpeakersChanged', [{ identity: 'user' }])
    await recorder.mediaReady
    await Promise.resolve()
    const path = await recorder.stop()
    expect(await recorder.stop()).toBe(path)
    expect(created).toEqual(['user-track', 'agent-track'])
    expect(canceled).toHaveBeenCalledTimes(2)
    expect(disconnect).not.toHaveBeenCalled()
    expect(agentRoom.listenerCount('trackSubscribed')).toBe(0)
    expect(callerRoom.listenerCount('trackSubscribed')).toBe(0)
    expect(agentRoom.listenerCount('activeSpeakersChanged')).toBe(0)
    expect(recorder.tracker.finalize().interruptions.count).toBe(0)
    const wav = readFileSync(path)
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF')
    expect(wav.readInt16LE(44)).toBe(1000)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
