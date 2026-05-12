# pi-link

> Inter-session agent communication for [pi](https://github.com/badlogic/pi-coding-agent) via Unix domain sockets and HTTP.

## What It Does

Connects two or more pi chat sessions, letting agents delegate tasks to each other. Think of it as A2A (agent-to-agent) over local pipes or HTTP.

**Silent mode** (default): Sends a task as a headless subprocess. The peer's context stays clean.

**Visible mode**: Injects directly into the peer's session for collaborative workflows.

## Features

- **UDS transport**: Zero-dependency Unix domain sockets with JSON-RPC 2.0 framing
- **HTTP transport**: Cross-machine linking with Bearer token auth and A2A-compatible discovery
- **Multi-link**: Connect to multiple peers simultaneously, target by ID/name/index
- **Streaming**: Real-time chunk delivery for long-running tasks
- **Silent mode**: Headless `pi --mode json` subprocess — no context pollution on peer
- **Visible mode**: Direct session injection for collaborative workflows
- **Activity indicator**: Live spinner in widget and status bar during task execution
- **Persistence**: Links survive session reload via recovery data
- **Half-open detection**: Heartbeat-based timeout catches silently dropped peers
- **Version mismatch**: Detects and warns when peers run different extension versions
- **Jiti cache detection**: Warns when extension files changed but cached version is loaded

## Install

```bash
# Clone
git clone https://github.com/bkuri-org/pi-link.git ~/.pi/agent/extensions/link

# Or copy from source
cp -r ~/source/pi-link-extension/ ~/.pi/agent/extensions/link/

# Clear jiti cache
rm -f /tmp/jiti/extensions-link.*
```

## Quick Start

```bash
# Terminal 1: create a link
/link create

# Terminal 2: join the link
/link join

# Send a task (agent tool — automatic)
# Or via slash command:
/link-task What files are in your current directory?

# Visible mode (collaborative):
/link-task --visible Let's design the API together

# Check status
/link status

# Compare versions between peers
/link version

# Disconnect
/link disconnect
```

## Architecture

```
Agent A                          Agent B
┌──────────┐                     ┌──────────┐
│ /link-task│                     │          │
│     ↓    │                     │          │
│ JSON-RPC │─── UDS / HTTP ────→ │ headless │
│   2.0    │                     │ subprocess│
│          │←── result ───────── │ (silent) │
│  📥 result│                     │          │
└──────────┘                     └──────────┘
```

### Transports

| Transport | Use Case | Discovery |
|-----------|----------|-----------|
| **UDS** | Same machine | `~/.pi/links/<id>/meta.json` |
| **HTTP** | Cross-machine | `/.well-known/agent.json` |

### Message Types

| Method | Direction | Purpose |
|--------|-----------|---------|
| `ping` | Both | Heartbeat + peer info exchange |
| `task/send` | Sender → Peer | Delegate a task |
| `task/stream` | Peer → Sender | Stream intermediate chunks |
| `version/get` | Both | Query peer version + hash |

## Multi-Link

Connect to multiple peers simultaneously:

```bash
/link create          # Create first link
/link create          # Create second link
/link list            # Show all links with index
```

Target a specific link with the `link_send_task` tool:

```typescript
link_send_task({ prompt: "...", target: "0" })        // by index
link_send_task({ prompt: "...", target: "a3f2b" })    // by ID prefix
link_send_task({ prompt: "...", target: "server2" })   // by session name
```

## HTTP Adapter

For cross-machine linking:

```bash
# Host side
/link create --http 4567

# Client side
/link http://server2.lan:4567
```

Auth via shared secret (env var or auto-generated file):

```bash
export PI_LINK_SECRET="my-shared-secret"
```

## Modules

| File | Responsibility |
|------|---------------|
| `index.ts` | Extension entry — commands, tools, events, socket handling, UI, activity tracking |
| `types.ts` | Types, constants, UDS helpers, JSON-RPC framing, link discovery, HTTP client |
| `headless.ts` | Context snapshot + headless `pi --mode json` subprocess spawning |

## Security

- **UDS**: Filesystem permissions (0600), same-user only
- **HTTP**: Bearer token auth, no plaintext secrets in task prompts
- **No auto-execution**: Tasks processed by the agent with all safety gates
- **No tool exposure**: Peer agents can't access the sender's tools

## Development

```bash
# Verify bracket balance (critical for jiti)
node -e "const c=require('fs').readFileSync('index.ts','utf-8');let b=0;for(const ch of c){if(ch==='{')b++;if(ch==='}')b--;}console.log(b===0?'balanced':'mismatch')"

# Run tests (110 total)
npx -y tsx test-link.ts
npx -y tsx test-new-features.ts
npx -y tsx test-headless-edge.ts

# Clear jiti cache after changes
rm -f /tmp/jiti/extensions-link.*
```

## License

MIT
