# pi-link-extension

> Inter-session agent communication for [pi](https://github.com/badlogic/pi-coding-agent) via Unix domain sockets.

## What It Does

Connects two pi chat sessions on the same machine, letting agents delegate tasks to each other. Think of it as A2A (agent-to-agent) over local pipes.

**Silent mode** (default): Sends a task to the peer's session as a headless subprocess. The peer's context stays clean — it never sees the interaction.

**Visible mode**: Injects directly into the peer's session. Both agents share context for collaborative workflows.

## Install

```bash
# Copy to pi's extension directory
cp -r ~/source/pi-link-extension/ ~/.pi/agent/extensions/link/
# Clear jiti cache
rm -f /tmp/jiti/extensions-link.*
```

## Usage

### Create / Join a Link

```bash
/link create          # Create a new link (shows join command)
/link join <id>       # Join an existing link
/link                 # Auto-create if no links exist
```

### Send Tasks

```bash
# From within a chat session — agent uses the tool directly
# Or via slash command:
/link-task Tell the other agent to check the build logs
/link-task --visible Let's collaborate on this architecture decision
```

### LLM Tools (automatic)

The extension registers two tools that agents can call:

| Tool | Purpose |
|------|---------|
| `link_send_task` | Send a prompt to the linked peer session |
| `link_status` | Check connection status and peer info |

### Status & Cleanup

```bash
/link status         # Show link state, peer info, heartbeat
/link version        # Show extension version (content hash)
/link disconnect     # Close the link
```

## Architecture

```
Agent A (this session)          Agent B (peer session)
┌──────────────┐               ┌──────────────┐
│ /link-task   │               │              │
│      ↓       │               │              │
│ JSON-RPC 2.0 │─── UDS ──────→│ headless pi  │
│   over UDS   │               │ subprocess   │
│              │←── result ────│ (silent mode)│
│  📥 result   │               │              │
└──────────────┘               └──────────────┘
```

- **Transport**: Unix domain sockets (`~/.pi/links/<id>/link.sock`)
- **Framing**: JSON-RPC 2.0 (`task/send`, `task/stream`, `ping`)
- **Discovery**: `~/.pi/links/<id>/meta.json`
- **Security**: 0600 permissions, same-user only

## Modules

| File | Responsibility |
|------|---------------|
| `index.ts` | Extension entry — commands, tools, events, socket handling, UI |
| `types.ts` | Types, constants, UDS helpers, JSON-RPC framing, link discovery |
| `headless.ts` | Context snapshot + headless `pi --mode json` subprocess spawning |

## Development

```bash
# Verify bracket balance (critical — jiti crashes on mismatch)
node -e "const c=require('fs').readFileSync('index.ts','utf-8');let b=0;for(const ch of c){if(ch==='{')b++;if(ch==='}')b--;}console.log(b===0?'balanced':'mismatch')"

# Test UDS + framing
npx -y tsx test-link.ts

# Clear jiti cache after changes
rm -f /tmp/jiti/extensions-link.*
```

## Design Decisions

- **UDS over HTTP**: Zero dependencies, low latency, filesystem-based discovery
- **Silent by default**: Context isolation is the safe default; visible is opt-in
- **JSON-RPC 2.0**: Maps to A2A Task model, standard framing, easy to debug
- **No npm dependencies**: Works with only Node.js built-ins + pi bundles

## Roadmap

- [ ] Streaming results (`task/stream` method)
- [ ] Multi-link support
- [ ] Cross-machine via A2A/ACP HTTP adapter
