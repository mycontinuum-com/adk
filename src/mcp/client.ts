import type { RetryConfig } from '../types'
import type {
  MCPServerConfig,
  MCPToolInfo,
  MCPResourceInfo,
  MCPPromptInfo,
  MCPClientInterface,
} from './types'

import { withRetry } from '../core'

type AnyClient = {
  connect(transport: unknown): Promise<void>
  close(): Promise<void>
  listTools(): Promise<{ tools: MCPToolInfo[] }>
  callTool(params: {
    name: string
    arguments: Record<string, unknown>
  }): Promise<{ content: unknown[]; isError?: boolean }>
  listResources(): Promise<{ resources: MCPResourceInfo[] }>
  readResource(params: { uri: string }): Promise<{
    contents: Array<{
      uri: string
      mimeType?: string
      text?: string
      blob?: string
    }>
  }>
  listPrompts(): Promise<{ prompts: MCPPromptInfo[] }>
  getPrompt(params: { name: string; arguments?: Record<string, unknown> }): Promise<{
    messages: Array<{
      role: 'user' | 'assistant'
      content: { type: 'text'; text: string } | string
    }>
  }>
}

const DEFAULT_TIMEOUT = 30000
const CONNECTION_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 3,
  initialDelayMs: 1000,
  maxDelayMs: 5000,
  backoffMultiplier: 2,
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, operation: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`MCP ${operation} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    promise
      .then((result) => {
        clearTimeout(timer)
        resolve(result)
      })
      .catch((err) => {
        clearTimeout(timer)
        reject(err)
      })
  })
}

async function importMCPSDK() {
  try {
    return await import('@modelcontextprotocol/sdk/client/index.js')
  } catch {
    throw new Error('MCP SDK not found. Install it with: npm install @modelcontextprotocol/sdk')
  }
}

async function importStdioTransport() {
  try {
    return await import('@modelcontextprotocol/sdk/client/stdio.js')
  } catch {
    throw new Error('MCP SDK not found. Install it with: npm install @modelcontextprotocol/sdk')
  }
}

async function importHttpTransport() {
  try {
    return await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
  } catch {
    throw new Error('MCP SDK not found. Install it with: npm install @modelcontextprotocol/sdk')
  }
}

async function importSSETransport() {
  try {
    return await import('@modelcontextprotocol/sdk/client/sse.js')
  } catch {
    throw new Error('MCP SDK not found. Install it with: npm install @modelcontextprotocol/sdk')
  }
}

export class MCPClient implements MCPClientInterface {
  private config: MCPServerConfig
  private client: AnyClient | null = null
  private connected = false
  private timeout: number
  private reconnectAttempts = 0
  private maxReconnectAttempts = 3

  constructor(config: MCPServerConfig) {
    this.config = config
    this.timeout = config.timeout ?? DEFAULT_TIMEOUT
  }

  async connect(): Promise<void> {
    if (this.connected) return

    await withRetry(async () => {
      const { Client } = await importMCPSDK()

      if (this.config.command) {
        const { StdioClientTransport } = await importStdioTransport()
        const transport = new StdioClientTransport({
          command: this.config.command,
          args: this.config.args,
          env: this.config.env ? { ...process.env, ...this.config.env } : undefined,
          cwd: this.config.cwd,
        })
        this.client = new Client({
          name: `adk-${this.config.name}`,
          version: '1.0.0',
        })
        await withTimeout(this.client!.connect(transport), this.timeout, 'connect')
      } else if (this.config.url) {
        const headers: Record<string, string> = { ...this.config.headers }
        if (this.config.authorization)
          headers['Authorization'] = `Bearer ${this.config.authorization}`
        const url = new URL(this.config.url)

        this.client = new Client({
          name: `adk-${this.config.name}`,
          version: '1.0.0',
        })

        if (this.config.transport === 'sse') {
          await this.connectSSE(url, headers)
        } else if (this.config.transport === 'http') {
          await this.connectHTTP(url, headers)
        } else {
          try {
            await this.connectHTTP(url, headers)
          } catch (httpError) {
            try {
              await this.connectSSE(url, headers)
            } catch {
              throw httpError
            }
          }
        }
      } else {
        throw new Error(`MCP server "${this.config.name}" must have 'command' or 'url'`)
      }
    }, CONNECTION_RETRY_CONFIG)

    this.connected = true
    this.reconnectAttempts = 0
  }

  private async connectHTTP(url: URL, headers: Record<string, string>): Promise<void> {
    const { StreamableHTTPClientTransport } = await importHttpTransport()
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers },
    })
    await withTimeout(this.client!.connect(transport), this.timeout, 'connect')
  }

  private async connectSSE(url: URL, headers: Record<string, string>): Promise<void> {
    const { SSEClientTransport } = await importSSETransport()
    const transport = new SSEClientTransport(url, {
      requestInit: { headers },
    })
    await withTimeout(this.client!.connect(transport), this.timeout, 'connect')
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      try {
        await this.client.close()
      } catch {
        /* ignore */
      }
      this.client = null
    }
    this.connected = false
  }

  isConnected(): boolean {
    return this.connected
  }

  private isConnectionError(error: unknown): boolean {
    const msg = error instanceof Error ? error.message : String(error)
    return (
      msg.includes('EPIPE') ||
      msg.includes('ECONNRESET') ||
      msg.includes('ECONNREFUSED') ||
      msg.includes('closed') ||
      msg.includes('disconnected') ||
      msg.includes('not connected')
    )
  }

  private async withReconnect<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (error) {
      if (this.isConnectionError(error) && this.reconnectAttempts < this.maxReconnectAttempts) {
        this.reconnectAttempts++
        this.connected = false
        this.client = null
        await this.connect()
        return await fn()
      }
      throw error
    }
  }

  async listTools(): Promise<MCPToolInfo[]> {
    return this.withReconnect('listTools', async () => {
      const { tools } = await withTimeout(this.client!.listTools(), this.timeout, 'listTools')
      return tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema as Record<string, unknown>,
      }))
    })
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ content: unknown[]; isError?: boolean }> {
    return this.withReconnect(`callTool(${name})`, () =>
      withTimeout(
        this.client!.callTool({ name, arguments: args }),
        this.timeout,
        `callTool(${name})`,
      ),
    )
  }

  async listResources(): Promise<MCPResourceInfo[]> {
    return this.withReconnect('listResources', async () => {
      const { resources } = await withTimeout(
        this.client!.listResources(),
        this.timeout,
        'listResources',
      )
      return resources
    })
  }

  async readResource(
    uri: string,
  ): Promise<{ uri: string; mimeType?: string; text?: string; data?: Buffer }> {
    return this.withReconnect(`readResource(${uri})`, async () => {
      const { contents } = await withTimeout(
        this.client!.readResource({ uri }),
        this.timeout,
        `readResource(${uri})`,
      )
      const c = contents[0]
      if (!c) return { uri }
      return {
        uri: c.uri,
        mimeType: c.mimeType,
        text: c.text,
        data: c.blob ? Buffer.from(c.blob, 'base64') : undefined,
      }
    })
  }

  async listPrompts(): Promise<MCPPromptInfo[]> {
    return this.withReconnect('listPrompts', async () => {
      const { prompts } = await withTimeout(this.client!.listPrompts(), this.timeout, 'listPrompts')
      return prompts
    })
  }

  async getPrompt(
    name: string,
    args?: Record<string, unknown>,
  ): Promise<{
    messages: Array<{ role: 'user' | 'assistant'; content: string }>
  }> {
    return this.withReconnect(`getPrompt(${name})`, async () => {
      const result = await withTimeout(
        this.client!.getPrompt({ name, arguments: args }),
        this.timeout,
        `getPrompt(${name})`,
      )
      return {
        messages: result.messages.map((m) => ({
          role: m.role,
          content: typeof m.content === 'string' ? m.content : m.content.text,
        })),
      }
    })
  }
}
