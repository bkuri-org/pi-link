# Changelog

All notable changes to pi-link will be documented in this file.

## [1.0.0] - 2026-05-11

### Added
- **UDS transport**: Unix domain sockets with JSON-RPC 2.0 framing
- **HTTP transport**: Cross-machine linking with Bearer token auth and `/.well-known/agent.json` discovery
- **Multi-link**: Connect to multiple peers simultaneously, target by ID prefix, name, or index
- **Streaming**: Real-time chunk delivery via `task/stream` method with live widget preview
- **Silent mode**: Headless `pi --mode json` subprocess — peer context stays clean
- **Visible mode**: Direct session injection for collaborative workflows
- **Activity indicator**: Spinner animation in widget + compact LED in status bar during task execution
- **Persistence**: Links survive `/reload` via recovery data stored in `~/.pi/link-recovery/`
- **Half-open detection**: 60s heartbeat timeout detects silently dropped peers
- **Version mismatch**: `/link version` compares hashes between peers, warns on mismatch
- **Jiti cache detection**: Warns on session start when extension files changed but cached version is loaded
- **`link_send_task` tool**: LLM-callable tool for cross-session task delegation
- **`link_status` tool**: LLM-callable tool for connection status checks
- **Custom `📥 Peer Response` renderer**: Formatted display of peer task results
- **110 tests** across 3 suites (core, new features, headless/edge cases)
- **Village admin skill**: Global skill at `~/.pi/agent/skills/village/SKILL.md`

### Fixed
- Crash on disconnect when peer already cleaned up link directory (ENOENT race)
- Heartbeat ordering: `stopHeartbeat()` before `writeMeta()` prevents stale timer firing after cleanup
- Test link artifacts (`__test_` prefix) no longer leak into `/link` discovery
- `include_context` defaults to `true` when `reply_to` is `"sender"` (no more empty-context round trips)

## [0.2.0] - 2026-05-11

### Added
- Multi-link support with `linksRegistry`
- Streaming results via `task/stream`
- HTTP adapter for cross-machine linking
- Village skill iteration

## [0.1.0] - 2026-05-11

### Added
- Initial release: UDS transport, silent/visible modes, `/link` commands, basic widget
