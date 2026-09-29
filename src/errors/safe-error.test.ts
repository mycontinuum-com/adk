import { safeErrorFields } from './safe-error'

class SocketClosedError extends Error {}

describe('safeErrorFields', () => {
  it('keeps only the class, never the message or the stack', () => {
    expect(safeErrorFields(new Error('Patient Okafor not found'))).toEqual({ errorName: 'Error' })
    expect(safeErrorFields(new SocketClosedError('Socket closed'))).toEqual({
      errorName: 'SocketClosedError',
    })
    const renamed = Object.assign(new TypeError('x'), { name: 'Jo Bloggs' })
    expect(safeErrorFields(renamed)).toEqual({ errorName: 'TypeError' })
    const reclassed = Object.assign(new RangeError('x'), { constructor: { name: 'Jo Bloggs' } })
    expect(safeErrorFields(reclassed)).toEqual({ errorName: 'RangeError' })
  })

  it('handles thrown values that are not errors', () => {
    expect(safeErrorFields('Unknown surname Okafor')).toEqual({ errorName: 'string' })
    expect(safeErrorFields({ dob: '1982-03-15' })).toEqual({ errorName: 'object' })
  })
})
