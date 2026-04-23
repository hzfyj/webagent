import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import readline, { type Interface as ReadLineInterface } from "node:readline";
import { AppError } from "../errors";
import type {
  ClaudeMessageRequest,
  ClaudeMessageResult,
  ClaudeUsage,
  SkillDefinition,
  StreamDoneEvent,
  StreamStartEvent,
} from "../types";

export interface ClaudeClientConfig {
  command: string;
  defaultModel: string;
  workdir: string;
  timeoutMs: number;
  idleTimeoutMs: number;
}

export interface ClaudeStreamHandlers {
  onStart(event: StreamStartEvent): void;
  onDelta(delta: string): void;
  onUsage(usage: ClaudeUsage): void;
  onDone(event: StreamDoneEvent): void;
}

type SdkMessage =
  | {
      type: "system";
      subtype: "init";
      session_id: string;
      model?: string;
    }
  | {
      type: "user";
      session_id: string;
      message: {
        content?: Array<{ type?: string; text?: string }>;
      };
    }
  | {
      type: "assistant";
      session_id: string;
      message: {
        content?: Array<{ type?: string; text?: string }>;
      };
    }
  | {
      type: "result";
      subtype: string;
      session_id: string;
      is_error: boolean;
      result?: string;
      total_cost_usd: number;
      duration_ms: number;
      duration_api_ms: number;
      num_turns: number;
    };

interface RuntimeRequest {
  input: ClaudeMessageRequest;
  handlers?: ClaudeStreamHandlers;
  resolve: (result: ClaudeMessageResult) => void;
  reject: (error: AppError) => void;
  timeoutId: NodeJS.Timeout;
  abortHandler?: () => void;
  signal?: AbortSignal;
  started: boolean;
  resolvedSessionId: string;
  resolvedModel: string;
  finalResult: string;
  finalSubtype: string;
  lastAssistantText: string;
  usage?: ClaudeUsage;
}

interface RuntimeSession {
  appSessionId: string;
  signature: string;
  child: ChildProcessWithoutNullStreams;
  rl: ReadLineInterface;
  stderr: string;
  idleTimer?: NodeJS.Timeout;
  claudeSessionId?: string;
  model: string;
  current?: RuntimeRequest;
  closing: boolean;
}

export class ClaudeClient {
  private readonly sessions = new Map<string, RuntimeSession>();

  constructor(private readonly config: ClaudeClientConfig) {}

  async prewarmSession(input: {
    appSessionId: string;
    model: string;
    skill: SkillDefinition;
    resumeSessionId?: string;
  }): Promise<void> {
    const runtime = this.ensureRuntime({
      appSessionId: input.appSessionId,
      message: "",
      resumeSessionId: input.resumeSessionId,
      model: input.model,
      skill: input.skill,
      requestId: `prewarm-${input.appSessionId}`,
    });
    this.scheduleIdleClose(runtime);
  }

  async checkHealth(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = this.spawnClaudeProcess(["-v"], {
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.once("error", (error) => reject(this.wrapSpawnError(error)));
      child.once("close", (code) => {
        if (code === 0) {
          resolve();
          return;
        }
        reject(new AppError(503, "claude_unavailable", stderr || "Claude CLI is unavailable."));
      });
    });
  }

  async sendMessage(input: ClaudeMessageRequest): Promise<ClaudeMessageResult> {
    return this.runTurn(input);
  }

  async streamMessage(
    input: ClaudeMessageRequest,
    handlers: ClaudeStreamHandlers,
    signal?: AbortSignal,
  ): Promise<ClaudeMessageResult> {
    return this.runTurn(input, handlers, signal);
  }

  async closeSession(appSessionId: string): Promise<void> {
    const runtime = this.sessions.get(appSessionId);
    if (!runtime) {
      return;
    }

    this.destroyRuntime(runtime);
  }

  async closeAll(): Promise<void> {
    for (const runtime of this.sessions.values()) {
      this.destroyRuntime(runtime);
    }
    this.sessions.clear();
  }

  private async runTurn(
    input: ClaudeMessageRequest,
    handlers?: ClaudeStreamHandlers,
    signal?: AbortSignal,
  ): Promise<ClaudeMessageResult> {
    const runtime = this.ensureRuntime(input);

    if (runtime.current) {
      throw new AppError(409, "session_busy", "Claude session already has an active request.");
    }

    return new Promise<ClaudeMessageResult>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.failCurrent(runtime, new AppError(504, "claude_timeout", "Claude CLI request timed out."));
        this.destroyRuntime(runtime);
      }, this.config.timeoutMs);

      const current: RuntimeRequest = {
        input,
        handlers,
        resolve,
        reject,
        timeoutId,
        signal,
        started: false,
        resolvedSessionId: runtime.claudeSessionId ?? input.resumeSessionId ?? "",
        resolvedModel: runtime.model || input.model,
        finalResult: "",
        finalSubtype: "success",
        lastAssistantText: "",
      };

      if (signal) {
        current.abortHandler = () => {
          this.failCurrent(
            runtime,
            new AppError(499, "client_aborted", "Request was aborted by the client."),
          );
          this.destroyRuntime(runtime);
        };
        signal.addEventListener("abort", current.abortHandler, { once: true });
      }

      runtime.current = current;
      this.clearIdleTimer(runtime);

      try {
        runtime.child.stdin.write(`${this.buildInputLine(input)}\n`);
      } catch (error) {
        this.failCurrent(runtime, new AppError(503, "claude_unavailable", "Failed to write to Claude CLI.", error));
        this.destroyRuntime(runtime);
      }
    });
  }

  private ensureRuntime(input: ClaudeMessageRequest): RuntimeSession {
    const signature = this.buildSignature(input.model, input.skill, input.resumeSessionId);
    const existing = this.sessions.get(input.appSessionId);

    if (existing && existing.signature === signature && !existing.closing) {
      return existing;
    }

    if (existing) {
      this.destroyRuntime(existing);
    }

    const child = this.spawnClaudeProcess(this.buildPersistentArgs(input), {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const rl = readline.createInterface({ input: child.stdout });
    const runtime: RuntimeSession = {
      appSessionId: input.appSessionId,
      signature,
      child,
      rl,
      stderr: "",
      model: input.model,
      closing: false,
    };

    child.stderr.on("data", (chunk: Buffer) => {
      runtime.stderr += chunk.toString("utf8");
    });

    rl.on("line", (line) => {
      this.handleLine(runtime, line);
    });

    child.once("error", (error) => {
      this.failCurrent(runtime, this.wrapSpawnError(error));
      this.destroyRuntime(runtime);
    });

    child.once("close", () => {
      if (!runtime.closing) {
        this.failCurrent(
          runtime,
          new AppError(502, "claude_process_failed", runtime.stderr || "Claude CLI process exited unexpectedly."),
        );
      }
      this.destroyRuntime(runtime);
    });

    this.sessions.set(input.appSessionId, runtime);
    return runtime;
  }

  private handleLine(runtime: RuntimeSession, line: string): void {
    if (!line.trim()) {
      return;
    }

    let message: SdkMessage;
    try {
      message = JSON.parse(line) as SdkMessage;
    } catch (error) {
      this.failCurrent(
        runtime,
        new AppError(502, "invalid_claude_response", "Claude CLI stream returned invalid JSON.", error),
      );
      this.destroyRuntime(runtime);
      return;
    }

    if (message.type === "system" && message.subtype === "init") {
      runtime.claudeSessionId = message.session_id;
      runtime.model = message.model ?? runtime.model;
      if (runtime.current && !runtime.current.started) {
        runtime.current.started = true;
        runtime.current.resolvedSessionId = message.session_id;
        runtime.current.resolvedModel = message.model ?? runtime.current.resolvedModel;
        runtime.current.handlers?.onStart({
          sessionId: runtime.current.resolvedSessionId,
          model: runtime.current.resolvedModel,
        });
      }
      return;
    }

    if (!runtime.current) {
      return;
    }

    const current = runtime.current;

    if (message.type === "assistant") {
      if (!current.started) {
        current.started = true;
        current.handlers?.onStart({
          sessionId: current.resolvedSessionId,
          model: current.resolvedModel,
        });
      }

      const currentText = extractText(message.message.content);
      const delta = currentText.startsWith(current.lastAssistantText)
        ? currentText.slice(current.lastAssistantText.length)
        : currentText;

      current.lastAssistantText = currentText;
      if (delta) {
        current.handlers?.onDelta(delta);
      }
      return;
    }

    if (message.type === "result") {
      clearTimeout(current.timeoutId);
      if (current.abortHandler && current.signal) {
        current.signal.removeEventListener("abort", current.abortHandler);
      }

      runtime.claudeSessionId = message.session_id;
      current.resolvedSessionId = message.session_id;

      if (message.is_error) {
        runtime.current = undefined;
        this.scheduleIdleClose(runtime);
        current.reject(
          new AppError(
            502,
            "claude_execution_error",
            `Claude CLI returned an error result: ${message.subtype}.`,
          ),
        );
        return;
      }

      current.finalSubtype = message.subtype;
      current.finalResult = message.result ?? current.lastAssistantText;
      const missingDelta = current.finalResult.startsWith(current.lastAssistantText)
        ? current.finalResult.slice(current.lastAssistantText.length)
        : current.finalResult;
      if (missingDelta) {
        current.handlers?.onDelta(missingDelta);
        current.lastAssistantText = current.finalResult;
      }

      current.usage = this.extractUsage(message);
      current.handlers?.onUsage(current.usage);
      current.handlers?.onDone({
        sessionId: current.resolvedSessionId,
        finishReason: current.finalSubtype,
        usage: current.usage,
        result: current.finalResult,
      });

      runtime.current = undefined;
      this.scheduleIdleClose(runtime);
      current.resolve({
        sessionId: current.resolvedSessionId,
        result: current.finalResult,
        subtype: current.finalSubtype,
        usage: current.usage,
      });
    }
  }

  private buildPersistentArgs(input: ClaudeMessageRequest): string[] {
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--input-format",
      "stream-json",
      "--include-partial-messages",
      "--verbose",
      "--permission-mode",
      "dontAsk",
      "--model",
      input.model,
    ];

    if (input.resumeSessionId) {
      args.push("--resume", input.resumeSessionId);
    }

    if (input.skill.appendSystemPrompt) {
      args.push("--append-system-prompt", input.skill.appendSystemPrompt);
    }

    if (input.skill.mcpConfigPath) {
      args.push("--mcp-config", input.skill.mcpConfigPath);
    }

    if (input.skill.allowedTools && input.skill.allowedTools.length > 0) {
      args.push("--allowedTools", input.skill.allowedTools.join(","));
    }

    return args;
  }

  private buildInputLine(input: ClaudeMessageRequest): string {
    return JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "text",
            text: this.buildPrompt(input),
          },
        ],
      },
    });
  }

  private buildPrompt(input: ClaudeMessageRequest): string {
    if (!input.skill.promptPrefix) {
      return input.message;
    }

    return `${input.skill.promptPrefix}\n\n${input.message}`;
  }

  private buildSignature(model: string, skill: SkillDefinition, resumeSessionId?: string): string {
    return JSON.stringify({
      model,
      skill: {
        name: skill.name,
        appendSystemPrompt: skill.appendSystemPrompt ?? "",
        promptPrefix: skill.promptPrefix ?? "",
        mcpConfigPath: skill.mcpConfigPath ?? "",
        allowedTools: skill.allowedTools ?? [],
      },
      resumeSessionId: resumeSessionId ?? "",
    });
  }

  private extractUsage(payload: Record<string, unknown>): ClaudeUsage {
    return {
      totalCostUsd: Number(payload.total_cost_usd ?? 0),
      durationMs: Number(payload.duration_ms ?? 0),
      durationApiMs: Number(payload.duration_api_ms ?? 0),
      numTurns: Number(payload.num_turns ?? 0),
    };
  }

  private scheduleIdleClose(runtime: RuntimeSession): void {
    this.clearIdleTimer(runtime);
    runtime.idleTimer = setTimeout(() => {
      this.destroyRuntime(runtime);
    }, this.config.idleTimeoutMs);
  }

  private clearIdleTimer(runtime: RuntimeSession): void {
    if (runtime.idleTimer) {
      clearTimeout(runtime.idleTimer);
      runtime.idleTimer = undefined;
    }
  }

  private failCurrent(runtime: RuntimeSession, error: AppError): void {
    const current = runtime.current;
    if (!current) {
      return;
    }

    clearTimeout(current.timeoutId);
    if (current.abortHandler && current.signal) {
      current.signal.removeEventListener("abort", current.abortHandler);
    }
    runtime.current = undefined;
    current.reject(error);
  }

  private destroyRuntime(runtime: RuntimeSession): void {
    if (runtime.closing) {
      return;
    }

    runtime.closing = true;
    this.clearIdleTimer(runtime);
    runtime.rl.close();
    if (!runtime.child.killed) {
      runtime.child.kill();
    }
    this.sessions.delete(runtime.appSessionId);
  }

  private wrapSpawnError(error: unknown): AppError {
    return new AppError(503, "claude_unavailable", "Failed to start Claude CLI process.", error);
  }

  private spawnClaudeProcess(
    args: string[],
    options: {
      stdio: ["ignore" | "pipe", "pipe", "pipe"];
    },
  ): ChildProcessWithoutNullStreams {
    const commandExt = path.extname(this.config.command).toLowerCase();
    const isCmdScript = commandExt === ".cmd" || commandExt === ".bat";

    if (isCmdScript) {
      return spawn("cmd.exe", ["/d", "/s", "/c", this.config.command, ...args], {
        cwd: this.config.workdir,
        env: process.env,
        stdio: options.stdio,
        windowsHide: true,
      }) as ChildProcessWithoutNullStreams;
    }

    return spawn(this.config.command, args, {
      cwd: this.config.workdir,
      env: process.env,
      stdio: options.stdio,
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams;
  }
}

function extractText(content?: Array<{ type?: string; text?: string }>): string {
  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .filter((item) => item?.type === "text" && typeof item.text === "string")
    .map((item) => item.text ?? "")
    .join("");
}
