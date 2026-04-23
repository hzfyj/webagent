import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z, ZodError } from "zod";
import { AppError, isAppError } from "./errors";
import type { AppConfig } from "./config";
import { SkillCatalog } from "./skills/catalog";
import type { SessionStore } from "./sessions/session-store";
import type { ClaudeClient } from "./claude/claude-client";
import type { SessionMessage, SessionRecord } from "./types";

declare module "fastify" {
  interface FastifyRequest {
    authContext: {
      userId: string;
      traceId?: string;
    };
  }
}

const createSessionSchema = z.object({
  skill: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const messageSchema = z.object({
  message: z.string().trim().min(1),
  skill: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
});

export interface AppDependencies {
  config: AppConfig;
  sessionStore: SessionStore;
  skillCatalog: SkillCatalog;
  claudeClient: ClaudeClient;
}

export function buildApp(deps: AppDependencies): FastifyInstance {
  const app = Fastify({
    logger: true,
    disableRequestLogging: true,
    genReqId: (request) => request.headers["x-trace-id"]?.toString() ?? randomUUID(),
  });

  app.decorateRequest("authContext", undefined as unknown as FastifyRequest["authContext"]);

  app.addHook("onRequest", async (request) => {
    (request as FastifyRequest & { startedAt: number }).startedAt = Date.now();
  });

  app.addHook("onResponse", async (request, reply) => {
    const startedAt = (request as FastifyRequest & { startedAt?: number }).startedAt ?? Date.now();
    request.log.info({
      requestId: request.id,
      userId: request.authContext?.userId,
      traceId: request.headers["x-trace-id"],
      sessionId: (request.params as Record<string, unknown>)?.sessionId,
      method: request.method,
      url: request.url,
      statusCode: reply.statusCode,
      durationMs: Date.now() - startedAt,
    });
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      reply.status(400).send({
        error: {
          code: "invalid_request",
          message: "Request validation failed.",
          details: error.flatten(),
        },
        requestId: request.id,
      });
      return;
    }

    if (isAppError(error)) {
      reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          details: error.details,
        },
        requestId: request.id,
      });
      return;
    }

    request.log.error({ err: error }, "Unhandled application error");
    reply.status(500).send({
      error: {
        code: "internal_error",
        message: "Internal server error.",
      },
      requestId: request.id,
    });
  });

  const publicDir = path.resolve(process.cwd(), "public");

  app.get("/", async (_request, reply) => {
    return sendPublicAsset(reply, publicDir, "index.html", "text/html; charset=utf-8");
  });

  app.get("/app.js", async (_request, reply) => {
    return sendPublicAsset(reply, publicDir, "app.js", "application/javascript; charset=utf-8");
  });

  app.get("/styles.css", async (_request, reply) => {
    return sendPublicAsset(reply, publicDir, "styles.css", "text/css; charset=utf-8");
  });

  app.get("/livez", async () => ({ ok: true }));

  app.get("/readyz", async (_request, reply) => {
    try {
      await Promise.all([deps.sessionStore.ping(), deps.claudeClient.checkHealth()]);
      return { ok: true };
    } catch (error) {
      reply.status(503);
      throw new AppError(503, "dependency_unhealthy", "Readiness checks failed.", error);
    }
  });

  app.addHook("preHandler", async (request) => {
    if (!request.url.startsWith("/api/v1/")) {
      return;
    }

    const apiKey = request.headers["x-api-key"]?.toString();
    const userId = request.headers["x-user-id"]?.toString();
    const traceId = request.headers["x-trace-id"]?.toString();
    const uiRequest = request.headers["x-ui-request"]?.toString() === "1";

    const localRequest = isLocalRequest(request);
    if ((!apiKey || !deps.config.apiKeys.has(apiKey)) && !(localRequest && uiRequest)) {
      throw new AppError(401, "unauthorized", "Missing or invalid API key.");
    }

    if (!userId) {
      throw new AppError(400, "missing_user_id", "Missing X-User-Id header.");
    }

    request.authContext = { userId, traceId };
  });

  app.get("/api/v1/skills", async () => {
    return {
      skills: deps.skillCatalog.list().map((skill) => ({
        name: skill.name,
        description: skill.description,
      })),
    };
  });

  app.get("/api/v1/sessions", async (request) => {
    const sessions = await deps.sessionStore.listByUser(request.authContext.userId);
    return {
      sessions: sessions.map((session) => ({
        sessionId: session.sessionId,
        title: session.title,
        skill: session.skillName,
        model: session.model,
        lastMessagePreview: session.lastMessagePreview,
        lastMessageAt: session.lastMessageAt,
        messageCount: session.messageCount,
        updatedAt: session.updatedAt,
        createdAt: session.createdAt,
      })),
    };
  });

  app.post("/api/v1/sessions", async (request) => {
    const body = createSessionSchema.parse(request.body ?? {});
    const skill = deps.skillCatalog.resolve(body.skill);
    const model = body.model ?? deps.config.defaultModel;

    const session = await deps.sessionStore.create({
      userId: request.authContext.userId,
      model,
      skillName: skill.name,
      metadata: body.metadata,
    });

    void deps.claudeClient
      .prewarmSession({
        appSessionId: session.sessionId,
        model: session.model,
        skill,
        resumeSessionId: session.claudeSessionId,
      })
      .catch((error) => {
        request.log.warn(
          {
            err: error,
            sessionId: session.sessionId,
            userId: request.authContext.userId,
          },
          "Claude session prewarm failed",
        );
      });

    return {
      sessionId: session.sessionId,
      expiresAt: session.expiresAt,
      skill: session.skillName,
      model: session.model,
    };
  });

  app.get("/api/v1/sessions/:sessionId", async (request) => {
    const session = await requireOwnedSession(request, deps.sessionStore);
    return {
      sessionId: session.sessionId,
      skill: session.skillName,
      model: session.model,
      title: session.title,
      lastMessagePreview: session.lastMessagePreview,
      lastMessageAt: session.lastMessageAt,
      messageCount: session.messageCount,
      messages: session.messages,
      updatedAt: session.updatedAt,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
    };
  });

  app.delete("/api/v1/sessions/:sessionId", async (request) => {
    const session = await requireOwnedSession(request, deps.sessionStore);
    await deps.claudeClient.closeSession(session.sessionId);
    await deps.sessionStore.delete(session.sessionId);
    return { ok: true };
  });

  app.post("/api/v1/sessions/:sessionId/messages", async (request) => {
    const session = await requireOwnedSession(request, deps.sessionStore);
    const body = messageSchema.parse(request.body ?? {});
    const skill = deps.skillCatalog.resolve(body.skill ?? session.skillName);
    const model = body.model ?? session.model;
    const requestId = request.id;

    await acquireGuardsOrThrow({
      session,
      requestId,
      sessionStore: deps.sessionStore,
      userConcurrencyLimit: deps.config.userConcurrencyLimit,
      ttlSeconds: deps.config.sessionTtlSeconds,
    });

    try {
      const result = await deps.claudeClient.sendMessage({
        appSessionId: session.sessionId,
        message: body.message,
        resumeSessionId: session.claudeSessionId,
        model,
        skill,
        requestId,
      });

      const saved = await deps.sessionStore.save({
        ...session,
        claudeSessionId: result.sessionId,
        model,
        skillName: skill.name,
        ...appendConversation(session, body.message, result.result),
      });

      return {
        messageId: randomUUID(),
        sessionId: saved.sessionId,
        content: result.result,
        usage: result.usage,
        finishReason: result.subtype,
      };
    } finally {
      await releaseGuards({
        session,
        requestId,
        sessionStore: deps.sessionStore,
      });
    }
  });

  app.post("/api/v1/sessions/:sessionId/messages/stream", async (request, reply) => {
    const session = await requireOwnedSession(request, deps.sessionStore);
    const body = messageSchema.parse(request.body ?? {});
    const skill = deps.skillCatalog.resolve(body.skill ?? session.skillName);
    const model = body.model ?? session.model;
    const requestId = request.id;

    await acquireGuardsOrThrow({
      session,
      requestId,
      sessionStore: deps.sessionStore,
      userConcurrencyLimit: deps.config.userConcurrencyLimit,
      ttlSeconds: deps.config.sessionTtlSeconds,
    });

    const abortController = new AbortController();
    const release = async () => {
      await releaseGuards({
        session,
        requestId,
        sessionStore: deps.sessionStore,
      });
    };

    request.raw.on("close", () => {
      if (request.raw.aborted) {
        abortController.abort();
      }
    });

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    reply.hijack();

    const sendEvent = (event: string, data: unknown): void => {
      reply.raw.write(`event: ${event}\n`);
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    sendEvent("start", {
      requestId,
      sessionId: session.sessionId,
      skill: skill.name,
      model,
    });

    try {
      const result = await deps.claudeClient.streamMessage(
        {
          appSessionId: session.sessionId,
          message: body.message,
          resumeSessionId: session.claudeSessionId,
          model,
          skill,
          requestId,
        },
        {
          onStart: (event) => {
            sendEvent("start", {
              requestId,
              sessionId: session.sessionId,
              claudeSessionId: event.sessionId,
              skill: skill.name,
              model: event.model ?? model,
            });
          },
          onDelta: (delta) => {
            sendEvent("delta", { delta });
          },
          onUsage: (usage) => {
            sendEvent("usage", usage);
          },
          onDone: (event) => {
            sendEvent("done", {
              sessionId: session.sessionId,
              claudeSessionId: event.sessionId,
              finishReason: event.finishReason,
              usage: event.usage,
            });
          },
        },
        abortController.signal,
      );

      await deps.sessionStore.save({
        ...session,
        claudeSessionId: result.sessionId,
        model,
        skillName: skill.name,
        ...appendConversation(session, body.message, result.result),
      });
    } catch (error) {
      const appError = isAppError(error)
        ? error
        : new AppError(500, "stream_failed", "Streaming request failed.", error);
      sendEvent("error", {
        code: appError.code,
        message: appError.message,
      });
    } finally {
      await release();
      reply.raw.end();
    }
  });

  return app;
}

function isLocalRequest(request: FastifyRequest): boolean {
  return request.ip === "127.0.0.1" || request.ip === "::1" || request.hostname === "127.0.0.1";
}

function appendConversation(session: SessionRecord, userMessage: string, assistantMessage: string) {
  const now = new Date().toISOString();
  const title = session.messageCount === 0 ? truncateForPreview(userMessage, 48) : session.title;
  const nextMessages: SessionMessage[] = [
    ...session.messages,
    { role: "user", content: userMessage, createdAt: now },
    { role: "assistant", content: assistantMessage, createdAt: now },
  ];

  return {
    title,
    lastMessagePreview: truncateForPreview(assistantMessage, 120),
    lastMessageAt: now,
    messageCount: nextMessages.length,
    messages: nextMessages,
  };
}

function truncateForPreview(value: string, maxLength: number): string {
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(0, maxLength - 1))}…`;
}

function sendPublicAsset(
  reply: FastifyReply,
  publicDir: string,
  fileName: string,
  contentType: string,
) {
  const filePath = path.join(publicDir, fileName);
  if (!existsSync(filePath)) {
    throw new AppError(404, "asset_not_found", `Public asset ${fileName} was not found.`);
  }

  reply.header("Content-Type", contentType);
  reply.header("Cache-Control", "no-store");
  return reply.send(readFileSync(filePath, "utf8"));
}

async function requireOwnedSession(
  request: FastifyRequest,
  sessionStore: SessionStore,
): Promise<SessionRecord> {
  const sessionId = z.string().uuid().parse((request.params as Record<string, unknown>).sessionId);
  const session = await sessionStore.get(sessionId);

  if (!session || session.userId !== request.authContext.userId) {
    throw new AppError(404, "session_not_found", "Session was not found.");
  }

  return session;
}

async function acquireGuardsOrThrow(input: {
  session: SessionRecord;
  requestId: string;
  sessionStore: SessionStore;
  userConcurrencyLimit: number;
  ttlSeconds: number;
}): Promise<void> {
  const userSlot = await input.sessionStore.acquireUserSlot(
    input.session.userId,
    input.requestId,
    input.userConcurrencyLimit,
    input.ttlSeconds,
  );

  if (!userSlot) {
    throw new AppError(429, "too_many_requests", "User concurrency limit exceeded.");
  }

  const sessionLock = await input.sessionStore.acquireSessionLock(
    input.session.sessionId,
    input.requestId,
    input.ttlSeconds,
  );

  if (!sessionLock) {
    await input.sessionStore.releaseUserSlot(input.session.userId, input.requestId);
    throw new AppError(409, "session_busy", "Another request is already running for this session.");
  }
}

async function releaseGuards(input: {
  session: SessionRecord;
  requestId: string;
  sessionStore: SessionStore;
}): Promise<void> {
  await Promise.all([
    input.sessionStore.releaseSessionLock(input.session.sessionId, input.requestId),
    input.sessionStore.releaseUserSlot(input.session.userId, input.requestId),
  ]);
}
