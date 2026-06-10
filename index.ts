/**
 * Link Extension — Connect pi sessions via Unix domain sockets or HTTP
 *
 * Two task modes:
 *   silent  (default) — spawns a headless pi subprocess, context stays clean
 *   visible — injects into session, both agents share context
 *
 * Two transports:
 *   uds  — Unix domain sockets (local, zero-dep)
 *   http — HTTP adapter (cross-machine, shared secret auth)
 *
 * Multi-link: support multiple simultaneous connections.
 *
 * Usage:
 *   /link                — smart: join existing or create new
 *   /link new [name] [--interview] [--http [port]] — create a link endpoint
 *   /link join            — discover and pick an existing link
 *   /link interview       — join as interviewer (🎤 → interviewee)
 *   /link http://host:port — connect to remote link via HTTP
 *   /link status           — show connection info
 *   /link role             — show or change interview role
 *   /link list             — show all links
 *   /link disconnect [id]  — close a link
 *   /link purge [--force]  — remove all inactive links + stale disk state
 *   /link version          — show version + content hash
 *   /link-task <prompt>    — send a silent task
 *   /link-task --visible <prompt> — send a visible task
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
	type LinkState,
	type LinkRecoveryData,
	createInitialState,
	ensureLinksDir,
	generateId,
	sendJsonRpc,
	saveRecoveryData,
} from "./types.js";
import type { LinkContext } from "./link-context.js";
import { initActivity } from "./activity.js";
import { initWidget } from "./widget.js";
import { initMessageHandler } from "./message-handler.js";
import { initLifecycle } from "./lifecycle.js";
import { initHttpAdapter } from "./http-adapter.js";
import { initRecovery } from "./recovery.js";
import { initCommands } from "./commands.js";
import { initTools } from "./tools.js";

const LINK_VERSION = "v1.0.0";

// Compute content hash at load time for cache-bust detection
const EXTENSION_DIR = path.join(os.homedir(), ".pi", "agent", "extensions", "link");
function computeHash(): string {
	try {
		const content = fs.readFileSync(path.join(EXTENSION_DIR, "index.ts"), "utf-8");
		return crypto.createHash("sha256").update(content).digest("hex").slice(0, 8);
	} catch { return "unknown"; }
}
const loadTimeHash = computeHash();

export default function (pi: ExtensionAPI) {
	// ─── Build shared context bag ────────────────────────────────────────
	const linksRegistry = new Map<string, LinkState>();
	const streamBuffers = new Map<string, string>();
	let state = createInitialState();
	let ctx: ExtensionContext | undefined;

	const lc: LinkContext = {
		pi,
		ctx,
		loadTimeHash,
		linksRegistry,
		state,
		streamBuffers,

		// State management — populated inline below
		setActiveLink: () => {},
		addLink: () => {},
		removeLink: () => {},
		getActiveLink: () => undefined,

		// Stubs — populated by init* functions
		updateWidget: () => {},
		setActivity: () => {},
		clearActivity: () => {},
		formatActivity: () => "",
		stopSpinner: () => {},
		handleDataForLink: () => {},
		processVisibleTaskForLink: () => {},
		startHeartbeatForLink: () => {},
		stopHeartbeatForLink: () => {},
		handlePeerLostForLink: () => {},
		cleanupLink: () => {},
		cleanupAll: () => {},
		startHttpAdapter: () => { throw new Error("not initialized"); },
		handleHttpRpcForLink: async () => ({ jsonrpc: "2.0" as const, id: "" }),
		connectHttpRemote: async () => createInitialState(),
		attemptRecovery: async () => {},
	};

	// ─── Multi-link state management ─────────────────────────────────────
	lc.setActiveLink = (id: string): void => {
		const link = linksRegistry.get(id);
		if (link) state = link;
	};

	lc.getActiveLink = (): LinkState | undefined => {
		if (state.mode !== "none") return state;
		return undefined;
	};

	lc.addLink = (link: LinkState): void => {
		linksRegistry.set(link.linkId, link);
		state = link;
	};

	lc.removeLink = (linkId: string): void => {
		linksRegistry.delete(linkId);
		if (state.linkId === linkId) {
			let next: LinkState | undefined;
			for (const l of linksRegistry.values()) {
				if (l.isConnected) { next = l; break; }
			}
			if (!next) next = linksRegistry.values().next().value;
			state = next ?? createInitialState();
		}
	};

	// ─── Initialize modules (order matters: deps first) ─────────────────
	// Widget depends on: formatActivity (from activity)
	// Message handler depends on: updateWidget, setActivity, clearActivity, processVisibleTaskForLink
	// Lifecycle depends on: handlePeerLostForLink, removeLink, updateWidget
	// HTTP adapter depends on: handleHttpRpcForLink, processVisibleTaskForLink, handlePeerLostForLink, addLink
	// Recovery depends on: handleDataForLink, stopHeartbeatForLink, startHeartbeatForLink, addLink, cleanupLink
	// Commands depends on: everything
	// Tools depends on: setActivity, addLink

	initActivity(lc);    // sets: setActivity, clearActivity, formatActivity, stopSpinner
	initWidget(lc);      // sets: updateWidget (uses formatActivity from context)
	initLifecycle(lc);   // sets: startHeartbeatForLink, stopHeartbeatForLink, handlePeerLostForLink, cleanupLink, cleanupAll
	initMessageHandler(lc); // sets: handleDataForLink, processVisibleTaskForLink
	initHttpAdapter(lc); // sets: startHttpAdapter, handleHttpRpcForLink, connectHttpRemote
	initRecovery(lc);    // sets: attemptRecovery
	initCommands(lc);    // registers /link and /link-task commands
	initTools(lc);       // registers link_send_task and link_status tools

	// ─── Events ────────────────────────────────────────────────────────────

	pi.registerMessageRenderer("link-result", (message, _options, theme) => {
		const lines = [theme.fg("accent", theme.bold("📥 Peer Response"))];
		if (message.details?.taskId) {
			lines.push(theme.fg("dim", `  task: ${message.details.taskId}`));
		}
		lines.push("", message.content as string);
		return new Text(lines.join("\n"), 0, 0);
	});

	pi.on("session_start", async (event, c) => {
		lc.ctx = c;
		const sessionFile = c.sessionManager.getSessionFile();
		state.meta.sessionId = sessionFile ?? crypto.randomUUID();
		state.meta.sessionName = pi.getSessionName() ?? path.basename(sessionFile ?? "unnamed", ".jsonl");
		state.meta.model = c.model ? `${c.model.provider}/${c.model.id}` : "unknown";

		// Check if extension files changed since load (jiti cache stale)
		const currentHash = computeHash();
		if (currentHash !== loadTimeHash && loadTimeHash !== "unknown") {
			c.ui.notify(
				`⚠️ Link extension changed on disk (${loadTimeHash} → ${currentHash}). Run /reload to pick up changes.`,
				"warning",
			);
		}

		// Attempt to recover a link after reload
		if ((event as any).reason === "reload") {
			await lc.attemptRecovery(c);
		}
	});

	pi.on("session_shutdown", async (event) => {
		// Persist link state for recovery on reload
		if (linksRegistry.size > 0 && (event as any).reason === "reload") {
			for (const link of linksRegistry.values()) {
				if (link.mode !== "none" && link.meta.sessionId) {
					saveRecoveryData(link.meta.sessionId, {
						sessionId: link.meta.sessionId,
						mode: link.mode as "host" | "guest",
						linkId: link.linkId,
						meta: link.meta,
						peerInfo: link.peerInfo,
						savedAt: Date.now(),
					});
				}
			}
		}
		lc.cleanupAll();
	});

	pi.on("agent_end", async (event, c) => {
		// Check all links for pending visible tasks
		for (const link of linksRegistry.values()) {
			if (!link.pendingTask || !link.isConnected) continue;
			if (link.pendingTask.mode !== "visible") continue;

			const task = link.pendingTask;
			link.pendingTask = undefined;

			const conn = link.connection;
			if (!conn || conn.destroyed) continue;

			let resultText = "";
			for (let i = event.messages.length - 1; i >= 0; i--) {
				if (event.messages[i].role === "assistant") {
					resultText = (event.messages[i].content as Array<{ type: string; text?: string }>)
						.filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
					break;
				}
			}

			sendJsonRpc(conn, { jsonrpc: "2.0", id: crypto.randomUUID(), result: { taskId: task.taskId, status: "completed", content: resultText } });
			c.ui.notify("📤 Task result sent to peer", "success");
		}
	});
}
