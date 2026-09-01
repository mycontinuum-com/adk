import type {
  ContextRenderer,
  FunctionTool,
  RenderContext,
  SystemEvent,
  UserEvent,
  AssistantEvent,
} from '../types'
import type { StateSchema } from '../types/schema'
import type {
  MCPServer,
  MCPServerConfig,
  MCPServerState,
  MCPToolInfo,
  MCPResourceInfo,
  MCPPromptInfo,
} from './types'

import { createEventId } from '../session'
import { MCPClient } from './client'
import { createMCPTool } from './tools'

export interface MCPServerInternal<S extends StateSchema = StateSchema> extends MCPServer<S> {
  disconnect(): Promise<void>
}

function validateConfig(config: MCPServerConfig): void {
  if (!config.command && !config.url) {
    throw new Error(`MCP server "${config.name}" must have either 'command' or 'url'`)
  }
  if (config.command && config.url) {
    throw new Error(`MCP server "${config.name}" cannot have both 'command' and 'url'`)
  }
}

export function createMCPServer<S extends StateSchema>(
  config: MCPServerConfig,
): MCPServerInternal<S> {
  validateConfig(config)
  return new MCPServerImpl<S>(config)
}

class MCPServerImpl<S extends StateSchema> implements MCPServerInternal<S> {
  readonly kind = 'mcp_server' as const
  readonly name: string
  readonly config: MCPServerConfig
  private client: MCPClient
  private include?: Set<string>
  private excludeSet?: Set<string>
  private toolsCache: MCPToolInfo[] | null = null
  private resourcesCache: MCPResourceInfo[] | null = null
  private promptsCache: MCPPromptInfo[] | null = null
  private fnToolsCache = new Map<string, FunctionTool<unknown, unknown, unknown, S>>()
  private state: MCPServerState = { status: 'disconnected' }
  private connectPromise: Promise<void> | null = null

  constructor(config: MCPServerConfig, include?: string[], exclude?: string[]) {
    this.config = config
    this.name = config.name
    this.client = new MCPClient(config)
    this.include = include
      ? new Set(include)
      : config.includeTools
        ? new Set(config.includeTools)
        : undefined
    this.excludeSet = exclude
      ? new Set(exclude)
      : config.excludeTools
        ? new Set(config.excludeTools)
        : undefined
  }

  only(names: string[]): MCPServer<S> {
    const s = new MCPServerImpl<S>(
      this.config,
      names,
      this.excludeSet ? [...this.excludeSet] : undefined,
    )
    s.client = this.client
    s.toolsCache = this.toolsCache
    s.resourcesCache = this.resourcesCache
    s.promptsCache = this.promptsCache
    s.fnToolsCache = this.fnToolsCache
    return s
  }

  exclude(names: string[]): MCPServer<S> {
    const merged = [...(this.excludeSet || []), ...names]
    const s = new MCPServerImpl<S>(
      this.config,
      this.include ? [...this.include] : undefined,
      merged,
    )
    s.client = this.client
    s.toolsCache = this.toolsCache
    s.resourcesCache = this.resourcesCache
    s.promptsCache = this.promptsCache
    s.fnToolsCache = this.fnToolsCache
    return s
  }

  async connect(): Promise<void> {
    if (this.connectPromise) return this.connectPromise
    if (this.client.isConnected()) return

    this.state = { status: 'connecting' }
    this.connectPromise = this.client
      .connect()
      .then(() => {
        this.state = { status: 'connected' }
      })
      .catch((e) => {
        this.state = {
          status: 'error',
          error: e instanceof Error ? e.message : String(e),
        }
        throw e
      })
      .finally(() => {
        this.connectPromise = null
      })

    return this.connectPromise
  }

  async disconnect(): Promise<void> {
    await this.client.disconnect()
    this.toolsCache = null
    this.resourcesCache = null
    this.promptsCache = null
    this.fnToolsCache.clear()
    this.state = { status: 'disconnected' }
  }

  isConnected(): boolean {
    return this.client.isConnected()
  }

  getState(): MCPServerState {
    return { ...this.state, toolCount: this.toolsCache?.length }
  }

  async healthCheck(): Promise<boolean> {
    try {
      if (!this.client.isConnected()) {
        await this.connect()
      }
      await this.client.listTools()
      return true
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e)
      this.state = { status: 'error', error: errorMsg }
      return false
    }
  }

  async toolDefinitions(): Promise<MCPToolInfo[]> {
    if (!this.client.isConnected()) await this.connect()
    if (this.config.cacheToolsList && this.toolsCache) return this.filter(this.toolsCache)
    this.toolsCache = await this.client.listTools()
    return this.filter(this.toolsCache)
  }

  async tools(): Promise<FunctionTool<unknown, unknown, unknown, S>[]> {
    const infos = await this.toolDefinitions()
    return infos.map((info) => {
      let t = this.fnToolsCache.get(info.name)
      if (!t) {
        t = createMCPTool<S>(this.name, info, this.client)
        this.fnToolsCache.set(info.name, t)
      }
      return t
    })
  }

  async resourceDefinitions(): Promise<MCPResourceInfo[]> {
    if (!this.client.isConnected()) await this.connect()
    if (this.config.cacheResourcesList && this.resourcesCache) {
      return this.resourcesCache
    }
    this.resourcesCache = await this.client.listResources()
    return this.resourcesCache
  }

  async readResource(uri: string) {
    if (!this.client.isConnected()) await this.connect()
    return this.client.readResource(uri)
  }

  resource(uri: string): ContextRenderer<S> {
    return async (ctx: RenderContext<S>) => {
      try {
        const c = await this.readResource(uri)
        if (c.text) {
          const ev: SystemEvent = {
            id: createEventId(),
            type: 'system',
            createdAt: Date.now(),
            invocationId: ctx.invocationId,
            agentName: ctx.agentName,
            text: `[Resource: ${uri}]\n${c.text}`,
          }
          return { ...ctx, events: [...ctx.events, ev] }
        }
      } catch (e) {
        const errorMsg = e instanceof Error ? e.message : String(e)
        console.warn(
          `[ADK:MCP] Failed to load resource ${uri} from server "${this.name}": ${errorMsg}`,
        )
      }
      return ctx
    }
  }

  async promptDefinitions(): Promise<MCPPromptInfo[]> {
    if (!this.client.isConnected()) await this.connect()
    if (this.config.cachePromptsList && this.promptsCache) {
      return this.promptsCache
    }
    this.promptsCache = await this.client.listPrompts()
    return this.promptsCache
  }

  async getPrompt(name: string, args?: Record<string, unknown>) {
    if (!this.client.isConnected()) await this.connect()
    return this.client.getPrompt(name, args)
  }

  prompt(name: string, args?: Record<string, unknown>): ContextRenderer<S> {
    return async (ctx: RenderContext<S>) => {
      try {
        const p = await this.getPrompt(name, args)
        const newEvents = p.messages.map((m) => {
          const base = {
            id: createEventId(),
            createdAt: Date.now(),
            invocationId: ctx.invocationId,
            agentName: ctx.agentName,
            text: m.content,
          }
          return m.role === 'user'
            ? ({ ...base, type: 'user' } as UserEvent)
            : ({ ...base, type: 'assistant' } as AssistantEvent)
        })
        return { ...ctx, events: [...ctx.events, ...newEvents] }
      } catch (e) {
        const errorMsg = e instanceof Error ? e.message : String(e)
        console.warn(
          `[ADK:MCP] Failed to load prompt "${name}" from server "${this.name}": ${errorMsg}`,
        )
      }
      return ctx
    }
  }

  private filter(tools: MCPToolInfo[]): MCPToolInfo[] {
    let result = tools
    if (this.include) result = result.filter((t) => this.include!.has(t.name))
    if (this.excludeSet) result = result.filter((t) => !this.excludeSet!.has(t.name))
    return result
  }
}
