# Bookings — the agent that stops and asks

A slot-booking assistant in three small files. It searches a fixed list of appointment slots, offers one, and then **stops**: booking is a yielding tool, so the run suspends and waits for a human. The session is a row in a SQLite file from that moment — no process is left running, nothing is held in memory. A later command supplies the approval and the run continues from exactly where it paused.

That pause is the point. It is not a callback, a queue, or a `while` loop parked on a promise; it is an event in the session ledger, and anything that can read the ledger can answer it.

## What it shows

|  |  |
| --- | --- |
| **A deterministic tool** | `search_slots` — the model picks the filter, ordinary code decides the answer. |
| **A yielding tool** | `book_slot` declares a `yieldSchema`, so calling it suspends the run instead of executing. |
| **Pause and resume** | `session.input.tool({ callId, input })` answers the suspended call; the run picks up there. |
| **Sessions as rows** | `@animahealth/adk/stores/sqlite` — `ask` and `approve` are separate processes with nothing between them but a file. |
| **Typed state** | The confirmation is declared in the app's Zod schema, so `session.state.confirmation` is typed even after a round trip through SQLite. |
| **Keyless tests** | `runTest` scripts the model's turns. Tools still run, state still writes, the yield still happens — with no credentials. |

## Run it

The sample links to the ADK in the repo above it (`"@animahealth/adk": "file:.."`), so build that once from the repo root:

```bash
pnpm install && pnpm run build
```

Then the sample itself is three commands:

```bash
cd sample
npm install
export OPENAI_API_KEY=...            # only the live run needs this; the tests do not
npx tsx src/cli.ts ask "I need physio on Tuesday afternoon, for Alex Doe"
```

No Docker, no Postgres, no cloud. The only thing written to disk is `bookings.db`; delete it to start over.

## The demo

```
$ npx tsx src/cli.ts ask "I need physio on Tuesday afternoon, for Alex Doe"
session session_8c1f…

agent  Tuesday 14:30 with R. Ellis is open — shall I book it?

paused book_slot {"slotId":"slot-02","bookedFor":"Alex Doe"}
       npx tsx src/cli.ts approve session_8c1f…
       npx tsx src/cli.ts deny session_8c1f… "why not"
```

The process exits. Nothing is waiting. Come back tomorrow, from another terminal:

```
$ npx tsx src/cli.ts pending
session_8c1f…  book_slot  {"slotId":"slot-02","bookedFor":"Alex Doe"}

$ npx tsx src/cli.ts approve session_8c1f…

agent  Booked — Tuesday 14:30 with R. Ellis.
booked CLINIC-001 — physiotherapy with R. Ellis, Tuesday 14:30, for Alex Doe
```

`approve` loaded the session out of SQLite, handed `{ approved: true }` to the suspended call, and `book_slot`'s `execute` ran for the first time — in a process that did not exist when the model decided to call it. Declining works the same way and the agent offers another slot:

```
$ npx tsx src/cli.ts deny session_8c1f… "Alex cannot do afternoons"

agent  Understood — 09:15 on Monday is the other physio slot. Shall I take it?
```

The agent's wording is the model's, so it will not match word for word. Everything else — the session id line, the `paused` line, the `booked` line — is printed by `src/cli.ts`.

## Tests, with no key at all

```bash
npm test
```

`runTest` swaps out one thing: the model. The script says _that_ `book_slot` gets called; the tool itself really runs, the ledger really accrues, and the yield really happens. So the interesting assertion is available with no credentials on any fork:

```typescript
const run = await runTest(agent, [
  user('Book slot-02 for Alex Doe.'),
  model({ toolCalls: [{ name: 'book_slot', args: { slotId: 'slot-02', bookedFor: 'Alex Doe' } }] }),
  input({ book_slot: { approved: true } }), // what a human sends, hours later, from anywhere
  model('Booked — Tuesday 14:30 with R. Ellis.'),
])

expect(run.status).toBe('completed')
expect(run.session.state.confirmation.reference).toBe('CLINIC-001')
```

Drop the `input(...)` line and the run ends at `yielded_tool` with nothing booked — which is the other test, and the one that proves the pause is real.

## The files

```
src/clinic.ts     The world: seven slots and a booking ledger, as plain functions.
src/bookings.ts   The whole ADK program — app, schema, two tools, one agent.
src/cli.ts        ask / pending / approve / deny.
test/             The same agent, scripted, keyless.
```

Start in `src/bookings.ts`. The rest is scaffolding around it.
