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
 *   /link create [name] [--http [port]]  — create a link endpoint
 *   /link                                 — pick an available link (auto-creates if none)
 *   /link http://host:port                — connect to remote link via HTTP
 *   /link status                          — show connection info
 *   /link list                            — show all links
 *   /link disconnect [id]                 — close a link
 *   /link version                         — show version + content hash
 *   /link-task <prompt>                   — send a silent task
 *   /link-task --visible <prompt>         — send a visible task
 */

import * as fs from "node:fs";
import * as net from "node:net";
import * as http from "node:http";
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
	HTTP_LINK_DEFAULT_PORT,
	HTTP_TASK_TIMEOUT_MS,
	type LinkMeta,
	type JsonRpcMessage,
	type LinkState,
	type LinkRecoveryData,
	type PendingTask,
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
	saveRecoveryData,
	loadRecoveryData,
	deleteRecoveryData,
	getLinkSecret,
	ensureLinkSecret,
	httpPostRpc,
} from "./types.js";
import { buildContextSnapshot, runSilentTask } from "./headless.js";

const LINK_VERSION = "v0.2.0";

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
	// ─── Multi-link state ─────────────────────────────────────────────────
	const linksRegistry = new Map<string, LinkState>();
	let state = createInitialState(); // active link (backward compat)
	let ctx: ExtensionContext | undefined;

	function setActiveLink(id: string): void {
		const link = linksRegistry.get(id);
		if (link) state = link;
	}

	function getActiveLink(): LinkState | undefined {
		if (state.mode !== "none") return state;
		return undefined;
	}

	function addLink(link: LinkState): void {
		linksRegistry.set(link.linkId, link);
		state = link; // new link becomes active
	}

	function removeLink(linkId: string): void {
		linksRegistry.delete(linkId);
		// Set active to next available connected link, or first available
		if (state.linkId === linkId) {
			let next: LinkState | undefined;
			for (const l of linksRegistry.values()) {
				if (l.isConnected) { next = l; break; }
			}
			if (!next) next = linksRegistry.values().next().value;
			state = next ?? createInitialState();
		}
	}

	// ─── Widget ────────────────────────────────────────────────────────────

	function updateWidget(): void {
		if (!ctx) return;

		if (linksRegistry.size === 0) {
			ctx.ui.setWidget("link", undefined);
			ctx.ui.setStatus("link", undefined);
			return;
		}

		if (linksRegistry.size === 1) {
			// Single link — compact display
			const link = linksRegistry.values().next().value;
			renderSingleLinkWidget(link);
			return;
		}

		// Multiple links
		const lines: string[] = [`🔗 Links (${linksRegistry.size})`];
		for (const [id, link] of linksRegistry) {
			const prefix = id === state.linkId ? "→ " : "  ";
			if (link.isConnected) {
				const peer = link.peerInfo?.sessionName ?? link.meta.sessionName;
				const transport = link.transport === "http" ? " [HTTP]" : "";
				lines.push(`${prefix}🔗 ${peer}${transport}`);
			} else if (link.mode === "host") {
				lines.push(`${prefix}⏳ ${link.meta.sessionName} (waiting)`);
			} else {
				lines.push(`${prefix}❌ ${link.meta.sessionName} (disconnected)`);
			}
		}
		ctx.ui.setWidget("link", lines);
		const connectedCount = [...linksRegistry.values()].filter(l => l.isConnected).length;
		ctx.ui.setStatus("link", `🔗 ${connectedCount}/${linksRegistry.size}`);
	}

	function renderSingleLinkWidget(link: LinkState): void {
		if (link.mode === "none") {
			ctx!.ui.setWidget("link", undefined);
			ctx!.ui.setStatus("link", undefined);
			return;
		}

		if (link.mode === "host") {
			if (link.recovering) {
				ctx!.ui.setWidget("link", [`🔗 Recovering link...`, `  ${link.meta.sessionName}`]);
				ctx!.ui.setStatus("link", "🔗 recovering...");
				return;
			}
			if (link.isConnected) {
				const peer = link.peerInfo?.sessionName ?? "peer";
				const transport = link.transport === "http" ? ` [HTTP :${link.httpPort}]` : "";
				ctx!.ui.setWidget("link", [`🔗 Linked (host) → ${peer}`, `  ${link.meta.model}${transport}`]);
				ctx!.ui.setStatus("link", `🔗 ${peer}`);
			} else {
				const transport = link.transport === "http" ? ` [HTTP :${link.httpPort}]` : "";
				ctx!.ui.setWidget("link", [`🔗 Waiting for peer...${transport}`, `  ${link.meta.sessionName}`, `  ${link.meta.model}`]);
				ctx!.ui.setStatus("link", "🔗 waiting...");
			}
			return;
		}

		// guest
		if (link.recovering) {
			ctx!.ui.setWidget("link", [`🔗 Recovering link...`, `  ${link.meta.sessionName}`]);
			ctx!.ui.setStatus("link", "🔗 recovering...");
			return;
		}
		if (link.isConnected) {
			const peer = link.meta.sessionName || link.meta.id;
			const transport = link.transport === "http" ? " [HTTP]" : "";
			ctx!.ui.setWidget("link", [`🔗 Linked (guest) → ${peer}${transport}`, `  ${link.peerInfo?.model ?? ""}`]);
			ctx!.ui.setStatus("link", `🔗 ${peer}`);
		} else {
			ctx!.ui.setWidget("link", undefined);
			ctx!.ui.setStatus("link", undefined);
		}
	}

	// ─── Per-link message handling ─────────────────────────────────────────
	// These functions operate on a specific link, not the global state.

	function handleDataForLink(link: LinkState, data: Buffer): void {
		link.lastPeerActivity = Date.now();
		link.buffer += data.toString();
		const { messages, remaining } = parseJsonRpcLines(link.buffer);
		link.buffer = remaining;
		for (const msg of messages) handleMsgForLink(link, msg);
	}

	function handleMsgForLink(link: LinkState, msg: JsonRpcMessage): void {
		// Resolve pending promises (ping responses)
		if (!msg.method && msg.id) {
			const resolver = link.resolveQueue.get(msg.id);
			if (resolver) {
				link.resolveQueue.delete(msg.id);
				resolver(msg);
			}
		}

		// Ping
		if (msg.method === "ping") {
			const conn = link.connection;
			if (conn && !conn.destroyed) {
				sendJsonRpc(conn, {
					jsonrpc: "2.0",
					id: msg.id,
					result: {
						sessionId: link.meta.sessionId,
						sessionName: link.meta.sessionName,
						model: link.meta.model,
						hash: loadTimeHash,
					},
				});
			}
			return;
		}

		// Version query
		if (msg.method === "version/get") {
			const conn = link.connection;
			if (conn && !conn.destroyed) {
				sendJsonRpc(conn, {
					jsonrpc: "2.0",
					id: msg.id,
					result: {
						version: LINK_VERSION,
						hash: loadTimeHash,
						sessionName: link.meta.sessionName,
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
			const conn = link.connection;
			if (conn && !conn.destroyed) {
				sendJsonRpc(conn, { jsonrpc: "2.0", id: msg.id, result: { taskId: p.taskId, status: "received", mode } });
			}

			if (mode === "silent") {
				processSilentTaskForLink(link, p);
			} else {
				processVisibleTaskForLink(link, p);
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

	async function processSilentTaskForLink(
		link: LinkState,
		p: { taskId: string; prompt: string; context?: string; replyTo?: string },
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

		const result = await runSilentTask(p.prompt, fullContext, ctx?.cwd ?? process.cwd(), link.meta.model);

		if (shouldReply) {
			const conn = link.connection;
			if (conn && !conn.destroyed) {
				sendJsonRpc(conn, {
					jsonrpc: "2.0",
					id: crypto.randomUUID(),
					result: { taskId: p.taskId, status: "completed", content: result.output, error: result.error },
				});
				ctx?.ui.notify(`📤 Silent task result sent (${p.taskId.slice(0, 8)})`, "success");
			}
		}
	}

	function processVisibleTaskForLink(link: LinkState, p: { taskId: string; prompt: string; context?: string; replyTo?: string }): void {
		let prompt = p.prompt;
		if (p.context) {
			prompt = `## Context from linked session\n\n${p.context}\n\n---\n\n${p.prompt}`;
		}

		if (p.replyTo === "sender" && p.taskId) {
			link.pendingTask = { taskId: p.taskId, replyTo: "sender", mode: "visible", receivedAt: Date.now() };
		}

		ctx?.ui.notify(`📥 Visible task: ${p.prompt.slice(0, 60)}...`, "info");
		pi.sendUserMessage(prompt, { deliverAs: "steer" });
	}

	// ─── Per-link heartbeat & lifecycle ────────────────────────────────────

	function startHeartbeatForLink(link: LinkState): void {
		link.lastPeerActivity = Date.now();
		link.heartbeatTimer = setInterval(() => {
			const conn = link.connection;
			if (!conn || conn.destroyed) return;

			// Detect half-open connection
			if (link.lastPeerActivity > 0 && Date.now() - link.lastPeerActivity > HEARTBEAT_TIMEOUT_MS) {
				handlePeerLostForLink(link, "heartbeat timeout — no response from peer");
				return;
			}

			sendJsonRpc(conn, createJsonRpc("ping", {
				sessionId: link.meta.sessionId,
				sessionName: link.meta.sessionName,
			}));
			link.meta.lastHeartbeat = Date.now();

			if (link.mode === "host" && link.isConnected) {
				writeMeta(path.join(LINKS_DIR, link.linkId), link.meta);
			}
		}, HEARTBEAT_INTERVAL_MS);
	}

	function stopHeartbeatForLink(link: LinkState): void {
		if (link.heartbeatTimer) {
			clearInterval(link.heartbeatTimer);
			link.heartbeatTimer = undefined;
		}
	}

	function handlePeerLostForLink(link: LinkState, reason: string): void {
		stopHeartbeatForLink(link);
		if (link.connection) { link.connection.destroy(); link.connection = undefined; }
		link.isConnected = false;

		if (link.mode === "host") {
			link.meta.status = "waiting";
			writeMeta(path.join(LINKS_DIR, link.linkId), link.meta);
		} else {
			link.mode = link.mode; // keep mode for display
			link.linkId = link.linkId;
			link.socketPath = "";
			link.meta.status = "waiting";
		}

		ctx?.ui.notify(`🔗 Peer lost: ${reason}`, "warning");
		updateWidget();
	}

	function cleanupLink(link: LinkState): void {
		stopHeartbeatForLink(link);
		if (link.connection) { link.connection.destroy(); link.connection = undefined; }
		if (link.server) { link.server.close(); link.server = undefined; }
		if (link.httpServer) {
			link.httpServer.close();
			link.httpServer = undefined;
			link.httpPort = undefined;
		}
		if (link.mode === "host" && link.linkId) {
			cleanupLinkDir(path.join(LINKS_DIR, link.linkId));
		}
		if (link.meta.sessionId) {
			deleteRecoveryData(link.meta.sessionId);
		}
		removeLink(link.linkId);
		updateWidget();
	}

	function cleanupAll(): void {
		for (const link of linksRegistry.values()) {
			stopHeartbeatForLink(link);
			if (link.connection) { link.connection.destroy(); link.connection = undefined; }
			if (link.server) { link.server.close(); link.server = undefined; }
			if (link.httpServer) { link.httpServer.close(); link.httpServer = undefined; }
			if (link.mode === "host" && link.linkId) {
				cleanupLinkDir(path.join(LINKS_DIR, link.linkId));
			}
			if (link.meta.sessionId) {
				deleteRecoveryData(link.meta.sessionId);
			}
		}
		linksRegistry.clear();
		state = createInitialState();
		updateWidget();
	}

	// ─── HTTP Adapter ─────────────────────────────────────────────────────

	function readBody(req: http.IncomingMessage): Promise<string> {
		return new Promise((resolve, reject) => {
			const chunks: Buffer[] = [];
			req.on("data", (chunk: Buffer) => chunks.push(chunk));
			req.on("end", () => resolve(Buffer.concat(chunks).toString()));
			req.on("error", reject);
		});
	}

	function startHttpAdapter(link: LinkState, port: number, secret: string): http.Server {
		const server = http.createServer(async (req, res) => {
			// CORS
			res.setHeader("Access-Control-Allow-Origin", "*");
			res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
			res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

			if (req.method === "OPTIONS") {
				res.writeHead(204);
				res.end();
				return;
			}

			// Auth
			const auth = req.headers["authorization"];
			if (auth !== `Bearer ${secret}`) {
				res.writeHead(401, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: 401, message: "Unauthorized" }, id: null }));
				return;
			}

			// Discovery (A2A-compatible agent card)
			if (req.url === "/.well-known/agent.json" && req.method === "GET") {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({
					name: link.meta.sessionName,
					url: `http://0.0.0.0:${port}`,
					model: link.meta.model,
					sessionId: link.meta.sessionId,
					protocol: "pi-link",
					version: LINK_VERSION,
					skills: ["task/send", "ping", "version/get"],
				}));
				return;
			}

			// Health check
			if (req.url === "/health" && req.method === "GET") {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ status: "ok", session: link.meta.sessionName, transport: "http" }));
				return;
			}

			// RPC endpoint
			if (req.url === "/rpc" && req.method === "POST") {
				try {
					const body = await readBody(req);
					const msg = JSON.parse(body) as JsonRpcMessage;
					const response = await handleHttpRpcForLink(link, msg);
					res.writeHead(200, { "Content-Type": "application/json" });
					res.end(JSON.stringify(response));
				} catch (err: any) {
					res.writeHead(500, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: err.message }, id: null }));
				}
				return;
			}

			res.writeHead(404);
			res.end("Not found");
		});

		server.listen(port, "0.0.0.0", () => {
			ctx?.ui.notify(`🔗 HTTP adapter listening on port ${port}`, "info");
		});

		server.on("error", (err) => {
			ctx?.ui.notify(`🔗 HTTP adapter error: ${err.message}`, "error");
		});

		return server;
	}

	async function handleHttpRpcForLink(link: LinkState, msg: JsonRpcMessage): Promise<JsonRpcMessage> {
		// Ping
		if (msg.method === "ping") {
			return {
				jsonrpc: "2.0",
				id: msg.id,
				result: {
					sessionId: link.meta.sessionId,
					sessionName: link.meta.sessionName,
					model: link.meta.model,
					hash: loadTimeHash,
				},
			};
		}

		// Version
		if (msg.method === "version/get") {
			return {
				jsonrpc: "2.0",
				id: msg.id,
				result: { version: LINK_VERSION, hash: loadTimeHash, sessionName: link.meta.sessionName },
			};
		}

		// Task send — synchronous for HTTP transport
		if (msg.method === "task/send") {
			const p = msg.params as { taskId: string; prompt: string; context?: string; replyTo?: string; mode?: string } | undefined;
			if (!p?.prompt) {
				return { jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "Missing prompt parameter" } };
			}

			const mode = p.mode === "visible" ? "visible" as const : "silent" as const;
			ctx?.ui.notify(`📥 HTTP task: ${p.prompt.slice(0, 60)}...`, "info");

			if (mode === "silent") {
				const ourContext = ctx ? buildContextSnapshot(() => ctx!.sessionManager.getBranch()) : undefined;
				let fullContext: string | undefined;
				if (p.context && ourContext) {
					fullContext = `## Sender's context\n\n${p.context}\n\n## Our context\n\n${ourContext}`;
				} else if (p.context) {
					fullContext = p.context;
				} else if (ourContext) {
					fullContext = ourContext;
				}

				const result = await runSilentTask(p.prompt, fullContext, ctx?.cwd ?? process.cwd(), link.meta.model);
				ctx?.ui.notify(`📤 HTTP task result sent (${p.taskId.slice(0, 8)})`, "success");
				return {
					jsonrpc: "2.0",
					id: msg.id,
					result: { taskId: p.taskId, status: "completed", content: result.output, error: result.error },
				};
			} else {
				// Visible mode — inject into session, return ack
				processVisibleTaskForLink(link, p);
				return {
					jsonrpc: "2.0",
					id: msg.id,
					result: { taskId: p.taskId, status: "received", mode: "visible", note: "Injected into session — result not returned over HTTP" },
				};
			}
		}

		return { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } };
	}

	async function connectHttpRemote(url: string, secret: string): Promise<LinkState> {
		// Discover remote session info
		const agentUrl = url.replace(/\/$/, "") + "/.well-known/agent.json";
		const agentInfo = await new Promise<any>((resolve, reject) => {
			const r = http.request(agentUrl, {
				method: "GET",
				headers: { Authorization: `Bearer ${secret}` },
				timeout: 10_000,
			}, (res) => {
				let data = "";
				res.on("data", (chunk: Buffer) => { data += chunk.toString(); });
				res.on("end", () => {
					if (res.statusCode === 200) {
						try { resolve(JSON.parse(data)); }
						catch { reject(new Error("Invalid agent card")); }
					} else {
						reject(new Error(`HTTP ${res.statusCode}: ${data}`));
					}
				});
			});
			r.on("error", reject);
			r.on("timeout", () => { r.destroy(); reject(new Error("Discovery timed out")); });
			r.end();
		});

		// Ping to verify connectivity
		const link = createInitialState();
		const pingResponse = await httpPostRpc(url, secret, createJsonRpc("ping", {
			sessionId: state.meta.sessionId,
			sessionName: state.meta.sessionName,
		}));

		const linkId = agentInfo.sessionId ?? generateId();
		link.mode = "guest";
		link.transport = "http";
		link.linkId = linkId;
		link.httpRemoteUrl = url;
		link.httpSecret = secret;
		link.isConnected = true;
		link.lastPeerActivity = Date.now();
		link.meta = {
			id: linkId,
			sessionId: agentInfo.sessionId ?? "",
			sessionName: agentInfo.name ?? "remote",
			model: agentInfo.model ?? "unknown",
			created: Date.now(),
			lastHeartbeat: Date.now(),
			status: "connected",
		};
		link.peerInfo = {
			sessionId: pingResponse.result?.sessionId as string ?? "",
			sessionName: pingResponse.result?.sessionName as string ?? agentInfo.name,
			model: pingResponse.result?.model as string ?? agentInfo.model,
		};

		// Start HTTP heartbeat
		link.heartbeatTimer = setInterval(async () => {
			if (Date.now() - link.lastPeerActivity > HEARTBEAT_TIMEOUT_MS) {
				handlePeerLostForLink(link, "HTTP heartbeat timeout");
				return;
			}
			try {
				await httpPostRpc(link.httpRemoteUrl!, link.httpSecret!, createJsonRpc("ping", {
					sessionId: link.meta.sessionId,
					sessionName: link.meta.sessionName,
				}), 10_000);
				link.lastPeerActivity = Date.now();
			} catch {
				// Remote unreachable — let timeout handle it
			}
		}, HEARTBEAT_INTERVAL_MS);

		addLink(link);
		return link;
	}

	// ─── Recovery ─────────────────────────────────────────────────────────

	async function attemptRecovery(c: ExtensionContext): Promise<void> {
		const recovery = loadRecoveryData(state.meta.sessionId);
		if (!recovery) return;

		if (Date.now() - recovery.savedAt > STALE_THRESHOLD_MS) {
			deleteRecoveryData(state.meta.sessionId);
			return;
		}

		if (!recovery.linkId) {
			deleteRecoveryData(state.meta.sessionId);
			return;
		}

		state.recovering = true;
		updateWidget();

		if (recovery.mode === "host") {
			await recoverAsHost(recovery, c);
		} else if (recovery.mode === "guest") {
			await recoverAsGuest(recovery, c);
		}

		deleteRecoveryData(state.meta.sessionId);
		state.recovering = false;
		updateWidget();
	}

	async function recoverAsHost(recovery: LinkRecoveryData, c: ExtensionContext): Promise<void> {
		ensureLinksDir();
		const linkDir = path.join(LINKS_DIR, recovery.linkId);
		const sockPath = path.join(linkDir, "link.sock");

		const link = createInitialState();
		fs.mkdirSync(linkDir, { recursive: true });
		const meta: LinkMeta = {
			...recovery.meta,
			sessionId: state.meta.sessionId,
			model: state.meta.model,
			lastHeartbeat: Date.now(),
			status: "waiting",
		};
		link.meta = meta;
		writeMeta(linkDir, meta);

		const server = net.createServer((socket) => {
			link.connection = socket;
			link.isConnected = true;
			link.buffer = "";
			link.lastPeerActivity = Date.now();
			link.recovering = false;
			link.meta.status = "connected";
			writeMeta(linkDir, link.meta);

			socket.on("data", (data) => handleDataForLink(link, data));
			socket.on("close", () => {
				stopHeartbeatForLink(link);
				link.isConnected = false;
				link.connection = undefined;
				link.meta.status = "waiting";
				writeMeta(linkDir, link.meta);
				c.ui.notify("🔗 Peer disconnected", "warning");
				updateWidget();
			});
			socket.on("error", (err) => { console.error("Link socket error:", err.message); });

			sendJsonRpc(socket, createJsonRpc("ping", { sessionId: meta.sessionId, sessionName: meta.sessionName }));
			startHeartbeatForLink(link);
			c.ui.notify("🔗 Peer reconnected!", "success");
			updateWidget();
		});

		try { if (fs.existsSync(sockPath)) fs.unlinkSync(sockPath); } catch { /* ignore */ }

		try {
			await new Promise<void>((resolve, reject) => {
				server.listen(sockPath, () => { fs.chmodSync(sockPath, 0o600); resolve(); });
				server.on("error", reject);
			});

			link.mode = "host";
			link.transport = "uds";
			link.linkId = recovery.linkId;
			link.socketPath = sockPath;
			link.server = server;
			if (recovery.peerInfo) link.peerInfo = recovery.peerInfo;

			addLink(link);
			c.ui.notify(`🔗 Link recovered (host): ${recovery.linkId}`, "success");
		} catch (err: any) {
			c.ui.notify(`🔗 Link recovery failed: ${err.message}`, "warning");
		}
	}

	async function recoverAsGuest(recovery: LinkRecoveryData, c: ExtensionContext): Promise<void> {
		const linkDir = path.join(LINKS_DIR, recovery.linkId);
		const sockPath = path.join(linkDir, "link.sock");

		const hostMeta = readMeta(linkDir);
		if (!hostMeta) {
			c.ui.notify("🔗 Link recovery failed: host link no longer exists", "warning");
			return;
		}

		const link = createInitialState();
		const socket = new net.Socket();
		socket.setTimeout(SOCKET_TIMEOUT_MS);

		socket.on("data", (data) => handleDataForLink(link, data));
		socket.on("close", () => {
			link.isConnected = false;
			link.connection = undefined;
			stopHeartbeatForLink(link);
			c.ui.notify("🔗 Link closed", "warning");
			cleanupLink(link);
		});
		socket.on("error", (err) => {
			console.error("Link error:", err.message);
			c.ui.notify(`🔗 Reconnection failed: ${err.message}`, "warning");
			link.mode = "none";
			removeLink(link.linkId);
			updateWidget();
		});
		socket.on("timeout", () => { c.ui.notify("🔗 Link timed out", "warning"); socket.destroy(); cleanupLink(link); });

		try {
			await new Promise<void>((resolve, reject) => {
				socket.connect(sockPath, () => resolve());
				socket.on("error", reject);
			});

			link.mode = "guest";
			link.transport = "uds";
			link.linkId = recovery.linkId;
			link.socketPath = sockPath;
			link.meta = hostMeta;
			link.connection = socket;
			link.isConnected = true;
			link.recovering = false;
			link.buffer = "";
			link.lastPeerActivity = Date.now();
			if (recovery.peerInfo) link.peerInfo = recovery.peerInfo;

			addLink(link);
			sendJsonRpc(socket, createJsonRpc("ping", { sessionId: link.meta.sessionId, sessionName: link.meta.sessionName }));
			startHeartbeatForLink(link);
			c.ui.notify(`🔗 Link recovered (guest) → ${hostMeta.sessionName}`, "success");
			updateWidget();
		} catch (err: any) {
			c.ui.notify(`🔗 Link recovery failed: ${err.message}`, "warning");
		}
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

	pi.on("session_start", async (event, c) => {
		ctx = c;
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
			await attemptRecovery(c);
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
		cleanupAll();
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

	// ─── Commands ──────────────────────────────────────────────────────────

	pi.registerCommand("link", {
		description: "Manage session links (create, join, status, disconnect, version, list, HTTP remote)",
		getArgumentCompletions: (prefix: string) => {
			const cmds = ["create", "status", "disconnect", "version", "list"];
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
				case "disconnect": return cmdDisconnect(rest, c);
				case "version": return cmdVersion(c);
				case "list": return cmdList(c);
				case "": return cmdJoin(c);
				default:
					if (sub.startsWith("http://") || sub.startsWith("https://")) {
						return cmdJoinHttp(sub, c);
					}
					c.ui.notify(`Unknown: ${sub}. Use: /link [create|status|disconnect|version|list|http://...]`, "error");
			}
		},
	});

	pi.registerCommand("link-task", {
		description: "Send a task to the linked session (--visible to inject into peer session)",
		handler: async (args, c) => {
			const link = getActiveLink();
			if (!link?.isConnected) { c.ui.notify("Not linked. Use /link to connect.", "warning"); return; }

			const trimmed = args.trim();
			if (!trimmed) { c.ui.notify("Usage: /link-task [--visible] <prompt>", "error"); return; }

			const isVisible = trimmed.startsWith("--visible");
			const prompt = isVisible ? trimmed.replace(/^--visible\s*/, "").trim() : trimmed;
			if (!prompt) { c.ui.notify("Usage: /link-task [--visible] <prompt>", "error"); return; }

			if (link.transport === "http" && link.httpRemoteUrl && link.httpSecret) {
				c.ui.notify("HTTP task sent via /link-task not yet supported. Use the link_send_task tool.", "warning");
				return;
			}

			const conn = link.connection;
			if (!conn || conn.destroyed) { c.ui.notify("Connection lost", "error"); cleanupLink(link); return; }

			sendJsonRpc(conn, createJsonRpc("task/send", {
				taskId: generateId(),
				prompt,
				mode: isVisible ? "visible" : "silent",
				replyTo: "sender",
			}));

			const badge = isVisible ? "👁 visible" : "🔇 silent";
			c.ui.notify(`📤 Task sent (${badge}) to ${link.meta.sessionName}`, "info");
		},
	});

	async function cmdCreate(args: string, c: ExtensionContext): Promise<void> {
		// Parse --http [port] flag
		const httpMatch = args.match(/--http(?:\s+(\d+))?/);
		const httpPort = httpMatch ? parseInt(httpMatch[1] || String(HTTP_LINK_DEFAULT_PORT), 10) : undefined;
		const name = args.replace(/--http(?:\s+\d+)?/, "").trim();

		ensureLinksDir();
		const linkId = generateId();
		const linkDir = path.join(LINKS_DIR, linkId);
		const sockPath = path.join(linkDir, "link.sock");
		fs.mkdirSync(linkDir, { recursive: true });

		const link = createInitialState();
		const meta: LinkMeta = {
			id: linkId,
			sessionId: state.meta.sessionId,
			sessionName: name || state.meta.sessionName,
			model: state.meta.model,
			created: Date.now(),
			lastHeartbeat: Date.now(),
			status: "waiting",
		};
		link.meta = meta;
		writeMeta(linkDir, meta);

		const server = net.createServer((socket) => {
			link.connection = socket;
			link.isConnected = true;
			link.buffer = "";
			link.lastPeerActivity = Date.now();
			link.meta.status = "connected";
			writeMeta(linkDir, link.meta);

			socket.on("data", (data) => handleDataForLink(link, data));
			socket.on("close", () => {
				stopHeartbeatForLink(link);
				link.isConnected = false;
				link.connection = undefined;
				link.meta.status = "waiting";
				writeMeta(linkDir, link.meta);
				c.ui.notify("🔗 Peer disconnected", "warning");
				updateWidget();
			});
			socket.on("error", (err) => { console.error("Link socket error:", err.message); });

			sendJsonRpc(socket, createJsonRpc("ping", { sessionId: meta.sessionId, sessionName: meta.sessionName }));
			startHeartbeatForLink(link);
			c.ui.notify("🔗 Peer connected!", "success");
			updateWidget();
		});

		try { if (fs.existsSync(sockPath)) fs.unlinkSync(sockPath); } catch { /* ignore */ }

		await new Promise<void>((resolve, reject) => {
			server.listen(sockPath, () => { fs.chmodSync(sockPath, 0o600); resolve(); });
			server.on("error", reject);
		});

		link.mode = "host";
		link.transport = httpPort ? "http" : "uds";
		link.linkId = linkId;
		link.socketPath = sockPath;
		link.server = server;

		// Start HTTP adapter if requested
		if (httpPort) {
			const secret = ensureLinkSecret();
			link.httpServer = startHttpAdapter(link, httpPort, secret);
			link.httpPort = httpPort;
			link.httpSecret = secret;
			c.ui.notify(`🔗 Shared secret: ${secret.slice(0, 8)}... (full: ${path.join(LINKS_DIR, "shared-secret")})`, "info");
		}

		addLink(link);
		c.ui.notify(`🔗 Link created: ${linkId} (${meta.sessionName})${httpPort ? ` [HTTP :${httpPort}]` : ""}`, "success");
		updateWidget();
	}

	async function cmdJoin(c: ExtensionContext): Promise<void> {
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

		const link = createInitialState();
		const socket = new net.Socket();
		socket.setTimeout(SOCKET_TIMEOUT_MS);

		socket.on("data", (data) => handleDataForLink(link, data));
		socket.on("close", () => {
			link.isConnected = false;
			link.connection = undefined;
			stopHeartbeatForLink(link);
			c.ui.notify("🔗 Link closed", "warning");
			cleanupLink(link);
		});
		socket.on("error", (err) => {
			console.error("Link error:", err.message);
			c.ui.notify(`Connection failed: ${err.message}`, "error");
			removeLink(link.linkId);
			updateWidget();
		});
		socket.on("timeout", () => { c.ui.notify("Link timed out", "warning"); socket.destroy(); cleanupLink(link); });

		await new Promise<void>((resolve, reject) => { socket.connect(selected.socketPath, () => resolve()); socket.on("error", reject); });

		link.mode = "guest";
		link.transport = "uds";
		link.linkId = selected.meta.id;
		link.socketPath = selected.socketPath;
		link.meta = selected.meta;
		link.connection = socket;
		link.isConnected = true;
		link.buffer = "";
		link.lastPeerActivity = Date.now();

		addLink(link);
		sendJsonRpc(socket, createJsonRpc("ping", { sessionId: link.meta.sessionId, sessionName: link.meta.sessionName }));
		startHeartbeatForLink(link);
		c.ui.notify(`🔗 Connected to ${selected.meta.sessionName}`, "success");
		updateWidget();
	}

	async function cmdJoinHttp(url: string, c: ExtensionContext): Promise<void> {
		let secret = getLinkSecret();
		if (!secret) {
			c.ui.notify("No shared secret found. Set PI_LINK_SECRET env var or create ~/.pi/links/shared-secret on both machines.", "warning");
			return;
		}

		try {
			c.ui.notify(`🔗 Connecting to ${url}...`, "info");
			await connectHttpRemote(url, secret);
			c.ui.notify(`🔗 Connected (HTTP) → ${state.meta.sessionName}`, "success");
			updateWidget();
		} catch (err: any) {
			c.ui.notify(`🔗 HTTP connection failed: ${err.message}`, "error");
		}
	}

	function cmdList(c: ExtensionContext): void {
		const lines: string[] = [];

		if (linksRegistry.size === 0) {
			const localLinks = discoverLinks().filter((l) => l.meta.sessionId !== state.meta.sessionId);
			if (localLinks.length > 0) {
				lines.push(`No active links. ${localLinks.length} local UDS link(s) available.`);
				for (const l of localLinks) {
					const status = l.meta.status === "connected" ? "🔴 busy" : "🟢 idle";
					lines.push(`  ${l.meta.sessionName} (${l.meta.model}) ${status} — ${l.meta.id.slice(0, 8)}`);
				}
			} else {
				lines.push("No active links.");
			}
			lines.push("\nTo join a remote link: /link http://host:port");
			c.ui.notify(lines.join("\n"), "info");
			return;
		}

		let i = 0;
		for (const [id, link] of linksRegistry) {
			const isActive = id === state.linkId;
			const prefix = isActive ? "→ " : "  ";
			const transport = link.transport === "http" ? " [HTTP]" : " [UDS]";
			const connStatus = link.isConnected ? "🟢 connected" : "🔴 disconnected";

			lines.push(`${prefix}[${i}] ${link.meta.sessionName}${transport} ${connStatus} (${id.slice(0, 8)})`);
			if (link.peerInfo?.sessionName) lines.push(`    peer: ${link.peerInfo.sessionName}`);
			if (link.transport === "http") {
				if (link.httpPort) lines.push(`    HTTP port: ${link.httpPort}`);
				if (link.httpRemoteUrl) lines.push(`    remote: ${link.httpRemoteUrl}`);
			}
			i++;
		}

		lines.push(`\nActive link: ${state.linkId ? state.meta.sessionName : "none"}`);
		lines.push("To switch: /link switch <index>");
		c.ui.notify(lines.join("\n"), "info");
	}

	function cmdStatus(c: ExtensionContext): void {
		const link = getActiveLink();
		if (!link) {
			const available = discoverLinks();
			c.ui.notify(available.length === 0 ? "No active links." : `${available.length} link(s) available. /link to join.`, "info");
			return;
		}

		const lines = [
			`Mode: ${link.mode} (${link.isConnected ? "connected" : "disconnected"})`,
			`Transport: ${link.transport.toUpperCase()}`,
			`Link ID: ${link.linkId}`,
			`Session: ${link.meta.sessionName}`,
			`Model: ${link.meta.model}`,
		];
		if (link.transport === "http") {
			if (link.httpPort) lines.push(`HTTP port: ${link.httpPort}`);
			if (link.httpRemoteUrl) lines.push(`Remote URL: ${link.httpRemoteUrl}`);
		}
		if (link.recovering) lines.push(`Status: recovering...`);
		if (link.peerInfo?.sessionName) lines.push(`Peer: ${link.peerInfo.sessionName}`);
		if (link.peerInfo?.model) lines.push(`Peer model: ${link.peerInfo.model}`);

		if (linksRegistry.size > 1) {
			lines.push(`\nTotal links: ${linksRegistry.size}`);
		}

		c.ui.notify(lines.join("\n"), "info");
	}

	function cmdDisconnect(args: string, c: ExtensionContext): void {
		if (linksRegistry.size === 0) { c.ui.notify("Not linked", "info"); return; }

		// /link disconnect [id_or_index]
		const target = args.trim();
		if (target) {
			// Try to find by ID prefix or index
			let foundLink: LinkState | undefined;
			for (const [id, link] of linksRegistry) {
				if (id.startsWith(target)) { foundLink = link; break; }
			}
			if (!foundLink) {
				// Try by index
				const idx = parseInt(target, 10);
				if (!isNaN(idx)) {
					const links = [...linksRegistry.values()];
					foundLink = links[idx];
				}
			}
			if (foundLink) {
				c.ui.notify(`🔗 Disconnecting ${foundLink.meta.sessionName}...`, "info");
				cleanupLink(foundLink);
				return;
			}
			c.ui.notify(`Link "${target}" not found. Use /link list to see all links.`, "error");
			return;
		}

		// No target — disconnect active link
		const link = getActiveLink();
		if (!link) { c.ui.notify("Not linked", "info"); return; }
		c.ui.notify("🔗 Disconnected", "info");
		cleanupLink(link);
	}

	function cmdVersion(c: ExtensionContext): void {
		try {
			const content = fs.readFileSync(path.join(os.homedir(), ".pi", "agent", "extensions", "link", "index.ts"), "utf-8");
			const diskHash = crypto.createHash("sha256").update(content).digest("hex").slice(0, 8);
			const localHash = loadTimeHash;
			const lines: string[] = [];

			if (diskHash !== localHash && localHash !== "unknown") {
				lines.push(`⚠️ You: ${LINK_VERSION} loaded:${localHash} disk:${diskHash} (STALE — /reload to update)`);
			} else {
				lines.push(`You: ${LINK_VERSION} (${localHash})`);
			}

			const link = getActiveLink();
			if (link?.isConnected && link.connection && !link.connection.destroyed) {
				const reqId = crypto.randomUUID();
				const timeout = setTimeout(() => {
					link.resolveQueue.delete(reqId);
					lines.push(`Peer: (no response — may be running older version without version/get support)`);
					c.ui.notify(lines.join("\n"), localHash !== diskHash ? "warning" : "info");
				}, 3000);

				link.resolveQueue.set(reqId, (msg: any) => {
					clearTimeout(timeout);
					const peer = msg.result;
					if (peer?.hash) {
						const match = peer.hash === localHash;
						const peerLabel = peer.sessionName ? ` (${peer.sessionName})` : "";
						lines.push(`Peer${peerLabel}: ${peer.version || "?"} (${peer.hash})${match ? "" : " ⚠️ MISMATCH"}`);
						c.ui.notify(lines.join("\n"), match ? "info" : "warning");
					} else {
						lines.push(`Peer: unknown version`);
						c.ui.notify(lines.join("\n"), "info");
					}
				});

				sendJsonRpc(link.connection, { jsonrpc: "2.0", id: reqId, method: "version/get", params: {} });
			} else {
				c.ui.notify(lines.join("\n"), localHash !== diskHash ? "warning" : "info");
			}
		} catch {
			c.ui.notify(`link extension ${LINK_VERSION}`, "info");
		}
	}

	// ─── Tools ─────────────────────────────────────────────────────────────

	pi.registerTool({
		name: "link_send_task",
		label: "Link: Send Task",
		description: [
			"Send a task/prompt to a linked pi session.",
			'Default mode is "silent" — runs headless, peer context untouched.',
			'Use mode "visible" to inject into peer session (collaborative).',
			"Supports both UDS (local) and HTTP (remote) transports.",
		].join(" "),
		promptSnippet: "Send a task to a linked pi session for cross-session collaboration",
		parameters: Type.Object({
			prompt: Type.String({ description: "The task or prompt to send to the linked session" }),
			mode: Type.Optional(Type.String({ description: '"silent" (default) or "visible"', default: "silent" })),
			include_context: Type.Optional(Type.Boolean({ description: "Include recent conversation as context", default: false })),
			reply_to: Type.Optional(Type.String({ description: '"sender" to get result back, "none" to fire-and-forget', default: "sender" })),
			target: Type.Optional(Type.String({ description: "Target link ID prefix, index, or session name (default: active link)" })),
		}),
		async execute(_id, params, _signal, onUpdate, c) {
			// Resolve target link
			let link = resolveTargetLink(params.target as string | undefined);
			if (!link?.isConnected) {
				if (params.target) {
					return { content: [{ type: "text", text: `Target link "${params.target}" not found or not connected.` }], details: { connected: false }, isError: true };
				}
				return { content: [{ type: "text", text: "Not linked. Use /link to connect." }], details: { connected: false } };
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

			onUpdate?.({ content: [{ type: "text", text: `Sending ${taskMode} task ${taskId.slice(0, 8)} to ${link.meta.sessionName}...` }] });

			// HTTP transport: synchronous request-response
			if (link.transport === "http" && link.httpRemoteUrl && link.httpSecret) {
				try {
					const response = await httpPostRpc(link.httpRemoteUrl, link.httpSecret, createJsonRpc("task/send", {
						taskId,
						prompt: params.prompt,
						context,
						mode: taskMode,
						replyTo: params.reply_to ?? "sender",
					}));

					const result = response.result as any;
					if (result?.status === "completed" && result.content) {
						return {
							content: [{ type: "text", text: result.content }],
							details: { taskId, peer: link.meta.sessionName, mode: taskMode, sent: true, content: result.content },
						};
					}

					const badge = taskMode === "visible" ? "👁" : "🔇";
					return {
						content: [{ type: "text", text: `Task ${taskId.slice(0, 8)} sent to ${link.meta.sessionName} (${badge}). Status: ${result?.status ?? "unknown"}` }],
						details: { taskId, peer: link.meta.sessionName, mode: taskMode, sent: true },
						terminate: taskMode === "silent",
					};
				} catch (err: any) {
					return {
						content: [{ type: "text", text: `HTTP task failed: ${err.message}` }],
						details: { taskId, sent: false, error: err.message },
						isError: true,
					};
				}
			}

			// UDS transport: async message
			const conn = link.connection;
			if (!conn || conn.destroyed) {
				return { content: [{ type: "text", text: "Connection lost." }], details: { connected: false }, isError: true };
			}

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
				content: [{ type: "text", text: `Task ${taskId.slice(0, 8)} sent to ${link.meta.sessionName} (${badge}).${willReply ? " Result will return." : " Fire-and-forget."}` }],
				details: { taskId, peer: link.meta.sessionName, mode: taskMode, replyTo: params.reply_to, sent: true },
				terminate: taskMode === "silent",
			};
		},
		renderCall(args, theme) {
			const preview = ((args.prompt as string) ?? "...").slice(0, 60);
			const mode = args.mode === "visible" ? theme.fg("warning", "👁") : theme.fg("dim", "🔇");
			const reply = args.reply_to === "sender" ? theme.fg("accent", "↩") : theme.fg("dim", "→");
			const target = args.target ? ` ${theme.fg("dim", `→${args.target}`)}` : "";
			return new Text(theme.fg("toolTitle", theme.bold("link ")) + `${mode} ${reply}${target} ` + theme.fg("dim", preview), 0, 0);
		},
		renderResult(result, _opts, theme) {
			const d = result.details as { taskId?: string; peer?: string; sent?: boolean; mode?: string } | undefined;
			if (!d?.sent) return new Text(theme.fg("warning", "Not linked"), 0, 0);
			const badge = d.mode === "visible" ? theme.fg("warning", "👁") : theme.fg("dim", "🔇");
			return new Text(`${theme.fg("success", "📤")} ${badge} Task sent to ${theme.fg("accent", d.peer ?? "peer")} (${d.taskId?.slice(0, 8)})`, 0, 0);
		},
	});

	/** Resolve a target link by ID prefix, index, or session name. */
	function resolveTargetLink(target: string | undefined): LinkState | undefined {
		if (!target) return getActiveLink();

		// By ID prefix
		for (const [id, link] of linksRegistry) {
			if (id.startsWith(target)) return link;
		}

		// By session name
		for (const link of linksRegistry.values()) {
			if (link.meta.sessionName === target) return link;
		}

		// By peer session name
		for (const link of linksRegistry.values()) {
			if (link.peerInfo?.sessionName === target) return link;
		}

		// By index
		const idx = parseInt(target, 10);
		if (!isNaN(idx)) {
			const links = [...linksRegistry.values()];
			return links[idx];
		}

		return undefined;
	}

	pi.registerTool({
		name: "link_status",
		label: "Link: Status",
		description: "Check the current link connection status and peer information.",
		parameters: Type.Object({}),
		async execute() {
			const allLinks: Record<string, unknown>[] = [];
			for (const [id, link] of linksRegistry) {
				const info: Record<string, unknown> = {
					id: id.slice(0, 8),
					mode: link.mode,
					transport: link.transport,
					connected: link.isConnected,
					sessionName: link.meta.sessionName,
					model: link.meta.model,
					active: id === state.linkId,
					peer: link.peerInfo,
				};
				if (link.transport === "http") {
					if (link.httpPort) info.httpPort = link.httpPort;
					if (link.httpRemoteUrl) info.httpRemoteUrl = link.httpRemoteUrl;
				}
				allLinks.push(info);
			}
			return {
				content: [{ type: "text", text: JSON.stringify({ totalLinks: allLinks.length, activeLink: state.linkId?.slice(0, 8), links: allLinks }, null, 2) }],
				details: { totalLinks: allLinks.length, links: allLinks },
			};
		},
	});
}
