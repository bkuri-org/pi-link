# pi-link-extension - Agent Development Guide

## Overview

A pi extension that connects two chat sessions via Unix domain sockets for real-time task delegation. Uses JSON-RPC 2.0 over UDS for low-latency, zero-dependency communication.

Two task modes:
- **Silent** (default) — spawns a headless `pi --mode json` subprocess, peer context stays clean
- **Visible** — injects into the peer's session, both agents share context

## Architecture

```
~/.pi/agent/extensions/link/
├── index.ts      — Extension entry point (commands, tools, events, socket handling, UI)
├── types.ts      — Types, constants, UDS helpers, JSON-RPC framing, link discovery
└── headless.ts   — Silent subprocess runner (context snapshot + headless pi spawn)
```

## Build, Lint, and Test Commands

```bash
# No build step — pi loads .ts directly via jiti
# Install: cp -r link/ ~/.pi/agent/extensions/
# Verify brackets: node -e "const c=require('fs').readFileSync('index.ts','utf-8');let b=0;for(const ch of c){if(ch==='{')b++;if(ch==='}')b--;}console.log(b===0?'balanced':'mismatch')"

# Test UDS + framing logic:
npx -y tsx test-link.ts

# Clear jiti cache after changes:
rm -f /tmp/jiti/extensions-link.*
```

## Code Style Guidelines

- TypeScript modules with ESM imports (`import * as fs from "node:fs"`)
- Node.js built-ins only — no npm dependencies
- Use `Type` from `typebox` for tool parameter schemas
- Use `StringEnum` from `@earendil-works/pi-ai` for string enums (Google compatibility)
- All closing braces must balance — verify before every install
- Tabs for indentation

## Key Integration Points

- **pi Extension API**: `ExtensionAPI`, `ExtensionContext` from `@earendil-works/pi-coding-agent`
- **pi TUI**: `Text` from `@earendil-works/pi-tui` for custom rendering
- **pi Events**: `session_start`, `session_shutdown`, `agent_end` for lifecycle hooks
- **pi Messages**: `pi.sendMessage()` with `triggerTurn: true` for result relay
- **pi Commands**: `pi.registerCommand()` for `/link`, `/link-task`, `/link status`, etc.
- **pi Tools**: `pi.registerTool()` for `link_send_task`, `link_status` (LLM-callable)
- **Village**: Can link pi sessions to Village builder worktrees for parallel monitoring

## Project Structure

```
pi-link-extension/
├── index.ts        # Commands, tools, events, socket handling, UI widgets
├── types.ts        # LinkMeta, JsonRpcMessage, LinkState, discovery, UDS helpers
├── headless.ts     # Context snapshot + headless pi subprocess spawning
├── DESIGN.md       # Architecture doc with A2A/ACP protocol mapping
└── test-link.ts    # Standalone tests for UDS + framing (14 tests)
```

## Constraints

- **No context pollution**: Silent mode must never inject messages into the host session
- **Same-user only**: UDS inherits filesystem permissions (0600 on socket)
- **No plaintext secrets over the socket**: Tasks are prompts, not credentials
- **No auto-execution**: Incoming tasks are processed by the agent with all safety gates
- **Stale cleanup**: Sockets older than 2h with no heartbeat are pruned on discovery
- **No npm dependencies**: Must work with only Node.js built-ins + pi's bundled packages
- **Bracket balance**: Every edit must maintain balanced braces — verify before installing

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:ca08a54f -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

## Session Completion

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   bd dolt push
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds
<!-- END BEADS INTEGRATION -->
