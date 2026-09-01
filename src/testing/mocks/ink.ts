/**
 * Vitest mock for 'ink' (ESM-only since v4). Provides minimal stubs so CLI-related test files can
 * be loaded without hitting "SyntaxError: Unexpected token 'export'" from ink's ESM build.
 */
import React from 'react'
import { vi } from 'vitest'

export const render = vi.fn<(...args: unknown[]) => unknown>(() => ({
  waitUntilExit: () => Promise.resolve(),
  unmount: vi.fn<(...args: unknown[]) => unknown>(),
  rerender: vi.fn<(...args: unknown[]) => unknown>(),
  cleanup: vi.fn<(...args: unknown[]) => unknown>(),
}))
export const Box = (props: { children?: React.ReactNode }) =>
  React.createElement('ink-box', null, props.children)
export const Text = (props: { children?: React.ReactNode }) =>
  React.createElement('ink-text', null, props.children)
export const useApp = () => ({ exit: vi.fn<(...args: unknown[]) => unknown>() })
export const useInput = vi.fn<(...args: unknown[]) => unknown>()
export const useStdout = () => ({
  stdout: process.stdout,
  write: vi.fn<(...args: unknown[]) => unknown>(),
})
export const useStdin = () => ({
  stdin: process.stdin,
  isRawModeSupported: true,
  setRawMode: vi.fn<(...args: unknown[]) => unknown>(),
})
