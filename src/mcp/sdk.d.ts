declare module '@modelcontextprotocol/sdk/client/index.js' {
  export class Client {
    constructor(options: { name: string; version: string })
    connect(transport: unknown): Promise<void>
    close(): Promise<void>
    listTools(): Promise<{
      tools: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }>
    }>
    callTool(params: {
      name: string
      arguments: Record<string, unknown>
    }): Promise<{ content: unknown[]; isError?: boolean }>
    listResources(): Promise<{
      resources: Array<{ uri: string; name: string; description?: string; mimeType?: string }>
    }>
    readResource(params: { uri: string }): Promise<{
      contents: Array<{ uri: string; mimeType?: string; text?: string; blob?: string }>
    }>
    listPrompts(): Promise<{
      prompts: Array<{
        name: string
        description?: string
        arguments?: Array<{ name: string; description?: string; required?: boolean }>
      }>
    }>
    getPrompt(params: { name: string; arguments?: Record<string, unknown> }): Promise<{
      messages: Array<{
        role: 'user' | 'assistant'
        content: { type: 'text'; text: string } | string
      }>
    }>
  }
}

declare module '@modelcontextprotocol/sdk/client/stdio.js' {
  // oxlint-disable-next-line typescript-eslint(no-extraneous-class)
  export class StdioClientTransport {
    constructor(options: {
      command: string
      args?: string[]
      env?: Record<string, string | undefined>
      cwd?: string
    })
  }
}

declare module '@modelcontextprotocol/sdk/client/streamableHttp.js' {
  // oxlint-disable-next-line typescript-eslint(no-extraneous-class)
  export class StreamableHTTPClientTransport {
    constructor(url: URL, options?: { requestInit?: { headers?: Record<string, string> } })
  }
}

declare module '@modelcontextprotocol/sdk/client/sse.js' {
  // oxlint-disable-next-line typescript-eslint(no-extraneous-class)
  export class SSEClientTransport {
    constructor(url: URL, options?: { requestInit?: { headers?: Record<string, string> } })
  }
}
