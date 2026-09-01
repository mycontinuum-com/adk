export const ADAPTER = Symbol.for('adk.adapter')
export const REALTIME_ADAPTER = Symbol.for('adk.realtime-adapter')
export const EMBEDDER = Symbol.for('adk.embedder')
export const INDEX = Symbol.for('adk.index')

export function getSymbol<T>(obj: unknown, sym: symbol): T | undefined {
  return (obj as any)?.[sym] as T | undefined
}
