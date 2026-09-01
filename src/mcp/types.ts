import type { FunctionTool, ContextRenderer } from '../types/runnables'
import type { StateSchema } from '../types/schema'

export interface MCPServerConfig {
  name: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  url?: string
  authorization?: string
  headers?: Record<string, string>
  timeout?: number
  transport?: 'stdio' | 'http' | 'sse'
  cacheToolsList?: boolean
  cacheResourcesList?: boolean
  cachePromptsList?: boolean
  includeTools?: string[]
  excludeTools?: string[]
}

export interface MCPToolInfo {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
}

export interface MCPResourceInfo {
  uri: string
  name: string
  description?: string
  mimeType?: string
}

export interface MCPPromptInfo {
  name: string
  description?: string
  arguments?: Array<{ name: string; description?: string; required?: boolean }>
}

export type MCPServerStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

export interface MCPServerState {
  status: MCPServerStatus
  error?: string
  toolCount?: number
}

export interface MCPClientInterface {
  connect(): Promise<void>
  disconnect(): Promise<void>
  isConnected(): boolean
  listTools(): Promise<MCPToolInfo[]>
  callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ content: unknown[]; isError?: boolean }>
  listResources(): Promise<MCPResourceInfo[]>
  readResource(
    uri: string,
  ): Promise<{ uri: string; mimeType?: string; text?: string; data?: Buffer }>
  listPrompts(): Promise<MCPPromptInfo[]>
  getPrompt(
    name: string,
    args?: Record<string, unknown>,
  ): Promise<{
    messages: Array<{ role: 'user' | 'assistant'; content: string }>
  }>
}

export interface MCPServer<S extends StateSchema = StateSchema> {
  readonly kind: 'mcp_server'
  readonly name: string
  readonly config: MCPServerConfig
  only(toolNames: string[]): MCPServer<S>
  exclude(toolNames: string[]): MCPServer<S>
  connect(): Promise<void>
  isConnected(): boolean
  getState(): MCPServerState
  healthCheck(): Promise<boolean>
  toolDefinitions(): Promise<MCPToolInfo[]>
  tools(): Promise<FunctionTool<unknown, unknown, unknown, S>[]>
  resourceDefinitions(): Promise<MCPResourceInfo[]>
  readResource(
    uri: string,
  ): Promise<{ uri: string; mimeType?: string; text?: string; data?: Buffer }>
  resource(uri: string): ContextRenderer<S>
  promptDefinitions(): Promise<MCPPromptInfo[]>
  getPrompt(
    name: string,
    args?: Record<string, unknown>,
  ): Promise<{
    messages: Array<{ role: 'user' | 'assistant'; content: string }>
  }>
  prompt(name: string, args?: Record<string, unknown>): ContextRenderer<S>
}

export interface MCPManager<S extends StateSchema = StateSchema> {
  server(config: MCPServerConfig): MCPServer<S>
  servers(): MCPServer<S>[]
  get(name: string): MCPServer<S> | undefined
  connect(): Promise<void>
  disconnect(): Promise<void>
  getAllTools(): Promise<FunctionTool<unknown, unknown, unknown, S>[]>
}
