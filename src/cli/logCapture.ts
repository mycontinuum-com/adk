export type LogLevel = 'log' | 'warn' | 'error' | 'debug' | 'info' | 'verbose';

export interface LogEntry {
  id: number;
  timestamp: Date;
  level: LogLevel;
  message: string;
}

let globalLogId = 0;
const logBuffer: LogEntry[] = [];
let bufferSize = 1000;
const listeners: Set<(entry: LogEntry) => void> = new Set();
let initialized = false;

let originalConsole: {
  log: typeof console.log;
  warn: typeof console.warn;
  error: typeof console.error;
  debug: typeof console.debug;
  info: typeof console.info;
} | null = null;

let originalStdoutWrite: typeof process.stdout.write | null = null;
let originalStderrWrite: typeof process.stderr.write | null = null;

function parsePinoLevel(level: string | number): LogLevel {
  const levelStr = typeof level === 'string' ? level.toLowerCase() : '';
  const levelNum = typeof level === 'number' ? level : parseInt(level, 10);

  if (levelStr === 'error' || levelStr === 'err' || levelNum === 50)
    return 'error';
  if (levelStr === 'warn' || levelStr === 'warning' || levelNum === 40)
    return 'warn';
  if (levelStr === 'info' || levelNum === 30) return 'info';
  if (levelStr === 'debug' || levelNum === 20) return 'debug';
  if (
    levelStr === 'verbose' ||
    levelStr === 'trace' ||
    levelNum === 15 ||
    levelNum <= 10
  )
    return 'verbose';
  return 'log';
}

function tryParsePinoJson(line: string): LogEntry | null {
  if (!line.startsWith('{')) return null;

  try {
    const parsed = JSON.parse(line);
    if (parsed.level !== undefined && (parsed.message || parsed.msg)) {
      const level = parsePinoLevel(parsed.level);
      const message = parsed.message || parsed.msg || '';
      const timestamp = parsed.timestamp
        ? new Date(parsed.timestamp)
        : new Date();

      const data = { ...parsed };
      delete data.level;
      delete data.message;
      delete data.msg;
      delete data.timestamp;
      delete data.time;
      delete data.functionName;
      delete data.region;

      const hasData = Object.keys(data).length > 0;
      const fullMessage = hasData
        ? `${message} ${JSON.stringify(data)}`
        : message;

      return {
        id: globalLogId++,
        timestamp,
        level,
        message: fullMessage,
      };
    }
  } catch {
    // Not valid JSON
  }
  return null;
}

function addEntry(entry: LogEntry): void {
  logBuffer.push(entry);
  if (logBuffer.length > bufferSize) {
    logBuffer.shift();
  }
  listeners.forEach((listener) => listener(entry));
}

function addLog(level: LogLevel, args: unknown[]): void {
  const entry: LogEntry = {
    id: globalLogId++,
    timestamp: new Date(),
    level,
    message: args
      .map((arg) => {
        if (typeof arg === 'string') return arg;
        try {
          return JSON.stringify(arg);
        } catch {
          return String(arg);
        }
      })
      .join(' '),
  };
  addEntry(entry);
}

function patchConsole(): void {
  console.log = (...args: unknown[]) => {
    addLog('log', args);
  };
  console.warn = (...args: unknown[]) => {
    addLog('warn', args);
  };
  console.error = (...args: unknown[]) => {
    addLog('error', args);
  };
  console.debug = (...args: unknown[]) => {
    addLog('debug', args);
  };
  console.info = (...args: unknown[]) => {
    addLog('info', args);
  };
}

function handleStreamWrite(chunk: string | Buffer): void {
  const str = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  const lines = str.split('\n').filter((line) => line.trim());

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('{')) {
      const pinoEntry = tryParsePinoJson(trimmed);
      if (pinoEntry) {
        addEntry(pinoEntry);
      }
    }
  }
}

function patchStdStreams(): void {
  process.stdout.write = ((
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((err?: Error | null) => void),
    callback?: (err?: Error | null) => void,
  ): boolean => {
    handleStreamWrite(chunk as string | Buffer);
    if (typeof encodingOrCallback === 'function') {
      return originalStdoutWrite!(chunk, encodingOrCallback);
    }
    return originalStdoutWrite!(chunk, encodingOrCallback, callback);
  }) as typeof process.stdout.write;

  process.stderr.write = ((
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((err?: Error | null) => void),
    callback?: (err?: Error | null) => void,
  ): boolean => {
    handleStreamWrite(chunk as string | Buffer);
    if (typeof encodingOrCallback === 'function') {
      return originalStderrWrite!(chunk, encodingOrCallback);
    }
    return originalStderrWrite!(chunk, encodingOrCallback, callback);
  }) as typeof process.stderr.write;
}

function subscribeToLogger(): void {
  // TODO: Re-enable when platform primitives are extracted to a shared package
  // This function subscribes to the platform Logger for log capture integration.
  // The logger module was part of the anima-service monorepo at:
  // '../../../platform/primitives/observability/logger'
  //
  // if (process.env.NODE_ENV === 'test') return;
  //
  // try {
  //   const {
  //     logger,
  //   } = require('@animahealth/primitives/observability/logger');
  //   logger.subscribe(
  //     (level: string, message: string, data?: Record<string, unknown>) => {
  //       const logLevel = parsePinoLevel(level);
  //       const dataStr =
  //         data && Object.keys(data).length > 0
  //           ? ` ${JSON.stringify(data)}`
  //           : '';
  //       addEntry({
  //         id: globalLogId++,
  //         timestamp: new Date(),
  //         level: logLevel,
  //         message: `${message}${dataStr}`,
  //       });
  //     },
  //   );
  // } catch {
  //   // Logger not available
  // }
}

export function initLogCapture(): void {
  if (initialized) return;
  initialized = true;

  originalConsole = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    debug: console.debug.bind(console),
    info: console.info.bind(console),
  };

  originalStdoutWrite = process.stdout.write.bind(process.stdout);
  originalStderrWrite = process.stderr.write.bind(process.stderr);

  patchConsole();
  patchStdStreams();
  subscribeToLogger();
}

export function repatchConsole(): void {
  if (!initialized) {
    initLogCapture();
    return;
  }
  patchConsole();
}

export function getLogs(): LogEntry[] {
  return [...logBuffer];
}

export function clearLogs(): void {
  logBuffer.length = 0;
}

export function setBufferSize(size: number): void {
  bufferSize = size;
  while (logBuffer.length > bufferSize) {
    logBuffer.shift();
  }
}

export function subscribe(callback: (entry: LogEntry) => void): () => void {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

export function isInitialized(): boolean {
  return initialized;
}
