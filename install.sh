#!/usr/bin/env bash
# Installs Budget it on this Linux machine as a service that starts on boot.
# Run from the unpacked folder:  bash install.sh
# Safe to run again to update: your data/ folder and budget-it.env are kept.
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/budget-it"
ME="${USER:-$(id -un)}"

# It runs as you, from your home folder, and starts with your login (systemd --user): never as root.
if [ "$(id -u)" = 0 ]; then
  echo "Run this as your normal user, without sudo: bash install.sh (it asks for your password when it needs it)."; exit 1
fi

# 1. Node.js 22 or newer (older ones no longer get security fixes)
need_node=1
if command -v node >/dev/null; then
  [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 22 ] && need_node=0
fi
if [ $need_node = 1 ]; then
  if command -v apt-get >/dev/null; then
    echo "Installing Node.js 24..."
    command -v curl >/dev/null || sudo apt-get install -y curl ca-certificates
    curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
    sudo apt-get install -y nodejs
  else
    echo "Please install Node.js 22 or newer with your package manager, then run this again."; exit 1
  fi
fi
echo "Node $(node -v)"

# 2. Copy the app, keeping any existing data and settings
mkdir -p "$DEST"
if [ "$SRC" != "$DEST" ]; then
  tar -C "$SRC" --exclude=./data --exclude=./budget-it.env --exclude=./.git --exclude=./.claude --exclude=./node_modules -cf - . | tar -C "$DEST" -xf -
fi
[ -f "$DEST/budget-it.env" ] || cp "$DEST/budget-it.env.example" "$DEST/budget-it.env"
chmod 600 "$DEST/budget-it.env"   # it holds your Plaid keys
# Budget it 1.0's example had a made-up address here, which sent AI assistants and email links nowhere
sed -i 's|^PUBLIC_URL=https://your-laptop\.your-tailnet\.ts\.net$|PUBLIC_URL=|' "$DEST/budget-it.env"
echo "App files in $DEST"
# The self-check runs on a copy without your settings and data, so your real keys and backup folder are never used
CHECK="$(mktemp -d)"
tar -C "$DEST" --exclude=./data --exclude=./budget-it.env -cf - . | tar -C "$CHECK" -xf -
(cd "$CHECK" && node --test test/*.test.js >/dev/null 2>&1 && echo "Self-check passed") || echo "Self-check had a problem (cd $DEST && node --test test/*.test.js shows it). Carrying on."
rm -rf "$CHECK"

# 3. Start on boot
mkdir -p "$HOME/.config/systemd/user"
cp "$DEST/budget-it.service" "$HOME/.config/systemd/user/"
systemctl --user daemon-reload
systemctl --user enable budget-it >/dev/null
systemctl --user restart budget-it
sudo loginctl enable-linger "$ME"
sleep 1
systemctl --user --no-pager status budget-it | head -5 || true

# 4. Next steps
if ! node -e "process.exit(Object.keys(require('$DEST/data/users.json').users||{}).length?0:1)" 2>/dev/null; then
  echo
  echo "Now add yourself (the first person added runs it):"
  echo "  cd $DEST && node server.js add-user YOURNAME"
fi
if ! grep -q '^PLAID_SECRET=.\+' "$DEST/budget-it.env"; then
  echo
  echo "To connect banks, put your Plaid keys in $DEST/budget-it.env (see step 4 in README.md)."
fi
echo
echo "Open http://localhost:8090 on this computer."
echo "For phones away from home, see step 6 (Tailscale) in README.md."
if ! grep -q '^BACKUP_COPY_DIR=.\+' "$DEST/budget-it.env"; then
  echo "Backups only live on this laptop for now. See Backups in README.md for a second place and a passphrase."
fi
