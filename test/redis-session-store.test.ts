import { describe, expect, it } from "vitest";
import { RedisSessionStore, type RedisLike } from "../src/sessions/redis-session-store";

class FakeRedis implements RedisLike {
  private readonly values = new Map<string, string>();
  private readonly sortedSets = new Map<string, Map<string, number>>();

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async set(...args: unknown[]): Promise<unknown> {
    const [key, value] = args as [string, string];
    if (args.includes("NX")) {
      if (this.values.has(key)) {
        return null;
      }
      this.values.set(key, value);
      return "OK";
    }

    this.values.set(key, value);
    return "OK";
  }

  async del(...keys: string[]): Promise<number> {
    let count = 0;
    for (const key of keys) {
      count += this.values.delete(key) ? 1 : 0;
      count += this.sortedSets.delete(key) ? 1 : 0;
    }
    return count;
  }

  async zadd(...args: unknown[]): Promise<unknown> {
    const [key, score, member] = args as [string, number, string];
    const bucket = this.sortedSets.get(key) ?? new Map();
    bucket.set(member, Number(score));
    this.sortedSets.set(key, bucket);
    return 1;
  }

  async zrem(...args: unknown[]): Promise<unknown> {
    const [key, member] = args as [string, string];
    const bucket = this.sortedSets.get(key);
    if (!bucket) {
      return 0;
    }
    return bucket.delete(member) ? 1 : 0;
  }

  async zrevrange(...args: unknown[]): Promise<unknown> {
    const [key] = args as [string, number, number];
    const bucket = this.sortedSets.get(key);
    if (!bucket) {
      return [];
    }
    return [...bucket.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([member]) => member);
  }

  async ping(): Promise<string> {
    return "PONG";
  }

  async quit(): Promise<unknown> {
    return "OK";
  }

  async eval(...rawArgs: unknown[]): Promise<unknown> {
    const [script, _numKeys, ...args] = rawArgs as [string, number, ...Array<string | number>];
    if (script.includes('redis.call("GET", KEYS[1]) == ARGV[1]')) {
      const key = String(args[0]);
      const value = String(args[1]);
      if (this.values.get(key) === value) {
        this.values.delete(key);
        return 1;
      }
      return 0;
    }

    if (script.includes('redis.call("EXISTS", KEYS[2]) == 1')) {
      const counterKey = String(args[0]);
      const tokenKey = String(args[1]);
      const max = Number(args[2]);

      if (this.values.has(tokenKey)) {
        return 1;
      }

      const current = Number(this.values.get(counterKey) ?? "0");
      if (current >= max) {
        return 0;
      }

      this.values.set(tokenKey, "1");
      this.values.set(counterKey, String(current + 1));
      return 1;
    }

    const counterKey = String(args[0]);
    const tokenKey = String(args[1]);

    if (!this.values.has(tokenKey)) {
      return 0;
    }

    this.values.delete(tokenKey);
    const current = Number(this.values.get(counterKey) ?? "0");
    if (current <= 1) {
      this.values.delete(counterKey);
      return 1;
    }

    this.values.set(counterKey, String(current - 1));
    return 1;
  }
}

describe("RedisSessionStore", () => {
  it("creates and saves sessions with refreshed expiry", async () => {
    const store = new RedisSessionStore(new FakeRedis(), 60);
    const session = await store.create({
      userId: "user-1",
      model: "sonnet",
      skillName: "general",
    });

    const loaded = await store.get(session.sessionId);
    expect(loaded?.userId).toBe("user-1");
    expect(loaded?.skillName).toBe("general");
    expect(loaded?.messages).toEqual([]);

    await new Promise((resolve) => setTimeout(resolve, 5));
    const saved = await store.save({
      ...session,
      claudeSessionId: "claude-session-1",
      skillName: "ops",
    });

    expect(saved.claudeSessionId).toBe("claude-session-1");
    expect(Date.parse(saved.updatedAt)).toBeGreaterThan(Date.parse(session.updatedAt));
    expect(Date.parse(saved.expiresAt)).toBeGreaterThan(Date.parse(session.expiresAt));
  });

  it("enforces session locks and user concurrency slots", async () => {
    const store = new RedisSessionStore(new FakeRedis(), 60);
    const session = await store.create({
      userId: "user-1",
      model: "sonnet",
      skillName: "general",
    });

    await expect(store.acquireSessionLock(session.sessionId, "req-1", 30)).resolves.toBe(true);
    await expect(store.acquireSessionLock(session.sessionId, "req-2", 30)).resolves.toBe(false);
    await store.releaseSessionLock(session.sessionId, "req-1");
    await expect(store.acquireSessionLock(session.sessionId, "req-2", 30)).resolves.toBe(true);

    await expect(store.acquireUserSlot("user-1", "req-1", 2, 30)).resolves.toBe(true);
    await expect(store.acquireUserSlot("user-1", "req-2", 2, 30)).resolves.toBe(true);
    await expect(store.acquireUserSlot("user-1", "req-3", 2, 30)).resolves.toBe(false);
    await store.releaseUserSlot("user-1", "req-1");
    await expect(store.acquireUserSlot("user-1", "req-3", 2, 30)).resolves.toBe(true);
  });

  it("lists sessions by user in reverse updated order", async () => {
    const store = new RedisSessionStore(new FakeRedis(), 60);
    const first = await store.create({
      userId: "user-1",
      model: "sonnet",
      skillName: "general",
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await store.create({
      userId: "user-1",
      model: "sonnet",
      skillName: "ops",
    });

    const sessions = await store.listByUser("user-1");
    expect(sessions.map((session) => session.sessionId)).toEqual([second.sessionId, first.sessionId]);
  });
});
