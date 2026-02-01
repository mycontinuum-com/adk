import type {
  InvocationContext,
  ToolContext,
  RenderContext,
  ModelStepResult,
  ToolCallEvent,
  ToolResultEvent,
  StreamEvent,
  Event,
  Session,
  Runnable,
  StateSchema,
} from '../types';

export interface Middleware<S extends StateSchema = StateSchema> {
  name?: string;

  beforeAgent?: (
    ctx: InvocationContext<S>,
  ) => string | void | Promise<string | void>;

  afterAgent?: (
    ctx: InvocationContext<S>,
    output: string,
  ) => string | void | Promise<string | void>;

  beforeModel?: (
    ctx: InvocationContext<S>,
    renderCtx: RenderContext<S>,
  ) => ModelStepResult | void | Promise<ModelStepResult | void>;

  afterModel?: (
    ctx: InvocationContext<S>,
    result: ModelStepResult,
  ) => ModelStepResult | void | Promise<ModelStepResult | void>;

  beforeTool?: (
    ctx: ToolContext<S>,
    call: ToolCallEvent,
  ) => ToolResultEvent | void | Promise<ToolResultEvent | void>;

  afterTool?: (
    ctx: ToolContext<S>,
    result: ToolResultEvent,
  ) => ToolResultEvent | void | Promise<ToolResultEvent | void>;

  onStream?: (event: StreamEvent) => void;

  onStep?: (stepEvents: Event[], session: Session<S>, runnable: Runnable<S>) => void;
}

export interface ComposedObservationHooks<S extends StateSchema = StateSchema> {
  onStream?: (event: StreamEvent) => void;
  onStep?: (stepEvents: Event[], session: Session<S>, runnable: Runnable<S>) => void;
}
