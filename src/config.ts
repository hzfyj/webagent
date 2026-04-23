import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { z } from "zod";
import type { SkillDefinition } from "./types";

dotenv.config();

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  HOST: z.string().min(1).default("0.0.0.0"),
  API_KEYS: z.string().min(1, "API_KEYS is required"),
  REDIS_URL: z.string().min(1, "REDIS_URL is required"),
  SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(86400),
  USER_CONCURRENCY_LIMIT: z.coerce.number().int().positive().default(3),
  CLAUDE_COMMAND: z.string().min(1).default("claude"),
  CLAUDE_MODEL: z.string().min(1).default("sonnet"),
  CLAUDE_WORKDIR: z.string().min(1).default(".runtime/claude-workdir"),
  CLAUDE_TIMEOUT_MS: z.coerce.number().int().positive().default(300000),
  CLAUDE_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(3600000),
  SKILLS_FILE: z.string().min(1).default("./skills/default-skills.json"),
});

const rawEnv = envSchema.parse(process.env);

export interface AppConfig {
  port: number;
  host: string;
  apiKeys: Set<string>;
  redisUrl: string;
  sessionTtlSeconds: number;
  userConcurrencyLimit: number;
  claudeCommand: string;
  defaultModel: string;
  claudeWorkdir: string;
  claudeTimeoutMs: number;
  claudeIdleTimeoutMs: number;
  skillsFile: string;
}

export const config: AppConfig = {
  port: rawEnv.PORT,
  host: rawEnv.HOST,
  apiKeys: new Set(
    rawEnv.API_KEYS.split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  ),
  redisUrl: rawEnv.REDIS_URL,
  sessionTtlSeconds: rawEnv.SESSION_TTL_SECONDS,
  userConcurrencyLimit: rawEnv.USER_CONCURRENCY_LIMIT,
  claudeCommand: rawEnv.CLAUDE_COMMAND,
  defaultModel: rawEnv.CLAUDE_MODEL,
  claudeWorkdir: path.resolve(rawEnv.CLAUDE_WORKDIR),
  claudeTimeoutMs: rawEnv.CLAUDE_TIMEOUT_MS,
  claudeIdleTimeoutMs: rawEnv.CLAUDE_IDLE_TIMEOUT_MS,
  skillsFile: path.resolve(rawEnv.SKILLS_FILE),
};

export function ensureRuntimeDirectories(appConfig: AppConfig): void {
  mkdirSync(appConfig.claudeWorkdir, { recursive: true });
}

const skillSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  appendSystemPrompt: z.string().min(1).optional(),
  promptPrefix: z.string().min(1).optional(),
  mcpConfigPath: z.string().min(1).optional(),
  allowedTools: z.array(z.string().min(1)).optional(),
});

export function loadSkillDefinitions(appConfig: AppConfig): SkillDefinition[] {
  if (!existsSync(appConfig.skillsFile)) {
    throw new Error(`Skills file not found: ${appConfig.skillsFile}`);
  }

  const fileContent = readFileSync(appConfig.skillsFile, "utf8");
  const parsed = JSON.parse(fileContent) as unknown;
  const skills = z.array(skillSchema).parse(parsed);

  if (skills.length === 0) {
    throw new Error("At least one skill must be configured.");
  }

  return skills.map((skill) => ({
    ...skill,
    mcpConfigPath: skill.mcpConfigPath ? path.resolve(skill.mcpConfigPath) : undefined,
  }));
}
