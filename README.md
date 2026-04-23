# Claude CLI Gateway

Windows-friendly internal HTTP/SSE gateway that wraps the local `claude` CLI for multi-user text Q&A.

## Features

- `POST /api/v1/sessions` to create app sessions
- `GET /api/v1/skills` to list hosted skills
- `POST /api/v1/sessions/:sessionId/messages` for JSON replies
- `POST /api/v1/sessions/:sessionId/messages/stream` for SSE replies
- `DELETE /api/v1/sessions/:sessionId` to close sessions
- Redis-backed session persistence and concurrency control
- API-key auth and user attribution headers
- Claude CLI health checks and Windows service wrapper sample

## Quick start

1. Install dependencies:

   ```bash
   npm install
   ```

2. Copy env file and adjust values:

   ```bash
   copy .env.example .env
   ```

3. Make sure `claude` CLI is already authenticated on this machine.

4. For local Windows development, use the bundled helper scripts:

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

6. If you want to run the gateway manually after Redis is already available:

   ```bash
   npm run build
   node dist/src/server.js
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

## Source notes

- The gateway never forwards arbitrary CLI flags or local directory access from callers.
- Session continuity is managed by Redis using Claude's `session_id` and `--resume`.
- Logs intentionally omit prompt and answer bodies.
