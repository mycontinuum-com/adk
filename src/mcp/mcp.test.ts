import { vi, type Mock } from 'vitest'
import { z } from 'zod'

import type { MCPToolInfo, MCPClientInterface } from './types'

import { createMCPServer } from './server'
import { createMCPTool } from './tools'

const createMockClient = (tools: MCPToolInfo[] = []): MCPClientInterface => ({
  connect: vi.fn<(...args: unknown[]) => unknown>().mockResolvedValue(undefined),
  disconnect: vi.fn<(...args: unknown[]) => unknown>().mockResolvedValue(undefined),
  isConnected: vi.fn<(...args: unknown[]) => unknown>().mockReturnValue(true),
  listTools: vi.fn<(...args: unknown[]) => unknown>().mockResolvedValue(tools),
  callTool: vi.fn<(...args: unknown[]) => unknown>().mockResolvedValue({
    content: [{ type: 'text', text: '{"result": "ok"}' }],
  }),
  listResources: vi.fn<(...args: unknown[]) => unknown>().mockResolvedValue([]),
  readResource: vi
    .fn<(...args: unknown[]) => unknown>()
    .mockResolvedValue({ uri: 'test', text: 'content' }),
  listPrompts: vi.fn<(...args: unknown[]) => unknown>().mockResolvedValue([]),
  getPrompt: vi.fn<(...args: unknown[]) => unknown>().mockResolvedValue({ messages: [] }),
})

describe('MCPServer', () => {
  const baseConfig = { name: 'test', command: 'test-cmd' }

  describe('config validation', () => {
    test('throws if neither command nor url provided', () => {
      expect(() => createMCPServer({ name: 'invalid' })).toThrow(
        "must have either 'command' or 'url'",
      )
    })

    test('throws if both command and url provided', () => {
      expect(() =>
        createMCPServer({
          name: 'invalid',
          command: 'cmd',
          url: 'http://example.com',
        }),
      ).toThrow("cannot have both 'command' and 'url'")
    })

    test('accepts valid stdio config', () => {
      expect(() => createMCPServer({ name: 'valid', command: 'npx' })).not.toThrow()
    })

    test('accepts valid http config', () => {
      expect(() => createMCPServer({ name: 'valid', url: 'http://example.com' })).not.toThrow()
    })
  })

  describe('connection race protection', () => {
    test('deduplicates concurrent connect calls', async () => {
      const server = createMCPServer(baseConfig)
      let connectCalls = 0
      let connected = false
      const mockClient: MCPClientInterface = {
        connect: vi.fn<(...args: unknown[]) => unknown>().mockImplementation(async () => {
          connectCalls++
          await new Promise((r) => setTimeout(r, 50))
          connected = true
        }),
        disconnect: vi.fn<(...args: unknown[]) => unknown>().mockResolvedValue(undefined),
        isConnected: vi.fn<(...args: unknown[]) => unknown>().mockImplementation(() => connected),
        listTools: vi.fn<(...args: unknown[]) => unknown>().mockResolvedValue([]),
        callTool: vi.fn<(...args: unknown[]) => unknown>().mockResolvedValue({ content: [] }),
        listResources: vi.fn<(...args: unknown[]) => unknown>().mockResolvedValue([]),
        readResource: vi.fn<(...args: unknown[]) => unknown>().mockResolvedValue({ uri: 'test' }),
        listPrompts: vi.fn<(...args: unknown[]) => unknown>().mockResolvedValue([]),
        getPrompt: vi.fn<(...args: unknown[]) => unknown>().mockResolvedValue({ messages: [] }),
      }
      ;(server as unknown as { client: MCPClientInterface }).client = mockClient

      await Promise.all([server.connect(), server.connect(), server.connect()])

      expect(connectCalls).toBe(1)
    })
  })

  describe('tool filtering', () => {
    const mockTools: MCPToolInfo[] = [
      {
        name: 'read_file',
        description: 'Reads a file',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'write_file',
        description: 'Writes a file',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'delete_file',
        description: 'Deletes a file',
        inputSchema: { type: 'object', properties: {} },
      },
    ]

    test('only() filters to specified tools', async () => {
      const server = createMCPServer(baseConfig)
      ;(server as unknown as { client: MCPClientInterface }).client = createMockClient(mockTools)

      const filtered = server.only(['read_file', 'write_file'])
      const tools = await filtered.tools()

      expect(tools).toHaveLength(2)
      expect(tools.map((t) => t.name)).toEqual(['mcp_test_read_file', 'mcp_test_write_file'])
    })

    test('exclude() removes specified tools', async () => {
      const server = createMCPServer(baseConfig)
      ;(server as unknown as { client: MCPClientInterface }).client = createMockClient(mockTools)

      const filtered = server.exclude(['delete_file'])
      const tools = await filtered.tools()

      expect(tools).toHaveLength(2)
      expect(tools.map((t) => t.name)).toEqual(['mcp_test_read_file', 'mcp_test_write_file'])
    })

    test('only() and exclude() can be chained', async () => {
      const server = createMCPServer(baseConfig)
      ;(server as unknown as { client: MCPClientInterface }).client = createMockClient(mockTools)

      const filtered = server.only(['read_file', 'write_file']).exclude(['write_file'])
      const tools = await filtered.tools()

      expect(tools).toHaveLength(1)
      expect(tools[0].name).toBe('mcp_test_read_file')
    })

    test('filtering shares client instance', async () => {
      const server = createMCPServer({ ...baseConfig, cacheToolsList: true })
      const mockClient = createMockClient(mockTools)
      ;(server as unknown as { client: MCPClientInterface }).client = mockClient

      await server.tools()
      const filtered = server.only(['read_file'])
      await filtered.tools()

      expect(mockClient.listTools).toHaveBeenCalledTimes(1)
    })
  })

  describe('tool caching', () => {
    test('caches tools when cacheToolsList is true', async () => {
      const server = createMCPServer({ ...baseConfig, cacheToolsList: true })
      const mockClient = createMockClient([{ name: 'tool1', inputSchema: { type: 'object' } }])
      ;(server as unknown as { client: MCPClientInterface }).client = mockClient

      await server.tools()
      await server.tools()

      expect(mockClient.listTools).toHaveBeenCalledTimes(1)
    })

    test('does not cache when cacheToolsList is false', async () => {
      const server = createMCPServer({ ...baseConfig, cacheToolsList: false })
      const mockClient = createMockClient([{ name: 'tool1', inputSchema: { type: 'object' } }])
      ;(server as unknown as { client: MCPClientInterface }).client = mockClient

      await server.tools()
      await server.tools()

      expect(mockClient.listTools).toHaveBeenCalledTimes(2)
    })
  })

  describe('state management', () => {
    test('getState returns current status', () => {
      const server = createMCPServer(baseConfig)
      expect(server.getState().status).toBe('disconnected')
    })

    test('isConnected reflects client state', () => {
      const server = createMCPServer(baseConfig)
      expect(server.isConnected()).toBe(false)
    })
  })

  describe('disconnect (internal)', () => {
    test('disconnect clears caches and state', async () => {
      const server = createMCPServer({ ...baseConfig, cacheToolsList: true })
      let connected = true
      const mockClient: MCPClientInterface = {
        ...createMockClient([{ name: 'tool1', inputSchema: { type: 'object' } }]),
        isConnected: vi.fn<(...args: unknown[]) => unknown>().mockImplementation(() => connected),
        disconnect: vi.fn<(...args: unknown[]) => unknown>().mockImplementation(async () => {
          connected = false
        }),
      }
      ;(server as unknown as { client: MCPClientInterface }).client = mockClient

      await server.tools()
      expect(server.getState().toolCount).toBe(1)

      await server.disconnect()
      expect(server.getState().status).toBe('disconnected')
      expect(server.isConnected()).toBe(false)
    })
  })
})

describe('MCPClient resource handling', () => {
  test('readResource returns text content', async () => {
    const mockClient = createMockClient()
    ;(mockClient.readResource as Mock).mockResolvedValue({
      uri: 'file:///test.txt',
      mimeType: 'text/plain',
      text: 'Hello World',
    })

    const result = await mockClient.readResource('file:///test.txt')

    expect(result.text).toBe('Hello World')
    expect(result.uri).toBe('file:///test.txt')
  })

  test('readResource handles missing content gracefully', async () => {
    const mockClient = createMockClient()
    ;(mockClient.readResource as Mock).mockResolvedValue({ uri: 'empty' })

    const result = await mockClient.readResource('empty')

    expect(result.uri).toBe('empty')
    expect(result.text).toBeUndefined()
  })
})

describe('MCPClient auto-reconnect', () => {
  test('isConnectionError detects connection errors', async () => {
    const { MCPClient } = await import('./client')
    const client = new MCPClient({ name: 'test', command: 'test' })
    const isConnectionError = (
      client as unknown as { isConnectionError: (e: unknown) => boolean }
    ).isConnectionError.bind(client)

    expect(isConnectionError(new Error('EPIPE'))).toBe(true)
    expect(isConnectionError(new Error('ECONNRESET'))).toBe(true)
    expect(isConnectionError(new Error('ECONNREFUSED'))).toBe(true)
    expect(isConnectionError(new Error('connection closed'))).toBe(true)
    expect(isConnectionError(new Error('disconnected'))).toBe(true)
    expect(isConnectionError(new Error('not connected'))).toBe(true)
    expect(isConnectionError(new Error('timeout'))).toBe(false)
    expect(isConnectionError(new Error('invalid argument'))).toBe(false)
  })
})

describe('createMCPTool', () => {
  describe('tool creation', () => {
    test('creates tool with prefixed name', () => {
      const toolInfo: MCPToolInfo = {
        name: 'read_file',
        description: 'Reads a file',
        inputSchema: { type: 'object', properties: {} },
      }
      const mockClient = createMockClient()
      const tool = createMCPTool('filesystem', toolInfo, mockClient)

      expect(tool.name).toBe('mcp_filesystem_read_file')
      expect(tool.description).toBe('Reads a file')
    })

    test('uses fallback description when not provided', () => {
      const toolInfo: MCPToolInfo = {
        name: 'my_tool',
        inputSchema: { type: 'object', properties: {} },
      }
      const mockClient = createMockClient()
      const tool = createMCPTool('server', toolInfo, mockClient)

      expect(tool.description).toBe('MCP tool: my_tool')
    })
  })

  describe('tool execution', () => {
    test('calls client with correct arguments', async () => {
      const toolInfo: MCPToolInfo = {
        name: 'test_tool',
        inputSchema: {
          type: 'object',
          properties: { arg1: { type: 'string' } },
        },
      }
      const mockClient = createMockClient()
      const tool = createMCPTool('test', toolInfo, mockClient)

      await tool.execute!({ args: { arg1: 'value' } } as never)

      expect(mockClient.callTool).toHaveBeenCalledWith('test_tool', {
        arg1: 'value',
      })
    })

    test('parses JSON response', async () => {
      const toolInfo: MCPToolInfo = {
        name: 'test',
        inputSchema: { type: 'object' },
      }
      const mockClient = createMockClient()
      ;(mockClient.callTool as Mock).mockResolvedValue({
        content: [{ type: 'text', text: '{"data": [1, 2, 3]}' }],
      })
      const tool = createMCPTool('test', toolInfo, mockClient)

      const result = await tool.execute!({ args: {} } as never)

      expect(result).toEqual({ data: [1, 2, 3] })
    })

    test('returns text when JSON parsing fails', async () => {
      const toolInfo: MCPToolInfo = {
        name: 'test',
        inputSchema: { type: 'object' },
      }
      const mockClient = createMockClient()
      ;(mockClient.callTool as Mock).mockResolvedValue({
        content: [{ type: 'text', text: 'plain text response' }],
      })
      const tool = createMCPTool('test', toolInfo, mockClient)

      const result = await tool.execute!({ args: {} } as never)

      expect(result).toBe('plain text response')
    })

    test('throws on error response', async () => {
      const toolInfo: MCPToolInfo = {
        name: 'test',
        inputSchema: { type: 'object' },
      }
      const mockClient = createMockClient()
      ;(mockClient.callTool as Mock).mockResolvedValue({
        content: [{ type: 'text', text: 'Something went wrong' }],
        isError: true,
      })
      const tool = createMCPTool('test', toolInfo, mockClient)

      await expect(tool.execute!({ args: {} } as never)).rejects.toThrow('Something went wrong')
    })

    test('throws generic error when error response has no text', async () => {
      const toolInfo: MCPToolInfo = {
        name: 'test',
        inputSchema: { type: 'object' },
      }
      const mockClient = createMockClient()
      ;(mockClient.callTool as Mock).mockResolvedValue({
        content: [],
        isError: true,
      })
      const tool = createMCPTool('test', toolInfo, mockClient)

      await expect(tool.execute!({ args: {} } as never)).rejects.toThrow('MCP tool failed')
    })

    test('returns multiple content blocks as array', async () => {
      const toolInfo: MCPToolInfo = {
        name: 'test',
        inputSchema: { type: 'object' },
      }
      const mockClient = createMockClient()
      ;(mockClient.callTool as Mock).mockResolvedValue({
        content: [
          { type: 'text', text: 'first' },
          { type: 'text', text: 'second' },
        ],
      })
      const tool = createMCPTool('test', toolInfo, mockClient)

      const result = await tool.execute!({ args: {} } as never)

      expect(result).toEqual([
        { type: 'text', text: 'first' },
        { type: 'text', text: 'second' },
      ])
    })
  })
})

describe('JSON Schema to Zod conversion', () => {
  const createToolWithSchema = (inputSchema: Record<string, unknown>) => {
    const toolInfo: MCPToolInfo = { name: 'test', inputSchema }
    return createMCPTool('test', toolInfo, createMockClient())
  }

  test('converts string type', () => {
    const tool = createToolWithSchema({
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    })
    expect(tool.schema.parse({ name: 'test' })).toEqual({ name: 'test' })
    expect(() => tool.schema.parse({ name: 123 })).toThrow()
  })

  test('converts number type', () => {
    const tool = createToolWithSchema({
      type: 'object',
      properties: { count: { type: 'number' } },
      required: ['count'],
    })
    expect(tool.schema.parse({ count: 42 })).toEqual({ count: 42 })
    expect(() => tool.schema.parse({ count: 'not a number' })).toThrow()
  })

  test('converts integer type as number', () => {
    const tool = createToolWithSchema({
      type: 'object',
      properties: { id: { type: 'integer' } },
      required: ['id'],
    })
    expect(tool.schema.parse({ id: 5 })).toEqual({ id: 5 })
  })

  test('converts boolean type', () => {
    const tool = createToolWithSchema({
      type: 'object',
      properties: { enabled: { type: 'boolean' } },
      required: ['enabled'],
    })
    expect(tool.schema.parse({ enabled: true })).toEqual({ enabled: true })
    expect(() => tool.schema.parse({ enabled: 'yes' })).toThrow()
  })

  test('converts array type', () => {
    const tool = createToolWithSchema({
      type: 'object',
      properties: { tags: { type: 'array', items: { type: 'string' } } },
      required: ['tags'],
    })
    expect(tool.schema.parse({ tags: ['a', 'b'] })).toEqual({
      tags: ['a', 'b'],
    })
  })

  test('converts nested object type', () => {
    const tool = createToolWithSchema({
      type: 'object',
      properties: {
        user: {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name'],
        },
      },
      required: ['user'],
    })
    expect(tool.schema.parse({ user: { name: 'Alice' } })).toEqual({
      user: { name: 'Alice' },
    })
  })

  test('handles optional fields', () => {
    const tool = createToolWithSchema({
      type: 'object',
      properties: {
        required: { type: 'string' },
        optional: { type: 'string' },
      },
      required: ['required'],
    })
    expect(tool.schema.parse({ required: 'yes' })).toEqual({ required: 'yes' })
    expect(tool.schema.parse({ required: 'yes', optional: 'also' })).toEqual({
      required: 'yes',
      optional: 'also',
    })
  })

  test('converts string enums', () => {
    const tool = createToolWithSchema({
      type: 'object',
      properties: { status: { type: 'string', enum: ['active', 'inactive'] } },
      required: ['status'],
    })
    expect(tool.schema.parse({ status: 'active' })).toEqual({
      status: 'active',
    })
    expect(() => tool.schema.parse({ status: 'unknown' })).toThrow()
  })

  test('preserves descriptions', () => {
    const tool = createToolWithSchema({
      type: 'object',
      properties: { name: { type: 'string', description: 'The name' } },
    })
    expect(
      (tool.schema as z.ZodObject<{ name: z.ZodOptional<z.ZodString> }>).shape.name.description,
    ).toBe('The name')
  })

  test('rejects extra properties (strict mode for OpenAI compatibility)', () => {
    const tool = createToolWithSchema({
      type: 'object',
      properties: { known: { type: 'string' } },
    })
    expect(tool.schema.parse({ known: 'a' })).toEqual({ known: 'a' })
    expect(() => tool.schema.parse({ known: 'a', extra: 'b' })).toThrow()
  })

  test('returns z.record for non-object schemas', () => {
    const tool = createToolWithSchema({ type: 'string' })
    expect(tool.schema.parse({ anything: 'goes' })).toEqual({
      anything: 'goes',
    })
  })

  test('converts nullable types', () => {
    const tool = createToolWithSchema({
      type: 'object',
      properties: { value: { type: ['string', 'null'] } },
      required: ['value'],
    })
    expect(tool.schema.parse({ value: 'test' })).toEqual({ value: 'test' })
    expect(tool.schema.parse({ value: null })).toEqual({ value: null })
  })

  test('converts const values', () => {
    const tool = createToolWithSchema({
      type: 'object',
      properties: { type: { const: 'fixed' } },
      required: ['type'],
    })
    expect(tool.schema.parse({ type: 'fixed' })).toEqual({ type: 'fixed' })
    expect(() => tool.schema.parse({ type: 'other' })).toThrow()
  })

  test('converts string with minLength/maxLength', () => {
    const tool = createToolWithSchema({
      type: 'object',
      properties: { name: { type: 'string', minLength: 2, maxLength: 5 } },
      required: ['name'],
    })
    expect(tool.schema.parse({ name: 'abc' })).toEqual({ name: 'abc' })
    expect(() => tool.schema.parse({ name: 'a' })).toThrow()
    expect(() => tool.schema.parse({ name: 'abcdef' })).toThrow()
  })

  test('converts string with pattern', () => {
    const tool = createToolWithSchema({
      type: 'object',
      properties: { code: { type: 'string', pattern: '^[A-Z]{3}$' } },
      required: ['code'],
    })
    expect(tool.schema.parse({ code: 'ABC' })).toEqual({ code: 'ABC' })
    expect(() => tool.schema.parse({ code: 'abc' })).toThrow()
    expect(() => tool.schema.parse({ code: 'ABCD' })).toThrow()
  })

  test('converts number with minimum/maximum', () => {
    const tool = createToolWithSchema({
      type: 'object',
      properties: { age: { type: 'number', minimum: 0, maximum: 120 } },
      required: ['age'],
    })
    expect(tool.schema.parse({ age: 25 })).toEqual({ age: 25 })
    expect(() => tool.schema.parse({ age: -1 })).toThrow()
    expect(() => tool.schema.parse({ age: 150 })).toThrow()
  })

  test('converts integer type with validation', () => {
    const tool = createToolWithSchema({
      type: 'object',
      properties: { count: { type: 'integer' } },
      required: ['count'],
    })
    expect(tool.schema.parse({ count: 5 })).toEqual({ count: 5 })
    expect(() => tool.schema.parse({ count: 5.5 })).toThrow()
  })

  test('converts array with minItems/maxItems', () => {
    const tool = createToolWithSchema({
      type: 'object',
      properties: {
        tags: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          maxItems: 3,
        },
      },
      required: ['tags'],
    })
    expect(tool.schema.parse({ tags: ['a', 'b'] })).toEqual({
      tags: ['a', 'b'],
    })
    expect(() => tool.schema.parse({ tags: [] })).toThrow()
    expect(() => tool.schema.parse({ tags: ['a', 'b', 'c', 'd'] })).toThrow()
  })
})

describe('MCPServer health check', () => {
  test('healthCheck returns true when connected', async () => {
    const server = createMCPServer({ name: 'test', command: 'test-cmd' })
    const mockClient = createMockClient([{ name: 'tool1', inputSchema: { type: 'object' } }])
    ;(server as unknown as { client: MCPClientInterface }).client = mockClient

    const result = await server.healthCheck()

    expect(result).toBe(true)
  })

  test('healthCheck returns false on error', async () => {
    const server = createMCPServer({ name: 'test', command: 'test-cmd' })
    const mockClient = createMockClient()
    ;(mockClient.listTools as Mock).mockRejectedValue(new Error('Connection failed'))
    ;(server as unknown as { client: MCPClientInterface }).client = mockClient

    const result = await server.healthCheck()

    expect(result).toBe(false)
    expect(server.getState().status).toBe('error')
  })
})

describe('MCPServer resource/prompt caching', () => {
  test('caches resources when cacheResourcesList is true', async () => {
    const server = createMCPServer({
      name: 'test',
      command: 'test-cmd',
      cacheResourcesList: true,
    })
    const mockClient = createMockClient()
    ;(mockClient.listResources as Mock).mockResolvedValue([
      { uri: 'file:///test.txt', name: 'test' },
    ])
    ;(server as unknown as { client: MCPClientInterface }).client = mockClient

    await server.resourceDefinitions()
    await server.resourceDefinitions()

    expect(mockClient.listResources).toHaveBeenCalledTimes(1)
  })

  test('caches prompts when cachePromptsList is true', async () => {
    const server = createMCPServer({
      name: 'test',
      command: 'test-cmd',
      cachePromptsList: true,
    })
    const mockClient = createMockClient()
    ;(mockClient.listPrompts as Mock).mockResolvedValue([
      { name: 'greeting', description: 'A greeting prompt' },
    ])
    ;(server as unknown as { client: MCPClientInterface }).client = mockClient

    await server.promptDefinitions()
    await server.promptDefinitions()

    expect(mockClient.listPrompts).toHaveBeenCalledTimes(1)
  })
})

describe('MCPServer toolDefinitions', () => {
  test('returns raw MCPToolInfo without wrapping', async () => {
    const server = createMCPServer({ name: 'test', command: 'test-cmd' })
    const mockTools: MCPToolInfo[] = [
      {
        name: 'read_file',
        description: 'Reads a file',
        inputSchema: { type: 'object' },
      },
    ]
    ;(server as unknown as { client: MCPClientInterface }).client = createMockClient(mockTools)

    const defs = await server.toolDefinitions()

    expect(defs).toHaveLength(1)
    expect(defs[0].name).toBe('read_file')
    expect(defs[0].description).toBe('Reads a file')
  })

  test('toolDefinitions respects filtering', async () => {
    const server = createMCPServer({ name: 'test', command: 'test-cmd' })
    const mockTools: MCPToolInfo[] = [
      { name: 'read_file', inputSchema: { type: 'object' } },
      { name: 'write_file', inputSchema: { type: 'object' } },
    ]
    ;(server as unknown as { client: MCPClientInterface }).client = createMockClient(mockTools)

    const filtered = server.only(['read_file'])
    const defs = await filtered.toolDefinitions()

    expect(defs).toHaveLength(1)
    expect(defs[0].name).toBe('read_file')
  })
})
