import { Writable } from 'node:stream'

import { adk, inMemoryStore } from '@animahealth/adk'
import { openai } from '@animahealth/adk/openai'

declare global {
  namespace awslambda {
    function streamifyResponse(handler: StreamHandler): unknown
    namespace HttpResponseStream {
      function from(
        stream: Writable,
        metadata: { statusCode: number; headers?: Record<string, string> },
      ): Writable
    }
  }
}

type StreamHandler = (
  event: { body?: string; isBase64Encoded?: boolean },
  stream: Writable,
) => Promise<void>

// Note: For production, use postgresStore or dynamoStore:
//   import { postgresStore } from '@animahealth/adk/stores/postgres';
//   import { dynamoStore } from '@animahealth/adk/stores/dynamodb';
const app = adk({
  name: 'agui',
  store: inMemoryStore(),
})

const agent = app.agent({
  name: 'assistant',
  model: openai('gpt-4o-mini'),
  context: [app.context.system('You are a helpful assistant.'), app.context.history()],
})

const handle = app.handler.agui({ agent })

export const handler = awslambda.streamifyResponse(async (event, responseStream) => {
  const stream = awslambda.HttpResponseStream.from(responseStream, {
    statusCode: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
    },
  })

  const body = JSON.parse(
    event.isBase64Encoded
      ? Buffer.from(event.body ?? '', 'base64').toString()
      : (event.body ?? '{}'),
  )

  for await (const chunk of handle(body)) {
    const chunkEvent = chunk as { type: string }
    stream.write(`event: ${chunkEvent.type}\ndata: ${JSON.stringify(chunk)}\n\n`)
  }
  stream.end()
})
