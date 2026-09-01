/**
 * Knowledge Types
 *
 * Types for the knowledge assembly system. Knowledge is the Fab's unified system for shared memory,
 * collaboration, alignment, and self-awareness.
 *
 * Every piece of information has three properties:
 *
 * - **Provenance**: Who produced it and how (git, human, agent, system, external)
 * - **Scope**: Who can see it (process, flow, area, system)
 * - **Authority**: How the agent should treat it (instruction, decision, reference, etc.)
 *
 * @module
 */

// ─────────────────────────────────────────────────────────────────────────────
// Core Enums
// ─────────────────────────────────────────────────────────────────────────────

/** Source type - who produced the knowledge and how. */
export type KnowledgeSourceType =
  | 'git' // Committed via PR - highest trust
  | 'human' // Direct human input (steering, dashboard edit)
  | 'agent' // Agent output, subject to review
  | 'system' // Empirical data (observations, baselines)
  | 'external' // External system data (Linear, Sentry)

/** Scope - who can see the knowledge. */
export type KnowledgeScope =
  | 'process' // Only the owning process
  | 'flow' // All processes of this flow type
  | 'area' // All processes targeting this area
  | 'system' // Every process

/** Authority - how the agent should treat the knowledge. */
export type KnowledgeAuthority =
  | 'instruction' // Must follow - guardrails, conventions, rules
  | 'decision' // Already decided - don't revisit unless asked
  | 'reference' // Useful context - informational, not directive
  | 'output' // Produced for human review - the agent's work product
  | 'observation' // Empirical data - facts, not opinions
  | 'draft' // Work in progress - tentative, may change

/** Special knowledge types for provisioning. */
export type KnowledgeType = 'skill' | 'rule'

// ─────────────────────────────────────────────────────────────────────────────
// Assembled Context
// ─────────────────────────────────────────────────────────────────────────────

/** A single piece of knowledge ready for adapter-controlled provisioning. */
export interface ProvisioningItem {
  /** Unique name/identifier for this context item. */
  name: string

  /** The content (text or binary). */
  content: string | Buffer

  /** MIME type of the content. */
  mimeType: string

  /** How the agent should treat this knowledge. */
  authority: KnowledgeAuthority

  /** Visibility scope. */
  scope: KnowledgeScope

  /** How this knowledge was produced. */
  sourceType: KnowledgeSourceType

  /**
   * Path scope for conditional rules. When set, this instruction only applies to files matching
   * this glob pattern.
   */
  pathScope?: string

  /**
   * Special knowledge type for provisioning decisions. - 'skill': Goes to .claude/skills/ - 'rule':
   * Goes to .claude/rules/
   */
  type?: KnowledgeType

  /**
   * Render hint for dashboard display. Examples: 'markdown', 'checklist', 'url', 'json',
   * 'test-report'
   */
  renderHint?: string

  /** Human-readable label for dashboard display. */
  label?: string

  /**
   * Source reference for traceability. For git: { ref: 'abc123', path: 'docs/conventions.md' } For
   * external: { system: 'linear', issueId: 'ABC-123' }
   */
  sourceRef?: Record<string, unknown>

  /**
   * Priority for budget truncation (higher = more important, keep first). Default priorities by
   * scope: - process decisions/outputs: 100 - system instructions: 90 - flow instructions: 80 -
   * area references: 70 - external references: 60 - inherited decisions: 50 - system observations:
   * 40
   */
  priority?: number

  /** Estimated token count for budget management. */
  tokenEstimate?: number
}

// ─────────────────────────────────────────────────────────────────────────────
// Provision Manifest
// ─────────────────────────────────────────────────────────────────────────────

/** Metadata about a provisioned file. */
export interface ProvisionedFile {
  /** SHA-256 hash of the content for change detection. */
  hash: string

  /** True if this file was inherited from a parent/broader scope. */
  inherited?: boolean

  /** True if this file was seeded as an empty placeholder. */
  seeded?: boolean

  /** Original source path (for git-sourced files). */
  sourcePath?: string

  /** MIME type of the content. */
  mimeType?: string
}

/**
 * Manifest tracking what was provisioned to a workspace.
 *
 * Used by the artifact sync to detect changes and by collect() to determine what the agent produced
 * vs what was provided.
 */
export interface ProvisionManifest {
  /** Map of workspace-relative path to file metadata. */
  files: Map<string, ProvisionedFile>

  /** Git ref that was used for git-sourced knowledge. */
  gitRef?: string

  /** Timestamp when provisioning completed. */
  provisionedAt: Date
}

// ─────────────────────────────────────────────────────────────────────────────
// Knowledge Entry (Database)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Knowledge entry as stored in the database.
 *
 * This matches the fab.knowledge table schema.
 */
export interface KnowledgeEntry {
  id: string
  name: string
  sourceType: KnowledgeSourceType
  sourceRef: Record<string, unknown> | null
  scope: KnowledgeScope
  scopeKey: string | null
  processId: string | null
  authority: KnowledgeAuthority
  mimeType: string
  version: number
  renderHint: string | null
  label: string | null
  derivedFrom: string[] | null
  supersedes: string | null
  tags: string[]
  createdAt: Date
  updatedAt: Date
}

/** Input for creating a new knowledge entry. */
export interface CreateKnowledgeInput {
  name: string
  content: string | Buffer
  mimeType: string
  sourceType: KnowledgeSourceType
  sourceRef?: Record<string, unknown>
  scope: KnowledgeScope
  scopeKey?: string
  processId?: string
  authority: KnowledgeAuthority
  renderHint?: string
  label?: string
  tags?: string[]
}

// ─────────────────────────────────────────────────────────────────────────────
// Provisioner Types
// ─────────────────────────────────────────────────────────────────────────────

/** Options for provisioning knowledge to a workspace. */
export interface ProvisionOptions {
  /** Absolute path to the workspace root. */
  workspace: string

  /** Knowledge items to provision. */
  context: ProvisioningItem[]

  /** Flow configuration for permissions. */
  flow?: {
    allowedTools?: string[]
    disallowedTools?: string[]
  }

  /** Pre-declared artifacts to seed. */
  declaredArtifacts?: Record<
    string,
    {
      mimeType: string
      render?: string
      label?: string
    }
  >
}

/** Claude Code settings.json structure. */
export interface ClaudeSettings {
  permissions?: {
    allow?: string[]
    deny?: string[]
  }
}
