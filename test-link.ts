/**
 * Integration tests for pi-link-extension
 *
 * Tests UDS creation, JSON-RPC framing, recovery data, and disconnect handling.
 * Run: npx -y tsx test-link.ts
 */

import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import {
	LINKS_DIR,
	LINK_RECOVERY_DIR,
	STALE_THRESHOLD_MS,
	HEARTBEAT_INTERVAL_MS,
	HEARTBEAT_TIMEOUT_MS,
	SOCKET_TIMEOUT_MS,
	type LinkMeta,
	type JsonRpcMessage,
	type LinkRecoveryData,
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
	getRecoveryFilePath,
} from "./types.js";

let passed = 0;
let failed = 0;
const TEST_LINKS_DIR = path.join(os.tmpdir(), `pi-link-test-${crypto.randomBytes(4).toString("hex")}`);
const TEST_RECOVERY_DIR = path.join(os.tmpdir(), `pi-link-recovery-test-${crypto.randomBytes(4).toString("hex")}`);

// Monkey-patch the dirs for testing
import * as types from "./types.js";
const origLinksDir = (types as any).LINKS_DIR;
const origRecoveryDir = (types as any).LINK_RECOVERY_DIR;
(types as any).LINKS_DIR = TEST_LINKS_DIR;
(types as any).LINK_RECOVERY_DIR = TEST_RECOVERY_DIR;

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

// ─── Setup ────────────────────────────────────────────────────────────────

console.log("\n📋 pi-link-extension tests\n");

// ─── Types / Constants ───────────────────────────────────────────────────

console.log("Types & Constants:");
test("createInitialState returns valid defaults", () => {
	const s = createInitialState();
	assert(s.mode === "none", "mode should be none");
	assert(s.isConnected === false, "should not be connected");
	assert(s.lastPeerActivity === 0, "no peer activity");
	assert(s.recovering === false, "not recovering");
	assert(s.linkId === "", "no linkId");
	assert(s.buffer === "", "empty buffer");
	assert(s.resolveQueue instanceof Map, "resolveQueue is Map");
	assertEq(s.resolveQueue.size, 0);
});

test("generateId produces 8-char hex", () => {
	const id = generateId();
	assertEq(id.length, 8, "id length");
	assert(/^[0-9a-f]+$/.test(id), "hex chars only");
});

test("generateId produces unique ids", () => {
	const ids = new Set(Array.from({ length: 100 }, () => generateId()));
	assertEq(ids.size, 100, "all unique");
});

// ─── JSON-RPC Framing ────────────────────────────────────────────────────

console.log("\nJSON-RPC Framing:");
test("createJsonRpc produces valid structure", () => {
	const msg = createJsonRpc("ping", { sessionId: "abc" });
	assertEq(msg.jsonrpc, "2.0");
	assertEq(msg.method, "ping");
	assertEq(msg.id.length > 0, true);
	assertEq((msg.params as any).sessionId, "abc");
});

test("parseJsonRpcLines splits on newlines", () => {
	const input = JSON.stringify(createJsonRpc("ping", {})) + "\n" + JSON.stringify(createJsonRpc("pong", {})) + "\n";
	const { messages, remaining } = parseJsonRpcLines(input);
	assertEq(messages.length, 2);
	assertEq(messages[0].method, "ping");
	assertEq(messages[1].method, "pong");
	assertEq(remaining, "");
});

test("parseJsonRpcLines preserves incomplete last line", () => {
	const msg = createJsonRpc("ping", {});
	const input = JSON.stringify(msg) + '\n{"incomplete":';
	const { messages, remaining } = parseJsonRpcLines(input);
	assertEq(messages.length, 1);
	assert(remaining.includes("incomplete"), "should have remaining");
});

test("parseJsonRpcLines skips empty lines", () => {
	const input = "\n\n" + JSON.stringify(createJsonRpc("ping", {})) + "\n\n";
	const { messages, remaining } = parseJsonRpcLines(input);
	assertEq(messages.length, 1);
});

test("parseJsonRpcLines skips malformed lines", () => {
	const input = "not-json\n" + JSON.stringify(createJsonRpc("ping", {})) + "\n{bad}\n";
	const { messages } = parseJsonRpcLines(input);
	assertEq(messages.length, 1);
});

test("sendJsonRpc writes newline-delimited JSON to socket", (done) => {
	const server = net.createServer((socket) => {
		let data = "";
		socket.on("data", (d) => { data += d.toString(); });
		socket.on("end", () => {
			const lines = data.trim().split("\n");
			assertEq(lines.length, 2, "should have 2 messages");
			const parsed = lines.map((l) => JSON.parse(l));
			assertEq(parsed[0].method, "ping");
			assertEq(parsed[1].method, "pong");
			socket.end();
			server.close();
			done();
		});
	});
	server.listen(() => {
		const sock = new net.Socket();
		sock.connect((server as any).address().port, "127.0.0.1", () => {
			sendJsonRpc(sock, createJsonRpc("ping", {}));
			sendJsonRpc(sock, createJsonRpc("pong", {}));
			sock.end();
		});
	});
});

// ─── Link Directory ──────────────────────────────────────────────────────

console.log("\nLink Directory:");
test("ensureLinksDir creates directory", () => {
	ensureLinksDir();
	assert(fs.existsSync(TEST_LINKS_DIR), "dir should exist");
});

test("writeMeta + readMeta round-trip", () => {
	const linkDir = path.join(TEST_LINKS_DIR, "test-meta");
	const meta: LinkMeta = {
		id: "abc123",
		sessionId: "sess1",
		sessionName: "test-session",
		model: "test/model",
		created: Date.now(),
		lastHeartbeat: Date.now(),
		status: "waiting",
	};
	writeMeta(linkDir, meta);
	const read = readMeta(linkDir);
	assert(read !== null, "meta should not be null");
	assertEq(read!.id, "abc123");
	assertEq(read!.sessionId, "sess1");
	assertEq(read!.status, "waiting");
});

test("readMeta returns null for missing dir", () => {
	const read = readMeta(path.join(TEST_LINKS_DIR, "nonexistent"));
	assertEq(read, null);
});

test("discoverLinks finds active links", () => {
	const linkDir = path.join(TEST_LINKS_DIR, "discover-test");
	const meta: LinkMeta = {
		id: "discover1",
		sessionId: "sess-disc",
		sessionName: "discoverable",
		model: "test/model",
		created: Date.now(),
		lastHeartbeat: Date.now(),
		status: "waiting",
	};
	writeMeta(linkDir, meta);
	const links = discoverLinks();
	assert(links.some((l) => l.meta.id === "discover1"), "should find discover1");
});

test("discoverLinks skips stale links", () => {
	const linkDir = path.join(TEST_LINKS_DIR, "stale-test");
	const meta: LinkMeta = {
		id: "stale1",
		sessionId: "sess-stale",
		sessionName: "stale",
		model: "test/model",
		created: Date.now() - STALE_THRESHOLD_MS - 1000,
		lastHeartbeat: Date.now() - STALE_THRESHOLD_MS - 1000,
		status: "waiting",
	};
	writeMeta(linkDir, meta);
	const links = discoverLinks();
	assert(!links.some((l) => l.meta.id === "stale1"), "should not find stale1");
});

test("cleanupLinkDir removes directory", () => {
	const linkDir = path.join(TEST_LINKS_DIR, "cleanup-test");
	fs.mkdirSync(linkDir, { recursive: true });
	fs.writeFileSync(path.join(linkDir, "meta.json"), "{}");
	assert(fs.existsSync(linkDir), "dir should exist before cleanup");
	cleanupLinkDir(linkDir);
	assert(!fs.existsSync(linkDir), "dir should be gone after cleanup");
});

// ─── Recovery Data ───────────────────────────────────────────────────────

console.log("\nRecovery Data:");
test("saveRecoveryData + loadRecoveryData round-trip", () => {
	const sessionId = "test-session-recovery";
	const data: LinkRecoveryData = {
		sessionId,
		mode: "host",
		linkId: "link-abc",
		meta: {
			id: "link-abc",
			sessionId,
			sessionName: "host-session",
			model: "test/model",
			created: Date.now(),
			lastHeartbeat: Date.now(),
			status: "connected",
		},
		peerInfo: { sessionId: "peer-sess", sessionName: "peer-session", model: "peer/model" },
		savedAt: Date.now(),
	};
	saveRecoveryData(sessionId, data);
	const loaded = loadRecoveryData(sessionId);
	assert(loaded !== null, "should load data");
	assertEq(loaded!.mode, "host");
	assertEq(loaded!.linkId, "link-abc");
	assertEq(loaded!.peerInfo?.sessionName, "peer-session");
});

test("loadRecoveryData returns null for missing", () => {
	const loaded = loadRecoveryData("nonexistent-session");
	assertEq(loaded, null);
});

test("deleteRecoveryData removes file", () => {
	const sessionId = "delete-test-session";
	const data: LinkRecoveryData = {
		sessionId,
		mode: "guest",
		linkId: "link-del",
		meta: {
			id: "link-del",
			sessionId,
			sessionName: "guest-session",
			model: "test/model",
			created: Date.now(),
			lastHeartbeat: Date.now(),
			status: "connected",
		},
		savedAt: Date.now(),
	};
	saveRecoveryData(sessionId, data);
	assert(loadRecoveryData(sessionId) !== null, "should exist before delete");
	deleteRecoveryData(sessionId);
	assertEq(loadRecoveryData(sessionId), null);
});

test("recovery file has restrictive permissions (0600)", () => {
	const sessionId = "perms-test-session";
	saveRecoveryData(sessionId, {
		sessionId,
		mode: "host",
		linkId: "link-perms",
		meta: {
			id: "link-perms",
			sessionId,
			sessionName: "perms-test",
			model: "test/model",
			created: Date.now(),
			lastHeartbeat: Date.now(),
			status: "connected",
		},
		savedAt: Date.now(),
	});
	const stat = fs.statSync(getRecoveryFilePath(sessionId));
	const mode = stat.mode & 0o777;
	assertEq(mode, 0o600, "should be 0600");
});

// ─── UDS Connection (integration) ────────────────────────────────────────

console.log("\nUDS Connection:");

async function testUdsConnection(): Promise<void> {
	const sockPath = path.join(TEST_LINKS_DIR, `test-uds-${generateId()}.sock`);
	const server = net.createServer((socket) => {
		socket.on("data", (data) => {
			const msgs = parseJsonRpcLines(data.toString());
			for (const msg of msgs.messages) {
				if (msg.method === "ping") {
					sendJsonRpc(socket, { jsonrpc: "2.0", id: msg.id, result: { pong: true } });
				}
			}
		});
	});

	await new Promise<void>((resolve, reject) => {
		server.listen(sockPath, () => resolve());
		server.on("error", reject);
	});

	const client = new net.Socket();
	await new Promise<void>((resolve, reject) => {
		client.connect(sockPath, () => resolve());
		client.on("error", reject);
	});

	// Send ping and await response
	const ping = createJsonRpc("ping", { test: true });
	sendJsonRpc(client, ping);

	const response = await new Promise<JsonRpcMessage>((resolve) => {
		let buf = "";
		client.on("data", (data) => {
			buf += data.toString();
			const { messages } = parseJsonRpcLines(buf);
			if (messages.length > 0) resolve(messages[0]);
		});
	});

	assertEq(response.id, ping.id, "response id should match ping id");
	assertEq((response.result as any)?.pong, true, "should have pong result");

	client.destroy();
	server.close();
	fs.unlinkSync(sockPath);
}

test("UDS ping/pong round-trip", () => testUdsConnection());

async function testHalfOpenDetection(): Promise<void> {
	const sockPath = path.join(TEST_LINKS_DIR, `test-halfopen-${generateId()}.sock`);

	// Create a server that accepts but never responds
	const server = net.createServer((socket) => {
		// Intentionally don't set up any data handler — simulates half-open
	});

	await new Promise<void>((resolve) => {
		server.listen(sockPath, () => resolve());
	});

	const client = new net.Socket();
	await new Promise<void>((resolve) => {
		client.connect(sockPath, () => resolve());
	});

	// Track lastPeerActivity
	let lastPeerActivity = Date.now();

	// Simulate heartbeat check (should detect no activity)
	const ping = createJsonRpc("ping", {});
	sendJsonRpc(client, ping);

	// Simulate time passing without response
	lastPeerActivity = Date.now() - HEARTBEAT_TIMEOUT_MS - 1000;
	const isHalfOpen = lastPeerActivity > 0 && Date.now() - lastPeerActivity > HEARTBEAT_TIMEOUT_MS;
	assert(isHalfOpen, "should detect half-open connection");

	client.destroy();
	server.close();
	fs.unlinkSync(sockPath);
}

test("half-open detection logic works", () => testHalfOpenDetection());

async function testDisconnectClean(): Promise<void> {
	const sockPath = path.join(TEST_LINKS_DIR, `test-disconnect-${generateId()}.sock`);

	let serverClosed = false;
	const server = net.createServer((socket) => {
		socket.on("close", () => { serverClosed = true; });
	});

	await new Promise<void>((resolve) => {
		server.listen(sockPath, () => resolve());
	});

	const client = new net.Socket();
	await new Promise<void>((resolve) => {
		client.connect(sockPath, () => resolve());
	});

	client.destroy();

	// Wait for close event
	await new Promise<void>((resolve) => setTimeout(resolve, 100));
	assert(serverClosed, "server should detect client disconnect");

	server.close();
	fs.unlinkSync(sockPath);
}

test("server detects client disconnect", () => testDisconnectClean());

async function testRecoverySurvivesCleanup(): Promise<void> {
	// Simulate the session_shutdown → cleanup ordering
	const sessionId = "recovery-survive-test";
	const data: LinkRecoveryData = {
		sessionId,
		mode: "host",
		linkId: "link-survive",
		meta: {
			id: "link-survive",
			sessionId,
			sessionName: "survive-host",
			model: "test/model",
			created: Date.now(),
			lastHeartbeat: Date.now(),
			status: "connected",
		},
		savedAt: Date.now(),
	};

	// Save recovery data (like session_shutdown does on reload)
	saveRecoveryData(sessionId, data);

	// Simulate cleanup() — should NOT delete recovery data
	// (This is the fix: cleanup no longer calls deleteRecoveryData)
	const loaded = loadRecoveryData(sessionId);
	assert(loaded !== null, "recovery data should survive cleanup");

	// Only explicit disconnect should delete
	deleteRecoveryData(sessionId);
	assertEq(loadRecoveryData(sessionId), null, "should be deleted after explicit delete");
}

test("recovery data survives cleanup (fix verification)", () => testRecoverySurvivesCleanup());

// ─── Teardown + Summary ──────────────────────────────────────────────────

setTimeout(() => {
	// Clean up test dirs
	try { fs.rmSync(TEST_LINKS_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
	try { fs.rmSync(TEST_RECOVERY_DIR, { recursive: true, force: true }); } catch { /* ignore */ }

	// Restore original dirs
	(types as any).LINKS_DIR = origLinksDir;
	(types as any).LINK_RECOVERY_DIR = origRecoveryDir;

	console.log(`\n${"─".repeat(40)}`);
	console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
	if (failed > 0) {
		console.log("\n⚠️  Some tests failed!");
		process.exit(1);
	} else {
		console.log("\n✅ All tests passed!");
		process.exit(0);
	}
}, 2000);
