import { useState, useEffect, useCallback, useRef } from 'react';
import {
  getLogs,
  clearLogs as globalClearLogs,
  subscribe,
  setBufferSize,
  type LogEntry,
  type LogLevel,
} from '../logCapture';

export type { LogEntry, LogLevel };

export interface UseLogCaptureOptions {
  bufferSize?: number;
}

export interface UseLogCaptureReturn {
  logs: LogEntry[];
  clearLogs: () => void;
}

export function useLogCapture(
  options: UseLogCaptureOptions = {},
): UseLogCaptureReturn {
  const { bufferSize = 1000 } = options;
  const [, forceUpdate] = useState(0);
  const logsRef = useRef<LogEntry[]>([]);

  useEffect(() => {
    setBufferSize(bufferSize);
  }, [bufferSize]);

  useEffect(() => {
    logsRef.current = getLogs();
    forceUpdate((n) => n + 1);

    const unsubscribe = subscribe(() => {
      logsRef.current = getLogs();
      forceUpdate((n) => n + 1);
    });

    return unsubscribe;
  }, []);

  const clearLogs = useCallback(() => {
    globalClearLogs();
    logsRef.current = [];
    forceUpdate((n) => n + 1);
  }, []);

  return { logs: logsRef.current, clearLogs };
}
