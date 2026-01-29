import React, { createContext, useContext, useState, useEffect } from 'react';
// @ts-ignore
import { useStdout } from 'ink';

interface TerminalDimensions {
  columns: number;
  rows: number;
}

const DEFAULT_DIMENSIONS: TerminalDimensions = {
  columns: 80,
  rows: 24,
};

const TerminalContext = createContext<TerminalDimensions>(DEFAULT_DIMENSIONS);

interface TerminalProviderProps {
  children: React.ReactNode;
}

export function TerminalProvider({ children }: TerminalProviderProps): React.ReactElement {
  const { stdout } = useStdout();
  const [dimensions, setDimensions] = useState<TerminalDimensions>({
    columns: stdout?.columns ?? DEFAULT_DIMENSIONS.columns,
    rows: stdout?.rows ?? DEFAULT_DIMENSIONS.rows,
  });

  useEffect(() => {
    if (!stdout) return;

    const handleResize = () => {
      setDimensions({
        columns: stdout.columns ?? DEFAULT_DIMENSIONS.columns,
        rows: stdout.rows ?? DEFAULT_DIMENSIONS.rows,
      });
    };

    stdout.on('resize', handleResize);
    return () => {
      stdout.off('resize', handleResize);
    };
  }, [stdout]);

  useEffect(() => {
    if (stdout) {
      const newCols = stdout.columns ?? DEFAULT_DIMENSIONS.columns;
      const newRows = stdout.rows ?? DEFAULT_DIMENSIONS.rows;
      if (newCols !== dimensions.columns || newRows !== dimensions.rows) {
        setDimensions({ columns: newCols, rows: newRows });
      }
    }
  }, [stdout, dimensions.columns, dimensions.rows]);

  return (
    <TerminalContext.Provider value={dimensions}>
      {children}
    </TerminalContext.Provider>
  );
}

export function useTerminalDimensions(): TerminalDimensions {
  return useContext(TerminalContext);
}

export function useTerminalWidth(): number {
  return useContext(TerminalContext).columns;
}

export function useTerminalHeight(): number {
  return useContext(TerminalContext).rows;
}

