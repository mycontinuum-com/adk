export class EvalToolError extends Error {
  readonly toolName: string
  readonly args: unknown

  constructor(toolName: string, args: unknown) {
    const message = `Tool '${toolName}' was called during eval but no mock was provided.

Add a mock:
  toolMocks: {
    ${toolName}: { execute: (args) => ({ /* mock result */ }) }
  }

Or if this tool has no side effects, provide the actual tool:
  import { ${toolName} } from './tools';
  toolMocks: { ${toolName} }

Tool was called with args:
  ${JSON.stringify(args, null, 2)}`

    super(message)
    this.name = 'EvalToolError'
    this.toolName = toolName
    this.args = args
  }
}
