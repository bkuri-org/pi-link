/**
 * Link Extension — Connect two pi sessions via Unix domain sockets
 *
 * Two task modes:
 *   silent  (default) — spawns a headless pi subprocess, context stays clean
 *   visible — injects into session, both agents share context
 *
 * Usage:
 *   /link create [name]     — create a link endpoint
 *   /link                    — pick an available link (auto-creates if none)
 *   /link status             — show connection info
 *   /link disconnect         — close the link
 *   /link version            — show version + content hash
 *   /link-task <prompt>      — send a silent task
 *   /link-task --visible <prompt> — send a visible task
 */

import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import {
	LINKS_DIR,
	STALE_THRESHOLD_MS,
	HEARTBEAT_INTERVAL_MS,
	HEARTBEAT_TIMEOUT_MS,
	SOCKET_TIMEOUT_MS,
	type LinkMeta,
	type JsonRpcMessage,
	type LinkState,
	createInitialState,
	ensureLinksDir,
	generateId,
	readMeta,
	writeMeta,
	discoverLinks,
	cleanupLinkDir,
	createJsonRpc,
	sendJsonRpc,
	parseJsonRpcLines,
} from "./types.js";
import { buildContextSnapshot, runSilentTask } from "./headless.js";

const LINK_VERSION = "v0.1.0";

export default function (pi: ExtensionAPI) {
	let state = createInitialState();
	let ctx: ExtensionContext | undefined;

	// ─── Widget ────────────────────────────────────────────────────────────

	function updateWidget(): void {
		if (!ctx) return;

		if (state.mode === "none") {
			ctx.ui.setWidget("link", undefined);
			ctx.ui.setStatus("link", undefined);
			return;
		}

		if (state.mode === "host") {
			if (state.isConnected) {
				const peer = state.peerInfo?.sessionName ?? "peer";
				ctx.ui.setWidget("link", [`🔗 Linked (host) → ${peer}`, `  ${state.meta.model}`]);
				ctx.ui.setStatus("link", `🔗 ${peer}`);
			} else {
				ctx.ui.setWidget("link", [`🔗 Waiting for peer...`, `  ${state.meta.sessionName}`, `  ${state.meta.model}`]);
				ctx.ui.setStatus("link", "🔗 waiting...");
			}
			return;
		}

		// guest
		if (state.isConnected) {
			const peer = state.meta.sessionName || state.meta.id;
			ctx.ui.setWidget("link", [`🔗 Linked (guest) → ${peer}`, `  ${state.peerInfo?.model ?? ""}`]);
			ctx.ui.setStatus("link", `🔗 ${peer}`);
		} else {
			ctx.ui.setWidget("link", undefined);
			ctx.ui.setStatus("link", undefined);
		}
	}

	// ─── Socket ────────────────────────────────────────────────────────────

	function handleData(data: Buffer): void {
		state.lastPeerActivity = Date.now();
		state.buffer += data.toString();
		const { messages, remaining } = parseJsonRpcLines(state.buffer);
		state.buffer = remaining;
		for (const msg of messages) handleMsg(msg);
	}

	function handleMsg(msg: JsonRpcMessage): void {
		// Resolve pending promises (ping responses)
		if (!msg.method && msg.id) {
			const resolver = state.resolveQueue.get(msg.id);
			if (resolver) {
				state.resolveQueue.delete(msg.id);
				resolver(msg);
			}
			// Don't return — fall through to result handler
		}

		// Ping
		if (msg.method === "ping") {
			const conn = state.connection;
			if (conn && !conn.destroyed) {
				sendJsonRpc(conn, {
					jsonrpc: "2.0",
					id: msg.id,
					result: {
						sessionId: state.meta.sessionId,
						sessionName: state.meta.sessionName,
						model: state.meta.model,
					},
				});
			}
			return;
		}

		// Incoming task
		if (msg.method === "task/send") {
			const p = msg.params as { taskId: string; prompt: string; context?: string; replyTo?: string; mode?: string } | undefined;
			if (!p?.prompt) return;

			const mode = p.mode === "visible" ? "visible" as const : "silent" as const;

			// Ack
			const conn = state.connection;
			if (conn && !conn.destroyed) {
				sendJsonRpc(conn, { jsonrpc: "2.0", id: msg.id, result: { taskId: p.taskId, status: "received", mode } });
			}

			if (mode === "silent") {
				processSilentTask(p, conn);
			} else {
				processVisibleTask(p);
			}
			return;
		}

		// Incoming task result
		if (!msg.method && msg.result && typeof msg.result === "object") {
			const r = msg.result as { taskId?: string; status?: string; content?: string };
			if (r.status === "completed" && r.content) {
				ctx?.ui.notify(`📥 Result from peer (${r.taskId?.slice(0, 8)})`, "success");
				pi.sendMessage({
					customType: "link-result",
					content: r.content,
					display: true,
					details: { taskId: r.taskId },
				}, { triggerTurn: true, deliverAs: "steer" });
			}
			return;
		}
	}

	async function processSilentTask(
		p: { taskId: string; prompt: string; context?: string; replyTo?: string },
		conn: net.Socket | undefined,
	): Promise<void> {
		const shouldReply = p.replyTo === "sender";
		ctx?.ui.notify(`📥 Silent task: ${p.prompt.slice(0, 60)}...`, "info");

		const ourContext = ctx ? buildContextSnapshot(() => ctx!.sessionManager.getBranch()) : undefined;
		let fullContext: string | undefined;
		if (p.context && ourContext) {
			fullContext = `## Sender's context\n\n${p.context}\n\n## Our context\n\n${ourContext}`;
		} else if (p.context) {
			fullContext = p.context;
		} else if (ourContext) {
			fullContext = ourContext;
		}

		const result = await runSilentTask(p.prompt, fullContext, ctx?.cwd ?? process.cwd(), state.meta.model);

		if (shouldReply && conn && !conn.destroyed) {
			sendJsonRpc(conn, {
				jsonrpc: "2.0",
				id: crypto.randomUUID(),
				result: { taskId: p.taskId, status: "completed", content: result.output, error: result.error },
			});
			ctx?.ui.notify(`📤 Silent task result sent (${p.taskId.slice(0, 8)})`, "success");
		}
	}

	function processVisibleTask(p: { taskId: string; prompt: string; context?: string; replyTo?: string }): void {
		let prompt = p.prompt;
		if (p.context) {
			prompt = `## Context from linked session\n\n${p.context}\n\n---\n\n${p.prompt}`;
		}

		if (p.replyTo === "sender" && p.taskId) {
			state.pendingTask = { taskId: p.taskId, replyTo: "sender", mode: "visible", receivedAt: Date.now() };
		}

		ctx?.ui.notify(`📥 Visible task: ${p.prompt.slice(0, 60)}...`, "info");
		pi.sendUserMessage(prompt, { deliverAs: "steer" });
	}

	function handlePeerLost(reason: string): void {
		stopHeartbeat();
		if (state.connection) { state.connection.destroy(); state.connection = undefined; }
		state.isConnected = false;

		if (state.mode === "host") {
			state.meta.status = "waiting";
			writeMeta(path.join(LINKS_DIR, state.linkId), state.meta);
		} else {
			state.mode = "none";
			state.linkId = "";
			state.socketPath = "";
			state.meta.status = "waiting";
		}

		ctx?.ui.notify(`🔗 Peer lost: ${reason}`, "warning");
		updateWidget();
	}

	function startHeartbeat(): void {
		state.lastPeerActivity = Date.now();
		state.heartbeatTimer = setInterval(() => {
			const conn = state.connection;
			if (!conn || conn.destroyed) return;

			// Detect half-open connection
			if (state.lastPeerActivity > 0 && Date.now() - state.lastPeerActivity > HEARTBEAT_TIMEOUT_MS) {
				handlePeerLost("heartbeat timeout — no response from peer");
				return;
			}

			sendJsonRpc(conn, createJsonRpc("ping", {
				sessionId: state.meta.sessionId,
				sessionName: state.meta.sessionName,
			}));
			state.meta.lastHeartbeat = Date.now();

			if (state.mode === "host" && state.isConnected) {
				writeMeta(path.join(LINKS_DIR, state.linkId), state.meta);
			}
		}, HEARTBEAT_INTERVAL_MS);
	}

	function stopHeartbeat(): void {
		if (state.heartbeatTimer) {
			clearInterval(state.heartbeatTimer);
			state.heartbeatTimer = undefined;
		}
	}

	function cleanup(): void {
		stopHeartbeat();
		if (state.connection) { state.connection.destroy(); state.connection = undefined; }
		if (state.server) { state.server.close(); state.server = undefined; }
		if (state.mode === "host" && state.linkId) {
			cleanupLinkDir(path.join(LINKS_DIR, state.linkId));
		}
		state = createInitialState();
		updateWidget();
	}

	// ─── Events ────────────────────────────────────────────────────────────

	pi.registerMessageRenderer("link-result", (message, _options, theme) => {
		const lines = [theme.fg("accent", theme.bold("📥 Peer Response"))];
		if (message.details?.taskId) {
			lines.push(theme.fg("dim", `  task: ${message.details.taskId}`));
		}
		lines.push("", message.content as string);
		return new Text(lines.join("\n"), 0, 0);
	});

	pi.on("session_start", async (_event, c) => {
		ctx = c;
		const sessionFile = c.sessionManager.getSessionFile();
		state.meta.sessionId = sessionFile ?? crypto.randomUUID();
		state.meta.sessionName = pi.getSessionName() ?? path.basename(sessionFile ?? "unnamed", ".jsonl");
		state.meta.model = c.model ? `${c.model.provider}/${c.model.id}` : "unknown";
	});

	pi.on("session_shutdown", async () => { cleanup(); });

	pi.on("agent_end", async (event, c) => {
		if (!state.pendingTask || !state.isConnected) return;
		if (state.pendingTask.mode !== "visible") return;

		const task = state.pendingTask;
		state.pendingTask = undefined;

		const conn = state.connection;
		if (!conn || conn.destroyed) return;

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
	});

	// ─── Commands ──────────────────────────────────────────────────────────

	pi.registerCommand("link", {
		description: "Manage session links (create, join, status, disconnect, version)",
		getArgumentCompletions: (prefix: string) => {
			const cmds = ["create", "status", "disconnect", "version"];
			const filtered = cmds.filter((c) => c.startsWith(prefix));
			return filtered.length > 0 ? filtered.map((c) => ({ value: c, label: c })) : null;
		},
		handler: async (args, c) => {
			if (!c.hasUI) { c.ui.notify("/link requires interactive mode", "error"); return; }

			const parts = args.trim().split(/\s+/);
			const sub = parts[0] || "";
			const rest = parts.slice(1).join(" ");

			switch (sub) {
				case "create": return cmdCreate(rest, c);
				case "status": return cmdStatus(c);
				case "disconnect": return cmdDisconnect(c);
				case "version": return cmdVersion(c);
				case "": return cmdJoin(c);
				default: c.ui.notify(`Unknown: ${sub}. Use: /link [create|status|disconnect|version]`, "error");
			}
		},
	});

	pi.registerCommand("link-task", {
		description: "Send a task to the linked session (--visible to inject into peer session)",
		handler: async (args, c) => {
			if (!state.isConnected) { c.ui.notify("Not linked. Use /link to connect.", "warning"); return; }

			const trimmed = args.trim();
			if (!trimmed) { c.ui.notify("Usage: /link-task [--visible] <prompt>", "error"); return; }

			const isVisible = trimmed.startsWith("--visible");
			const prompt = isVisible ? trimmed.replace(/^--visible\s*/, "").trim() : trimmed;
			if (!prompt) { c.ui.notify("Usage: /link-task [--visible] <prompt>", "error"); return; }

			const conn = state.connection;
			if (!conn || conn.destroyed) { c.ui.notify("Connection lost", "error"); cleanup(); return; }

			sendJsonRpc(conn, createJsonRpc("task/send", {
				taskId: generateId(),
				prompt,
				mode: isVisible ? "visible" : "silent",
				replyTo: "sender",
			}));

			const badge = isVisible ? "👁 visible" : "🔇 silent";
			c.ui.notify(`📤 Task sent (${badge})`, "info");
		},
	});

	async function cmdCreate(name: string, c: ExtensionContext): Promise<void> {
		if (state.mode !== "none") { c.ui.notify("Already linked. /link disconnect first.", "warning"); return; }

		ensureLinksDir();
		const linkId = generateId();
		const linkDir = path.join(LINKS_DIR, linkId);
		const sockPath = path.join(linkDir, "link.sock");
		fs.mkdirSync(linkDir, { recursive: true });

		const meta: LinkMeta = {
			id: linkId,
			sessionId: state.meta.sessionId,
			sessionName: name || state.meta.sessionName,
			model: state.meta.model,
			created: Date.now(),
			lastHeartbeat: Date.now(),
			status: "waiting",
		};
		writeMeta(linkDir, meta);

		const server = net.createServer((socket) => {
			state.connection = socket;
			state.isConnected = true;
			state.buffer = "";
			state.lastPeerActivity = Date.now();
			state.meta.status = "connected";
			writeMeta(linkDir, state.meta);

			socket.on("data", handleData);
			socket.on("close", () => {
				stopHeartbeat();
				state.isConnected = false;
				state.connection = undefined;
				state.meta.status = "waiting";
				writeMeta(linkDir, state.meta);
				c.ui.notify("🔗 Peer disconnected", "warning");
				updateWidget();
			});
			socket.on("error", (err) => { console.error("Link socket error:", err.message); });

			sendJsonRpc(socket, createJsonRpc("ping", { sessionId: meta.sessionId, sessionName: meta.sessionName }));
			startHeartbeat();
			c.ui.notify("🔗 Peer connected!", "success");
			updateWidget();
		});

		try { if (fs.existsSync(sockPath)) fs.unlinkSync(sockPath); } catch { /* ignore */ }

		await new Promise<void>((resolve, reject) => {
			server.listen(sockPath, () => { fs.chmodSync(sockPath, 0o600); resolve(); });
			server.on("error", reject);
		});

		state.mode = "host";
		state.linkId = linkId;
		state.socketPath = sockPath;
		state.meta = meta;
		state.server = server;

		c.ui.notify(`🔗 Link created: ${linkId} (${meta.sessionName})`, "success");
		updateWidget();
	}

	async function cmdJoin(c: ExtensionContext): Promise<void> {
		if (state.mode !== "none") { c.ui.notify("Already linked. /link disconnect first.", "warning"); return; }

		const filtered = discoverLinks().filter((l) => l.meta.sessionId !== state.meta.sessionId);

		if (filtered.length === 0) {
			c.ui.notify("No active links found — creating one for you.", "info");
			return cmdCreate("", c);
		}

		const items = filtered.map((l) => {
			const age = Math.round((Date.now() - l.meta.created) / 1000);
			const ageStr = age < 60 ? `${age}s` : age < 3600 ? `${Math.round(age / 60)}m` : `${Math.round(age / 3600)}h`;
			const status = l.meta.status === "connected" ? "🔴 busy" : "🟢 idle";
			return { dir: l.dir, label: `${l.meta.sessionName} (${l.meta.model}) ${status} — ${ageStr} ago` };
		});

		const labels = items.map((i) => i.label);
		const choice = await c.ui.select("Join a link:", labels);
		if (!choice) { c.ui.notify("Cancelled", "info"); return; }

		const selected = filtered[labels.indexOf(choice)];
		if (!selected) { c.ui.notify("Link not found", "error"); return; }

		const socket = new net.Socket();
		socket.setTimeout(SOCKET_TIMEOUT_MS);

		socket.on("data", handleData);
		socket.on("close", () => { state.isConnected = false; state.connection = undefined; stopHeartbeat(); c.ui.notify("🔗 Link closed", "warning"); cleanup(); });
		socket.on("error", (err) => { console.error("Link error:", err.message); c.ui.notify(`Connection failed: ${err.message}`, "error"); state.mode = "none"; updateWidget(); });
		socket.on("timeout", () => { c.ui.notify("Link timed out", "warning"); socket.destroy(); cleanup(); });

		await new Promise<void>((resolve, reject) => { socket.connect(selected.socketPath, () => resolve()); socket.on("error", reject); });

		state.mode = "guest";
		state.linkId = selected.meta.id;
		state.socketPath = selected.socketPath;
		state.meta = selected.meta;
		state.connection = socket;
		state.isConnected = true;
		state.buffer = "";
		state.lastPeerActivity = Date.now();

		sendJsonRpc(socket, createJsonRpc("ping", { sessionId: state.meta.sessionId, sessionName: state.meta.sessionName }));
		startHeartbeat();
		c.ui.notify(`🔗 Connected to ${selected.meta.sessionName}`, "success");
		updateWidget();
	}

	function cmdStatus(c: ExtensionContext): void {
		if (state.mode === "none") {
			const available = discoverLinks();
			c.ui.notify(available.length === 0 ? "No active links." : `${available.length} link(s) available. /link to join.`, "info");
			return;
		}

		const lines = [
			`Mode: ${state.mode} (${state.isConnected ? "connected" : "disconnected"})`,
			`Link ID: ${state.linkId}`,
			`Session: ${state.meta.sessionName}`,
			`Model: ${state.meta.model}`,
		];
		if (state.peerInfo?.sessionName) lines.push(`Peer: ${state.peerInfo.sessionName}`);
		if (state.peerInfo?.model) lines.push(`Peer model: ${state.peerInfo.model}`);
		c.ui.notify(lines.join("\n"), "info");
	}

	function cmdDisconnect(c: ExtensionContext): void {
		if (state.mode === "none") { c.ui.notify("Not linked", "info"); return; }
		c.ui.notify("🔗 Disconnected", "info");
		cleanup();
	}

	function cmdVersion(c: ExtensionContext): void {
		try {
			const content = fs.readFileSync(path.join(os.homedir(), ".pi", "agent", "extensions", "link", "index.ts"), "utf-8");
			const hash = crypto.createHash("sha256").update(content).digest("hex").slice(0, 8);
			c.ui.notify(`link extension ${LINK_VERSION} (${hash})`, "info");
		} catch {
			c.ui.notify(`link extension ${LINK_VERSION}`, "info");
		}
	}

	// ─── Tools ─────────────────────────────────────────────────────────────

	pi.registerTool({
		name: "link_send_task",
		label: "Link: Send Task",
		description: [
			"Send a task/prompt to the linked pi session.",
			'Default mode is "silent" — runs headless, peer context untouched.',
			'Use mode "visible" to inject into peer session (collaborative).',
		].join(" "),
		promptSnippet: "Send a task to a linked pi session for cross-session collaboration",
		parameters: Type.Object({
			prompt: Type.String({ description: "The task or prompt to send to the linked session" }),
			mode: Type.Optional(Type.String({ description: '"silent" (default) or "visible"', default: "silent" })),
			include_context: Type.Optional(Type.Boolean({ description: "Include recent conversation as context", default: false })),
			reply_to: Type.Optional(Type.String({ description: '"sender" to get result back, "none" to fire-and-forget', default: "sender" })),
		}),
		async execute(_id, params, _signal, onUpdate, c) {
			if (!state.isConnected) {
				return { content: [{ type: "text", text: "Not linked. Use /link to connect." }], details: { connected: false } };
			}

			const conn = state.connection;
			if (!conn || conn.destroyed) {
				return { content: [{ type: "text", text: "Connection lost." }], details: { connected: false }, isError: true };
			}

			const taskId = generateId();
			const taskMode = params.mode === "visible" ? "visible" : "silent";

			const wantReply = (params.reply_to ?? "sender") === "sender";
			const includeContext = params.include_context === true || (params.include_context === undefined && wantReply);

			let context: string | undefined;
			if (includeContext) {
				const recent = c.sessionManager.getBranch()
					.filter((e: any) => e.type === "message" && e.message.role === "assistant")
					.slice(-5)
					.map((e: any) => {
						const text = e.message.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
						return text.length > 200 ? text.slice(0, 200) + "..." : text;
					})
					.join("\n\n");
				context = recent || undefined;
			}

			onUpdate?.({ content: [{ type: "text", text: `Sending ${taskMode} task ${taskId.slice(0, 8)} to ${state.meta.sessionName}...` }] });

			sendJsonRpc(conn, createJsonRpc("task/send", {
				taskId,
				prompt: params.prompt,
				context,
				mode: taskMode,
				replyTo: params.reply_to ?? "sender",
			}));

			const willReply = wantReply;
			const badge = taskMode === "visible" ? "👁" : "🔇";
			return {
				content: [{ type: "text", text: `Task ${taskId.slice(0, 8)} sent to ${state.meta.sessionName} (${badge}).${willReply ? " Result will return." : " Fire-and-forget."}` }],
				details: { taskId, peer: state.meta.sessionName, mode: taskMode, replyTo: params.reply_to, sent: true },
				terminate: taskMode === "silent",
			};
		},
		renderCall(args, theme) {
			const preview = ((args.prompt as string) ?? "...").slice(0, 60);
			const mode = args.mode === "visible" ? theme.fg("warning", "👁") : theme.fg("dim", "🔇");
			const reply = args.reply_to === "sender" ? theme.fg("accent", "↩") : theme.fg("dim", "→");
			return new Text(theme.fg("toolTitle", theme.bold("link ")) + `${mode} ${reply} ` + theme.fg("dim", preview), 0, 0);
		},
		renderResult(result, _opts, theme) {
			const d = result.details as { taskId?: string; peer?: string; sent?: boolean; mode?: string } | undefined;
			if (!d?.sent) return new Text(theme.fg("warning", "Not linked"), 0, 0);
			const badge = d.mode === "visible" ? theme.fg("warning", "👁") : theme.fg("dim", "🔇");
			return new Text(`${theme.fg("success", "📤")} ${badge} Task sent to ${theme.fg("accent", d.peer ?? "peer")} (${d.taskId?.slice(0, 8)})`, 0, 0);
		},
	});

	pi.registerTool({
		name: "link_status",
		label: "Link: Status",
		description: "Check the current link connection status and peer information.",
		parameters: Type.Object({}),
		async execute() {
			return {
				content: [{ type: "text", text: JSON.stringify({ mode: state.mode, connected: state.isConnected, linkId: state.linkId, sessionName: state.meta.sessionName, model: state.meta.model, peer: state.peerInfo }, null, 2) }],
				details: { mode: state.mode, connected: state.isConnected, peer: state.peerInfo },
			};
		},
	});
}
