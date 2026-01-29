import React, { createContext, useContext, useState, useEffect, useMemo, useRef, useCallback } from 'react';
// @ts-ignore
import { Text } from 'ink';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const TICK_INTERVAL_MS = 80;

type TickCallback = () => void;
const tickSubscribers = new Set<TickCallback>();

interface SpinnerContextValue {
  frame: string;
  subscribe: (callback: TickCallback) => () => void;
}

const SpinnerContext = createContext<SpinnerContextValue>({
  frame: SPINNER_FRAMES[0],
  subscribe: () => () => {},
});

interface SpinnerProviderProps {
  children: React.ReactNode;
}

export function SpinnerProvider({ children }: SpinnerProviderProps): React.ReactElement {
  const [frameIndex, setFrameIndex] = useState(0);

  const subscribe = useCallback((callback: TickCallback) => {
    tickSubscribers.add(callback);
    return () => {
      tickSubscribers.delete(callback);
    };
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      setFrameIndex((prev) => (prev + 1) % SPINNER_FRAMES.length);
      for (const callback of tickSubscribers) {
        callback();
      }
    }, TICK_INTERVAL_MS);

    return () => clearInterval(interval);
  }, []);

  const frame = SPINNER_FRAMES[frameIndex];

  const value = useMemo(() => ({ frame, subscribe }), [frame, subscribe]);

  return (
    <SpinnerContext.Provider value={value}>
      {children}
    </SpinnerContext.Provider>
  );
}

export function useSpinner(): string {
  const { frame } = useContext(SpinnerContext);
  return frame;
}

export function useOnTick(callback: () => void): void {
  const { subscribe } = useContext(SpinnerContext);
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    return subscribe(() => callbackRef.current());
  }, [subscribe]);
}

interface SyncedSpinnerProps {
  color?: string;
}

export function SyncedSpinner({ color }: SyncedSpinnerProps): React.ReactElement {
  const frame = useSpinner();
  return <Text color={color}>{frame}</Text>;
}

