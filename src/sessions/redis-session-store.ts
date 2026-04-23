import { randomUUID } from "node:crypto";
import type { SessionStore } from "./session-store";
import type { SessionRecord } from "../types";

const RELEASE_LOCK_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`;

const ACQUIRE_USER_SLOT_SCRIPT = `
if redis.call("EXISTS", KEYS[2]) == 1 then
  return 1
end
local current = tonumber(redis.call("GET", KEYS[1]) or "0")
local limit = tonumber(ARGV[1])
if current >= limit then
  return 0
end
redis.call("SET", KEYS[2], "1", "EX", ARGV[2])
redis.call("INCR", KEYS[1])
redis.call("EXPIRE", KEYS[1], ARGV[2])
return 1
`;

const RELEASE_USER_SLOT_SCRIPT = `
if redis.call("EXISTS", KEYS[2]) == 0 then
  return 0
end
redis.call("DEL", KEYS[2])
local current = tonumber(redis.call("GET", KEYS[1]) or "0")
if current <= 1 then
  redis.call("DEL", KEYS[1])
  return 1
end
redis.call("DECR", KEYS[1])
return 1
`;

export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(...args: unknown[]): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
  zadd(...args: unknown[]): Promise<unknown>;
  zrem(...args: unknown[]): Promise<unknown>;
  zrevrange(...args: unknown[]): Promise<unknown>;
  ping(): Promise<string>;
  quit(): Promise<unknown>;
  eval(...args: unknown[]): Promise<unknown>;
}

export class RedisSessionStore implements SessionStore {
  constructor(
    private readonly redis: RedisLike,
    private readonly ttlSeconds: number,
    private readonly namespace = "claude-gateway",
  ) {}

  async create(input: {
    userId: string;
    model: string;
    skillName: string;
    metadata?: Record<string, unknown>;
  }): Promise<SessionRecord> {
    const now = new Date();
    const session = this.buildSession({
      sessionId: randomUUID(),
      userId: input.userId,
      model: input.model,
      skillName: input.skillName,
      metadata: input.metadata,
      title: `${input.skillName} session`,
      lastMessagePreview: "",
      messageCount: 0,
      messages: [],
      createdAt: now,
      updatedAt: now,
    });
    await this.persist(session);
    return session;
  }

  async get(sessionId: string): Promise<SessionRecord | null> {
    const payload = await this.redis.get(this.sessionKey(sessionId));
    if (!payload) {
      return null;
    }

    return JSON.parse(payload) as SessionRecord;
  }

  async save(session: SessionRecord): Promise<SessionRecord> {
    const saved = this.buildSession({
      ...session,
      createdAt: new Date(session.createdAt),
      updatedAt: new Date(),
    });
    await this.persist(saved);
    return saved;
  }

  async listByUser(userId: string): Promise<SessionRecord[]> {
    const sessionIds = (await this.redis.zrevrange(this.userSessionsKey(userId), 0, -1)) as string[] | null;
    if (!sessionIds || sessionIds.length === 0) {
      return [];
    }

    const sessions = await Promise.all(sessionIds.map((sessionId) => this.get(sessionId)));
    return sessions.filter((session): session is SessionRecord => Boolean(session));
  }

  async delete(sessionId: string): Promise<void> {
    const existing = await this.get(sessionId);
    await this.redis.del(this.sessionKey(sessionId), this.sessionLockKey(sessionId));
    if (existing) {
      await this.redis.zrem(this.userSessionsKey(existing.userId), sessionId);
    }
  }

  async acquireSessionLock(
    sessionId: string,
    requestId: string,
    ttlSeconds: number,
  ): Promise<boolean> {
    const result = await this.redis.set(
      this.sessionLockKey(sessionId),
      requestId,
      "EX",
      ttlSeconds,
      "NX",
    );
    return result === "OK";
  }

  async releaseSessionLock(sessionId: string, requestId: string): Promise<void> {
    await this.redis.eval(RELEASE_LOCK_SCRIPT, 1, this.sessionLockKey(sessionId), requestId);
  }

  async acquireUserSlot(
    userId: string,
    requestId: string,
    maxConcurrent: number,
    ttlSeconds: number,
  ): Promise<boolean> {
    const result = Number(
      await this.redis.eval(
        ACQUIRE_USER_SLOT_SCRIPT,
        2,
        this.userCounterKey(userId),
        this.userTokenKey(userId, requestId),
        maxConcurrent,
        ttlSeconds,
      ),
    );
    return result === 1;
  }

  async releaseUserSlot(userId: string, requestId: string): Promise<void> {
    await this.redis.eval(
      RELEASE_USER_SLOT_SCRIPT,
      2,
      this.userCounterKey(userId),
      this.userTokenKey(userId, requestId),
    );
  }

  async ping(): Promise<void> {
    await this.redis.ping();
  }

  async disconnect(): Promise<void> {
    await this.redis.quit();
  }

  private async persist(session: SessionRecord): Promise<void> {
    await this.redis.set(this.sessionKey(session.sessionId), JSON.stringify(session), "EX", this.ttlSeconds);
    await this.redis.zadd(
      this.userSessionsKey(session.userId),
      Date.parse(session.updatedAt),
      session.sessionId,
    );
  }

  private buildSession(input: {
    sessionId: string;
    userId: string;
    model: string;
    skillName: string;
    metadata?: Record<string, unknown>;
    claudeSessionId?: string;
    title: string;
    lastMessagePreview: string;
    lastMessageAt?: string;
    messageCount: number;
    messages: SessionRecord["messages"];
    createdAt: Date;
    updatedAt: Date;
  }): SessionRecord {
    const expiresAt = new Date(input.updatedAt.getTime() + this.ttlSeconds * 1000);
    return {
      sessionId: input.sessionId,
      userId: input.userId,
      claudeSessionId: input.claudeSessionId,
      model: input.model,
      skillName: input.skillName,
      metadata: input.metadata,
      title: input.title,
      lastMessagePreview: input.lastMessagePreview,
      lastMessageAt: input.lastMessageAt,
      messageCount: input.messageCount,
      messages: input.messages,
      createdAt: input.createdAt.toISOString(),
      updatedAt: input.updatedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };
  }

  private sessionKey(sessionId: string): string {
    return `${this.namespace}:session:${sessionId}`;
  }

  private sessionLockKey(sessionId: string): string {
    return `${this.namespace}:session-lock:${sessionId}`;
  }

  private userCounterKey(userId: string): string {
    return `${this.namespace}:user-counter:${userId}`;
  }

  private userTokenKey(userId: string, requestId: string): string {
    return `${this.namespace}:user-token:${userId}:${requestId}`;
  }

  private userSessionsKey(userId: string): string {
    return `${this.namespace}:user-sessions:${userId}`;
  }
}
