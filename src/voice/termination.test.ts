import { vi } from 'vitest'

import type { VoiceEvent } from './types'

import { terminateLiveKitCall } from './termination'

function fixture() {
  const deleteRoom = vi.fn<(room: string) => Promise<void>>().mockResolvedValue(undefined)
  const removeParticipant = vi
    .fn<(room: string, participant: string) => Promise<void>>()
    .mockResolvedValue(undefined)
  const shutdown = vi.fn<(reason?: string) => void>()
  const onVoiceEvent = vi.fn<(event: VoiceEvent) => void>()
  const deps = {
    livekitServer: () => ({
      RoomServiceClient: class {
        deleteRoom = deleteRoom
        removeParticipant = removeParticipant
      },
    }),
  }
  return { deps, shutdown, onVoiceEvent, deleteRoom, removeParticipant }
}

test('terminates the room even when job shutdown fails', async () => {
  const f = fixture()
  const error = new Error('Job shutdown failed')
  f.shutdown.mockImplementation(() => {
    throw error
  })

  await terminateLiveKitCall({
    config: undefined,
    deps: f.deps,
    ctx: { room: { name: 'call-room' }, shutdown: f.shutdown },
    onVoiceEvent: f.onVoiceEvent,
  })

  expect(f.deleteRoom).toHaveBeenCalledWith('call-room')
  expect(f.onVoiceEvent).toHaveBeenCalledWith({ type: 'voice_error', error })
})

test('reports missing caller identity without deleting the room', async () => {
  const f = fixture()

  await terminateLiveKitCall({
    config: { strategy: 'removeParticipant' },
    deps: f.deps,
    ctx: { room: { name: 'shared-room' }, shutdown: f.shutdown },
    onVoiceEvent: f.onVoiceEvent,
  })

  expect(f.removeParticipant).not.toHaveBeenCalled()
  expect(f.deleteRoom).not.toHaveBeenCalled()
  expect(f.onVoiceEvent).toHaveBeenCalledWith({
    type: 'voice_error',
    error: new Error('Cannot remove LiveKit participant: participant identity is unavailable.'),
  })
})
