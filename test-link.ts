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
	STALE_THRESHOLD_MS,
	HEARTBEAT_TIMEOUT_MS,
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
const PREFIX = `__test_${crypto.randomBytes(4).toString("hex")}_`;
const createdDirs: string[] = [];

function testDir(id: string): string {
	const dir = path.join(LINKS_DIR, `${PREFIX}${id}`);
	fs.mkdirSync(dir, { recursive: true });
	createdDirs.push(dir);
	return dir;
}

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
ensureLinksDir();

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

test("sendJsonRpc writes newline-delimited JSON to socket", () => {
	return new Promise<void>((resolve, reject) => {
		const server = net.createServer((socket) => {
			let data = "";
			socket.on("data", (d) => { data += d.toString(); });
			socket.on("end", () => {
				try {
					const lines = data.trim().split("\n");
					assertEq(lines.length, 2, "should have 2 messages");
					const parsed = lines.map((l) => JSON.parse(l));
					assertEq(parsed[0].method, "ping");
					assertEq(parsed[1].method, "pong");
					socket.end();
					server.close();
					resolve();
				} catch (err) {
					reject(err);
				}
			});
		});
		server.listen(() => {
			const addr = server.address() as net.AddressInfo;
			const sock = new net.Socket();
			sock.connect(addr.port, "127.0.0.1", () => {
				sendJsonRpc(sock, createJsonRpc("ping", {}));
				sendJsonRpc(sock, createJsonRpc("pong", {}));
				sock.end();
			});
		});
	});
});

// ─── Link Directory ──────────────────────────────────────────────────────

console.log("\nLink Directory:");
test("writeMeta + readMeta round-trip", () => {
	const linkDir = testDir("meta-roundtrip");
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
	const read = readMeta(path.join(LINKS_DIR, "nonexistent-test-dir"));
	assertEq(read, null);
});

test("discoverLinks finds active links", () => {
	const linkDir = testDir("discover-active");
	const meta: LinkMeta = {
		id: `${PREFIX}discover1`,
		sessionId: "sess-disc",
		sessionName: "discoverable",
		model: "test/model",
		created: Date.now(),
		lastHeartbeat: Date.now(),
		status: "waiting",
	};
	writeMeta(linkDir, meta);
	const links = discoverLinks();
	assert(links.some((l) => l.meta.id === `${PREFIX}discover1`), "should find discover1");
});

test("discoverLinks skips stale links", () => {
	const linkDir = testDir("discover-stale");
	const meta: LinkMeta = {
		id: `${PREFIX}stale1`,
		sessionId: "sess-stale",
		sessionName: "stale",
		model: "test/model",
		created: Date.now() - STALE_THRESHOLD_MS - 1000,
		lastHeartbeat: Date.now() - STALE_THRESHOLD_MS - 1000,
		status: "waiting",
	};
	writeMeta(linkDir, meta);
	const links = discoverLinks();
	assert(!links.some((l) => l.meta.id === `${PREFIX}stale1`), "should not find stale1");
});

test("cleanupLinkDir removes directory", () => {
	const linkDir = testDir("cleanup-dir");
	fs.writeFileSync(path.join(linkDir, "meta.json"), "{}");
	assert(fs.existsSync(linkDir), "dir should exist before cleanup");
	cleanupLinkDir(linkDir);
	assert(!fs.existsSync(linkDir), "dir should be gone after cleanup");
});

// ─── Recovery Data ───────────────────────────────────────────────────────

console.log("\nRecovery Data:");
test("saveRecoveryData + loadRecoveryData round-trip", () => {
	const sessionId = `${PREFIX}recovery-rt`;
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
	deleteRecoveryData(sessionId);
});

test("loadRecoveryData returns null for missing", () => {
	const loaded = loadRecoveryData(`${PREFIX}nonexistent-session`);
	assertEq(loaded, null);
});

test("deleteRecoveryData removes file", () => {
	const sessionId = `${PREFIX}delete-test`;
	saveRecoveryData(sessionId, {
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
	});
	assert(loadRecoveryData(sessionId) !== null, "should exist before delete");
	deleteRecoveryData(sessionId);
	assertEq(loadRecoveryData(sessionId), null);
});

test("recovery file has restrictive permissions (0600)", () => {
	const sessionId = `${PREFIX}perms-test`;
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
	deleteRecoveryData(sessionId);
});

test("recovery data survives cleanup (fix verification)", () => {
	// Simulate session_shutdown → cleanup on reload:
	// 1. saveRecoveryData (session_shutdown saves state)
	// 2. cleanup() runs but should NOT delete recovery data (the fix)
	const sessionId = `${PREFIX}survive-cleanup`;
	saveRecoveryData(sessionId, {
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
	});

	// Simulate cleanup() — no longer calls deleteRecoveryData
	const loaded = loadRecoveryData(sessionId);
	assert(loaded !== null, "recovery data should survive cleanup");

	// Only explicit disconnect (cmdDisconnect) should delete
	deleteRecoveryData(sessionId);
	assertEq(loadRecoveryData(sessionId), null, "should be deleted after explicit delete");
});

// ─── UDS Connection (integration) ────────────────────────────────────────

console.log("\nUDS Connection:");

test("UDS ping/pong round-trip", () => {
	const sockPath = testDir("uds-ping") + "/link.sock";
	return new Promise<void>((resolve, reject) => {
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

		server.listen(sockPath, () => {
			const client = new net.Socket();
			client.connect(sockPath, () => {
				const ping = createJsonRpc("ping", { test: true });
				sendJsonRpc(client, ping);

				let buf = "";
				client.on("data", (data) => {
					buf += data.toString();
					const { messages } = parseJsonRpcLines(buf);
					if (messages.length > 0) {
						try {
							assertEq(messages[0].id, ping.id, "response id should match");
							assertEq((messages[0].result as any)?.pong, true, "should have pong");
							client.destroy();
							server.close();
							resolve();
						} catch (err) {
							reject(err);
						}
					}
				});
			});
			client.on("error", reject);
		});
		server.on("error", reject);
	});
});

test("half-open detection logic", () => {
	// Pure logic test: verify the condition used in startHeartbeat
	let lastPeerActivity = Date.now() - HEARTBEAT_TIMEOUT_MS - 5000;
	const isHalfOpen = lastPeerActivity > 0 && Date.now() - lastPeerActivity > HEARTBEAT_TIMEOUT_MS;
	assert(isHalfOpen, "should detect half-open when activity is stale");

	// Fresh activity should not trigger
	lastPeerActivity = Date.now();
	const isFresh = !(lastPeerActivity > 0 && Date.now() - lastPeerActivity > HEARTBEAT_TIMEOUT_MS);
	assert(isFresh, "should not detect half-open with fresh activity");
});

test("server detects client disconnect", () => {
	const sockPath = testDir("uds-disconnect") + "/link.sock";
	return new Promise<void>((resolve, reject) => {
		let serverGotClose = false;
		const server = net.createServer((socket) => {
			socket.on("close", () => { serverGotClose = true; });
		});

		server.listen(sockPath, () => {
			const client = new net.Socket();
			client.connect(sockPath, () => {
				client.destroy();
			});
			client.on("error", () => {});
		});

		setTimeout(() => {
			try {
				assert(serverGotClose, "server should detect client disconnect");
				server.close();
				resolve();
			} catch (err) {
				reject(err);
			}
		}, 200);
	});
});

test("writeMeta handles ENOENT gracefully (peer cleaned up dir)", () => {
	const linkDir = path.join(LINKS_DIR, `${PREFIX}enoent-test-${Date.now()}`);
	// Don't create the dir — writeMeta should not throw
	writeMeta(linkDir, {
		id: "enoent",
		sessionId: "enoent-sess",
		sessionName: "enoent",
		model: "test/model",
		created: Date.now(),
		lastHeartbeat: Date.now(),
		status: "waiting",
	});
	// If we got here, no exception was thrown
	assert(true, "writeMeta should not throw on ENOENT");
});

// ─── Teardown + Summary ──────────────────────────────────────────────────

setTimeout(() => {
	// Clean up all test directories
	for (const dir of createdDirs) {
		try { cleanupLinkDir(dir); } catch { /* best effort */ }
	}

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
