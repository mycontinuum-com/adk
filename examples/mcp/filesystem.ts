import { adk, openai } from '@animahealth/adk'

const app = adk({ name: 'mcp-filesystem' })

const filesystem = app.mcp.server({
  name: 'filesystem',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem', process.cwd()],
  cacheToolsList: true,
})

const agent = app.agent({
  name: 'file-reader',
  model: openai('gpt-5-mini'),
  context: [
    app.context.system(`You are a helpful assistant that can read and list files.
You can only access files within: ${process.cwd()}
You run multiple tools in parallel and batch inputs whenever possible.
You read entire files without truncation.`),
    app.context.history(),
  ],
  tools: [filesystem.only(['read_file', 'list_directory', 'search_files'])],
})

async function main() {
  const defs = await filesystem.toolDefinitions()
  console.log('Available tools:')
  for (const d of defs) {
    console.log(d.name)
  }
  console.log()

  const result = await app.cli(agent, 'Explore the ADK and outline how it works.')
  console.log(result.output.text)
}

main().catch(console.error)
