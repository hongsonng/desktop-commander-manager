#!/usr/bin/env bash
# Shell script to package Desktop Commander Manager for standalone distribution on Linux / Ubuntu
set -euo pipefail

VERSION="${1:-0.1.0}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "========================================"
echo "Packaging Desktop Commander Manager (Linux x64) v$VERSION"
echo "========================================"

cd "$REPO_ROOT"

# 1. Build frontend dashboard
echo -e "\n[1/4] Building dashboard..."
npm run build -w apps/dashboard

# 2. Build release binary
echo -e "\n[2/4] Building Rust release binary..."
cargo build --workspace --release

# 3. Create staging directory
DIST_ROOT="$REPO_ROOT/dist-release"
STAGE_DIR="$DIST_ROOT/desktop-commander-manager-linux-x64"
rm -rf "$STAGE_DIR"
mkdir -p "$STAGE_DIR/data/workers"

echo -e "\n[3/4] Copying artifacts to staging..."
cp "$REPO_ROOT/target/release/dcm-manager" "$STAGE_DIR/dcm-manager"
chmod +x "$STAGE_DIR/dcm-manager"
cp -r "$REPO_ROOT/apps/dashboard/dist" "$STAGE_DIR/dashboard"

# Create start.sh
cat << 'EOF' > "$STAGE_DIR/start.sh"
#!/usr/bin/env bash
set -e
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export DCM_DASHBOARD_DIR="$DIR/dashboard"
export DCM_DATABASE_PATH="$DIR/data/manager.db"
export DCM_RUNTIME_ROOT="$DIR/data/workers"

echo "========================================"
echo "Desktop Commander Manager"
echo "MCP URL:   http://127.0.0.1:8787/mcp"
echo "Dashboard: http://127.0.0.1:8788/"
echo "========================================"
exec "$DIR/dcm-manager" sidecar
EOF
chmod +x "$STAGE_DIR/start.sh"

# Create systemd service installer script
cat << 'EOF' > "$STAGE_DIR/install-service.sh"
#!/usr/bin/env bash
set -e
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SYSTEMD_USER_DIR="$HOME/.config/systemd/user"
mkdir -p "$SYSTEMD_USER_DIR"

cat << SERVICE > "$SYSTEMD_USER_DIR/dcm-manager.service"
[Unit]
Description=Desktop Commander Manager Service
After=network.target

[Service]
Type=simple
WorkingDirectory=$DIR
ExecStart=$DIR/start.sh
Restart=always
RestartSec=5s

[Install]
WantedBy=default.target
SERVICE

systemctl --user daemon-reload
systemctl --user enable dcm-manager.service
systemctl --user restart dcm-manager.service
echo "Desktop Commander Manager service installed and started!"
echo "Check status: systemctl --user status dcm-manager.service"
EOF
chmod +x "$STAGE_DIR/install-service.sh"

# Create README.txt
cat << EOF > "$STAGE_DIR/README.txt"
Desktop Commander Manager (Standalone Linux / Ubuntu Distribution)
Version: $VERSION

QUICK START:
1. Run directly:
   ./start.sh
2. Open your browser:
   http://127.0.0.1:8788/
3. MCP URL:
   http://127.0.0.1:8787/mcp

OPTIONAL SYSTEMD SERVICE (Auto-start on boot / login):
   ./install-service.sh

No source code or Rust toolchain required on this machine!
EOF

# 4. Create tar.gz archive
echo -e "\n[4/4] Creating tar.gz package..."
TAR_PATH="$DIST_ROOT/desktop-commander-manager-linux-x64.tar.gz"
tar -czf "$TAR_PATH" -C "$DIST_ROOT" "desktop-commander-manager-linux-x64"

echo "========================================"
echo "PACKAGE READY: $TAR_PATH"
echo "Users on Ubuntu can extract and run ./start.sh directly!"
echo "========================================"
