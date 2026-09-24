import type { SessionStore } from '../types/session'

import { InMemoryStore } from './memory'
import { sessionService } from './service'

class GatedStore extends InMemoryStore {
  private gate?: { entered: () => void; released: Promise<void> }

  pauseNextCommit() {
    const entered = Promise.withResolvers<void>()
    const released = Promise.withResolvers<void>()
    this.gate = { entered: entered.resolve, released: released.promise }
    return { entered: entered.promise, release: released.resolve, fail: released.reject }
  }

  override async commit(...args: Parameters<SessionStore['commit']>) {
    const gate = this.gate
    this.gate = undefined
    if (gate) {
      gate.entered()
      await gate.released
    }
    return super.commit(...args)
  }
}

async function fixture() {
  const store = new GatedStore()
  const service = sessionService(store)
  const session = await service.createSession('app', { scopes: { user: 'user-1' } })
  const messages = async () =>
    (await store.load('app', session.id))?.events
      .filter((event) => event.type === 'user')
      .map((event) => event.text)
  const state = () => store.loadScopedState('app', 'user', 'user-1')
  return { store, service, session, messages, state }
}

describe('session persistence concurrency', () => {
  test('retains events appended while a commit is in flight', async () => {
    const { store, service, session, messages } = await fixture()
    session.input.message('first')
    const gate = store.pauseNextCommit()
    const first = service.commitSession(session)
    await gate.entered
    session.input.message('second')
    gate.release()
    expect(await first).toEqual({ ok: true, version: 2 })
    expect(await messages()).toEqual(['first'])
    await service.commitSession(session)
    expect(await messages()).toEqual(['first', 'second'])
  })

  test('serializes concurrent commits and evaluates the default version when each starts', async () => {
    const { store, service, session, messages } = await fixture()
    session.input.message('first')
    const gate = store.pauseNextCommit()
    const first = service.commitSession(session)
    await gate.entered
    session.input.message('second')
    const second = service.commitSession(session)
    gate.release()
    expect(await Promise.all([first, second])).toEqual([
      { ok: true, version: 2 },
      { ok: true, version: 3 },
    ])
    expect(await messages()).toEqual(['first', 'second'])
  })

  test('keeps an explicit expected version when the commit is queued', async () => {
    const { store, service, session, messages } = await fixture()
    session.input.message('first')
    const gate = store.pauseNextCommit()
    const first = service.commitSession(session)
    await gate.entered
    session.input.message('second')
    const second = service.commitSession(session, 1)
    gate.release()
    await first
    expect(await second).toEqual({ ok: false, conflict: true, currentVersion: 2 })
    await service.commitSession(session)
    expect(await messages()).toEqual(['first', 'second'])
  })

  test('retains newer scoped changes, including deletions, during a successful commit', async () => {
    const { store, service, session, state } = await fixture()
    session.state.user.name = 'first'
    session.state.user.removable = 'old'
    const gate = store.pauseNextCommit()
    const first = service.commitSession(session)
    await gate.entered
    session.state.user.name = 'second'
    delete session.state.user.removable
    session.state.user.added = 'new'
    gate.release()
    await first
    expect(await state()).toEqual({ name: 'first', removable: 'old' })
    await service.commitSession(session)
    expect(await state()).toEqual({ name: 'second', added: 'new' })
  })

  test.each(['throw', 'conflict'] as const)(
    'restores a failed batch after %s without overwriting newer state',
    async (failure) => {
      const { store, service, session, messages, state } = await fixture()
      session.input.message('first')
      session.state.user.name = 'first'
      session.state.user.retained = 'kept'
      session.state.user.unchanged = 'still here'
      const gate = store.pauseNextCommit()
      const first = service.commitSession(session, failure === 'conflict' ? 0 : undefined)
      const outcome = first.then(
        (result) => result,
        (error) => error,
      )
      await gate.entered
      session.input.message('second')
      session.state.user.name = 'second'
      session.state.user.retained = undefined
      session.state.user.newKey = 'new'
      if (failure === 'throw') gate.fail(new Error('storage unavailable'))
      else gate.release()
      const result = await outcome
      if (failure === 'throw') expect(result).toEqual(new Error('storage unavailable'))
      else expect(result).toEqual({ ok: false, conflict: true, currentVersion: 1 })
      expect(await messages()).toEqual([])
      await service.commitSession(session)
      expect(await messages()).toEqual(['first', 'second'])
      expect(await state()).toEqual({ name: 'second', newKey: 'new', unchanged: 'still here' })
    },
  )

  test('serializes merge and commit while retaining events and scoped changes arriving during merge', async () => {
    const { store, service, session, messages, state } = await fixture()
    const other = await service.getSession('app', session.id)
    if (!other) throw new Error('Missing session')
    other.input.message('external')
    await service.commitSession(other)
    session.input.message('first')
    session.state.user.name = 'first'
    const gate = store.pauseNextCommit()
    const merge = service.mergeSession(session)
    await gate.entered
    session.input.message('second')
    session.state.user.name = 'second'
    const commit = service.commitSession(session)
    gate.release()
    expect(await merge).toEqual({ ok: true, version: 3, merged: true })
    expect(await commit).toEqual({ ok: true, version: 4 })
    expect(await messages()).toEqual(['external', 'first', 'second'])
    expect(await state()).toEqual({ name: 'second' })
  })

  test.each(['throw', 'conflict'] as const)(
    'retains a merge batch after %s for another merge',
    async (failure) => {
      const { store, service, session, messages, state } = await fixture()
      const other = await service.getSession('app', session.id)
      if (!other) throw new Error('Missing session')
      session.input.message('local')
      session.state.user.retained = 'kept'
      const gate = store.pauseNextCommit()
      const merge = service.mergeSession(session)
      const outcome = merge.then(
        (result) => result,
        (error) => error,
      )
      await gate.entered
      other.input.message('external')
      await service.commitSession(other)
      session.state.user.newKey = 'new'
      if (failure === 'throw') gate.fail(new Error('storage unavailable'))
      else gate.release()
      const result = await outcome
      if (failure === 'throw') expect(result).toEqual(new Error('storage unavailable'))
      else expect(result).toEqual({ ok: false, conflict: true, currentVersion: 2 })
      expect(await service.mergeSession(session)).toEqual({ ok: true, version: 3, merged: true })
      expect(await messages()).toEqual(['external', 'local'])
      expect(await state()).toEqual({ retained: 'kept', newKey: 'new' })
    },
  )
})
