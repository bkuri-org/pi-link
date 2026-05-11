# `/link` — Inter-Session Agent Linking Extension

## Problem

Two pi chat sessions running on the same machine are completely isolated. There's no way to:
- Share context between a "research" session and an "implementation" session
- Let one agent delegate a subtask to another session with a different model/tools
- Create a supervisor → worker topology across terminals

## Solution

A pi extension that provides a `/link` command, using **Unix domain sockets** as the rendezvous and transport mechanism. Once linked, sessions communicate using a lightweight **JSON-RPC framing** inspired by A2A/ACP principles (task delegation, message passing, status streaming).

## Architecture

```
┌─────────────────────┐         ┌─────────────────────┐
│   Session A          │         │   Session B          │
│   /link create       │         │   /link join         │
│                     │         │                     │
│  ┌───────────────┐  │         │  ┌───────────────┐  │
│  │ LinkExtension  │◄─┼─────────┼─►│ LinkExtension  │  │
│  │               │  │  UDS    │  │               │  │
│  │ JSON-RPC pipe │  │  pair   │  │ JSON-RPC pipe │  │
│  └───────┬───────┘  │         │  └───────┬───────┘  │
│          │          │         │          │          │
│   send_task()       │         │   recv_task()       │
│   recv_result()     │         │   send_result()     │
└─────────────────────┘         └─────────────────────┘
```

## Protocol: `pi-link` (JSON-RPC 2.0 over UDS)

### Why JSON-RPC over raw A2A/ACP?

- **A2A** (Google) and **ACP** (OpenACP) are HTTP-based protocols designed for *remote* agent discovery and interop
- For two sessions on the **same machine**, Unix sockets + JSON-RPC is simpler, lower latency, and zero-dependency
- The JSON-RPC framing maps cleanly to A2A's `Task` model and ACP's `process` model
- A future adapter layer could translate to HTTP-based A2A/ACP for cross-machine linking

### Message Types

```typescript
// Task delegation (A2A-inspired)
interface LinkTask {
  jsonrpc: "2.0";
  id: string;
  method: "task/send";
  params: {
    taskId: string;
    prompt: string;
    context?: string;       // optional context snapshot
    tools?: string[];       // which tools to expose
    replyTo?: "sender" | "none";  // send result back?
  };
}

// Result (A2A-inspired)
interface LinkResult {
  jsonrpc: "2.0";
  id: string;
  result: {
    taskId: string;
    status: "completed" | "failed" | "streaming";
    content?: string;
    error?: string;
    usage?: { inputTokens: number; outputTokens: number };
  };
}

// Stream chunk (for real-time progress)
interface LinkStream {
  jsonrpc: "2.0";
  id: string;
  method: "task/stream";
  params: {
    taskId: string;
    chunk: string;
    done: boolean;
  };
}

// Heartbeat / presence
interface LinkPing {
  jsonrpc: "2.0";
  id: string;
  method: "ping";
  params: { sessionId: string; sessionName?: string };
}

interface LinkPong {
  jsonrpc: "2.0";
  id: string;
  result: { sessionId: string; sessionName?: string; model?: string };
}
```

## User Flow

### Session A (create)
```
User: /link create
Extension: 
  → Creates UDS pair in ~/.pi/links/<id>/
  → Starts listening
  → Shows widget: "🔗 Linked — waiting for peer..."
  → Shows socket path for reference
```

### Session B (join)
```
User: /link
Extension:
  → Scans ~/.pi/links/ for available sockets
  → Shows select dialog:
      [1] Session "refactor-auth" (model: claude-sonnet-4, idle) — created 2m ago
      [2] Session "research-api" (model: o3, busy) — created 8m ago
  → User picks [1]
  → Connects
  → Shows widget: "🔗 Linked to refactor-auth"
```

### After linking
```
# In Session B (the "client"):
User: Ask the linked session to review my auth changes
→ LLM calls link_send_task tool
→ Task ships over UDS to Session A
→ Session A receives it as an injected user message
→ Session A processes, result ships back
→ Session B gets the result as a tool result

# Or use /link-task shortcut:
User: /link-task explain the database schema
→ Same flow, but via command instead of LLM tool
```

## Socket Discovery: `~/.pi/links/`

```
~/.pi/links/
├── abc123/
│   ├── meta.json          # { sessionId, sessionName, model, created, status }
│   └── link.sock          # the Unix socket
├── def456/
│   ├── meta.json
│   └── link.sock
```

- `meta.json` is written by the creator, read by joiners
- Sockets are cleaned up on `session_shutdown`
- Stale sockets (>1h old, no heartbeat) are pruned on discovery

## Extension API Surface

### Commands

| Command | Description |
|---------|-------------|
| `/link create [name]` | Create a new link endpoint, optionally named |
| `/link` | Show picker of available links to join |
| `/link status` | Show current link status |
| `/link disconnect` | Close the current link |
| `/link-task <prompt>` | Send a one-shot task to the linked session |

### Tools (LLM-callable)

| Tool | Description |
|------|-------------|
| `link_send_task` | Send a task/prompt to the linked session |
| `link_status` | Check link status and peer info |

### Events

| Event | Description |
|-------|-------------|
| `link:connected` | Peer connected |
| `link:disconnected` | Peer disconnected |
| `link:task_received` | Incoming task from peer |
| `link:task_result` | Task result from peer |
| `link:task_stream` | Streaming chunk from peer |

### UI

- **Widget**: Shows link status (disconnected / waiting / linked-to-X)
- **Status bar**: `🔗 refactor-auth (claude-sonnet-4)` when linked
- **Notifications**: Connect/disconnect events
- **Custom message renderer**: Incoming tasks rendered distinctly

## Implementation Plan

### Phase 1: Core (MVP)
1. UDS creation/listening with `node:net`
2. `~/.pi/links/` discovery with `meta.json`
3. `/link create` and `/link join` commands
4. JSON-RPC message framing
5. `link_send_task` tool + auto-inject as user message on receiver
6. Widget + status display
7. Cleanup on session_shutdown

### Phase 2: Bidirectional
8. Result shipping back to sender
9. `/link-task` command shortcut
10. Heartbeat/presence
11. Context snapshot (serialize recent messages as task context)

### Phase 3: Advanced
12. Streaming support (stream chunks back in real-time)
13. Multi-link (one session linked to N others)
14. A2A/ACP HTTP adapter for cross-machine linking
15. Link ACLs (which tools/commands the peer can invoke)

## Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Transport | Unix domain sockets | Zero-dep, low latency, filesystem discovery |
| Framing | JSON-RPC 2.0 | Standard, maps to A2A task model, easy to debug |
| Direction | Initially unidirectional (→) | Simpler; bidirectional in Phase 2 |
| Auth | Filesystem permissions only | Same user only; UDS respects file mode bits |
| Discovery | Directory scanning | No daemon, no registry, works offline |
| Protocol | Custom "pi-link" | A2A/ACP adapters can be layered on top |

## Relationship to A2A / ACP

This is the **local, fast path**. The same task/message model maps directly:

| pi-link | A2A | ACP |
|---------|-----|-----|
| `task/send` | `POST /tasks` | `process` |
| `task/stream` | SSE stream | SSE stream |
| `task/result` | `Task.status` | `process` result |
| `ping` | Agent card | Agent card |

For cross-machine linking, a Phase 3 adapter would:
1. Wrap `pi-link` JSON-RPC in HTTP POST bodies
2. Host an A2A-compatible `/.well-known/agent.json` card
3. Translate `task/send` → A2A `Task` creation
4. Use the existing OpenACP container as the relay

## Security Considerations

- UDS inherits filesystem permissions — only the creating user can connect
- No plaintext secrets over the socket (tasks are prompts, not credentials)
- `meta.json` is user-readable only (`0600`)
- No incoming task auto-execution — receiver's agent processes it normally with all safety gates
- Stale socket cleanup prevents zombie endpoints
