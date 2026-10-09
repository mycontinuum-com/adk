/** What the suite in `eval-cli.ts` is made of, for the tests that select from it and assert on it. */
export const GREETING = 'greeting/text'
export const VOICE = 'greeting/voice'
export const LOOKUP = 'lookup/text'

/** The agent `LOOKUP` runs, as a scorecard lists the model it calls. */
export const LOOKER = { agent: 'looker', model: 'mock', effort: 'low' } as const

export const TOOL = 'lookup'

/** The line `TOOL` returns unless `EVAL_TEST_LINE` sets another. */
export const OLD_LINE = 'the old line'

/** What `GREETING` appends to the file `EVAL_TEST_COUNTER` names, each time it runs. */
export const COUNTED = 'text\n'

export const CONCURRENCY = 2
