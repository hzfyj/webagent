import Redis from "ioredis";
import { buildApp } from "./app";
import { ClaudeClient } from "./claude/claude-client";
import { config, ensureRuntimeDirectories, loadSkillDefinitions } from "./config";
import { SkillCatalog } from "./skills/catalog";
import { RedisSessionStore } from "./sessions/redis-session-store";

async function main(): Promise<void> {
  ensureRuntimeDirectories(config);

  const redis = new Redis(config.redisUrl, {
    lazyConnect: false,
    maxRetriesPerRequest: 1,
    enableAutoPipelining: true,
  });
  const sessionStore = new RedisSessionStore(redis, config.sessionTtlSeconds);
  const skillCatalog = new SkillCatalog(loadSkillDefinitions(config));
  const claudeClient = new ClaudeClient({
    command: config.claudeCommand,
    defaultModel: config.defaultModel,
    workdir: config.claudeWorkdir,
    timeoutMs: config.claudeTimeoutMs,
    idleTimeoutMs: config.claudeIdleTimeoutMs,
  });

  const app = buildApp({
    config,
    sessionStore,
    skillCatalog,
    claudeClient,
  });

  app.addHook("onClose", async () => {
    await claudeClient.closeAll();
    await sessionStore.disconnect();
  });

  await app.listen({
    port: config.port,
    host: config.host,
  });

  app.log.info(
    {
      host: config.host,
      port: config.port,
      skills: skillCatalog.list().map((skill) => skill.name),
    },
    "Claude CLI gateway started",
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
