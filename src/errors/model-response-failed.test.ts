import { inspect } from 'node:util'
import { describe, expect, it } from 'vitest'

import { ModelResponseFailedError } from './types'

const SERVER_ERROR = 'server_error'
const RATE_LIMIT = 'rate_limit_exceeded'
const SHORTEST_CODE = 'a'
const LONGEST_CODE = 'a'.repeat(64)
const TOO_LONG = 'a'.repeat(65)
const BARE_MESSAGE = 'OpenAI response failed'

// A code of these shapes is dropped; each is declared once for every test that needs it.
const NOT_STRINGS: Array<[shape: string, code: unknown]> = [
  ['missing', undefined],
  ['null', null],
  ['a number', 429],
  ['an object', { code: SERVER_ERROR }],
]
const REJECTED_STRINGS: Array<[shape: string, code: string]> = [
  ['uppercase', 'Server_Error'],
  ['free text', 'Patient Okafor not found'],
  ['led by a digit', '1_server_error'],
  ['over 64 characters', TOO_LONG],
]

describe('ModelResponseFailedError', () => {
  it.each([SERVER_ERROR, RATE_LIMIT, SHORTEST_CODE, LONGEST_CODE])(
    'keeps the identifier code %s in the error and its message',
    (code) => {
      const error = new ModelResponseFailedError('OpenAI', code)
      expect(error).toMatchObject({
        name: 'ModelResponseFailedError',
        provider: 'OpenAI',
        code,
        message: `${BARE_MESSAGE}: ${code}`,
      })
    },
  )

  it.each([...NOT_STRINGS, ['empty', ''], ...REJECTED_STRINGS])(
    'drops a code that is %s',
    (_shape, code) => {
      const error = new ModelResponseFailedError('OpenAI', code)
      expect(error.code).toBeUndefined()
      expect(error.message).toBe(BARE_MESSAGE)
      expect(error.provider).toBe('OpenAI')
    },
  )

  it.each(REJECTED_STRINGS)('keeps a rejected code that is %s out of the error', (_shape, code) => {
    const error = new ModelResponseFailedError('OpenAI', code)
    expect(inspect(error)).not.toContain(code)
  })

  it('matches by name, so a copy of the class from another bundle counts', () => {
    const copy = Object.assign(new Error('copy'), { name: 'ModelResponseFailedError' })
    expect(copy).toBeInstanceOf(ModelResponseFailedError)
    expect(new Error('other')).not.toBeInstanceOf(ModelResponseFailedError)
    expect(BARE_MESSAGE).not.toBeInstanceOf(ModelResponseFailedError)
  })
})
