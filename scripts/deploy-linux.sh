#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/claude-cli-gateway}"
APP_USER="${APP_USER:-claude-gateway}"
APP_GROUP="${APP_GROUP:-$APP_USER}"
NODE_ENV="${NODE_ENV:-production}"
SERVICE_NAME="${SERVICE_NAME:-claude-cli-gateway}"
ENV_FILE="${ENV_FILE:-$APP_DIR/.env}"
SYSTEMD_UNIT_SOURCE="${SYSTEMD_UNIT_SOURCE:-$APP_DIR/linux/claude-cli-gateway.service}"
SYSTEMD_UNIT_TARGET="/etc/systemd/system/${SERVICE_NAME}.service"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Please run as root so the script can install dependencies and the systemd unit."
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed or not on PATH."
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is not installed or not on PATH."
  exit 1
fi

if ! command -v redis-cli >/dev/null 2>&1; then
  echo "redis-cli is not installed. Install Redis server/client first."
  exit 1
fi

if ! command -v claude >/dev/null 2>&1; then
  echo "claude CLI is not installed or not on PATH for the current shell."
  exit 1
fi

if [[ ! -d "$APP_DIR" ]]; then
  echo "App directory not found: $APP_DIR"
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Environment file not found: $ENV_FILE"
  exit 1
fi

if [[ ! -f "$SYSTEMD_UNIT_SOURCE" ]]; then
  echo "systemd unit template not found: $SYSTEMD_UNIT_SOURCE"
  exit 1
fi

if ! getent group "$APP_GROUP" >/dev/null 2>&1; then
  groupadd --system "$APP_GROUP"
fi

if ! id "$APP_USER" >/dev/null 2>&1; then
  useradd --system --gid "$APP_GROUP" --home-dir "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
fi

mkdir -p "$APP_DIR/.runtime/claude-workdir"
chown -R "$APP_USER:$APP_GROUP" "$APP_DIR"

pushd "$APP_DIR" >/dev/null
npm ci
npm run build
popd >/dev/null

install -m 0644 "$SYSTEMD_UNIT_SOURCE" "$SYSTEMD_UNIT_TARGET"
systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
systemctl restart "$SERVICE_NAME"

echo
echo "Deployment complete."
echo "Check status with: systemctl status $SERVICE_NAME --no-pager"
echo "Tail logs with: journalctl -u $SERVICE_NAME -f"
