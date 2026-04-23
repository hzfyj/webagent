import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app";
import { SkillCatalog } from "../src/skills/catalog";
import type { AppConfig } from "../src/config";
import type { SessionStore } from "../src/sessions/session-store";
import type { SessionRecord, SkillDefinition } from "../src/types";

class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly sessionLocks = new Set<string>();
  private readonly userCounts = new Map<string, number>();

  constructor(private readonly ttlSeconds: number) {}

  async create(input: {
    userId: string;
    model: string;
    skillName: string;
    metadata?: Record<string, unknown>;
  }): Promise<SessionRecord> {
    const now = new Date();
    const session: SessionRecord = {
      sessionId: randomUUID(),
      userId: input.userId,
      model: input.model,
      skillName: input.skillName,
      metadata: input.metadata,
      title: `${input.skillName} session`,
      lastMessagePreview: "",
      messageCount: 0,
      messages: [],
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.ttlSeconds * 1000).toISOString(),
    };
    this.sessions.set(session.sessionId, session);
    return session;
  }

  async get(sessionId: string): Promise<SessionRecord | null> {
    return this.sessions.get(sessionId) ?? null;
  }

  async listByUser(userId: string): Promise<SessionRecord[]> {
    return [...this.sessions.values()]
      .filter((session) => session.userId === userId)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }

  async save(session: SessionRecord): Promise<SessionRecord> {
    const now = new Date();
    const saved = {
      ...session,
      updatedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.ttlSeconds * 1000).toISOString(),
    };
    this.sessions.set(saved.sessionId, saved);
    return saved;
  }

  async delete(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }

  async acquireSessionLock(sessionId: string, _requestId: string, _ttlSeconds: number): Promise<boolean> {
    if (this.sessionLocks.has(sessionId)) {
      return false;
    }
    this.sessionLocks.add(sessionId);
    return true;
  }

  async releaseSessionLock(sessionId: string, _requestId: string): Promise<void> {
    this.sessionLocks.delete(sessionId);
  }

  async acquireUserSlot(userId: string, _requestId: string, maxConcurrent: number): Promise<boolean> {
    const current = this.userCounts.get(userId) ?? 0;
    if (current >= maxConcurrent) {
      return false;
    }
    this.userCounts.set(userId, current + 1);
    return true;
  }

  async releaseUserSlot(userId: string, _requestId: string): Promise<void> {
    const current = this.userCounts.get(userId) ?? 0;
    if (current <= 1) {
      this.userCounts.delete(userId);
      return;
    }
    this.userCounts.set(userId, current - 1);
  }

  async ping(): Promise<void> {}

  async disconnect(): Promise<void> {}
}

class FakeClaudeClient {
  public readonly prewarmSession = vi.fn();
  public readonly sendMessage = vi.fn();
  public readonly streamMessage = vi.fn();
  public readonly checkHealth = vi.fn();
  public readonly closeSession = vi.fn();
}

describe("buildApp", () => {
  const skills: SkillDefinition[] = [
    {
      name: "general",
      description: "General assistant",
      appendSystemPrompt: "Be helpful",
    },
    {
      name: "ops",
      description: "Ops assistant",
    },
  ];

  const config: AppConfig = {
    port: 8080,
    host: "127.0.0.1",
    apiKeys: new Set(["test-key"]),
    redisUrl: "redis://localhost:6379",
    sessionTtlSeconds: 60,
    userConcurrencyLimit: 3,
    claudeCommand: "claude",
    defaultModel: "sonnet",
    claudeWorkdir: process.cwd(),
    claudeTimeoutMs: 300000,
    claudeIdleTimeoutMs: 3600000,
    skillsFile: "",
  };

  let store: InMemorySessionStore;
  let claudeClient: FakeClaudeClient;

  beforeEach(() => {
    store = new InMemorySessionStore(config.sessionTtlSeconds);
    claudeClient = new FakeClaudeClient();
    claudeClient.checkHealth.mockResolvedValue(undefined);
    claudeClient.prewarmSession.mockResolvedValue(undefined);
    claudeClient.closeSession.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  function makeApp() {
    return buildApp({
      config,
      sessionStore: store,
      skillCatalog: new SkillCatalog(skills),
      claudeClient: claudeClient as never,
    });
  }

  it("creates sessions and lists allowed skills", async () => {
    const app = makeApp();
    const skillResponse = await app.inject({
      method: "GET",
      url: "/api/v1/skills",
      headers: {
        "x-api-key": "test-key",
        "x-user-id": "user-1",
      },
    });

    expect(skillResponse.statusCode).toBe(200);
    expect(skillResponse.json().skills).toHaveLength(2);

    const createResponse = await app.inject({
      method: "POST",
      url: "/api/v1/sessions",
      headers: {
        "x-api-key": "test-key",
        "x-user-id": "user-1",
      },
      payload: {
        skill: "ops",
      },
    });

    expect(createResponse.statusCode).toBe(200);
    expect(createResponse.json().skill).toBe("ops");
    expect(claudeClient.prewarmSession).toHaveBeenCalledOnce();
    expect(claudeClient.prewarmSession).toHaveBeenCalledWith(
      expect.objectContaining({
        appSessionId: createResponse.json().sessionId,
        model: "sonnet",
      }),
    );

    const sessionsResponse = await app.inject({
      method: "GET",
      url: "/api/v1/sessions",
      headers: {
        "x-api-key": "test-key",
        "x-user-id": "user-1",
      },
    });

    expect(sessionsResponse.statusCode).toBe(200);
    expect(sessionsResponse.json().sessions).toHaveLength(1);
    await app.close();
  });

  it("does not fail session creation when prewarm fails", async () => {
    const app = makeApp();
    claudeClient.prewarmSession.mockRejectedValueOnce(new Error("prewarm failed"));

    const createResponse = await app.inject({
      method: "POST",
      url: "/api/v1/sessions",
      headers: {
        "x-api-key": "test-key",
        "x-user-id": "user-1",
      },
      payload: {
        skill: "general",
      },
    });

    expect(createResponse.statusCode).toBe(200);
    expect(claudeClient.prewarmSession).toHaveBeenCalledOnce();
    await app.close();
  });

  it("rejects invalid API keys and skills", async () => {
    const app = makeApp();
    const unauthorized = await app.inject({
      method: "GET",
      url: "/api/v1/skills",
    });
    expect(unauthorized.statusCode).toBe(401);

    const invalidSkill = await app.inject({
      method: "POST",
      url: "/api/v1/sessions",
      headers: {
        "x-api-key": "test-key",
        "x-user-id": "user-1",
      },
      payload: {
        skill: "secret",
      },
    });
    expect(invalidSkill.statusCode).toBe(400);
    await app.close();
  });

  it("returns JSON replies and persists Claude session ids", async () => {
    const app = makeApp();
    const session = await store.create({
      userId: "user-1",
      model: "sonnet",
      skillName: "general",
    });

    claudeClient.sendMessage.mockResolvedValue({
      sessionId: "claude-session-1",
      result: "Hello there",
      subtype: "success",
      usage: {
        totalCostUsd: 0.01,
        durationMs: 100,
        durationApiMs: 80,
        numTurns: 1,
      },
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${session.sessionId}/messages`,
      headers: {
        "x-api-key": "test-key",
        "x-user-id": "user-1",
      },
      payload: {
        message: "Hello",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().content).toBe("Hello there");
    expect(claudeClient.sendMessage).toHaveBeenCalledOnce();
    expect((await store.get(session.sessionId))?.claudeSessionId).toBe("claude-session-1");
    await app.close();
  });

  it("returns 409 when the session is already busy", async () => {
    const app = makeApp();
    const session = await store.create({
      userId: "user-1",
      model: "sonnet",
      skillName: "general",
    });
    await store.acquireSessionLock(session.sessionId, "req-locked", 60);

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${session.sessionId}/messages`,
      headers: {
        "x-api-key": "test-key",
        "x-user-id": "user-1",
      },
      payload: {
        message: "Hello",
      },
    });

    expect(response.statusCode).toBe(409);
    await app.close();
  });

  it("streams SSE events and saves the resumed Claude session id", async () => {
    const app = makeApp();
    const session = await store.create({
      userId: "user-1",
      model: "sonnet",
      skillName: "general",
    });

    claudeClient.streamMessage.mockImplementation(async (_input, handlers) => {
      handlers.onStart({ sessionId: "claude-session-2", model: "sonnet" });
      handlers.onDelta("Hel");
      handlers.onDelta("lo");
      handlers.onUsage({
        totalCostUsd: 0.02,
        durationMs: 120,
        durationApiMs: 100,
        numTurns: 1,
      });
      handlers.onDone({
        sessionId: "claude-session-2",
        finishReason: "success",
        usage: {
          totalCostUsd: 0.02,
          durationMs: 120,
          durationApiMs: 100,
          numTurns: 1,
        },
        result: "Hello",
      });

      return {
        sessionId: "claude-session-2",
        result: "Hello",
        subtype: "success",
        usage: {
          totalCostUsd: 0.02,
          durationMs: 120,
          durationApiMs: 100,
          numTurns: 1,
        },
      };
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${session.sessionId}/messages/stream`,
      headers: {
        "x-api-key": "test-key",
        "x-user-id": "user-1",
      },
      payload: {
        message: "Hello",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("event: delta");
    expect(response.body).toContain("\"delta\":\"Hel\"");
    expect(response.body).toContain("event: done");
    expect((await store.get(session.sessionId))?.claudeSessionId).toBe("claude-session-2");
    await app.close();
  });

  it("returns unhealthy readiness when dependencies fail", async () => {
    const app = makeApp();
    claudeClient.checkHealth.mockRejectedValue(new Error("claude down"));

    const response = await app.inject({
      method: "GET",
      url: "/readyz",
    });

    expect(response.statusCode).toBe(503);
    await app.close();
  });

  it("allows local UI requests without an API key", async () => {
    const app = makeApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/skills",
      headers: {
        "x-user-id": "user-1",
        "x-ui-request": "1",
      },
    });

    expect(response.statusCode).toBe(200);
    await app.close();
  });
});
