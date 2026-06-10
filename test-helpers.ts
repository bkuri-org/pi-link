/**
 * Shared test helpers for pi-link-extension tests.
 */

import * as fs from "node:fs";
import * as net from "node:net";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import {
	LINKS_DIR,
	type LinkMeta,
	type LinkState,
	type JsonRpcMessage,
	createInitialState,
	generateId,
	createJsonRpc,
	sendJsonRpc,
	parseJsonRpcLines,
} from "./types.js";

// ─── Test runner ──────────────────────────────────────────────────────────

export let passed = 0;
export let failed = 0;

export function test(name: string, fn: () => void | Promise<void>): void {
	try {
		const result = fn();
		if (result instanceof Promise) {
			result.then(
				() => { passed++; console.log(`  ✅ ${name}`); },
				(err) => { failed++; console.log(`  ❌ ${name}: ${err.message}`); },
			);
		} else {
			passed++;
			console.log(`  ✅ ${name}`);
		}
	} catch (err: any) {
		failed++;
		console.log(`  ❌ ${name}: ${err.message}`);
	}
}

export function assert(condition: boolean, msg: string): void {
	if (!condition) throw new Error(msg);
}

export function assertEq<T>(actual: T, expected: T, msg?: string): void {
	if (actual !== expected) throw new Error(msg ?? `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

export function resetCounts(): void {
	passed = 0;
	failed = 0;
}

// ─── Multi-link registry helpers ─────────────────────────────────────────

export function makeLink(opts: {
	linkId: string;
	sessionName?: string;
	mode?: LinkState["mode"];
	isConnected?: boolean;
	transport?: LinkState["transport"];
	peerInfo?: LinkState["peerInfo"];
}): LinkState {
	const link = createInitialState();
	link.linkId = opts.linkId;
	link.meta = {
		id: opts.linkId,
		sessionId: `sess-${opts.linkId}`,
		sessionName: opts.sessionName ?? opts.linkId,
		model: "test/model",
		created: Date.now(),
		lastHeartbeat: Date.now(),
		status: "connected",
	};
	if (opts.mode) link.mode = opts.mode;
	if (opts.isConnected !== undefined) link.isConnected = opts.isConnected;
	if (opts.transport) link.transport = opts.transport;
	if (opts.peerInfo) link.peerInfo = opts.peerInfo;
	return link;
}

/** Replicate linksRegistry CRUD from index.ts */
export function createRegistry() {
	const linksRegistry = new Map<string, LinkState>();
	const stateRef = { current: createInitialState() as LinkState };

	function addLink(link: LinkState) {
		linksRegistry.set(link.linkId, link);
		stateRef.current = link;
	}

	function removeLink(linkId: string) {
		linksRegistry.delete(linkId);
		if (stateRef.current.linkId === linkId) {
			let next: LinkState | undefined;
			for (const l of linksRegistry.values()) {
				if (l.isConnected) { next = l; break; }
			}
			if (!next) next = linksRegistry.values().next().value;
			stateRef.current = next ?? createInitialState();
		}
	}

	function getActiveLink(): LinkState | undefined {
		if (stateRef.current.mode !== "none") return stateRef.current;
		return undefined;
	}

	function resolveTargetLink(target: string | undefined): LinkState | undefined {
		if (!target) return getActiveLink();
		for (const [id, link] of linksRegistry) {
			if (id.startsWith(target)) return link;
		}
		for (const link of linksRegistry.values()) {
			if (link.meta.sessionName === target) return link;
		}
		for (const link of linksRegistry.values()) {
			if (link.peerInfo?.sessionName === target) return link;
		}
		const idx = parseInt(target, 10);
		if (!isNaN(idx)) {
			return [...linksRegistry.values()][idx];
		}
		return undefined;
	}

	return { linksRegistry, state: stateRef, addLink, removeLink, getActiveLink, resolveTargetLink };
}

// ─── HTTP test helpers ────────────────────────────────────────────────────

export function getFreePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = net.createServer();
		srv.listen(0, "127.0.0.1", () => {
			const addr = srv.address() as net.AddressInfo;
			srv.close(() => resolve(addr.port));
		});
		srv.on("error", reject);
	});
}

function readBody(req: http.IncomingMessage): Promise<string> {
	return new Promise((res, rej) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => res(Buffer.concat(chunks).toString()));
		req.on("error", rej);
	});
}

/** Handle /rpc endpoint — ping and task/send methods. */
function handleRpcRoute(
	req: http.IncomingMessage,
	res: http.ServerResponse,
	link: LinkState,
): Promise<void> {
	return readBody(req).then((body) => {
		const msg = JSON.parse(body) as JsonRpcMessage;

		if (msg.method === "ping") {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({
				jsonrpc: "2.0", id: msg.id,
				result: { sessionId: link.meta.sessionId, sessionName: link.meta.sessionName, model: link.meta.model },
			}));
			return;
		}
		if (msg.method === "task/send") {
			const p = msg.params as any;
			if (!p?.prompt) {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "Missing prompt parameter" } }));
				return;
			}
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({
				jsonrpc: "2.0", id: msg.id,
				result: { taskId: p.taskId, status: "received", mode: p.mode ?? "silent" },
			}));
			return;
		}
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } }));
	}).catch((err: any) => {
		res.writeHead(500, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: err.message }, id: null }));
	});
}

/** Create a mock HTTP server that mirrors the link HTTP adapter for testing. */
export function createTestHttpServer(link: LinkState, secret: string, port: number): Promise<http.Server> {
	return new Promise((resolve, reject) => {
		const server = http.createServer(async (req, res) => {
			res.setHeader("Access-Control-Allow-Origin", "*");
			res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
			res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

			if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

			const auth = req.headers["authorization"];
			if (auth !== `Bearer ${secret}`) {
				res.writeHead(401, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: 401, message: "Unauthorized" }, id: null }));
				return;
			}

			if (req.url === "/.well-known/agent.json" && req.method === "GET") {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({
					name: link.meta.sessionName,
					url: `http://0.0.0.0:${port}`,
					model: link.meta.model,
					sessionId: link.meta.sessionId,
					protocol: "pi-link",
					version: "v0.2.0",
					skills: ["task/send", "ping", "version/get"],
				}));
				return;
			}

			if (req.url === "/health" && req.method === "GET") {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ status: "ok", session: link.meta.sessionName, transport: "http" }));
				return;
			}

			if (req.url === "/rpc" && req.method === "POST") {
				await handleRpcRoute(req, res, link);
				return;
			}

			res.writeHead(404);
			res.end("Not found");
		});

		server.listen(port, "127.0.0.1", () => resolve(server));
		server.on("error", reject);
	});
}

export function httpGet(url: string, headers: Record<string, string> = {}): Promise<{ statusCode: number; body: string }> {
	return new Promise((resolve, reject) => {
		const r = http.request(url, { method: "GET", headers, timeout: 5000 }, (res) => {
			let data = "";
			res.on("data", (chunk: Buffer) => { data += chunk.toString(); });
			res.on("end", () => resolve({ statusCode: res.statusCode ?? 0, body: data }));
		});
		r.on("error", reject);
		r.on("timeout", () => { r.destroy(); reject(new Error("timeout")); });
		r.end();
	});
}

export function httpPost(url: string, body: string, headers: Record<string, string> = {}): Promise<{ statusCode: number; resBody: string }> {
	return new Promise((resolve, reject) => {
		const r = http.request(url, { method: "POST", headers, timeout: 5000 }, (res) => {
			let data = "";
			res.on("data", (chunk: Buffer) => { data += chunk.toString(); });
			res.on("end", () => resolve({ statusCode: res.statusCode ?? 0, resBody: data }));
		});
		r.on("error", reject);
		r.on("timeout", () => { r.destroy(); reject(new Error("timeout")); });
		r.write(body);
		r.end();
	});
}

// Shared test fixture for HTTP tests
export const testSecret = `test-secret-${crypto.randomBytes(8).toString("hex")}`;
export const testLink = makeLink({ linkId: "httptest", sessionName: "http-test-session" });
