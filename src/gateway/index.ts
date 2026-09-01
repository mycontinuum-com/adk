/**
 * Gateway Module
 *
 * The Gateway is the process runtime's central coordination point: - Manages process lifecycle
 * (dispatch → sleep → wake → execute → complete) - Routes events to subscribers (live during
 * execution, historical from store) - Coordinates with executors for turn execution - Implements
 * poll-based scheduling with claimDue/revertStale
 *
 * @example
 *   ;```typescript
 *   import { createGateway, createInProcessExecutor, inMemoryProcessStore } from '@animahealth/adk'
 *   import { InMemoryStore } from '@animahealth/adk/session/memory'
 *
 *   const processStore = inMemoryProcessStore()
 *   const sessionStore = new InMemoryStore()
 *
 *   const executor = createInProcessExecutor({ sessionStore })
 *
 *   const gateway = createGateway({
 *     appName: 'my-app',
 *     processStore,
 *     sessionStore,
 *     defaultExecutor: executor,
 *     agents: { 'my-agent': myAgent },
 *   })
 *
 *   // Start the poll loop
 *   gateway.start({ intervalMs: 1000 })
 *
 *   // Dispatch a task
 *   const processId = await gateway.dispatch('my-agent', {
 *     input: 'Fix the login bug',
 *   })
 *
 *   // Subscribe to events
 *   for await (const event of gateway.subscribe(processId)) {
 *     console.log(event)
 *   }
 *
 *   // Shutdown
 *   await gateway.shutdown()
 *   ```
 */

// ProcessStore types
export type {
  ProcessStatus,
  StoredProcess,
  ProcessUpdate,
  StoredMessage,
  ProcessFilter,
  ProcessSummary,
  ProcessStore,
} from './types'

// In-memory ProcessStore (no external dependencies)
export { inMemoryProcessStore, InMemoryProcessStore } from './memory'

// Postgres store (requires pg peer dependency)
export { postgresProcessStore, PostgresProcessStore } from './postgres'
export type { PostgresProcessStoreConfig } from './postgres'

// Gateway types
export type {
  Gateway,
  GatewayConfig,
  DispatchOptions,
  SendOptions,
  SubscribeOptions,
  ProcessEvent,
  ProcessStatusResponse,
  Executor,
  ExecutionRequest,
  ExecutionResult,
} from './gateway-types'

// Gateway implementation
export { createGateway, GatewayImpl } from './gateway'

// InProcessExecutor
export {
  createInProcessExecutor,
  InProcessExecutor,
  type InProcessExecutorConfig,
} from './in-process-executor'
// Compliance test suite is available via direct import for backend implementers:
//   import { runProcessStoreTests } from '@animahealth/adk/src/gateway/compliance.test'
