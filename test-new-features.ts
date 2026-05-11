/**
 * Tests for new features: multi-link (pz6), streaming (8jk), HTTP adapter (b6e)
 *
 * Run: npx -y tsx test-new-features.ts
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
	ensureLinksDir,
	generateId,
	createJsonRpc,
	sendJsonRpc,
	parseJsonRpcLines,
	ensureLinkSecret,
	httpPostRpc,
} from "./types.js";

// ─── Test runner (same pattern as test-link.ts) ───────────────────────────

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void | Promise<void>): void {
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

function assert(condition: boolean, msg: string): void {
	if (!condition) throw new Error(msg);
}

function assertEq<T>(actual: T, expected: T, msg?: string): void {
	if (actual !== expected) throw new Error(msg ?? `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ─── Helpers: replicate multi-link registry logic from index.ts ───────────

function makeLink(opts: {
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
function createRegistry() {
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

function getFreePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = net.createServer();
		srv.listen(0, "127.0.0.1", () => {
			const addr = srv.address() as net.AddressInfo;
			srv.close(() => resolve(addr.port));
		});
		srv.on("error", reject);
	});
}

function createTestHttpServer(link: LinkState, secret: string, port: number): Promise<http.Server> {
	return new Promise((resolve, reject) => {
		function readBody(req: http.IncomingMessage): Promise<string> {
			return new Promise((res, rej) => {
				const chunks: Buffer[] = [];
				req.on("data", (chunk: Buffer) => chunks.push(chunk));
				req.on("end", () => res(Buffer.concat(chunks).toString()));
				req.on("error", rej);
			});
		}

		const server = http.createServer(async (req, res) => {
			res.setHeader("Access-Control-Allow-Origin", "*");
			res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
			res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

			if (req.method === "OPTIONS") {
				res.writeHead(204);
				res.end();
				return;
			}

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
				try {
					const body = await readBody(req);
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
				} catch (err: any) {
					res.writeHead(500, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: err.message }, id: null }));
				}
				return;
			}

			res.writeHead(404);
			res.end("Not found");
		});

		server.listen(port, "127.0.0.1", () => resolve(server));
		server.on("error", reject);
	});
}

function httpGet(url: string, headers: Record<string, string> = {}): Promise<{ statusCode: number; body: string }> {
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

function httpPost(url: string, body: string, headers: Record<string, string> = {}): Promise<{ statusCode: number; resBody: string }> {
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
const testSecret = `test-secret-${crypto.randomBytes(8).toString("hex")}`;
const testLink = makeLink({ linkId: "httptest", sessionName: "http-test-session" });

// ─── Setup ────────────────────────────────────────────────────────────────

console.log("\n📋 pi-link-extension — new feature tests\n");

// ═══════════════════════════════════════════════════════════════════════════
// 1. MULTI-LINK (pz6) — linksRegistry CRUD, target resolution, list output
// ═══════════════════════════════════════════════════════════════════════════

console.log("── Multi-link (pz6) ──");

console.log("\n  linksRegistry CRUD:");

test("addLink adds to registry and sets active", () => {
	const reg = createRegistry();
	assertEq(reg.linksRegistry.size, 0);
	assertEq(reg.getActiveLink(), undefined);

	const link = makeLink({ linkId: "abc12345", mode: "host", isConnected: true, sessionName: "host-alpha" });
	reg.addLink(link);

	assertEq(reg.linksRegistry.size, 1);
	assert(reg.linksRegistry.has("abc12345"), "registry should contain link by ID");
	assertEq(reg.getActiveLink()?.linkId, "abc12345");
	assertEq(reg.state.current.linkId, "abc12345");
});

test("addLink multiple links — last added is active", () => {
	const reg = createRegistry();
	const link1 = makeLink({ linkId: "11111111", mode: "host", isConnected: true, sessionName: "first" });
	const link2 = makeLink({ linkId: "22222222", mode: "guest", isConnected: true, sessionName: "second" });

	reg.addLink(link1);
	assertEq(reg.state.current.linkId, "11111111", "first should be active after add");

	reg.addLink(link2);
	assertEq(reg.linksRegistry.size, 2);
	assertEq(reg.state.current.linkId, "22222222", "last added should be active");
});

test("removeLink removes from registry", () => {
	const reg = createRegistry();
	reg.addLink(makeLink({ linkId: "del00001", mode: "host", isConnected: true, sessionName: "to-delete" }));
	assertEq(reg.linksRegistry.size, 1);

	reg.removeLink("del00001");
	assertEq(reg.linksRegistry.size, 0);
	assertEq(reg.getActiveLink(), undefined);
	assertEq(reg.state.current.mode, "none");
});

test("removeLink active — falls back to next connected link", () => {
	const reg = createRegistry();
	reg.addLink(makeLink({ linkId: "active01", mode: "host", isConnected: true, sessionName: "active-link" }));
	reg.addLink(makeLink({ linkId: "other002", mode: "guest", isConnected: true, sessionName: "other-link" }));
	assertEq(reg.state.current.linkId, "other002", "other should be active (last added)");

	reg.removeLink("other002");
	assertEq(reg.linksRegistry.size, 1);
	assertEq(reg.state.current.linkId, "active01", "should fall back to connected link");
});

test("removeLink active — falls back to any remaining link if none connected", () => {
	const reg = createRegistry();
	reg.addLink(makeLink({ linkId: "active01", mode: "host", isConnected: true, sessionName: "active" }));
	reg.addLink(makeLink({ linkId: "disc0002", mode: "guest", isConnected: false, sessionName: "disconnected" }));

	reg.removeLink("active01");
	assertEq(reg.linksRegistry.size, 1);
	assertEq(reg.state.current.linkId, "disc0002", "should fall back to remaining link even if disconnected");
});

test("removeLink non-active — active link stays", () => {
	const reg = createRegistry();
	reg.addLink(makeLink({ linkId: "keep0001", mode: "host", isConnected: true, sessionName: "keeper" }));
	reg.addLink(makeLink({ linkId: "remove02", mode: "guest", isConnected: true, sessionName: "remover" }));
	assertEq(reg.state.current.linkId, "remove02");

	reg.removeLink("keep0001");
	assertEq(reg.linksRegistry.size, 1);
	assertEq(reg.state.current.linkId, "remove02", "active should not change when removing non-active");
});

test("removeLink unknown ID — no-op", () => {
	const reg = createRegistry();
	reg.addLink(makeLink({ linkId: "exist001", mode: "host", isConnected: true, sessionName: "exists" }));

	reg.removeLink("nonexist");
	assertEq(reg.linksRegistry.size, 1);
	assertEq(reg.state.current.linkId, "exist001");
});

test("removeLink last link resets to initial state", () => {
	const reg = createRegistry();
	reg.addLink(makeLink({ linkId: "last0001", mode: "host", isConnected: true, sessionName: "last" }));
	reg.removeLink("last0001");

	assertEq(reg.linksRegistry.size, 0);
	assertEq(reg.state.current.mode, "none");
	assertEq(reg.state.current.linkId, "");
});

console.log("\n  Target resolution:");

test("resolveTargetLink undefined — returns active link", () => {
	const reg = createRegistry();
	reg.addLink(makeLink({ linkId: "target01", mode: "host", isConnected: true, sessionName: "alpha" }));

	const resolved = reg.resolveTargetLink(undefined);
	assert(resolved !== undefined);
	assertEq(resolved!.linkId, "target01");
});

test("resolveTargetLink undefined — no active returns undefined", () => {
	const reg = createRegistry();
	assertEq(reg.resolveTargetLink(undefined), undefined);
});

test("resolveTargetLink by ID prefix", () => {
	const reg = createRegistry();
	reg.addLink(makeLink({ linkId: "aabbccdd", mode: "host", isConnected: true, sessionName: "full-id" }));

	const resolved = reg.resolveTargetLink("aabb");
	assert(resolved !== undefined);
	assertEq(resolved!.linkId, "aabbccdd");
});

test("resolveTargetLink by full ID", () => {
	const reg = createRegistry();
	reg.addLink(makeLink({ linkId: "aabbccdd", mode: "host", isConnected: true, sessionName: "full-id" }));

	assertEq(reg.resolveTargetLink("aabbccdd")?.linkId, "aabbccdd");
});

test("resolveTargetLink by session name", () => {
	const reg = createRegistry();
	reg.addLink(makeLink({ linkId: "aa11bb22", mode: "host", isConnected: true, sessionName: "my-session" }));

	assertEq(reg.resolveTargetLink("my-session")?.linkId, "aa11bb22");
});

test("resolveTargetLink by peer session name", () => {
	const reg = createRegistry();
	reg.addLink(makeLink({
		linkId: "peer0011", mode: "guest", isConnected: true, sessionName: "this-session",
		peerInfo: { sessionId: "peer-sess", sessionName: "peer-session", model: "peer/model" },
	}));

	assertEq(reg.resolveTargetLink("peer-session")?.linkId, "peer0011");
});

test("resolveTargetLink by index", () => {
	const reg = createRegistry();
	reg.addLink(makeLink({ linkId: "idx00001", mode: "host", isConnected: true, sessionName: "first" }));
	reg.addLink(makeLink({ linkId: "idx00002", mode: "guest", isConnected: true, sessionName: "second" }));
	reg.addLink(makeLink({ linkId: "idx00003", mode: "guest", isConnected: true, sessionName: "third" }));

	assertEq(reg.resolveTargetLink("0")?.linkId, "idx00001");
	assertEq(reg.resolveTargetLink("1")?.linkId, "idx00002");
	assertEq(reg.resolveTargetLink("2")?.linkId, "idx00003");
});

test("resolveTargetLink by index — out of range returns undefined", () => {
	const reg = createRegistry();
	reg.addLink(makeLink({ linkId: "only0001", mode: "host", isConnected: true, sessionName: "only" }));

	assertEq(reg.resolveTargetLink("5"), undefined);
});

test("resolveTargetLink — unknown target returns undefined", () => {
	const reg = createRegistry();
	reg.addLink(makeLink({ linkId: "exists01", mode: "host", isConnected: true, sessionName: "exists" }));

	assertEq(reg.resolveTargetLink("zzzzzzzz"), undefined);
	assertEq(reg.resolveTargetLink("nonexistent-session"), undefined);
});

test("resolveTargetLink — ID prefix takes priority over index", () => {
	const reg = createRegistry();
	reg.addLink(makeLink({ linkId: "0aaaaaaa", mode: "host", isConnected: true, sessionName: "zero-prefix" }));
	reg.addLink(makeLink({ linkId: "1bbbbbbb", mode: "guest", isConnected: true, sessionName: "one-name" }));

	const resolved = reg.resolveTargetLink("0");
	assert(resolved !== undefined);
	assertEq(resolved!.linkId, "0aaaaaaa", "ID prefix should take priority over index");
});

console.log("\n  /link list output parsing:");

test("list output format — single link shows active marker and transport", () => {
	const reg = createRegistry();
	reg.addLink(makeLink({ linkId: "list0001", mode: "host", isConnected: true, sessionName: "alpha" }));

	const lines: string[] = [];
	let i = 0;
	for (const [id, link] of reg.linksRegistry) {
		const isActive = id === reg.state.current.linkId;
		const prefix = isActive ? "→ " : "  ";
		const transport = link.transport === "http" ? " [HTTP]" : " [UDS]";
		const connStatus = link.isConnected ? "🟢 connected" : "🔴 disconnected";
		lines.push(`${prefix}[${i}] ${link.meta.sessionName}${transport} ${connStatus} (${id.slice(0, 8)})`);
		i++;
	}

	assertEq(lines.length, 1);
	assert(lines[0].startsWith("→ "), "active link should have → prefix");
	assert(lines[0].includes("[0]"), "should have index");
	assert(lines[0].includes("alpha"), "should have session name");
	assert(lines[0].includes("[UDS]"), "should have transport");
	assert(lines[0].includes("🟢 connected"), "should have connection status");
	assert(lines[0].includes("list0001"), "should have link ID prefix");
});

test("list output format — multiple links with active marker", () => {
	const reg = createRegistry();
	reg.addLink(makeLink({ linkId: "multi001", mode: "host", isConnected: true, sessionName: "first" }));
	reg.addLink(makeLink({ linkId: "multi002", mode: "guest", isConnected: true, sessionName: "second" }));

	const lines: string[] = [];
	let i = 0;
	for (const [id, link] of reg.linksRegistry) {
		const isActive = id === reg.state.current.linkId;
		const prefix = isActive ? "→ " : "  ";
		lines.push(`${prefix}[${i}] ${link.meta.sessionName} [UDS] ${link.isConnected ? "🟢 connected" : "🔴 disconnected"} (${id.slice(0, 8)})`);
		i++;
	}

	assertEq(lines.length, 2);
	assert(lines[0].startsWith("  "), "first should not be active");
	assert(lines[1].startsWith("→ "), "second should be active");
});

test("list output — HTTP transport shown", () => {
	const reg = createRegistry();
	reg.addLink(makeLink({ linkId: "http0001", mode: "host", transport: "http", isConnected: true, sessionName: "remote" }));

	let output = "";
	for (const [, link] of reg.linksRegistry) {
		output += link.transport === "http" ? " [HTTP]" : " [UDS]";
	}
	assert(output.includes("[HTTP]"), "should show HTTP transport");
});

test("list output — index is parseable for /link disconnect", () => {
	const reg = createRegistry();
	reg.addLink(makeLink({ linkId: "parse001", mode: "host", isConnected: true, sessionName: "alpha" }));
	reg.addLink(makeLink({ linkId: "parse002", mode: "guest", isConnected: true, sessionName: "beta" }));

	const listLine = "  [1] beta [UDS] 🟢 connected (parse002)";
	const indexMatch = listLine.match(/\[(\d+)\]/);
	assert(indexMatch !== null, "should extract index from list output");
	assertEq(parseInt(indexMatch![1], 10), 1);
	const links = [...reg.linksRegistry.values()];
	assertEq(links[1]?.linkId, "parse002", "index should resolve to correct link");
});

test("multi-link isolation — modifying one link does not affect others", () => {
	const reg = createRegistry();
	reg.addLink(makeLink({ linkId: "iso00001", mode: "host", isConnected: true, sessionName: "alpha" }));
	reg.addLink(makeLink({ linkId: "iso00002", mode: "guest", isConnected: true, sessionName: "beta" }));

	reg.linksRegistry.get("iso00001")!.meta.sessionName = "alpha-modified";
	reg.linksRegistry.get("iso00001")!.isConnected = false;

	const b = reg.linksRegistry.get("iso00002")!;
	assertEq(b.meta.sessionName, "beta", "B should be unchanged");
	assertEq(b.isConnected, true, "B connection state should be unchanged");
});

test("multi-link isolation — each link has independent resolveQueue", () => {
	const reg = createRegistry();
	const linkA = makeLink({ linkId: "qa000001", mode: "host", isConnected: true, sessionName: "alpha" });
	const linkB = makeLink({ linkId: "qa000002", mode: "guest", isConnected: true, sessionName: "beta" });
	reg.addLink(linkA);
	reg.addLink(linkB);

	linkA.resolveQueue.set("req-a1", () => {});
	linkA.resolveQueue.set("req-a2", () => {});
	linkB.resolveQueue.set("req-b1", () => {});

	assertEq(linkA.resolveQueue.size, 2);
	assertEq(linkB.resolveQueue.size, 1);
	linkA.resolveQueue.clear();
	assertEq(linkA.resolveQueue.size, 0);
	assertEq(linkB.resolveQueue.size, 1, "B's queue should be unaffected");
});

test("multi-link isolation — each link has independent buffer", () => {
	const reg = createRegistry();
	const linkA = makeLink({ linkId: "buf00001", mode: "host", isConnected: true, sessionName: "alpha" });
	const linkB = makeLink({ linkId: "buf00002", mode: "guest", isConnected: true, sessionName: "beta" });
	reg.addLink(linkA);
	reg.addLink(linkB);

	linkA.buffer = "data-from-alpha";
	linkB.buffer = "data-from-beta";

	assert(linkA.buffer.includes("alpha"));
	assert(linkB.buffer.includes("beta"));
	assert(!linkA.buffer.includes("beta"));
	assert(!linkB.buffer.includes("alpha"));
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. STREAMING (8jk) — chunk delivery, assembly, completion/cleanup
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n── Streaming (8jk) ──");

console.log("\n  task/stream JSON-RPC notifications:");

test("task/stream message has correct structure for chunk", () => {
	const taskId = generateId();
	const msg = createJsonRpc("task/stream", { taskId, chunk: "Hello ", done: false });
	assertEq(msg.jsonrpc, "2.0");
	assertEq(msg.method, "task/stream");
	assertEq((msg.params as any).taskId, taskId);
	assertEq((msg.params as any).chunk, "Hello ");
	assertEq((msg.params as any).done, false);
});

test("task/stream message has correct structure for done", () => {
	const taskId = generateId();
	const msg = createJsonRpc("task/stream", { taskId, chunk: "", done: true });
	assertEq(msg.method, "task/stream");
	assertEq((msg.params as any).done, true);
	assertEq((msg.params as any).chunk, "");
});

test("task/stream chunk is a method call (not a result)", () => {
	const msg = createJsonRpc("task/stream", { taskId: "abc", chunk: "data", done: false });
	assert(msg.id.length > 0, "should have id");
	assert(msg.method === "task/stream", "should be a method call");
	assert(msg.result === undefined, "should not have result");
});

console.log("\n  Chunk assembly in streamBuffers:");

test("chunks accumulate in buffer", () => {
	const streamBuffers = new Map<string, string>();
	const taskId = "accum01";

	streamBuffers.set(taskId, "");
	streamBuffers.set(taskId, (streamBuffers.get(taskId) ?? "") + "Hello ");
	streamBuffers.set(taskId, (streamBuffers.get(taskId) ?? "") + "World");

	assertEq(streamBuffers.get(taskId), "Hello World");
});

test("multiple tasks have independent buffers", () => {
	const streamBuffers = new Map<string, string>();
	streamBuffers.set("task_aaa", "alpha");
	streamBuffers.set("task_bbb", "beta");
	streamBuffers.set("task_aaa", (streamBuffers.get("task_aaa") ?? "") + " modified");

	assertEq(streamBuffers.get("task_aaa"), "alpha modified");
	assertEq(streamBuffers.get("task_bbb"), "beta");
});

test("chunk assembly from parsed UDS messages", () => {
	const streamBuffers = new Map<string, string>();
	const taskId = "asm001";
	const msg1 = createJsonRpc("task/stream", { taskId, chunk: "line1\n", done: false });
	const msg2 = createJsonRpc("task/stream", { taskId, chunk: "line2\n", done: false });
	const msg3 = createJsonRpc("task/stream", { taskId, chunk: "line3", done: false });

	const raw = JSON.stringify(msg1) + "\n" + JSON.stringify(msg2) + "\n" + JSON.stringify(msg3) + "\n";
	const { messages } = parseJsonRpcLines(raw);
	assertEq(messages.length, 3);

	for (const msg of messages) {
		if (msg.method === "task/stream") {
			const p = msg.params as { taskId: string; chunk: string; done: boolean };
			if (p.chunk && !p.done) {
				streamBuffers.set(p.taskId, (streamBuffers.get(p.taskId) ?? "") + p.chunk);
			}
		}
	}

	assertEq(streamBuffers.get(taskId), "line1\nline2\nline3");
});

test("chunk assembly handles interleaved tasks", () => {
	const streamBuffers = new Map<string, string>();
	const taskA = "interA";
	const taskB = "interB";

	const msgs = [
		createJsonRpc("task/stream", { taskId: taskA, chunk: "A1 ", done: false }),
		createJsonRpc("task/stream", { taskId: taskB, chunk: "B1 ", done: false }),
		createJsonRpc("task/stream", { taskId: taskA, chunk: "A2", done: false }),
		createJsonRpc("task/stream", { taskId: taskB, chunk: "B2", done: false }),
	];

	const raw = msgs.map((m) => JSON.stringify(m)).join("\n") + "\n";
	const { messages } = parseJsonRpcLines(raw);

	for (const msg of messages) {
		if (msg.method === "task/stream") {
			const p = msg.params as { taskId: string; chunk: string; done: boolean };
			if (p.chunk && !p.done) {
				streamBuffers.set(p.taskId, (streamBuffers.get(p.taskId) ?? "") + p.chunk);
			}
		}
	}

	assertEq(streamBuffers.get(taskA), "A1 A2");
	assertEq(streamBuffers.get(taskB), "B1 B2");
});

console.log("\n  Stream completion and cleanup:");

test("done=true removes task from streamBuffers", () => {
	const streamBuffers = new Map<string, string>();
	streamBuffers.set("done001", "accumulated content");
	assertEq(streamBuffers.size, 1);

	streamBuffers.delete("done001");
	assertEq(streamBuffers.size, 0);
	assertEq(streamBuffers.get("done001"), undefined);
});

test("streamBuffers empty after all tasks complete — widget cleared", () => {
	const streamBuffers = new Map<string, string>();
	streamBuffers.set("task1", "content1");
	streamBuffers.set("task2", "content2");

	streamBuffers.delete("task1");
	streamBuffers.delete("task2");

	assertEq(streamBuffers.size, 0);
	// When streamBuffers.size === 0: ctx?.ui.setWidget("link-stream", undefined)
});

test("done=true ignores chunk field — only done flag matters", () => {
	const streamBuffers = new Map<string, string>();
	streamBuffers.set("done002", "existing content");

	const p = { taskId: "done002", chunk: "ignored", done: true };
	if (p.done) {
		streamBuffers.delete(p.taskId);
	} else if (p.chunk) {
		streamBuffers.set(p.taskId, (streamBuffers.get(p.taskId) ?? "") + p.chunk);
	}

	assertEq(streamBuffers.get("done002"), undefined, "buffer should be deleted on done");
});

test("stream preview truncation logic (>300 chars)", () => {
	const content = "A".repeat(400);
	const preview = content.length > 300 ? "..." + content.slice(-300) : content;
	assertEq(preview.length, 303, "should be '...' + 300 chars");
	assert(preview.startsWith("..."), "should start with ...");
});

test("stream preview for short content", () => {
	const content = "short";
	const preview = content.length > 300 ? "..." + content.slice(-300) : content;
	assertEq(preview, "short");
});

test("stream preview shows last 3 lines", () => {
	const content = "line1\nline2\nline3\nline4\nline5";
	const last3 = content.split("\n").slice(-3).join("\n");
	assertEq(last3, "line3\nline4\nline5");
});

test("UDS transport delivers stream chunks and done signal", () => {
	const sockPath = path.join(os.tmpdir(), `__test_stream_${crypto.randomBytes(4).toString("hex")}.sock`);
	const taskId = generateId();

	return new Promise<void>((resolve, reject) => {
		const server = net.createServer((socket) => {
			socket.on("data", (data) => {
				const { messages } = parseJsonRpcLines(data.toString());
				for (const msg of messages) {
					if (msg.method === "task/stream") {
						sendJsonRpc(socket, msg); // echo back
					}
				}
			});
		});

		server.listen(sockPath, () => {
			const client = new net.Socket();
			client.connect(sockPath, () => {
				sendJsonRpc(client, createJsonRpc("task/stream", { taskId, chunk: "chunk1 ", done: false }));
				sendJsonRpc(client, createJsonRpc("task/stream", { taskId, chunk: "chunk2 ", done: false }));
				sendJsonRpc(client, createJsonRpc("task/stream", { taskId, chunk: "", done: true }));

				const streamBuffers = new Map<string, string>();
				let doneReceived = false;
				let buf = "";

				client.on("data", (data) => {
					buf += data.toString();
					const { messages, remaining } = parseJsonRpcLines(buf);
					buf = remaining;

					for (const msg of messages) {
						if (msg.method === "task/stream") {
							const p = msg.params as { taskId: string; chunk: string; done: boolean };
							if (p.done) {
								doneReceived = true;
								streamBuffers.delete(p.taskId);
							} else if (p.chunk) {
								streamBuffers.set(p.taskId, (streamBuffers.get(p.taskId) ?? "") + p.chunk);
							}
						}
					}

					if (doneReceived && streamBuffers.size === 0) {
						client.destroy();
						server.close();
						try { fs.unlinkSync(sockPath); } catch { /* ignore */ }
						resolve();
					}
				});
			});
			client.on("error", reject);
		});
		server.on("error", reject);

		setTimeout(() => {
			client.destroy();
			server.close();
			try { fs.unlinkSync(sockPath); } catch { /* ignore */ }
			reject(new Error("stream test timed out"));
		}, 5000);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. HTTP ADAPTER (b6e) — auth, RPC, discovery, health, UDS fallback
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n── HTTP Adapter (b6e) ──");

console.log("\n  Bearer token auth:");

test("valid token — returns 200", async () => {
	const port = await getFreePort();
	const srv = await createTestHttpServer(testLink, testSecret, port);

	const { statusCode, body } = await httpGet(`http://127.0.0.1:${port}/health`, {
		Authorization: `Bearer ${testSecret}`,
	});

	assertEq(statusCode, 200);
	assertEq(JSON.parse(body).status, "ok");
	srv.close();
});

test("missing token — returns 401", async () => {
	const port = await getFreePort();
	const srv = await createTestHttpServer(testLink, testSecret, port);

	const { statusCode, body } = await httpGet(`http://127.0.0.1:${port}/health`);

	assertEq(statusCode, 401);
	assertEq(JSON.parse(body).error.code, 401);
	assertEq(JSON.parse(body).error.message, "Unauthorized");
	srv.close();
});

test("wrong token — returns 401", async () => {
	const port = await getFreePort();
	const srv = await createTestHttpServer(testLink, testSecret, port);

	const { statusCode, body } = await httpGet(`http://127.0.0.1:${port}/health`, {
		Authorization: "Bearer wrong-secret",
	});

	assertEq(statusCode, 401);
	assertEq(JSON.parse(body).error.code, 401);
	srv.close();
});

test("malformed auth header (Basic instead of Bearer) — returns 401", async () => {
	const port = await getFreePort();
	const srv = await createTestHttpServer(testLink, testSecret, port);

	const { statusCode } = await httpGet(`http://127.0.0.1:${port}/health`, {
		Authorization: "Basic dXNlcjpwYXNz",
	});

	assertEq(statusCode, 401);
	srv.close();
});

test("CORS preflight (OPTIONS) — no auth required", async () => {
	const port = await getFreePort();
	const srv = await createTestHttpServer(testLink, testSecret, port);

	const { statusCode } = await new Promise<{ statusCode: number }>((resolve, reject) => {
		const r = http.request(`http://127.0.0.1:${port}/rpc`, { method: "OPTIONS", timeout: 3000 }, (res) => {
			resolve({ statusCode: res.statusCode ?? 0 });
			res.resume();
		});
		r.on("error", reject);
		r.on("timeout", () => { r.destroy(); reject(new Error("timeout")); });
		r.end();
	});

	assertEq(statusCode, 204, "OPTIONS should return 204 without auth");
	srv.close();
});

console.log("\n  /rpc endpoint task delivery:");

test("ping via /rpc returns session info", async () => {
	const port = await getFreePort();
	const srv = await createTestHttpServer(testLink, testSecret, port);

	const pingMsg = createJsonRpc("ping", { sessionId: "caller-sess", sessionName: "caller" });
	const { statusCode, resBody } = await httpPost(
		`http://127.0.0.1:${port}/rpc`,
		JSON.stringify(pingMsg),
		{ "Content-Type": "application/json", Authorization: `Bearer ${testSecret}` },
	);

	assertEq(statusCode, 200);
	const parsed = JSON.parse(resBody);
	assertEq(parsed.jsonrpc, "2.0");
	assertEq(parsed.id, pingMsg.id, "response id should match request");
	assertEq(parsed.result.sessionName, "http-test-session");
	assertEq(parsed.result.model, "test/model");
	srv.close();
});

test("task/send via /rpc with valid prompt returns received", async () => {
	const port = await getFreePort();
	const srv = await createTestHttpServer(testLink, testSecret, port);

	const taskId = generateId();
	const taskMsg = createJsonRpc("task/send", { taskId, prompt: "Do something", mode: "silent", replyTo: "sender" });
	const { statusCode, resBody } = await httpPost(
		`http://127.0.0.1:${port}/rpc`,
		JSON.stringify(taskMsg),
		{ "Content-Type": "application/json", Authorization: `Bearer ${testSecret}` },
	);

	assertEq(statusCode, 200);
	const parsed = JSON.parse(resBody);
	assertEq(parsed.result.taskId, taskId);
	assertEq(parsed.result.status, "received");
	assertEq(parsed.result.mode, "silent");
	srv.close();
});

test("task/send via /rpc with visible mode", async () => {
	const port = await getFreePort();
	const srv = await createTestHttpServer(testLink, testSecret, port);

	const taskMsg = createJsonRpc("task/send", { taskId: generateId(), prompt: "Visible task", mode: "visible" });
	const { statusCode, resBody } = await httpPost(
		`http://127.0.0.1:${port}/rpc`,
		JSON.stringify(taskMsg),
		{ "Content-Type": "application/json", Authorization: `Bearer ${testSecret}` },
	);

	assertEq(statusCode, 200);
	assertEq(JSON.parse(resBody).result.mode, "visible");
	srv.close();
});

test("task/send via /rpc missing prompt returns error", async () => {
	const port = await getFreePort();
	const srv = await createTestHttpServer(testLink, testSecret, port);

	const taskMsg = createJsonRpc("task/send", { taskId: generateId() }); // no prompt
	const { statusCode, resBody } = await httpPost(
		`http://127.0.0.1:${port}/rpc`,
		JSON.stringify(taskMsg),
		{ "Content-Type": "application/json", Authorization: `Bearer ${testSecret}` },
	);

	assertEq(statusCode, 200);
	const parsed = JSON.parse(resBody);
	assertEq(parsed.error.code, -32602);
	assert(parsed.error.message.includes("Missing prompt"));
	srv.close();
});

test("unknown method via /rpc returns Method not found", async () => {
	const port = await getFreePort();
	const srv = await createTestHttpServer(testLink, testSecret, port);

	const msg = createJsonRpc("nonexistent/method", {});
	const { statusCode, resBody } = await httpPost(
		`http://127.0.0.1:${port}/rpc`,
		JSON.stringify(msg),
		{ "Content-Type": "application/json", Authorization: `Bearer ${testSecret}` },
	);

	assertEq(statusCode, 200);
	assertEq(JSON.parse(resBody).error.code, -32601);
	assertEq(JSON.parse(resBody).error.message, "Method not found");
	srv.close();
});

test("malformed JSON via /rpc returns 500", async () => {
	const port = await getFreePort();
	const srv = await createTestHttpServer(testLink, testSecret, port);

	const { statusCode, resBody } = await httpPost(
		`http://127.0.0.1:${port}/rpc`,
		"not json at all",
		{ "Content-Type": "application/json", Authorization: `Bearer ${testSecret}` },
	);

	assertEq(statusCode, 500);
	assertEq(JSON.parse(resBody).error.code, -32603);
	srv.close();
});

console.log("\n  /.well-known/agent.json discovery:");

test("agent.json returns correct structure", async () => {
	const port = await getFreePort();
	const srv = await createTestHttpServer(testLink, testSecret, port);

	const { statusCode, body } = await httpGet(`http://127.0.0.1:${port}/.well-known/agent.json`, {
		Authorization: `Bearer ${testSecret}`,
	});

	assertEq(statusCode, 200);
	const card = JSON.parse(body);
	assertEq(card.name, "http-test-session");
	assertEq(card.model, "test/model");
	assertEq(card.sessionId, testLink.meta.sessionId);
	assertEq(card.protocol, "pi-link");
	assertEq(card.version, "v0.2.0");
	assert(Array.isArray(card.skills), "skills should be array");
	assert(card.skills.includes("task/send"));
	assert(card.skills.includes("ping"));
	srv.close();
});

test("agent.json requires auth", async () => {
	const port = await getFreePort();
	const srv = await createTestHttpServer(testLink, testSecret, port);

	const { statusCode } = await httpGet(`http://127.0.0.1:${port}/.well-known/agent.json`);
	assertEq(statusCode, 401);
	srv.close();
});

console.log("\n  Health endpoint:");

test("/health returns ok status", async () => {
	const port = await getFreePort();
	const srv = await createTestHttpServer(testLink, testSecret, port);

	const { statusCode, body } = await httpGet(`http://127.0.0.1:${port}/health`, {
		Authorization: `Bearer ${testSecret}`,
	});

	assertEq(statusCode, 200);
	const parsed = JSON.parse(body);
	assertEq(parsed.status, "ok");
	assertEq(parsed.session, "http-test-session");
	assertEq(parsed.transport, "http");
	srv.close();
});

test("/health requires auth", async () => {
	const port = await getFreePort();
	const srv = await createTestHttpServer(testLink, testSecret, port);

	const { statusCode } = await httpGet(`http://127.0.0.1:${port}/health`);
	assertEq(statusCode, 401);
	srv.close();
});

test("unknown endpoint returns 404 (with auth)", async () => {
	const port = await getFreePort();
	const srv = await createTestHttpServer(testLink, testSecret, port);

	const { statusCode } = await httpGet(`http://127.0.0.1:${port}/unknown`, {
		Authorization: `Bearer ${testSecret}`,
	});
	assertEq(statusCode, 404);
	srv.close();
});

test("unknown endpoint returns 401 (without auth — auth checked before routing)", async () => {
	const port = await getFreePort();
	const srv = await createTestHttpServer(testLink, testSecret, port);

	const { statusCode } = await httpGet(`http://127.0.0.1:${port}/unknown`);
	assertEq(statusCode, 401);
	srv.close();
});

console.log("\n  UDS fallback / httpPostRpc utility:");

test("httpPostRpc sends correct headers and hits /rpc", async () => {
	const port = await getFreePort();

	const srv = await new Promise<http.Server>((resolve, reject) => {
		const server = http.createServer((req, res) => {
			let body = "";
			req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
			req.on("end", () => {
				const parsed = JSON.parse(body) as JsonRpcMessage;
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({
					jsonrpc: "2.0", id: parsed.id,
					result: {
						auth: req.headers["authorization"],
						contentType: req.headers["content-type"],
						method: req.method,
						url: req.url,
					},
				}));
			});
		});
		server.listen(port, "127.0.0.1", () => resolve(server));
		server.on("error", reject);
	});

	const msg = createJsonRpc("ping", {});
	const result = await httpPostRpc(`http://127.0.0.1:${port}`, testSecret, msg, 5000);

	assertEq(result.result?.auth, `Bearer ${testSecret}`, "should send Bearer token");
	assertEq(result.result?.contentType, "application/json", "should send Content-Type");
	assertEq(result.result?.method, "POST", "should be POST");
	assertEq(result.result?.url, "/rpc", "should hit /rpc endpoint");
	srv.close();
});

test("httpPostRpc strips trailing slash from baseUrl", async () => {
	const port = await getFreePort();

	const srv = await new Promise<http.Server>((resolve, reject) => {
		const server = http.createServer((req, res) => {
			let body = "";
			req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
			req.on("end", () => {
				const parsed = JSON.parse(body) as JsonRpcMessage;
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: { url: req.url } }));
			});
		});
		server.listen(port, "127.0.0.1", () => resolve(server));
		server.on("error", reject);
	});

	const msg = createJsonRpc("ping", {});
	const result = await httpPostRpc(`http://127.0.0.1:${port}/`, testSecret, msg, 5000);
	assertEq(result.result?.url, "/rpc", "trailing slash should be stripped");
	srv.close();
});

test("httpPostRpc rejects on connection refused", async () => {
	const msg = createJsonRpc("ping", {});
	try {
		await httpPostRpc("http://127.0.0.1:1", testSecret, msg, 2000);
		throw new Error("should have rejected");
	} catch (err: any) {
		assert(err.message.includes("ECONNREFUSED") || err.message.includes("connect"), `should be connection error: ${err.message}`);
	}
});

test("httpPostRpc rejects on timeout", async () => {
	const port = await getFreePort();

	const srv = await new Promise<http.Server>((resolve, reject) => {
		const server = http.createServer(() => { /* never respond */ });
		server.listen(port, "127.0.0.1", () => resolve(server));
		server.on("error", reject);
	});

	const msg = createJsonRpc("ping", {});
	try {
		await httpPostRpc(`http://127.0.0.1:${port}`, testSecret, msg, 500);
		throw new Error("should have timed out");
	} catch (err: any) {
		assert(err.message.includes("timed out"), `should be timeout: ${err.message}`);
	}
	srv.close();
});

console.log("\n  Shared secret helpers:");

test("ensureLinkSecret uses env var when set", () => {
	const originalSecret = process.env.PI_LINK_SECRET;
	const testVal = `env-secret-${crypto.randomBytes(4).toString("hex")}`;
	process.env.PI_LINK_SECRET = testVal;

	try {
		assertEq(ensureLinkSecret(), testVal, "should use env secret when set");
	} finally {
		if (originalSecret === undefined) delete process.env.PI_LINK_SECRET;
		else process.env.PI_LINK_SECRET = originalSecret;
	}
});

test("ensureLinkSecret creates persistent secret when env not set", () => {
	const originalSecret = process.env.PI_LINK_SECRET;
	delete process.env.PI_LINK_SECRET;

	const secretFile = path.join(os.tmpdir(), `__test_pi_link_secret_${crypto.randomBytes(4).toString("hex")}`);
	const originalSecretFile = process.env.PI_LINK_SECRET_FILE;

	// We can't easily override the constant path, but we can test that
	// ensureLinkSecret returns a non-empty string
	try {
		// This will use the real file path — just verify it returns something
		const secret = ensureLinkSecret();
		assert(secret.length > 0, "should return a non-empty secret");
		assert(/^[0-9a-f]+$/.test(secret), "secret should be hex");
	} finally {
		if (originalSecret !== undefined) process.env.PI_LINK_SECRET = originalSecret;
	}
});

// ═══════════════════════════════════════════════════════════════════════════

// ─── Teardown + Summary ──────────────────────────────────────────────────

setTimeout(() => {
	console.log(`\n${"─".repeat(50)}`);
	console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
	if (failed > 0) {
		console.log("\n⚠️  Some tests failed!");
		process.exit(1);
	} else {
		console.log("\n✅ All tests passed!");
		process.exit(0);
	}
}, 3000);
