// The table is CommonJS because the postbuild scripts `require` it with no build step in front of
// them. This gives `tsup.config.ts` the types it would otherwise lose at that boundary.

/** A published entry name (`stores/dynamodb`) to its source file (`src/session/dynamodb.ts`). */
export type EntryMap = Record<string, string>

/** An entry plus the packages it stops treating as external. */
export type SubpathEntry = readonly [EntryMap, readonly string[]]

export declare const MAIN_ENTRIES: EntryMap
export declare const SUBPATH_ENTRIES: readonly SubpathEntry[]
export declare const ALL_ENTRIES: EntryMap
