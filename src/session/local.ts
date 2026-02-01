import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import type {
  Session,
  SessionService,
  CreateSessionOptions,
  Event,
} from '../types';
import { BaseSession } from './base';

type StateScope = 'user' | 'patient' | 'practice';

export class LocalSessionService implements SessionService {
  private db: Database.Database;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        app_name TEXT NOT NULL,
        data TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS shared_state (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_app ON sessions(app_name);
    `);
  }

  async createSession(
    appName: string,
    options?: CreateSessionOptions,
  ): Promise<Session> {
    const { sessionId, userId, patientId, practiceId, version } = options ?? {};

    const session = new BaseSession(appName, {
      id: sessionId,
      userId,
      patientId,
      practiceId,
      version,
    });

    this.bindSharedStates(session, { userId, patientId, practiceId });

    this.saveSession(session);
    return session;
  }

  async getSession(
    appName: string,
    sessionId: string,
  ): Promise<Session | null> {
    const row = this.db
      .prepare('SELECT data FROM sessions WHERE id = ? AND app_name = ?')
      .get(sessionId, appName) as { data: string } | undefined;

    if (!row) return null;

    const session = BaseSession.fromSnapshot(JSON.parse(row.data));
    this.bindSharedStates(session, {
      userId: session.userId,
      patientId: session.patientId,
      practiceId: session.practiceId,
    });

    return session;
  }

  async appendEvent(session: Session, event: Event): Promise<void> {
    (session as BaseSession).pushEvent(event);
    this.saveSession(session as BaseSession);
  }

  async deleteSession(appName: string, sessionId: string): Promise<void> {
    this.db
      .prepare('DELETE FROM sessions WHERE id = ? AND app_name = ?')
      .run(sessionId, appName);
  }

  async getUserState(
    appName: string,
    userId: string,
  ): Promise<Record<string, unknown>> {
    return this.getSharedState(appName, 'user', userId);
  }

  async setUserState(
    appName: string,
    userId: string,
    state: Record<string, unknown>,
  ): Promise<void> {
    this.setSharedState(appName, 'user', userId, state);
  }

  async getPatientState(
    appName: string,
    patientId: string,
  ): Promise<Record<string, unknown>> {
    return this.getSharedState(appName, 'patient', patientId);
  }

  async setPatientState(
    appName: string,
    patientId: string,
    state: Record<string, unknown>,
  ): Promise<void> {
    this.setSharedState(appName, 'patient', patientId, state);
  }

  async getPracticeState(
    appName: string,
    practiceId: string,
  ): Promise<Record<string, unknown>> {
    return this.getSharedState(appName, 'practice', practiceId);
  }

  async setPracticeState(
    appName: string,
    practiceId: string,
    state: Record<string, unknown>,
  ): Promise<void> {
    this.setSharedState(appName, 'practice', practiceId, state);
  }

  bindSessionScope(session: BaseSession, scope: StateScope, id: string): void {
    if (scope === 'user') session.userId = id;
    else if (scope === 'patient') session.patientId = id;
    else session.practiceId = id;

    this.bindScope(session, scope, id);
  }

  save(session: BaseSession): void {
    this.saveSession(session);
  }

  list(appName: string): Array<{ id: string; updatedAt: number }> {
    const rows = this.db
      .prepare(
        'SELECT id, updated_at FROM sessions WHERE app_name = ? ORDER BY updated_at DESC',
      )
      .all(appName) as Array<{ id: string; updated_at: number }>;

    return rows.map((r) => ({ id: r.id, updatedAt: r.updated_at }));
  }

  close(): void {
    this.db.close();
  }

  private saveSession(session: BaseSession): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO sessions (id, app_name, data, updated_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(
        session.id,
        session.appName,
        JSON.stringify(session.toJSON()),
        Date.now(),
      );
  }

  private stateKey(appName: string, scope: StateScope, id: string): string {
    return `${appName}:${scope}:${id}`;
  }

  private getSharedState(
    appName: string,
    scope: StateScope,
    id: string,
  ): Record<string, unknown> {
    const key = this.stateKey(appName, scope, id);
    const row = this.db
      .prepare('SELECT data FROM shared_state WHERE id = ?')
      .get(key) as { data: string } | undefined;

    return row ? JSON.parse(row.data) : {};
  }

  private setSharedState(
    appName: string,
    scope: StateScope,
    id: string,
    state: Record<string, unknown>,
  ): void {
    const key = this.stateKey(appName, scope, id);
    this.db
      .prepare('INSERT OR REPLACE INTO shared_state (id, data) VALUES (?, ?)')
      .run(key, JSON.stringify(state));
  }

  private bindScope(session: BaseSession, scope: StateScope, id: string): void {
    const state = this.getSharedState(session.appName, scope, id);
    session.bindSharedState(scope, state, (key, value) => {
      const current = this.getSharedState(session.appName, scope, id);
      if (value === undefined) {
        delete current[key];
      } else {
        current[key] = value;
      }
      this.setSharedState(session.appName, scope, id, current);
    });
  }

  private bindSharedStates(
    session: BaseSession,
    ids: { userId?: string; patientId?: string; practiceId?: string },
  ): void {
    if (ids.userId) this.bindScope(session, 'user', ids.userId);
    if (ids.patientId) this.bindScope(session, 'patient', ids.patientId);
    if (ids.practiceId) this.bindScope(session, 'practice', ids.practiceId);
  }
}
