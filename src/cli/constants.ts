export const LABEL_WIDTH = 8;
export const INDENT_WIDTH = 2;
export const MIN_TEXT_WIDTH = 40;
export const MIN_CONTINUATION_WIDTH = 10;
export const MAX_VISUAL_LINES_PER_EVENT = 80;
export const DETAIL_SCROLL_PAGE_SIZE = 10;
export const DEFAULT_TERMINAL_WIDTH = 80;
export const DEFAULT_TERMINAL_HEIGHT = 24;

export const CLEAN_MODE_EVENT_TYPES = new Set([
  'user',
  'assistant',
  'thought',
  'delta_batch',
  'tool_call',
  'tool_input',
]);
