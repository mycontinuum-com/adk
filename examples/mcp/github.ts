import { adk, openai } from '@animahealth/adk'

const app = adk({ name: 'mcp-github' })

const github = app.mcp.server({
  name: 'github',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-github'],
  env: {
    GITHUB_PERSONAL_ACCESS_TOKEN: process.env.GITHUB_TOKEN!,
  },
  cacheToolsList: true,
})

const agent = app.agent({
  name: 'github-assistant',
  model: openai('gpt-4o-mini'),
  context: [
    app.context.system(`You are a GitHub assistant that helps with repository management.
You can search repositories, read files, manage issues, and work with pull requests.
Always confirm destructive actions before executing them.
When searching, be specific and use appropriate filters.`),
    app.context.history(),
  ],
  tools: [
    github.only([
      'search_repositories',
      'search_code',
      'get_file_contents',
      'list_issues',
      'get_issue',
      'create_issue',
      'search_issues',
      'list_pull_requests',
      'get_pull_request',
      'get_pull_request_files',
      'list_commits',
    ]),
  ],
})

async function main() {
  if (!process.env.GITHUB_TOKEN) {
    console.error('Error: GITHUB_TOKEN environment variable is required')
    console.error('Create a token at: https://github.com/settings/tokens')
    process.exit(1)
  }

  const defs = await github.toolDefinitions()
  console.log('Available GitHub tools:')
  for (const d of defs) {
    console.log(`  - ${d.name}`)
  }
  console.log()

  const result = await app.cli(
    agent,
    'What is the most used agent development framework on github?',
  )
  console.log(result.output.text)
}

main().catch(console.error)
