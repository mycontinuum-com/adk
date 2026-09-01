/**
 * Artifact storage and management for the ADK.
 *
 * This module provides: - ArtifactService interface for pluggable storage backends -
 * InMemoryArtifactService for testing and development - Compliance test suite for validating
 * implementations - Type definitions for artifacts, versions, and events
 */

// Types
export type {
  ArtifactService,
  Artifact,
  ArtifactSummary,
  ArtifactVersion,
  SaveArtifactOptions,
  SaveArtifactResult,
  LoadArtifactOptions,
} from './types'

export { inferMimeType } from './types'

// In-memory implementation
export { InMemoryArtifactService } from './memory'

// Postgres implementation (requires pg peer dependency)
export { postgresArtifactService, PostgresArtifactService } from './postgres'
export type { PostgresArtifactServiceConfig } from './postgres'
