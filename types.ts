import * as fs from "node:fs";
import * as net from "node:net";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";

// ─── Constants ───────────────────────────────────────────────────────────────

export const LINKS_DIR = path.join(os.homedir(), ".pi", "links");
export const LINK_RECOVERY_DIR = path.join(os.homedir(), ".pi", "link-recovery");
export const STALE_THRESHOLD_MS = 2 * 60 * 60 * 1000;
export const HEARTBEAT_INTERVAL_MS = 30_000;
export const SOCKET_TIMEOUT_MS = 120_000;
export const HEARTBEAT_TIMEOUT_MS = 60_000;
export const HTTP_LINK_DEFAULT_PORT = 4567;
export const HTTP_LINK_SECRET_FILE = path.join(LINKS_DIR, "shared-secret");
export const HTTP_TASK_TIMEOUT_MS = 300_000;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface LinkMeta {
	id: string;
	sessionId: string;
	sessionName: string;
	model: string;
	created: number;
	lastHeartbeat: number;
	status: "waiting" | "connected";
}

export interface JsonRpcMessage {
	jsonrpc: "2.0";
	id: string;
	method?: string;
	params?: Record<string, unknown>;
	result?: Record<string, unknown>;
	error?: { code: number; message: string };
}

export interface PendingTask {
	taskId: string;
	replyTo: string;
	mode: "silent" | "visible";
	receivedAt: number;
}

export interface LinkRecoveryData {
	sessionId: string;
	mode: "host" | "guest";
	linkId: string;
	meta: LinkMeta;
	peerInfo?: { sessionId: string; sessionName?: string; model?: string };
	savedAt: number;
}

export interface LinkState {
	mode: "none" | "host" | "guest";
	transport: "uds" | "http";
	linkId: string;
	socketPath: string;
	meta: LinkMeta;
	connection?: net.Socket;
	server?: net.Server;
	buffer: string;
	resolveQueue: Map<string, (msg: JsonRpcMessage) => void>;
	isConnected: boolean;
	peerInfo?: { sessionId: string; sessionName?: string; model?: string };
	heartbeatTimer?: ReturnType<typeof setInterval>;
	lastPeerActivity: number;
	pendingTask?: PendingTask;
	recovering: boolean;
	httpServer?: import("node:http").Server;
	httpPort?: number;
	httpRemoteUrl?: string;
	httpSecret?: string;
}

export function createInitialState(): LinkState {
	return {
		mode: "none",
		transport: "uds",
		linkId: "",
		socketPath: "",
		meta: {
			id: "",
			sessionId: "",
			sessionName: "",
			model: "",
			created: 0,
			lastHeartbeat: 0,
			status: "waiting",
		},
		buffer: "",
		resolveQueue: new Map(),
		isConnected: false,
		lastPeerActivity: 0,
		pendingTask: undefined,
		recovering: false,
	};
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function ensureLinksDir(): void {
	fs.mkdirSync(LINKS_DIR, { recursive: true });
}

export function generateId(): string {
	return crypto.randomBytes(4).toString("hex");
}

export function readMeta(linkDir: string): LinkMeta | null {
	try {
		const raw = fs.readFileSync(path.join(linkDir, "meta.json"), "utf-8");
		return JSON.parse(raw) as LinkMeta;
	} catch {
		return null;
	}
}

export function writeMeta(linkDir: string, meta: LinkMeta): void {
	try {
		fs.mkdirSync(linkDir, { recursive: true });
		fs.writeFileSync(
			path.join(linkDir, "meta.json"),
			JSON.stringify(meta, null, 2),
			{ encoding: "utf-8", mode: 0o600 },
		);
	} catch (err: any) {
		if (err.code !== "ENOENT") throw err;
		// Directory was cleaned up by the other side — ignore
	}
}

export interface DiscoveredLink {
	meta: LinkMeta;
	socketPath: string;
	dir: string;
}

export function discoverLinks(): DiscoveredLink[] {
	ensureLinksDir();
	const results: DiscoveredLink[] = [];

	try {
		const entries = fs.readdirSync(LINKS_DIR, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			if (entry.name.startsWith("__test_")) continue; // skip test artifacts
			const dir = path.join(LINKS_DIR, entry.name);
			const meta = readMeta(dir);
			if (!meta) continue;

			if (Date.now() - meta.lastHeartbeat > STALE_THRESHOLD_MS) {
				cleanupLinkDir(dir);
				continue;
			}

			results.push({ meta, socketPath: path.join(dir, "link.sock"), dir });
		}
	} catch {
		// Directory doesn't exist yet
	}

	return results;
}

export function cleanupLinkDir(dir: string): void {
	try {
		const sock = path.join(dir, "link.sock");
		if (fs.existsSync(sock)) fs.unlinkSync(sock);
		fs.rmSync(dir, { recursive: true, force: true });
	} catch {
		// Best effort
	}
}

// ─── Recovery helpers ─────────────────────────────────────────────────────

export function getRecoveryFilePath(sessionId: string): string {
	return path.join(LINK_RECOVERY_DIR, `${sessionId}.json`);
}

export function saveRecoveryData(sessionId: string, data: LinkRecoveryData): void {
	try {
		fs.mkdirSync(LINK_RECOVERY_DIR, { recursive: true });
		fs.writeFileSync(
			getRecoveryFilePath(sessionId),
			JSON.stringify(data, null, 2),
			{ encoding: "utf-8", mode: 0o600 },
		);
	} catch {
		// Best effort — if we can't save, link won't survive reload
	}
}

export function loadRecoveryData(sessionId: string): LinkRecoveryData | null {
	try {
		const raw = fs.readFileSync(getRecoveryFilePath(sessionId), "utf-8");
		return JSON.parse(raw) as LinkRecoveryData;
	} catch {
		return null;
	}
}

export function deleteRecoveryData(sessionId: string): void {
	try {
		fs.unlinkSync(getRecoveryFilePath(sessionId));
	} catch {
		// Best effort
	}
}

export function createJsonRpc(method: string, params: Record<string, unknown>): JsonRpcMessage {
	return { jsonrpc: "2.0", id: crypto.randomUUID(), method, params };
}

// ─── HTTP helpers ───────────────────────────────────────────────────────

export function getLinkSecret(): string {
	const envSecret = process.env.PI_LINK_SECRET;
	if (envSecret) return envSecret;
	try {
		return fs.readFileSync(HTTP_LINK_SECRET_FILE, "utf-8").trim();
	} catch {
		return "";
	}
}

export function ensureLinkSecret(): string {
	let secret = getLinkSecret();
	if (!secret) {
		secret = crypto.randomBytes(16).toString("hex");
		ensureLinksDir();
		fs.writeFileSync(HTTP_LINK_SECRET_FILE, secret, { encoding: "utf-8", mode: 0o600 });
	}
	return secret;
}

export function httpPostRpc(
	baseUrl: string,
	secret: string,
	msg: JsonRpcMessage,
	timeoutMs = HTTP_TASK_TIMEOUT_MS,
): Promise<JsonRpcMessage> {
	const rpcUrl = baseUrl.replace(/\/$/, "") + "/rpc";
	const body = JSON.stringify(msg);

	return new Promise((resolve, reject) => {
		const r = http.request(rpcUrl, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Content-Length": Buffer.byteLength(body),
				Authorization: `Bearer ${secret}`,
			},
			timeout: timeoutMs,
		}, (res) => {
			let data = "";
			res.on("data", (chunk: Buffer) => { data += chunk.toString(); });
			res.on("end", () => {
				try { resolve(JSON.parse(data) as JsonRpcMessage); }
				catch { reject(new Error("Invalid JSON response from remote")); }
			});
		});
		r.on("error", reject);
		r.on("timeout", () => { r.destroy(); reject(new Error("HTTP request timed out")); });
		r.write(body);
		r.end();
	});
}

export function sendJsonRpc(socket: net.Socket, msg: JsonRpcMessage): void {
	socket.write(JSON.stringify(msg) + "\n");
}

export function parseJsonRpcLines(buffer: string): { messages: JsonRpcMessage[]; remaining: string } {
	const messages: JsonRpcMessage[] = [];
	const lines = buffer.split("\n");
	const remaining = lines.pop() ?? "";

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			messages.push(JSON.parse(trimmed) as JsonRpcMessage);
		} catch {
			// Malformed line, skip
		}
	}

	return { messages, remaining };
}

export function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(execName)) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}
