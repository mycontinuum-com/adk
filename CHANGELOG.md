# Changelog

## [0.2.0] - 2026-02-XX

### Added

- `webSearch` and `fetchPage` tools for online agentic research
- `run()`, `session()`, `runner()` factory functions for simplified API
- `session.state.update()` for bulk state updates across scopes

### Changed

- `cli()` signature now matches `run()` pattern

### Removed

- `initialState` from `CreateSessionOptions` (use `session.state.update()`)
- `runCLI()` (use `cli()`)

### Migration

```typescript
// Before
const s = new BaseSession('app');
s.addMessage('Hello!');
const runner = new BaseRunner();
const r = await runner.run(myAgent, s);

// After
const r = await run(myAgent, 'Hello!');

// With full control
const s = await session('app');
s.state.update({ session: { authenticated: true } });
const r = await run(myAgent, { session: s, input: 'Hello!' });
```

## [0.1.0] - 2026-01-15

### Added

- Initial release as standalone package ported from anima-service.

### Migration

```typescript
// Before
import { agent, tool } from '../../../modules/adk';

// After
import { agent, tool } from '@animahealth/adk';
```

For `PersistentSessionService` (DynamoDB), continue importing from anima-service until that is extracted.
