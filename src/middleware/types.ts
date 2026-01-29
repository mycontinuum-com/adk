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
} from '../types';

export interface Middleware {
  name?: string;

  beforeAgent?: (
    ctx: InvocationContext,
  ) => string | void | Promise<string | void>;

  afterAgent?: (
    ctx: InvocationContext,
    output: string,
  ) => string | void | Promise<string | void>;

  beforeModel?: (
    ctx: InvocationContext,
    renderCtx: RenderContext,
  ) => ModelStepResult | void | Promise<ModelStepResult | void>;

  afterModel?: (
    ctx: InvocationContext,
    result: ModelStepResult,
  ) => ModelStepResult | void | Promise<ModelStepResult | void>;

  beforeTool?: (
    ctx: ToolContext,
    call: ToolCallEvent,
  ) => ToolResultEvent | void | Promise<ToolResultEvent | void>;

  afterTool?: (
    ctx: ToolContext,
    result: ToolResultEvent,
  ) => ToolResultEvent | void | Promise<ToolResultEvent | void>;

  onStream?: (event: StreamEvent) => void;

  onStep?: (stepEvents: Event[], session: Session, runnable: Runnable) => void;
}

export interface ComposedObservationHooks {
  onStream?: (event: StreamEvent) => void;
  onStep?: (stepEvents: Event[], session: Session, runnable: Runnable) => void;
}
