# Claude CLI Gateway

Internal HTTP/SSE gateway that wraps the local `claude` CLI for multi-user text Q&A. The app code is cross-platform; Windows and Linux mainly differ in deployment tooling.

## Features

- `POST /api/v1/sessions` to create app sessions
- `GET /api/v1/skills` to list hosted skills
- `POST /api/v1/sessions/:sessionId/messages` for JSON replies
- `POST /api/v1/sessions/:sessionId/messages/stream` for SSE replies
- `DELETE /api/v1/sessions/:sessionId` to close sessions
- Redis-backed session persistence and concurrency control
- API-key auth and user attribution headers
- Claude CLI health checks and service wrapper samples for Windows and Linux

## Quick start

1. Install dependencies:

   ```bash
   npm install
   ```

2. Copy env file and adjust values:

   ```bash
   cp .env.example .env
   ```

3. Make sure `claude` CLI is already authenticated on this machine.

4. Build and start manually when Redis is already available:

   ```bash
   npm run build
   node dist/src/server.js
   ```

## Windows local development

Use the bundled helper scripts:

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\scripts\dev-start.ps1
   ```

   This starts:

- portable Memurai on `127.0.0.1:6379`
- the gateway on `127.0.0.1:8080`

5. Check status or stop everything:

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\scripts\dev-status.ps1
   powershell -ExecutionPolicy Bypass -File .\scripts\dev-stop.ps1
   ```

## Skills

Skills are loaded from the JSON file configured by `SKILLS_FILE`. Only listed skills are accepted by the API. Each skill can contribute:

- `appendSystemPrompt`: extra fixed instruction appended to Claude's system prompt
- `promptPrefix`: fixed user prompt prefix injected ahead of the incoming message
- `mcpConfigPath`: fixed MCP config file path controlled by the service
- `allowedTools`: fixed tool allowlist for the skill

## Windows service

`winsw/ClaudeCliGateway.xml` contains a sample WinSW wrapper configuration. Adjust paths after build:

- executable: `node.exe`
- arguments: `dist/src/server.js`
- working directory: this project root

## Linux deployment

Linux does not require code changes. Replace the Windows helper pieces with:

- `linux/claude-cli-gateway.service`: sample `systemd` unit
- `scripts/deploy-linux.sh`: deployment helper that installs dependencies, builds, installs the unit, and restarts the service

Recommended target layout:

```text
/opt/claude-cli-gateway
  |- .env
  |- dist/
  |- node_modules/
  |- skills/
  |- linux/claude-cli-gateway.service
```

Example Linux `.env` values:

```dotenv
PORT=8080
HOST=0.0.0.0
API_KEYS=replace-with-real-service-key
REDIS_URL=redis://127.0.0.1:6379
SESSION_TTL_SECONDS=86400
USER_CONCURRENCY_LIMIT=3
CLAUDE_COMMAND=claude
CLAUDE_MODEL=sonnet
CLAUDE_WORKDIR=/opt/claude-cli-gateway/.runtime/claude-workdir
CLAUDE_TIMEOUT_MS=300000
CLAUDE_IDLE_TIMEOUT_MS=3600000
SKILLS_FILE=/opt/claude-cli-gateway/skills/default-skills.json
```

Suggested server preparation:

1. Install Node.js 24+, npm, Redis, and the `claude` CLI.
2. Copy this project to `/opt/claude-cli-gateway`.
3. Create `/opt/claude-cli-gateway/.env` with Linux-style absolute paths.
4. Log in to `claude` as the runtime user and verify `claude -v` works in that context.
5. Run:

   ```bash
   sudo APP_DIR=/opt/claude-cli-gateway ./scripts/deploy-linux.sh
   ```

6. Validate:

   ```bash
   systemctl status claude-cli-gateway --no-pager
   curl http://127.0.0.1:8080/livez
   curl http://127.0.0.1:8080/readyz
   ```

Notes:

- If your Node binary is not discoverable by `systemd`, replace `ExecStart` in `linux/claude-cli-gateway.service` with the full Node path.
- The most common Linux blocker is Claude CLI authentication for the service user, not application code.
- If Redis runs on another host, update `REDIS_URL` only; no code changes are required.

## Source notes

- The gateway never forwards arbitrary CLI flags or local directory access from callers.
- Session continuity is managed by Redis using Claude's `session_id` and `--resume`.
- Logs intentionally omit prompt and answer bodies.
