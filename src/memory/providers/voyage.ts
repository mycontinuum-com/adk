import type { RetryConfig } from '../../types/runnables'
import type { Embedder, EmbedResult, VoyageModel } from '../types'

import { withRetry } from '../../core/retry'

const DEFAULT_BATCH_SIZE = 128

const DEFAULT_RETRY: RetryConfig = {
  maxAttempts: 3,
  initialDelayMs: 1000,
  maxDelayMs: 60_000,
  backoffMultiplier: 2,
}

export function voyage(name: string, config: Omit<VoyageModel, 'provider' | 'name'>): VoyageModel {
  return { provider: 'voyage', name, ...config }
}

interface VoyageClient {
  embed(opts: {
    input: string[]
    model: string
    inputType?: string
    outputDimension?: number
    outputDtype?: string
  }): Promise<{
    data?: Array<{ embedding?: number[]; index?: number }>
    usage?: { total_tokens?: number }
  }>
}

interface SageMakerRuntimeClient {
  send(command: unknown): Promise<{ Body?: Uint8Array }>
}

export function createVoyageEmbedder(config: VoyageModel): Embedder {
  const retryConfig = config.retry ?? DEFAULT_RETRY
  const batchSize = config.batchSize ?? DEFAULT_BATCH_SIZE
  const { dimensions } = config

  let voyageClient: VoyageClient | null = null
  let sagemakerClient: SageMakerRuntimeClient | null = null

  function getVoyageClient(): VoyageClient {
    if (!voyageClient) {
      const apiKey = config.apiKey ?? process.env.VOYAGE_API_KEY
      if (!apiKey) {
        throw new Error('Voyage API key required — set VOYAGE_API_KEY or pass apiKey in config.')
      }
      const { VoyageAIClient } = require('voyageai') as {
        VoyageAIClient: new (opts: { apiKey: string }) => VoyageClient
      }
      voyageClient = new VoyageAIClient({ apiKey })
    }
    return voyageClient
  }

  function getSageMakerClient(): SageMakerRuntimeClient {
    if (!sagemakerClient) {
      const { SageMakerRuntimeClient: SMClient } = require('@aws-sdk/client-sagemaker-runtime') as {
        SageMakerRuntimeClient: new (opts: { region: string }) => SageMakerRuntimeClient
      }
      sagemakerClient = new SMClient({
        region: config.sagemaker!.region ?? 'eu-west-2',
      })
    }
    return sagemakerClient
  }

  async function embedViaSageMaker(input: string[], inputType: string): Promise<EmbedResult> {
    const { InvokeEndpointCommand } = require('@aws-sdk/client-sagemaker-runtime') as {
      InvokeEndpointCommand: new (opts: {
        EndpointName: string
        ContentType: string
        Body: Uint8Array
      }) => unknown
    }

    const command = new InvokeEndpointCommand({
      EndpointName: config.sagemaker!.endpointName,
      ContentType: 'application/json',
      Body: new TextEncoder().encode(JSON.stringify({ input, input_type: inputType })),
    })

    const response = await getSageMakerClient().send(command)
    const resultBody = new TextDecoder().decode(response.Body)
    const result = JSON.parse(resultBody) as {
      data: Array<{ embedding: string[]; index: number }>
    }

    const embeddings = result.data
      .toSorted((a, b) => a.index - b.index)
      .map((r) => r.embedding.map((e) => parseFloat(e)))

    return { embeddings, model: config.name }
  }

  async function embedViaVoyageApi(input: string[], inputType: string): Promise<EmbedResult> {
    const client = getVoyageClient()
    const response = await client.embed({
      input,
      model: config.name,
      inputType,
      ...(config.dimensions ? { outputDimension: config.dimensions } : {}),
      ...(config.outputFormat && config.outputFormat !== 'float'
        ? { outputDtype: config.outputFormat }
        : {}),
    })

    const embeddings =
      response.data
        ?.toSorted((a, b) => (a.index ?? 0) - (b.index ?? 0))
        .map((d) => d.embedding ?? []) ?? []

    return {
      embeddings,
      model: config.name,
      ...(response.usage?.total_tokens
        ? { usage: { totalTokens: response.usage.total_tokens } }
        : {}),
    }
  }

  async function embedBatch(input: string[], inputType: string): Promise<EmbedResult> {
    if (config.sagemaker) {
      try {
        return await withRetry(() => embedViaSageMaker(input, inputType), retryConfig)
      } catch (sagemakerError) {
        console.warn(
          `[voyage] SageMaker endpoint "${config.sagemaker.endpointName}" failed after retries, falling back to Voyage API:`,
          sagemakerError instanceof Error ? sagemakerError.message : sagemakerError,
        )
      }
    }
    return withRetry(() => embedViaVoyageApi(input, inputType), retryConfig)
  }

  const embedder: Embedder = {
    dimensions,
    modelName: config.name,

    async embed(
      input: string[],
      options?: { inputType?: 'query' | 'document' },
    ): Promise<EmbedResult> {
      if (input.length === 0) {
        return { embeddings: [], model: config.name }
      }

      const inputType = options?.inputType ?? 'document'

      if (input.length <= batchSize) {
        return embedBatch(input, inputType)
      }

      const batches: string[][] = []
      for (let i = 0; i < input.length; i += batchSize) {
        batches.push(input.slice(i, i + batchSize))
      }

      const results = await Promise.all(batches.map((batch) => embedBatch(batch, inputType)))
      let totalTokens = 0
      const allEmbeddings: number[][] = []
      for (const r of results) {
        allEmbeddings.push(...r.embeddings)
        if (r.usage) totalTokens += r.usage.totalTokens
      }

      return {
        embeddings: allEmbeddings,
        model: config.name,
        ...(totalTokens > 0 ? { usage: { totalTokens } } : {}),
      }
    },
  }

  return embedder
}
