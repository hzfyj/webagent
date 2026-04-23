import type { SessionRecord } from "../types";

export interface SessionStore {
  create(input: {
    userId: string;
    model: string;
    skillName: string;
    metadata?: Record<string, unknown>;
  }): Promise<SessionRecord>;
  get(sessionId: string): Promise<SessionRecord | null>;
  listByUser(userId: string): Promise<SessionRecord[]>;
  save(session: SessionRecord): Promise<SessionRecord>;
  delete(sessionId: string): Promise<void>;
  acquireSessionLock(sessionId: string, requestId: string, ttlSeconds: number): Promise<boolean>;
  releaseSessionLock(sessionId: string, requestId: string): Promise<void>;
  acquireUserSlot(
    userId: string,
    requestId: string,
    maxConcurrent: number,
    ttlSeconds: number,
  ): Promise<boolean>;
  releaseUserSlot(userId: string, requestId: string): Promise<void>;
  ping(): Promise<void>;
  disconnect(): Promise<void>;
}
