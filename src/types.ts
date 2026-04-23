export interface SkillDefinition {
  name: string;
  description: string;
  appendSystemPrompt?: string;
  promptPrefix?: string;
  mcpConfigPath?: string;
  allowedTools?: string[];
}

export interface SessionRecord {
  sessionId: string;
  userId: string;
  claudeSessionId?: string;
  model: string;
  skillName: string;
  metadata?: Record<string, unknown>;
  title: string;
  lastMessagePreview: string;
  lastMessageAt?: string;
  messageCount: number;
  messages: SessionMessage[];
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

export interface SessionMessage {
  role: "user" | "assistant" | "system" | "error";
  content: string;
  createdAt: string;
  meta?: Record<string, unknown>;
}

export interface ClaudeUsage {
  totalCostUsd: number;
  durationMs: number;
  durationApiMs: number;
  numTurns: number;
}

export interface ClaudeMessageResult {
  sessionId: string;
  result: string;
  subtype: string;
  usage: ClaudeUsage;
}

export interface StreamStartEvent {
  sessionId: string;
  model?: string;
}

export interface StreamDoneEvent {
  sessionId: string;
  finishReason: string;
  usage: ClaudeUsage;
  result: string;
}

export interface ClaudeMessageRequest {
  appSessionId: string;
  message: string;
  resumeSessionId?: string;
  model: string;
  skill: SkillDefinition;
  requestId: string;
}
