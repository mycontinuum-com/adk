# Changelog

## [0.2.0] - 2026-02-XX

### Added

- `webSearch` and `fetchPage` tools for online agentic research
- `run()`, `session()`, `runner()` factory functions for simplified API
- `StateSchema` generic threading through factory functions and contexts
- `npm run ci` script combining typecheck and tests

### Changed

- `cli()` signature now matches `run()` pattern
- State API redesign: Replaced method-based API with ergonomic property access
  - Session state is now the default scope: `ctx.state.mode` (not `ctx.state.session.mode`)
  - Other scopes remain explicit: `ctx.state.user.preference`, `ctx.state.patient.id`
  - Full type inference from Zod schemas at compile time

### Removed

- `initialState` from `CreateSessionOptions` (use direct property assignment)
- `runCLI()` (use `cli()`)
- Method-based state API: `get()`, `set()`, `delete()`, `toObject()`, `getMany()` (replaced with property access)
- Note: `.update()` method retained for bulk updates

### Migration

#### Run, Runner, Session Factories

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
s.state.mode = 'triage'; // property-access state API
const r = await run(myAgent, { session: s, input: 'Hello!' });
```

#### Simplified State API

```typescript
// Before (method-based)
ctx.state.session.get('mode');
ctx.state.session.set('mode', 'triage');
ctx.state.session.delete('mode');
ctx.state.session.toObject();
ctx.state.session.update({ a: 1, b: 2 });
ctx.state.user.get('pref');

// After (property-access)
ctx.state.mode;                    // read session state (shorthand)
ctx.state.mode = 'triage';         // write session state
ctx.state.mode = undefined;        // delete (or use delete operator)
{ ...ctx.state };                  // spread to get all session keys
ctx.state.update({ a: 1, b: 2 });  // bulk update (retained!)
ctx.state.user.pref;               // other scopes still explicit

// Type-safe with schema
const stateSchema = {
  session: {
    mode: z.enum(['triage', 'consultation']),
    count: z.number(),
  },
} satisfies StateSchema;

ctx.state.mode = 'triage';    // ✅ Type-safe
ctx.state.mode = 'invalid';   // ❌ Compile error
ctx.state.typo = 'value';     // ❌ Compile error
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
