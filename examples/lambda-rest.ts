import { adk, inMemoryStore } from '@animahealth/adk'
import { openai } from '@animahealth/adk/openai'

function commonMiddleware(fn: (input: unknown) => Promise<unknown>) {
  return async (event: { body?: string; isBase64Encoded?: boolean }) => {
    const input = JSON.parse(
      event.isBase64Encoded
        ? Buffer.from(event.body ?? '', 'base64').toString()
        : (event.body ?? '{}'),
    )
    return { statusCode: 200, body: JSON.stringify(await fn(input)) }
  }
}

// Note: For production, use postgresStore or dynamoStore:
//   import { postgresStore } from '@animahealth/adk/stores/postgres';
//   import { dynamoStore } from '@animahealth/adk/stores/dynamodb';
const app = adk({
  name: 'rest',
  store: inMemoryStore(),
})

const agent = app.agent({
  name: 'assistant',
  model: openai('gpt-4o-mini'),
  context: [app.context.system('You are a helpful assistant.'), app.context.history()],
})

const handle = app.handler.rest({ agent })

export const main = commonMiddleware((input) => handle(input as any))
