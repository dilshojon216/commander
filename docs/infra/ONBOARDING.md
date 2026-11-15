# Onboarding Servers to Commander

Scripts and procedure for adding Ubuntu machines to the Commander network.

## Prerequisites

- SSH access configured for each target server (use aliases in ~/.ssh/config)
- Node.js ≥22 installed on each server (can use nvm)
- `claude` CLI installed and in PATH (login shell)
- `systemd --user` available
- Center running on Mac (accessible at `https://<mac>.<tailnet>.ts.net`)

## Quick Start

From the Mac (where center runs):

```bash
cd ~/working/commander
./ops/add-machine.sh <ssh-alias> [--name <machine-name>] [--dry-run]
```

Example:
```bash
./ops/add-machine.sh ProdAGlobal
./ops/add-machine.sh prod_b_global --name "Oqil Quduq"
```

### Dry-Run Mode

Test the script without making changes:
```bash
./ops/add-machine.sh <ssh-alias> --dry-run
```

## What the Script Does

1. **SSH Preflight Checks**: Verifies OS, user (not root), Node version, claude availability, systemd --user
2. **Build Bundle**: Locally builds agentd, cc-hook, cc-statusline binaries
3. **Copy Files**: SCPs bundle, install script, and service template to server
4. **Create Enrollment Code**: Generates a 15-minute TTL enrollment code on the center
5. **Run Install**: Executes install script on server (binary copy, service file creation)
6. **Enroll**: Registers device with center (creates ~/.commander/config.json)
7. **Update Settings**: Merges hooks and OTel config into ~/.claude/settings.json (backs up original)
8. **Start Service**: Enables and starts systemd --user service
9. **Verify**: Checks agentd status and confirms in center database

## Enrollment Code Security Note

Enrollment codes are:
- Valid for 15 minutes only
- Single-use
- NOT logged in center (burned after use)
- NOT stored in any config files

The code is passed to agentd during the brief enrollment window; after enrollment succeeds, only the device key pair (Ed25519) is stored in config.json.

## Server Status After Onboarding

On each server, verify:

```bash
# Check service status
systemctl --user status commander-agentd
systemctl --user is-active commander-agentd

# Check logs
journalctl --user -u commander-agentd -f

# Check agentd daemon
NODE_BIN=/usr/bin/node  # or actual node path
$NODE_BIN ~/.commander/bin/agentd.mjs status

# Check that hooks are registered
grep "cc-hook" ~/.claude/settings.json
```

## Linger Requirement

If the user logs out, the service will stop unless `loginctl linger` is enabled:

```bash
loginctl show-user $USER -p Linger

# If it says "Linger=no", enable it:
sudo loginctl enable-linger $USER
```

## Settings.json Backup

Before merging hooks, the script backs up your settings:

```bash
ls -la ~/.claude/settings.json.bak-commander-*
```

To restore:
```bash
cp ~/.claude/settings.json.bak-commander-TIMESTAMP ~/.claude/settings.json
chmod 600 ~/.claude/settings.json
```

## Troubleshooting

### Service failed to start

```bash
systemctl --user status commander-agentd
journalctl --user -u commander-agentd -n 50
```

### Settings merge failed

Check if ~/.claude/settings.json is corrupted:
```bash
node -e "require('fs').readFileSync(process.env.HOME + '/.claude/settings.json'); console.log('OK')"
```

Restore from backup if needed.

### Preflight failed: "node topilmadi"

Node must be in PATH for the login shell:
```bash
bash -lc 'command -v node'
```

If using nvm, ensure ~/.bashrc or ~/.zshrc initializes it.

### Enrollment code expired

Create a new enrollment code (valid for 15 min):
```bash
ops/mac/commander-admin.sh enroll-code create --kind agentd --machine-name <machine> --ttl-minutes 15 --json
```

Then manually enroll:
```bash
NODE_BIN=$(ssh <alias> 'bash -lc "command -v node"')
ssh <alias> "$NODE_BIN ~/.commander/bin/agentd.mjs enroll \
  --center https://<mac>.<tailnet>.ts.net \
  --code <code> \
  --claude-bin /path/to/claude"
```

## Removing a Server

```bash
./ops/remove-machine.sh <ssh-alias>
```

This:
- Stops and disables the systemd service
- Removes binaries
- Restores ~/.claude/settings.json from backup
- Clears device config

Device revocation on the center (if needed):
```bash
ops/mac/commander-admin.sh device revoke <device-id>
```

## Manual Enrollment (if needed)

If the script fails at step 5, you can enroll manually:

```bash
# On the server:
NODE_BIN=$(bash -lc 'command -v node')
CLAUDE_BIN=$(bash -lc 'command -v claude')

# From Mac, get code:
CODE=$(ops/mac/commander-admin.sh enroll-code create \
  --kind agentd --machine-name <machine> --ttl-minutes 15 --json | \
  grep -oE '"code":"[^"]+"' | cut -d'"' -f4)

# Enroll on server:
$NODE_BIN ~/.commander/bin/agentd.mjs enroll \
  --center https://<mac>.<tailnet>.ts.net \
  --code $CODE \
  --claude-bin $CLAUDE_BIN

# Then start service:
systemctl --user enable --now commander-agentd
```

## Checking Center Database

Verify machines are registered:

```bash
docker compose -f apps/center/docker-compose.yml exec -T db psql -U postgres -d commander -c \
  "SELECT id, name, online, last_heartbeat FROM machines ORDER BY name;"
```

## Monitoring

Once online, monitor sessions in real-time:

```bash
# List all sessions across all machines (center API)
curl -s https://<mac>.<tailnet>.ts.net/v1/sessions | jq '.'

# Check a specific machine
curl -s https://<mac>.<tailnet>.ts.net/v1/machines/<machine-id>/sessions | jq '.'
```
