import * as genai from '@google/genai'
import { afterEach, describe, expect, it } from 'vitest'

import { provideGenAI, serializeToolConfig } from '../integrations/gemini'

describe('provideGenAI', () => {
  afterEach(() => {
    provideGenAI(genai)
  })

  it('makes the provider read the module it was given', () => {
    const read: PropertyKey[] = []
    provideGenAI(
      new Proxy(genai, {
        get(target, key, receiver) {
          read.push(key)
          return Reflect.get(target, key, receiver)
        },
      }),
    )
    expect(serializeToolConfig('none')).toEqual({
      functionCallingConfig: { mode: genai.FunctionCallingConfigMode.NONE },
    })
    expect(read).toContain('FunctionCallingConfigMode')
  })
})
