import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../src/errors";

const spawnMock = vi.fn();

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  kill = vi.fn(() => {
    this.emit("close", 1);
  });
}

describe("ClaudeClient", () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it("builds json CLI calls and parses the final result", async () => {
    const { ClaudeClient } = await import("../src/claude/claude-client");
    const child = new FakeChild();
    let stdinBuffer = "";
    child.stdin.on("data", (chunk) => {
      stdinBuffer += chunk.toString("utf8");
    });

    spawnMock.mockImplementation((_command, args) => {
      process.nextTick(() => {
        child.stdout.write(
          `${JSON.stringify({
            type: "system",
            subtype: "init",
            session_id: "claude-session-1",
            model: "sonnet",
          })}\n`,
        );
        child.stdout.write(
          `${JSON.stringify({
            type: "assistant",
            session_id: "claude-session-1",
            message: {
              content: [{ type: "text", text: "Hello from Claude" }],
            },
          })}\n`,
        );
        child.stdout.write(
          `${JSON.stringify({
            type: "result",
            subtype: "success",
            session_id: "claude-session-1",
            result: "Hello from Claude",
            total_cost_usd: 0.01,
            duration_ms: 100,
            duration_api_ms: 80,
            num_turns: 1,
            is_error: false,
          })}\n`,
        );
        child.stdout.end();
        child.emit("close", 0);
      });

      expect(args).toContain("--output-format");
      expect(args).toContain("stream-json");
      expect(args).toContain("--input-format");
      expect(args).toContain("--include-partial-messages");
      expect(args).toContain("--append-system-prompt");
      expect(args).toContain("--resume");
      return child;
    });

    const client = new ClaudeClient({
      command: "claude",
      defaultModel: "sonnet",
      workdir: process.cwd(),
      timeoutMs: 1000,
      idleTimeoutMs: 3600000,
    });

    const result = await client.sendMessage({
      appSessionId: "app-session-1",
      message: "Ping",
      resumeSessionId: "resume-1",
      model: "sonnet",
      requestId: "req-1",
      skill: {
        name: "general",
        description: "General",
        appendSystemPrompt: "Be helpful",
        promptPrefix: "Skill prefix",
      },
    });

    expect(stdinBuffer).toContain("\"type\":\"user\"");
    expect(stdinBuffer).toContain("Skill prefix\\n\\nPing");
    expect(result.sessionId).toBe("claude-session-1");
    expect(result.result).toBe("Hello from Claude");
    expect(result.usage.numTurns).toBe(1);
  });

  it("maps streaming SDK messages into deltas and done usage", async () => {
    const { ClaudeClient } = await import("../src/claude/claude-client");
    const child = new FakeChild();

    spawnMock.mockReturnValue(child);

    const client = new ClaudeClient({
      command: "claude",
      defaultModel: "sonnet",
      workdir: process.cwd(),
      timeoutMs: 1000,
      idleTimeoutMs: 3600000,
    });

    const events: string[] = [];
    const resultPromise = client.streamMessage(
      {
        appSessionId: "app-session-1",
        message: "Ping",
        model: "sonnet",
        requestId: "req-1",
        skill: {
          name: "general",
          description: "General",
        },
      },
      {
        onStart: (event) => events.push(`start:${event.sessionId}`),
        onDelta: (delta) => events.push(`delta:${delta}`),
        onUsage: (usage) => events.push(`usage:${usage.numTurns}`),
        onDone: (event) => events.push(`done:${event.finishReason}`),
      },
    );

    process.nextTick(() => {
      child.stdout.write(
        `${JSON.stringify({ type: "system", subtype: "init", session_id: "claude-session-2", model: "sonnet" })}\n`,
      );
      child.stdout.write(
        `${JSON.stringify({
          type: "assistant",
          session_id: "claude-session-2",
          message: {
            content: [{ type: "text", text: "Hel" }],
          },
        })}\n`,
      );
      child.stdout.write(
        `${JSON.stringify({
          type: "assistant",
          session_id: "claude-session-2",
          message: {
            content: [{ type: "text", text: "Hello" }],
          },
        })}\n`,
      );
      child.stdout.write(
        `${JSON.stringify({
          type: "result",
          subtype: "success",
          session_id: "claude-session-2",
          result: "Hello",
          total_cost_usd: 0.02,
          duration_ms: 120,
          duration_api_ms: 100,
          num_turns: 1,
          is_error: false,
        })}\n`,
      );
      child.stdout.end();
      child.emit("close", 0);
    });

    const result = await resultPromise;
    expect(result.sessionId).toBe("claude-session-2");
    expect(result.result).toBe("Hello");
    expect(events).toEqual(["start:claude-session-2", "delta:Hel", "delta:lo", "usage:1", "done:success"]);
  });

  it("wraps spawn failures as application errors", async () => {
    const { ClaudeClient } = await import("../src/claude/claude-client");
    const child = new FakeChild();

    spawnMock.mockImplementation(() => {
      process.nextTick(() => child.emit("error", new Error("spawn failed")));
      return child;
    });

    const client = new ClaudeClient({
      command: "claude",
      defaultModel: "sonnet",
      workdir: process.cwd(),
      timeoutMs: 1000,
      idleTimeoutMs: 3600000,
    });

    await expect(
      client.sendMessage({
        appSessionId: "app-session-1",
        message: "Ping",
        model: "sonnet",
        requestId: "req-1",
        skill: {
          name: "general",
          description: "General",
        },
      }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it("prewarms a persistent runtime without sending a user turn", async () => {
    const { ClaudeClient } = await import("../src/claude/claude-client");
    const child = new FakeChild();
    let stdinBuffer = "";
    child.stdin.on("data", (chunk) => {
      stdinBuffer += chunk.toString("utf8");
    });

    spawnMock.mockReturnValue(child);

    const client = new ClaudeClient({
      command: "claude",
      defaultModel: "sonnet",
      workdir: process.cwd(),
      timeoutMs: 1000,
      idleTimeoutMs: 3600000,
    });

    await client.prewarmSession({
      appSessionId: "app-session-2",
      model: "sonnet",
      skill: {
        name: "general",
        description: "General",
      },
    });

    expect(spawnMock).toHaveBeenCalledOnce();
    expect(stdinBuffer).toBe("");
  });
});
