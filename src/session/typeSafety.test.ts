import { z } from 'zod';
import type { StateSchema, TypedState, ScopeState } from '../types/schema';
import type {
  Agent,
  Step,
  Loop,
  Parallel,
  Sequence,
  StepContext,
  LoopContext,
  InvocationContext,
  ToolContext,
  FunctionTool,
  ContextRenderer,
  OutputConfig,
  SessionKeyOf,
  Hooks,
} from '../types';
import { BaseSession } from './base';

const testSchema = {
  session: {
    mode: z.enum(['triage', 'consultation', 'followup']),
    count: z.number(),
    active: z.boolean(),
    label: z.string(),
  },
  user: {
    preference: z.string(),
    tier: z.enum(['free', 'pro', 'enterprise']),
  },
  patient: {
    id: z.string(),
  },
} satisfies StateSchema;

type TestState = TypedState<typeof testSchema>;

describe('TypedState compile-time type safety', () => {
  describe('session scope (shorthand access)', () => {
    it('allows reading declared keys with correct types', () => {
      const session = new BaseSession<typeof testSchema>('test-app');
      const state = session.state;

      const mode: 'triage' | 'consultation' | 'followup' | undefined = state.mode;
      const count: number | undefined = state.count;
      const active: boolean | undefined = state.active;
      const label: string | undefined = state.label;

      expect(mode).toBeUndefined();
      expect(count).toBeUndefined();
      expect(active).toBeUndefined();
      expect(label).toBeUndefined();
    });

    it('rejects reading undeclared keys', () => {
      const state = {} as TestState;

      // @ts-expect-error - 'typo' is not a declared key
      void state.typo;

      // @ts-expect-error - 'Mode' (wrong case) is not a declared key
      void state.Mode;

      expect(true).toBe(true);
    });

    it('allows writing declared keys with correct types', () => {
      const session = new BaseSession<typeof testSchema>('test-app');
      const state = session.state;

      state.mode = 'triage';
      expect(state.mode).toBe('triage');

      state.mode = 'consultation';
      expect(state.mode).toBe('consultation');

      state.mode = 'followup';
      expect(state.mode).toBe('followup');

      state.count = 42;
      expect(state.count).toBe(42);

      state.active = true;
      expect(state.active).toBe(true);

      state.label = 'test';
      expect(state.label).toBe('test');
    });

    it('rejects writing declared keys with wrong types', () => {
      const state = {} as TestState;

      // @ts-expect-error - 'invalid' is not a valid mode
      state.mode = 'invalid';

      // @ts-expect-error - string is not assignable to number
      state.count = 'five';

      // @ts-expect-error - number is not assignable to boolean
      state.active = 1;

      // @ts-expect-error - number is not assignable to string
      state.label = 123;

      expect(true).toBe(true);
    });

    it('rejects writing undeclared keys', () => {
      const state = {} as TestState;

      // @ts-expect-error - 'typo' is not a declared key
      state.typo = 'value';

      // @ts-expect-error - 'newKey' is not a declared key
      state.newKey = 42;

      expect(true).toBe(true);
    });

    it('allows undefined assignment (deletion)', () => {
      const session = new BaseSession<typeof testSchema>('test-app');
      const state = session.state;

      state.mode = 'triage';
      expect(state.mode).toBe('triage');

      state.mode = undefined;
      expect(state.mode).toBeUndefined();

      state.count = 42;
      state.count = undefined;
      expect(state.count).toBeUndefined();
    });
  });

  describe('user scope (explicit access)', () => {
    it('allows reading declared keys with correct types', () => {
      const session = new BaseSession<typeof testSchema>('test-app');
      const state = session.state;

      const preference: string | undefined = state.user.preference;
      const tier: 'free' | 'pro' | 'enterprise' | undefined = state.user.tier;

      expect(preference).toBeUndefined();
      expect(tier).toBeUndefined();
    });

    it('rejects reading undeclared keys', () => {
      const state = {} as TestState;

      // @ts-expect-error - 'typo' is not a declared key in user scope
      void state.user?.typo;

      expect(true).toBe(true);
    });

    it('allows writing declared keys with correct types', () => {
      const session = new BaseSession<typeof testSchema>('test-app');
      const state = session.state;

      state.user.preference = 'dark';
      state.user.tier = 'pro';

      expect(state.user.preference).toBe('dark');
      expect(state.user.tier).toBe('pro');
    });

    it('rejects writing declared keys with wrong types', () => {
      const state = {} as TestState;

      // @ts-expect-error - number is not assignable to string
      if (state.user) state.user.preference = 123;

      // @ts-expect-error - 'invalid' is not a valid tier
      if (state.user) state.user.tier = 'invalid';

      expect(true).toBe(true);
    });

    it('rejects writing undeclared keys', () => {
      const state = {} as TestState;

      // @ts-expect-error - 'newKey' is not a declared key
      if (state.user) state.user.newKey = 'value';

      expect(true).toBe(true);
    });
  });

  describe('patient scope (explicit access)', () => {
    it('allows reading and writing declared keys', () => {
      const session = new BaseSession<typeof testSchema>('test-app');
      const state = session.state;

      expect(state.patient.id).toBeUndefined();

      state.patient.id = 'patient-123';
      expect(state.patient.id).toBe('patient-123');
    });

    it('rejects undeclared keys', () => {
      const state = {} as TestState;

      // @ts-expect-error - 'name' is not declared in patient scope
      void state.patient?.name;

      // @ts-expect-error - 'age' is not declared in patient scope
      if (state.patient) state.patient.age = 30;

      expect(true).toBe(true);
    });
  });

  describe('practice scope (undefined in schema)', () => {
    it('allows dynamic access when scope is undefined in schema', () => {
      const session = new BaseSession<typeof testSchema>('test-app');
      const state = session.state;

      const practiceValue: unknown = state.practice.anyKey;
      expect(practiceValue).toBeUndefined();

      state.practice.dynamicKey = 'value';
      expect(state.practice.dynamicKey).toBe('value');
    });
  });

  describe('temp scope type safety', () => {
    it('has correct type when scope is undefined in schema', () => {
      type TempScope = typeof testSchema extends StateSchema
        ? ScopeState<typeof testSchema['temp']>
        : never;

      const temp = {} as TempScope;
      const anyValue: unknown = temp.anyKey;
      temp.dynamicKey = 123;

      expect(anyValue).toBeUndefined();
    });
  });

  describe('cross-scope isolation', () => {
    it('session keys are not available on user scope', () => {
      const state = {} as TestState;

      // @ts-expect-error - 'mode' is a session key, not user
      void state.user?.mode;

      expect(true).toBe(true);
    });

    it('user keys are not available on session scope (shorthand)', () => {
      const state = {} as TestState;

      // @ts-expect-error - 'preference' is a user key, not session
      void state.preference;

      expect(true).toBe(true);
    });
  });
});

describe('ScopeState type inference', () => {
  it('infers correct types from Zod schema', () => {
    type SessionScope = ScopeState<typeof testSchema.session>;

    const scope = {} as SessionScope;
    const mode: 'triage' | 'consultation' | 'followup' | undefined = scope.mode;
    const count: number | undefined = scope.count;

    expect(mode).toBeUndefined();
    expect(count).toBeUndefined();
  });

  it('falls back to Record<string, unknown> when undefined', () => {
    type UndefinedScope = ScopeState<undefined>;

    const scope = {} as UndefinedScope;
    const anyValue: unknown = scope.anyKey;

    expect(anyValue).toBeUndefined();
  });
});

describe('TypedState without schema (default)', () => {
  it('allows dynamic access with unknown type', () => {
    const session = new BaseSession('test-app');
    const state = session.state;

    const value: unknown = state.anyKey;
    expect(value).toBeUndefined();

    state.dynamicKey = 'anything';
    expect(state.dynamicKey).toBe('anything');

    state.user.dynamicKey = 123;
    expect(state.user.dynamicKey).toBe(123);
  });
});

describe('spread and destructuring behavior', () => {
  it('spread only includes session state keys', () => {
    const session = new BaseSession<typeof testSchema>('test-app');
    const state = session.state;

    state.mode = 'triage';
    state.count = 42;
    state.user.preference = 'dark';

    const spread = { ...state };

    expect(spread.mode).toBe('triage');
    expect(spread.count).toBe(42);
    expect('user' in spread).toBe(false);
    expect('patient' in spread).toBe(false);
    expect('practice' in spread).toBe(false);
    expect('temp' in spread).toBe(false);
  });

  it('destructuring extracts session values with correct types', () => {
    const session = new BaseSession<typeof testSchema>('test-app');
    const state = session.state;

    state.mode = 'consultation';
    state.count = 100;
    state.active = true;

    const { mode, count, active } = state;

    const typedMode: 'triage' | 'consultation' | 'followup' | undefined = mode;
    const typedCount: number | undefined = count;
    const typedActive: boolean | undefined = active;

    expect(typedMode).toBe('consultation');
    expect(typedCount).toBe(100);
    expect(typedActive).toBe(true);
  });

  it('Object.keys only returns session keys', () => {
    const session = new BaseSession<typeof testSchema>('test-app');
    const state = session.state;

    state.mode = 'triage';
    state.count = 1;

    const keys = Object.keys(state);

    expect(keys).toContain('mode');
    expect(keys).toContain('count');
    expect(keys).not.toContain('user');
    expect(keys).not.toContain('patient');
  });

  it('Object.assign updates multiple session keys', () => {
    const session = new BaseSession<typeof testSchema>('test-app');
    const state = session.state;

    Object.assign(state, { mode: 'followup', count: 99 });

    expect(state.mode).toBe('followup');
    expect(state.count).toBe(99);
  });
});

describe('generic propagation', () => {
  it('BaseSession generic propagates to state type', () => {
    const session = new BaseSession<typeof testSchema>('test-app');

    session.state.mode = 'triage';
    const mode: 'triage' | 'consultation' | 'followup' | undefined = session.state.mode;

    // @ts-expect-error - 'invalid' is not a valid mode
    session.state.mode = 'invalid';

    // @ts-expect-error - 'typo' is not a declared key
    void session.state.typo;

    expect(mode).toBe('triage');
  });

  it('session.state.user inherits user schema', () => {
    const session = new BaseSession<typeof testSchema>('test-app', {
      userId: 'user-123',
    });
    session.bindSharedState('user', {});

    session.state.user.preference = 'light';
    const pref: string | undefined = session.state.user.preference;

    // @ts-expect-error - number not assignable to string
    session.state.user.preference = 123;

    expect(pref).toBe('light');
  });
});

describe('update() method for bulk updates', () => {
  it('updates multiple session keys at once', () => {
    const session = new BaseSession<typeof testSchema>('test-app');
    const state = session.state;

    state.update({ mode: 'triage', count: 42 });

    expect(state.mode).toBe('triage');
    expect(state.count).toBe(42);
  });

  it('updates user scope with update()', () => {
    const session = new BaseSession<typeof testSchema>('test-app', {
      userId: 'user-123',
    });
    session.bindSharedState('user', {});

    session.state.user.update({ preference: 'dark', tier: 'pro' });

    expect(session.state.user.preference).toBe('dark');
    expect(session.state.user.tier).toBe('pro');
  });

  it('skips unchanged values', () => {
    const session = new BaseSession<typeof testSchema>('test-app');

    session.state.mode = 'triage';
    session.state.count = 10;
    const eventsBefore = session.events.length;

    session.state.update({ mode: 'triage', count: 10 });

    expect(session.events.length).toBe(eventsBefore);
  });

  it('handles undefined values (deletion)', () => {
    const session = new BaseSession<typeof testSchema>('test-app');

    session.state.mode = 'triage';
    session.state.count = 42;

    session.state.update({ mode: undefined, count: 100 });

    expect(session.state.mode).toBeUndefined();
    expect(session.state.count).toBe(100);
  });
});

describe('runtime proxy behavior matches types', () => {
  it('setting and getting values works correctly', () => {
    const session = new BaseSession<typeof testSchema>('test-app');

    expect(session.state.mode).toBeUndefined();

    session.state.mode = 'triage';
    expect(session.state.mode).toBe('triage');

    session.state.mode = undefined;
    expect(session.state.mode).toBeUndefined();
  });

  it('scope accessors return proxy objects', () => {
    const session = new BaseSession<typeof testSchema>('test-app');

    expect(session.state.user).toBeDefined();
    expect(typeof session.state.user).toBe('object');
  });

  it('shared scope writes require binding', () => {
    const session = new BaseSession<typeof testSchema>('test-app', {
      userId: 'user-123',
    });

    session.bindSharedState('user', {});

    session.state.user.preference = 'test';
    expect(session.state.user.preference).toBe('test');
  });

  it('undefined assignment removes keys (preferred over delete)', () => {
    const session = new BaseSession<typeof testSchema>('test-app');

    session.state.mode = 'triage';
    expect(session.state.mode).toBe('triage');

    session.state.mode = undefined;
    expect(session.state.mode).toBeUndefined();
    expect('mode' in session.state).toBe(false);
  });

  it('in operator checks key existence', () => {
    const session = new BaseSession<typeof testSchema>('test-app');

    expect('mode' in session.state).toBe(false);

    session.state.mode = 'triage';
    expect('mode' in session.state).toBe(true);

    session.state.mode = undefined;
    expect('mode' in session.state).toBe(false);
  });
});

describe('factory function generics', () => {
  describe('Agent<TOutput, S> generic', () => {
    it('Agent type accepts StateSchema generic', () => {
      type TypedAgent = Agent<string, typeof testSchema>;
      const a = {} as TypedAgent;
      expect(a.kind).toBeUndefined();
    });

    it('Agent.hooks callbacks receive typed context', () => {
      type TypedHooks = Hooks<typeof testSchema>;

      const hooks: TypedHooks = {
        beforeAgent: (ctx) => {
          const mode: 'triage' | 'consultation' | 'followup' | undefined = ctx.state.mode;
          // @ts-expect-error - 'invalid' is not a valid mode
          ctx.state.mode = 'invalid';
          expect(mode).toBeUndefined();
        },
      };

      expect(hooks.beforeAgent).toBeDefined();
    });
  });

  describe('Step<S> generic', () => {
    it('Step execute receives typed StepContext', () => {
      type TypedStep = Step<typeof testSchema>;
      const s = {} as TypedStep;

      const mockExecute: TypedStep['execute'] = (ctx) => {
        const mode: 'triage' | 'consultation' | 'followup' | undefined = ctx.state.mode;
        ctx.state.mode = 'triage';

        // @ts-expect-error - 'invalid' is not a valid mode
        ctx.state.mode = 'invalid';

        // @ts-expect-error - 'typo' is not a declared key
        void ctx.state.typo;

        expect(mode).toBeUndefined();
      };

      expect(s.kind).toBeUndefined();
      expect(mockExecute).toBeDefined();
    });

    it('StepContext.complete key is typed when schema provided', () => {
      type CompleteSignature = StepContext<typeof testSchema>['complete'];
      
      const complete: CompleteSignature = (_value, _key) => ({ signal: 'complete' as const, value: _value, key: _key });
      
      complete('value', 'mode');
      complete('value', 'count');

      // @ts-expect-error - 'invalid' is not a session key
      complete('value', 'invalid');

      expect(complete).toBeDefined();
    });
  });

  describe('Loop<S> generic', () => {
    it('Loop.while receives typed LoopContext', () => {
      type TypedLoop = Loop<typeof testSchema>;
      const l = {} as TypedLoop;

      const mockWhile: TypedLoop['while'] = (ctx) => {
        const mode: 'triage' | 'consultation' | 'followup' | undefined = ctx.state.mode;

        // @ts-expect-error - 'typo' is not a declared key
        void ctx.state.typo;

        expect(mode).toBeUndefined();
        return true;
      };

      expect(l.kind).toBeUndefined();
      expect(mockWhile).toBeDefined();
    });
  });

  describe('Parallel<S> generic', () => {
    it('Parallel.merge receives typed ParallelMergeContext', () => {
      type TypedParallel = Parallel<typeof testSchema>;
      const p = {} as TypedParallel;

      const mockMerge: TypedParallel['merge'] = (ctx) => {
        const mode: 'triage' | 'consultation' | 'followup' | undefined = ctx.state.mode;

        // @ts-expect-error - 'typo' is not a declared key
        void ctx.state.typo;

        expect(mode).toBeUndefined();
        return [];
      };

      expect(p.kind).toBeUndefined();
      expect(mockMerge).toBeDefined();
    });
  });

  describe('Sequence<S> generic', () => {
    it('Sequence.runnables accepts typed runnables', () => {
      type TypedSequence = Sequence<typeof testSchema>;
      const s = {} as TypedSequence;

      expect(s.kind).toBeUndefined();
    });
  });
});

describe('OutputConfig type safety', () => {
  describe('SessionKeyOf<S> helper type', () => {
    it('extracts session keys from schema', () => {
      type Keys = SessionKeyOf<typeof testSchema>;
      const key: Keys = 'mode';
      const key2: Keys = 'count';

      // @ts-expect-error - 'invalid' is not a session key
      const badKey: Keys = 'invalid';

      expect(key).toBe('mode');
      expect(key2).toBe('count');
    });

    it('falls back to string when session is undefined', () => {
      const emptySchema = {} satisfies StateSchema;
      type Keys = SessionKeyOf<typeof emptySchema>;
      const key: Keys = 'anything';

      expect(key).toBe('anything');
    });
  });

  describe('OutputConfig<T, S>', () => {
    it('OutputKeyConfig.key is typed to session keys', () => {
      type TypedOutputConfig = OutputConfig<unknown, typeof testSchema>;

      const config1: TypedOutputConfig = { key: 'mode' };
      const config2: TypedOutputConfig = { key: 'count' };

      // @ts-expect-error - 'invalid' is not a session key
      const badConfig: TypedOutputConfig = { key: 'invalid' };

      expect(config1.key).toBe('mode');
      expect(config2.key).toBe('count');
    });

    it('OutputSchemaConfig.key is typed to session keys', () => {
      type TypedOutputConfig = OutputConfig<number, typeof testSchema>;

      const config: TypedOutputConfig = {
        key: 'count',
        schema: z.number(),
      };

      // @ts-expect-error - 'invalid' is not a session key
      const badConfig: TypedOutputConfig = {
        key: 'invalid',
        schema: z.number(),
      };

      expect(config.key).toBe('count');
    });
  });
});

describe('FunctionTool<TInput, TOutput, TYield, S> generic', () => {
  it('tool callbacks receive typed ToolContext', () => {
    type TypedTool = FunctionTool<{ query: string }, string, unknown, typeof testSchema>;

    const mockExecute: TypedTool['execute'] = (ctx) => {
      const mode: 'triage' | 'consultation' | 'followup' | undefined = ctx.state.mode;
      ctx.state.mode = 'triage';

      // @ts-expect-error - 'invalid' is not a valid mode
      ctx.state.mode = 'invalid';

      expect(mode).toBeUndefined();
      return 'result';
    };

    expect(mockExecute).toBeDefined();
  });
});

describe('ContextRenderer<S> generic', () => {
  it('renderer receives typed RenderContext', () => {
    type TypedRenderer = ContextRenderer<typeof testSchema>;

    const renderer: TypedRenderer = (ctx) => {
      const mode: 'triage' | 'consultation' | 'followup' | undefined = ctx.state.mode;

      // @ts-expect-error - 'typo' is not a declared key
      void ctx.state.typo;

      expect(mode).toBeUndefined();
      return ctx;
    };

    expect(renderer).toBeDefined();
  });
});

describe('InvocationContext<S> and ToolContext<S>', () => {
  it('InvocationContext.state type is correctly inferred', () => {
    type StateType = InvocationContext<typeof testSchema>['state'];
    type ModeType = StateType['mode'];

    const mode: ModeType = undefined;
    const validMode: ModeType = 'triage';

    // @ts-expect-error - 'invalid' is not a valid mode
    const invalidMode: ModeType = 'invalid';

    expect(mode).toBeUndefined();
    expect(validMode).toBe('triage');
  });

  it('InvocationContext.state rejects undeclared keys', () => {
    type StateType = InvocationContext<typeof testSchema>['state'];

    // @ts-expect-error - 'typo' is not a declared key
    type TypoType = StateType['typo'];

    expect(true).toBe(true);
  });

  it('ToolContext extends InvocationContext with typed state', () => {
    type StateType = ToolContext<typeof testSchema>['state'];
    type ModeType = StateType['mode'];

    const mode: ModeType = 'consultation';

    // @ts-expect-error - 'invalid' is not a valid mode
    const invalidMode: ModeType = 'invalid';

    expect(mode).toBe('consultation');
  });
});
