import { setTimeout as delay } from 'node:timers/promises'

import type { VoiceProbeConnection, VoiceProbeDriver } from './probe'

/** @internal */
export async function createLiveKitProbe(config: VoiceProbeConnection): Promise<VoiceProbeDriver> {
  const [rtc, server] = await Promise.all([
    import('@livekit/rtc-node'),
    import('livekit-server-sdk'),
  ])
  const { url, apiKey, apiSecret } = config.room
  const rooms = new server.RoomServiceClient(url, apiKey, apiSecret)
  const dispatch = new server.AgentDispatchClient(url, apiKey, apiSecret)
  const room = new rtc.Room()
  const source = new rtc.AudioSource(config.sampleRate, 1)
  const track = rtc.LocalAudioTrack.createAudioTrack('voice-probe-caller', source)
  const readers: ReadableStreamDefaultReader<InstanceType<typeof rtc.AudioFrame>>[] = []
  const captured = new Set<string>()
  const finalSegments = new Set<string>()
  let assignedIdentity: string | undefined
  let requestedDispatchId: string | undefined
  let created = false
  let mediaClosed = false
  let closing = false
  const isTarget = (participant: InstanceType<typeof rtc.RemoteParticipant>) =>
    participant.identity === assignedIdentity ||
    participant.attributes['lk.agent.name'] === config.agentName
  const capture = (
    remoteTrack: InstanceType<typeof rtc.Track>,
    participant: InstanceType<typeof rtc.RemoteParticipant>,
  ) => {
    const sid = remoteTrack.sid
    if (
      !sid ||
      config.signal.aborted ||
      !isTarget(participant) ||
      remoteTrack.kind !== rtc.TrackKind.KIND_AUDIO ||
      captured.has(sid)
    )
      return
    captured.add(sid)
    const reader = new rtc.AudioStream(remoteTrack, config.sampleRate, 1).getReader()
    readers.push(reader)
    void (async () => {
      while (!config.signal.aborted) {
        const item = await reader.read()
        if (item.done) break
        config.onAudio(item.value.data, item.value.sampleRate)
      }
    })().catch(() => {
      if (!config.signal.aborted) config.onError()
    })
  }
  room.on('trackSubscribed', (remoteTrack, _publication, participant) =>
    capture(remoteTrack, participant),
  )
  room.on('participantAttributesChanged', (_attributes, participant) => {
    const remote = room.remoteParticipants.get(participant.identity)
    if (remote)
      for (const publication of remote.trackPublications.values()) {
        if (publication.track) capture(publication.track, remote)
      }
  })
  room.on('dataReceived', (payload, participant, _kind, topic) => {
    if (
      closing ||
      config.signal.aborted ||
      !config.observeData ||
      topic !== config.observeData.topic ||
      !assignedIdentity ||
      participant?.identity !== assignedIdentity
    )
      return
    config.onData(new TextDecoder().decode(payload))
  })
  room.on('disconnected', (reason) => {
    if (closing || config.signal.aborted) return
    if (reason === rtc.DisconnectReason.ROOM_DELETED) created = false
    config.onRemoteDisconnect(rtc.DisconnectReason[reason] ?? 'UNKNOWN_REASON')
  })
  room.registerTextStreamHandler('lk.transcription', (reader, sender) => {
    const participant = room.remoteParticipants.get(sender.identity)
    if (!participant || !isTarget(participant)) return
    const id = reader.info.attributes?.['lk.segment_id'] ?? reader.info.streamId
    const final = reader.info.attributes?.['lk.transcription_final'] === 'true'
    void reader
      .readAll()
      .then((text) => {
        if (!text.trim() || finalSegments.has(id)) return
        if (final) finalSegments.add(id)
        config.onTranscript(text, id)
      })
      .catch(() => {
        if (!config.signal.aborted) config.onError()
      })
  })
  const close = async () => {
    closing = true
    const tasks = readers.splice(0).map((reader) => reader.cancel())
    if (!mediaClosed) {
      mediaClosed = true
      tasks.push(track.close())
    }
    tasks.push(room.disconnect())
    if (created) {
      created = false
      tasks.push(rooms.deleteRoom(config.roomName))
    }
    const outcomes = await Promise.allSettled(tasks)
    if (outcomes.some((outcome) => outcome.status === 'rejected'))
      throw new Error('Probe cleanup failed')
  }
  return {
    async start() {
      try {
        config.signal.throwIfAborted()
        await rooms.createRoom({ name: config.roomName, emptyTimeout: 30, departureTimeout: 10 })
        created = true
        config.signal.throwIfAborted()
        const token = new server.AccessToken(apiKey, apiSecret, {
          identity: 'voice-probe-caller',
          ttl: '5m',
          attributes: config.participantAttributes,
        })
        token.addGrant({
          room: config.roomName,
          roomJoin: true,
          canPublish: true,
          canSubscribe: true,
        })
        await room.connect(url, await token.toJwt(), { autoSubscribe: true, dynacast: false })
        config.signal.throwIfAborted()
        if (!room.localParticipant) throw new Error('Caller not connected')
        await room.localParticipant.publishTrack(
          track,
          new rtc.TrackPublishOptions({ source: rtc.TrackSource.SOURCE_MICROPHONE }),
        )
        config.signal.throwIfAborted()
      } catch (error) {
        await close()
        throw error
      }
    },
    async dispatch() {
      const requested = await dispatch.createDispatch(config.roomName, config.agentName)
      requestedDispatchId = requested.id
      let current: Awaited<ReturnType<typeof dispatch.getDispatch>> = requested
      while (!config.signal.aborted) {
        assignedIdentity = current?.state?.jobs.find((job) => job.agentName === config.agentName)
          ?.state?.participantIdentity
        const participant = config.observeData
          ? assignedIdentity && room.remoteParticipants.get(assignedIdentity)
          : [...room.remoteParticipants.values()].find(isTarget)
        if (participant) {
          for (const publication of participant.trackPublications.values()) {
            if (publication.track) capture(publication.track, participant)
          }
          return
        }
        await delay(500, undefined, { signal: config.signal })
        current = await dispatch.getDispatch(requested.id, config.roomName)
      }
      config.signal.throwIfAborted()
    },
    async sendFrame(pcm16) {
      await source.captureFrame(new rtc.AudioFrame(pcm16, config.sampleRate, 1, pcm16.length))
    },
    async observeRpc(request) {
      config.signal.throwIfAborted()
      if (!requestedDispatchId || !room.localParticipant)
        throw new Error('Caller or dispatch unavailable')
      const current = await dispatch.getDispatch(requestedDispatchId, config.roomName)
      const identity = current?.state?.jobs.find((job) => job.agentName === config.agentName)?.state
        ?.participantIdentity
      config.signal.throwIfAborted()
      if (!identity || !room.remoteParticipants.has(identity))
        throw new Error('Assigned worker unavailable')
      return room.localParticipant.performRpc({
        destinationIdentity: identity,
        method: request.method,
        payload: request.payload ?? '',
        responseTimeout: 5_000,
      })
    },
    close,
  }
}
