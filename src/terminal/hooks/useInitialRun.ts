import { useEffect, useRef } from 'react'

/** Submits the initial prompt once, when the terminal first mounts. */
export function useInitialRun(
  initialInput: string | undefined,
  run: (prompt: string) => void,
): void {
  const startedRef = useRef(false)
  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true
    if (initialInput) run(initialInput)
  }, [initialInput, run])
}
