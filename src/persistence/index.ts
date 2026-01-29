/**
 * Persistence abstraction for ADK sessions.
 *
 * The core ADK package includes InMemorySessionService and LocalSessionService (SQLite).
 * For production DynamoDB persistence, see the anima-service implementation at:
 * https://github.com/AskAnima/anima-service/blob/main/modules/adk/session/persistent.ts
 *
 * To implement custom persistence:
 * 1. Implement the SessionService interface from '@anima/adk'
 * 2. Optionally implement the SessionSearchService for search capabilities
 */

import type { SessionService, Session, CreateSessionOptions } from '../types';

export type { SessionService, Session, CreateSessionOptions };

/**
 * Optional search interface for session persistence backends that support querying.
 */
export interface SessionSearchService {
  /**
   * Search sessions by criteria.
   */
  searchSessions(
    appName: string,
    query: SessionSearchQuery,
  ): Promise<SessionSearchResult>;
}

export interface SessionSearchQuery {
  userId?: string;
  patientId?: string;
  practiceId?: string;
  dateRange?: { start: Date; end: Date };
  status?: 'active' | 'completed' | 'error';
  limit?: number;
  cursor?: string;
}

export interface SessionSearchResult {
  sessions: SessionSummary[];
  nextCursor?: string;
  total?: number;
}

export interface SessionSummary {
  sessionId: string;
  appName: string;
  userId?: string;
  patientId?: string;
  practiceId?: string;
  createdAt: Date;
  updatedAt: Date;
  status: string;
  currentAgentName?: string;
  eventCount: number;
}

/**
 * Configuration for persistence implementations.
 */
export interface PersistenceConfig {
  /** Application namespace for session isolation */
  appName: string;
  /** Optional soft delete support */
  softDelete?: boolean;
}

/**
 * DynamoDB-specific configuration (for reference when implementing).
 */
export interface DynamoDBPersistenceConfig extends PersistenceConfig {
  tableName: string;
  /** OpenSearch integration for session search */
  opensearch?: {
    enabled: boolean;
    indexName?: string;
  };
}

// Re-export the built-in session services
export { InMemorySessionService } from '../session/inMemory';
export { LocalSessionService } from '../session/local';
