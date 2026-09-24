import { execFile } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it, vi } from 'vitest'

import { createLiveKitProbe } from './probe-livekit'

type ProbeOptions = Parameters<typeof createLiveKitProbe>[0]
type Stub = (...args: unknown[]) => unknown

it('lets a standalone process exit after disposing the same RTC runtime used by ADK probes', async () => {
  const source = `
    import probe from ${JSON.stringify(new URL('./probe.ts', import.meta.url).href)};
    const rtc = await import('@livekit/rtc-node');
    const source = new rtc.AudioSource(24000, 1);
    const track = rtc.LocalAudioTrack.createAudioTrack('synthetic-cleanup-check', source);
    await track.close();
    await probe.disposeVoiceProbeRuntime();
    console.log('native runtime disposed');
  `
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '--eval', source],
    {
      cwd: fileURLToPath(new URL('../../../', import.meta.url)),
      timeout: 5000,
    },
  )
  expect(stdout.trim()).toBe('native runtime disposed')
})

it('accepts observation data only from the dispatch identity and keeps remote deletion separate from cleanup', async () => {
  const assigned = {
    identity: 'assigned-worker',
    attributes: { 'lk.agent.name': 'worker' },
    trackPublications: new Map(),
  }
  const spoof = {
    identity: 'other-worker',
    attributes: { 'lk.agent.name': 'worker' },
    trackPublications: new Map(),
  }
  const room = Object.assign(new EventEmitter(), {
    remoteParticipants: new Map([
      [spoof.identity, spoof],
      [assigned.identity, assigned],
    ]),
    localParticipant: { publishTrack: vi.fn<Stub>(), performRpc: vi.fn<Stub>() },
    connect: vi.fn<Stub>(),
    registerTextStreamHandler: vi.fn<Stub>(),
    disconnect: vi.fn<() => Promise<void>>(async () => {
      room.emit('disconnected', 2)
    }),
  })
  const deleteRoom = vi.fn<Stub>()
  vi.doMock('@livekit/rtc-node', () => ({
    Room: class {
      constructor() {
        return room
      }
    },
    AudioSource: class {},
    LocalAudioTrack: { createAudioTrack: () => ({ close: vi.fn<Stub>() }) },
    TrackPublishOptions: class {},
    TrackSource: { SOURCE_MICROPHONE: 1 },
    DisconnectReason: { 1: 'ROOM_DELETED', 2: 'CLIENT_INITIATED', ROOM_DELETED: 1 },
  }))
  vi.doMock('livekit-server-sdk', () => ({
    RoomServiceClient: class {
      createRoom = vi.fn<Stub>()
      deleteRoom = deleteRoom
    },
    AgentDispatchClient: class {
      createDispatch = async () => ({
        id: 'assigned-dispatch',
        state: {
          jobs: [{ agentName: 'worker', state: { participantIdentity: assigned.identity } }],
        },
      })
    },
    AccessToken: class {
      addGrant = vi.fn<Stub>()
      toJwt = async () => 'test-token'
    },
  }))
  try {
    const onData = vi.fn<NonNullable<ProbeOptions['onData']>>()
    const onRemoteDisconnect = vi.fn<NonNullable<ProbeOptions['onRemoteDisconnect']>>()
    const driver = await createLiveKitProbe({
      room: { url: 'ws://localhost:7880' },
      roomName: 'test-room',
      agentName: 'worker',
      sampleRate: 16000,
      participantAttributes: {},
      signal: new AbortController().signal,
      observeData: { topic: 'state' },
      onAudio: vi.fn<NonNullable<ProbeOptions['onAudio']>>(),
      onTranscript: vi.fn<NonNullable<ProbeOptions['onTranscript']>>(),
      onError: vi.fn<NonNullable<ProbeOptions['onError']>>(),
      onData,
      onRemoteDisconnect,
    })
    await driver.start()
    room.emit('dataReceived', new TextEncoder().encode('before assignment'), assigned, 0, 'state')
    await driver.dispatch()
    room.emit('dataReceived', new TextEncoder().encode('spoof'), spoof, 0, 'state')
    room.emit('dataReceived', new TextEncoder().encode('wrong topic'), assigned, 0, 'other')
    room.emit('dataReceived', new TextEncoder().encode('missing sender'), undefined, 0, 'state')
    room.emit('dataReceived', new TextEncoder().encode('  {"ended":true}\n'), assigned, 0, 'state')
    room.emit('disconnected', 1)
    await driver.close()
    room.emit('dataReceived', new TextEncoder().encode('after cleanup'), assigned, 0, 'state')
    expect(onData.mock.calls).toEqual([['  {"ended":true}\n']])
    expect(onRemoteDisconnect.mock.calls).toEqual([['ROOM_DELETED']])
    expect(deleteRoom).not.toHaveBeenCalled()
  } finally {
    vi.doUnmock('@livekit/rtc-node')
    vi.doUnmock('livekit-server-sdk')
  }
})
