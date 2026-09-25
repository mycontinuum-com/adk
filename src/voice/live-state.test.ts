import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BaseSession } from '../session/base'
import { sessionService } from '../session/service'
import { SQLiteStore } from '../session/sqlite'
import { applyLiveState, seedLiveState } from './live-state'

test('carries workflow state and deletions through committed isolated runs and reopening', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'adk-live-state-'))
  let store = new SQLiteStore(join(directory, 'state.sqlite'))
  try {
    let service = sessionService(store)
    const owner = await service.createSession('test')
    owner.state.update({ stage: 'matching', obsolete: 'discard', attempts: 0 })
    owner.state.patient.update({ verified: false })
    expect((await service.commitSession(owner)).ok).toBe(true)

    const first = await service.createSession('test')
    seedLiveState(owner, first)
    const cursor = first.events.length
    expect(first.state.stage).toBe('matching')
    first.state.update({
      stage: 'questionnaire',
      patientId: 'synthetic-patient',
      obsolete: undefined,
    })
    first.boundState('matching-run').patient.verified = true
    owner.state.attempts = 1
    applyLiveState(first, owner, cursor)
    expect(owner.state.attempts).toBe(1)
    expect(owner.state.patientId).toBe('synthetic-patient')
    expect(owner.state.obsolete).toBeUndefined()
    expect((await service.commitSession(first)).ok).toBe(true)
    expect((await service.commitSession(owner)).ok).toBe(true)

    await store.close()
    store = new SQLiteStore(join(directory, 'state.sqlite'))
    service = sessionService(store)
    const reloaded = await service.getSession('test', owner.id)
    if (!reloaded) throw new Error('Call session was not persisted')
    expect(reloaded.state.patient.verified).toBe(true)
    expect(reloaded.boundState('next-run').patient.verified).toBe(true)
    const second = await service.createSession('test')
    seedLiveState(reloaded, second)
    expect(Object.fromEntries(Object.entries(second.state))).toEqual({
      stage: 'questionnaire',
      patientId: 'synthetic-patient',
      attempts: 1,
    })
    expect(second.id).not.toBe(first.id)
  } finally {
    await store.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('projects latest recorded values and isolates nested state in both directions', () => {
  const owner = new BaseSession('test')
  owner.state.update({ request: { answers: ['old'] } })
  owner.state.update({ request: { answers: ['latest'] } })
  const backend = new BaseSession('test')
  seedLiveState(owner, backend)
  const cursor = backend.events.length
  expect(backend.events.filter((event) => event.type === 'state_change')).toHaveLength(1)
  const backendRequest = backend.state.request as { answers: string[] }
  backendRequest.answers.push('backend-only')
  expect(owner.state.request).toEqual({ answers: ['latest'] })

  backend.state.update({ receipt: { submitted: true } })
  applyLiveState(backend, owner, cursor)
  const backendReceipt = backend.state.receipt as { submitted: boolean }
  backendReceipt.submitted = false
  expect(owner.state.receipt).toEqual({ submitted: true })
})

test('carries unbound scope changes but never temp state or bound scope snapshots', () => {
  const owner = new BaseSession('test', { scopes: { user: 'caller' } })
  const backend = new BaseSession('test', { scopes: { user: 'caller' } })
  owner.bindSharedState('user', { locale: 'old' })
  backend.bindSharedState('user', { locale: 'fresh' })
  const setupState = owner.boundState('setup')
  setupState.patient.update({ matched: 'synthetic-patient' })
  setupState.temp.secret = 'temporary'
  void setupState.user.locale
  seedLiveState(owner, backend)
  const cursor = backend.events.length
  expect(backend.state.patient.matched).toBe('synthetic-patient')
  expect(backend.state.user.locale).toBe('fresh')
  expect(backend.boundState('setup').temp.secret).toBeUndefined()

  const runState = backend.boundState('run')
  expect(runState.patient.matched).toBe('synthetic-patient')
  runState.patient.update({ matched: undefined, verified: true })
  runState.user.locale = 'updated'
  runState.temp.secret = 'another temporary value'
  applyLiveState(backend, owner, cursor)
  expect(owner.state.patient.matched).toBeUndefined()
  expect(owner.state.patient.verified).toBe(true)
  expect(owner.state.user.locale).toBe('old')
  expect(owner.boundState('run').temp.secret).toBeUndefined()
})

test('does not copy observations or backend messages into call state', () => {
  const owner = new BaseSession('test')
  const backend = new BaseSession('test')
  backend.state.practice.update({ name: 'Demo practice' })
  const cursor = backend.events.length
  backend.bindSharedState('practice', { name: 'Observed practice' })
  void backend.boundState('run').practice.name
  expect(backend.events.at(-1)).toMatchObject({ type: 'state_change', source: 'observation' })
  backend.input.message('Private backend input')
  applyLiveState(backend, owner, cursor)
  expect(owner.events).toHaveLength(0)
})
