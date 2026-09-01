/**
 * Vision Example - Multimodal Input with the ADK
 *
 * Demonstrates image analysis using session.input.message() with media.
 *
 * Usage: npx tsx examples/vision.ts
 */

import { adk } from '@animahealth/adk'
import { openai } from '@animahealth/adk/openai'

const app = adk({ name: 'vision-example' })

const assistant = app.agent({
  name: 'vision-assistant',
  model: openai('gpt-4o'),
  context: [app.context.system('You are a helpful assistant'), app.context.history()],
})

async function main() {
  const result = await app.run(assistant, {
    input: {
      message: {
        text: 'What do you see in this image?',
        media: [
          {
            type: 'image',
            source: {
              type: 'url',
              url: 'https://picsum.photos/id/237/400/300',
            },
          },
        ],
      },
    },
  })

  console.log('Response:', result.output.text)
}

main().catch(console.error)
