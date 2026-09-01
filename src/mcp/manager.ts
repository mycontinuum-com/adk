import type { FunctionTool } from '../types'
import type { StateSchema } from '../types/schema'
import type { MCPManager, MCPServer, MCPServerConfig } from './types'

import { createMCPServer, MCPServerInternal } from './server'

type DisconnectFn = () => Promise<void>
const disconnectFns = new Set<DisconnectFn>()
let cleanupRegistered = false

function registerProcessCleanup(): void {
  if (cleanupRegistered) return
  cleanupRegistered = true

  const cleanup = () => {
    for (const disconnect of disconnectFns) {
      disconnect().catch(() => {})
    }
  }

  process.on('beforeExit', cleanup)
  process.on('SIGTERM', () => {
    cleanup()
    process.exit(0)
  })
  process.on('SIGINT', () => {
    cleanup()
    process.exit(0)
  })
}

export function createMCPManager<S extends StateSchema>(): MCPManager<S> {
  const map = new Map<string, MCPServerInternal<S>>()

  const manager: MCPManager<S> = {
    server(config: MCPServerConfig): MCPServer<S> {
      const existing = map.get(config.name)
      if (existing) return existing
      const s = createMCPServer<S>(config)
      map.set(config.name, s)
      return s
    },
    servers: () => [...map.values()],
    get: (name) => map.get(name),
    connect: async () => {
      const results = await Promise.allSettled([...map.values()].map((s) => s.connect()))
      const failures = results
        .map((r, i) =>
          r.status === 'rejected' ? { name: [...map.keys()][i], error: r.reason } : null,
        )
        .filter((f): f is { name: string; error: unknown } => f !== null)
      if (failures.length > 0) {
        for (const { name, error } of failures) {
          console.warn(
            `[ADK:MCP] Server "${name}" failed to connect: ${
              error instanceof Error ? error.message : String(error)
            }`,
          )
        }
      }
    },
    disconnect: async () => {
      const results = await Promise.allSettled([...map.values()].map((s) => s.disconnect()))
      const failures = results
        .map((r, i) =>
          r.status === 'rejected' ? { name: [...map.keys()][i], error: r.reason } : null,
        )
        .filter((f): f is { name: string; error: unknown } => f !== null)
      if (failures.length > 0) {
        for (const { name, error } of failures) {
          console.warn(
            `[ADK:MCP] Server "${name}" failed to disconnect: ${
              error instanceof Error ? error.message : String(error)
            }`,
          )
        }
      }
    },
    getAllTools: async (): Promise<FunctionTool<unknown, unknown, unknown, S>[]> => {
      const toolArrays = await Promise.all([...map.values()].map((s) => s.tools()))
      const allTools = toolArrays.flat()
      const seen = new Map<string, string>()
      for (const tool of allTools) {
        const existing = seen.get(tool.name)
        if (existing) {
          console.warn(`[ADK:MCP] Tool name collision: "${tool.name}" exists in multiple servers`)
        } else {
          seen.set(tool.name, tool.name)
        }
      }
      return allTools
    },
  }

  disconnectFns.add(manager.disconnect)
  registerProcessCleanup()

  return manager
}
