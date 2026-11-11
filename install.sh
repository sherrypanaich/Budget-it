#!/usr/bin/env bash
# Installs Budget it on this Linux machine as a service that starts on boot.
# Run from the unpacked folder:  bash install.sh
# Safe to run again to update: your data/ folder and budget-it.env are kept.
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/budget-it"

# 1. Node.js 22 or newer (older ones no longer get security fixes)
need_node=1
if command -v node >/dev/null; then
  [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 22 ] && need_node=0
fi
if [ $need_node = 1 ]; then
  if command -v apt-get >/dev/null; then
    echo "Installing Node.js 24..."
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
  tar -C "$SRC" --exclude=./data --exclude=./budget-it.env --exclude=./.git -cf - . | tar -C "$DEST" -xf -
fi
[ -f "$DEST/budget-it.env" ] || { cp "$DEST/budget-it.env.example" "$DEST/budget-it.env"; chmod 600 "$DEST/budget-it.env"; }
echo "App files in $DEST"
(cd "$DEST" && node --test test/*.test.js >/dev/null 2>&1 && echo "Self-check passed") || echo "Self-check had a problem (cd $DEST && node --test test/*.test.js shows it). Carrying on."

# 3. Start on boot
mkdir -p "$HOME/.config/systemd/user"
cp "$DEST/budget-it.service" "$HOME/.config/systemd/user/"
systemctl --user daemon-reload
systemctl --user enable budget-it >/dev/null
systemctl --user restart budget-it
sudo loginctl enable-linger "$USER"
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
