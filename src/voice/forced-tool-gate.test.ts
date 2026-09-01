import { vi } from 'vitest'

import type { ToolCallEvent } from '../types/events'

import {
  createForcedToolGate,
  ForcedToolCallError,
  renderToolCorrectionInstructions,
} from './forced-tool-gate'

function makeCall(name: string): ToolCallEvent {
  return {
    id: `call-${name}`,
    type: 'tool_call',
    createdAt: Date.now(),
    invocationId: 'inv-1',
    agentName: 'agent',
    callId: `tool-${name}`,
    name,
    args: {},
  }
}

describe('forced tool gate', () => {
  test('correction instructions include the incorrect and intended tool names', () => {
    const instructions = renderToolCorrectionInstructions({
      incorrectToolName: 'transfer_to_human',
      intendedToolName: 'end_call',
    })

    expect(instructions).toContain('Incorrect tool called: transfer_to_human')
    expect(instructions).toContain('Required tool: end_call')
  })

  test('forceReply waits until the intended tool completes', async () => {
    const generateReply = vi.fn<(...args: unknown[]) => unknown>().mockResolvedValue({})
    const gate = createForcedToolGate({
      generateReply: generateReply as any,
    })

    const forced = gate.forceReply({ toolChoice: { name: 'end_call' } }, generateReply as any)
    let settled = false
    forced.then(() => {
      settled = true
    })
    await Promise.resolve()

    expect(generateReply).toHaveBeenCalledWith({
      toolChoice: 'required',
    })
    expect(settled).toBe(false)

    expect(await gate.interceptToolCall(makeCall('end_call'))).toBeUndefined()
    gate.completeToolCall('end_call')

    await expect(forced).resolves.toEqual({})
    expect(settled).toBe(true)
  })

  test('intercepts wrong tools before execution and retries with correction instructions', async () => {
    const generateReply = vi.fn<(...args: unknown[]) => unknown>().mockResolvedValue({})
    const events: unknown[] = []
    const gate = createForcedToolGate({
      generateReply: generateReply as any,
      onVoiceEvent: (event) => events.push(event),
      assistantMessageGraceMs: 0,
    })

    const forced = gate.forceReply({ toolChoice: { name: 'end_call' } }, async () => ({}) as any)
    await Promise.resolve()
    const interception = await gate.interceptToolCall(makeCall('transfer_to_human'))

    expect(interception?.result).toMatchObject({
      type: 'tool_result',
      name: 'transfer_to_human',
      result: undefined,
    })
    expect(generateReply).not.toHaveBeenCalled()
    interception?.afterResult?.()
    expect(generateReply).toHaveBeenCalledWith({
      toolChoice: 'required',
      instructions: expect.stringContaining('Incorrect tool called: transfer_to_human'),
    })
    expect(generateReply.mock.calls[0]![0]).toEqual(
      expect.objectContaining({
        instructions: expect.stringContaining('Required tool: end_call'),
      }),
    )
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'forced_tool_correction',
        intendedToolName: 'end_call',
        incorrectToolName: 'transfer_to_human',
      }),
    )
    expect(await gate.interceptToolCall(makeCall('end_call'))).toBeUndefined()
    gate.completeToolCall('end_call')
    await expect(forced).resolves.toEqual({})
  })

  test('exhausts retries with a typed forced-tool failure surfaced through forceReply', async () => {
    const generateReply = vi.fn<(...args: unknown[]) => unknown>().mockResolvedValue({})
    const events: unknown[] = []
    const gate = createForcedToolGate({
      generateReply: generateReply as any,
      onVoiceEvent: (event) => events.push(event),
      assistantMessageGraceMs: 0,
    })

    const forced = gate.forceReply({ toolChoice: { name: 'end_call' } }, async () => ({}) as any)
    await Promise.resolve()

    const first = await gate.interceptToolCall(makeCall('transfer_to_human'))
    first?.afterResult?.()
    const second = await gate.interceptToolCall(makeCall('transfer_to_human'))
    second?.afterResult?.()
    const failed = await gate.interceptToolCall(makeCall('transfer_to_human'))

    expect(failed?.result.error).toContain("expected 'end_call'")
    await expect(forced).rejects.toBeInstanceOf(ForcedToolCallError)
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'forced_tool_failure',
        intendedToolName: 'end_call',
        incorrectToolName: 'transfer_to_human',
      }),
    )
  })

  test('treats assistant speech during a forced gate as an incorrect tool choice and retries', async () => {
    const generateReply = vi.fn<(...args: unknown[]) => unknown>().mockResolvedValue({})
    const events: unknown[] = []
    const gate = createForcedToolGate({
      generateReply: generateReply as any,
      onVoiceEvent: (event) => events.push(event),
      assistantMessageGraceMs: 0,
    })

    const forced = gate.forceReply({ toolChoice: { name: 'end_call' } }, async () => ({}) as any)
    await Promise.resolve()

    await expect(gate.handleAssistantMessage('I am ending the call now.')).resolves.toBe(true)

    expect(generateReply).toHaveBeenCalledWith({
      toolChoice: 'required',
      instructions: expect.stringContaining('Incorrect tool called: spoken_response'),
    })
    expect(generateReply.mock.calls[0]![0]).toEqual(
      expect.objectContaining({
        instructions: expect.stringContaining('Required tool: end_call'),
      }),
    )
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'forced_tool_correction',
        intendedToolName: 'end_call',
        incorrectToolName: 'spoken_response',
      }),
    )

    expect(await gate.interceptToolCall(makeCall('end_call'))).toBeUndefined()
    gate.completeToolCall('end_call')
    await expect(forced).resolves.toEqual({})
  })

  test('ignores immediate assistant speech while the forced gate may still be draining prior audio', async () => {
    const generateReply = vi.fn<(...args: unknown[]) => unknown>().mockResolvedValue({})
    const gate = createForcedToolGate({
      generateReply: generateReply as any,
      assistantMessageGraceMs: 1000,
    })

    const forced = gate.forceReply({ toolChoice: { name: 'end_call' } }, async () => ({}) as any)
    await Promise.resolve()

    await expect(gate.handleAssistantMessage('Thanks, one moment.')).resolves.toBe(false)
    expect(generateReply).not.toHaveBeenCalled()

    gate.cancel('end_call')
    await forced
  })

  test('retries when required generation produces no tool call', async () => {
    vi.useFakeTimers()
    const generateReply = vi.fn<(...args: unknown[]) => unknown>().mockResolvedValue({})
    const events: unknown[] = []
    const gate = createForcedToolGate({
      generateReply: generateReply as any,
      onVoiceEvent: (event) => events.push(event),
      noToolRetryMs: 1000,
    })

    const forced = gate.forceReply({ toolChoice: { name: 'end_call' } }, async () => ({}) as any)
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(1000)

    expect(generateReply).toHaveBeenCalledWith({
      toolChoice: 'required',
      instructions: expect.stringContaining('Incorrect tool called: no_tool_call'),
    })
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'forced_tool_correction',
        intendedToolName: 'end_call',
        incorrectToolName: 'no_tool_call',
      }),
    )

    expect(await gate.interceptToolCall(makeCall('end_call'))).toBeUndefined()
    gate.completeToolCall('end_call')
    await expect(forced).resolves.toEqual({})

    vi.useRealTimers()
  })

  test('rejects nested forced gates deterministically', async () => {
    const gate = createForcedToolGate({
      generateReply: vi.fn<(...args: unknown[]) => unknown>().mockResolvedValue({}) as any,
    })

    const forced = gate.forceReply({ toolChoice: { name: 'end_call' } }, async () => ({}) as any)
    await Promise.resolve()

    await expect(
      gate.forceReply({ toolChoice: { name: 'is_patient' } }, async () => ({}) as any),
    ).rejects.toBeInstanceOf(ForcedToolCallError)

    gate.cancel('end_call')
    await forced
  })

  test('timeout rejects the pending forced reply with a typed failure', async () => {
    vi.useFakeTimers()
    const gate = createForcedToolGate({
      generateReply: vi.fn<(...args: unknown[]) => unknown>().mockResolvedValue({}) as any,
      timeoutMs: 1000,
    })

    const forced = gate.forceReply({ toolChoice: { name: 'end_call' } }, async () => ({}) as any)
    const assertion = expect(forced).rejects.toMatchObject({
      name: 'ForcedToolCallError',
      intendedToolName: 'end_call',
      reason: 'timeout',
    })
    await vi.advanceTimersByTimeAsync(1000)

    await assertion

    vi.useRealTimers()
  })
})
