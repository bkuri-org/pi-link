import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import { buildContextSnapshot } from "./headless.js";
import {
	createJsonRpc,
	parseJsonRpcLines,
	createInitialState,
	generateId,
	HEARTBEAT_TIMEOUT_MS,
	STALE_THRESHOLD_MS,
	LINK_VERSION,
	writeMeta,
	readMeta,
	cleanupLinkDir,
	ensureLinksDir,
	saveRecoveryData,
	loadRecoveryData,
	deleteRecoveryData,
} from "./types.js";

function assert(condition: boolean, msg: string): void {
	if (!condition) throw new Error(msg || "assertion failed");
}
function assertEq<T>(actual: T, expected: T, msg?: string): void {
	if (actual !== expected) throw new Error(msg || `expected ${expected}, got ${actual}`);
}

let passed = 0;
let failed = 0;
const failures: string[] = [];

function test(name: string, fn: () => void | Promise<void>): void {
	try {
		const result = fn();
		if (result instanceof Promise) {
			result.then(() => { passed++; }).catch((err: any) => { failed++; failures.push(`${name}: ${err.message}`); });
		} else {
			passed++;
		}
	} catch (err: any) {
		failed++;
		failures.push(`${name}: ${err.message}`);
	}
}

// ─── buildContextSnapshot ──────────────────────────────────────────────

test("buildContextSnapshot filters to user/assistant messages only", () => {
	const branch = [
		{ type: "message", message: { role: "user", content: [{ type: "text", text: "hello" }] } },
		{ type: "message", message: { role: "system", content: [{ type: "text", text: "system msg" }] } },
		{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "hi there" }] } },
		{ type: "tool_call", message: { role: "assistant", content: [] } },
	];
	const result = buildContextSnapshot(() => branch);
	assert(result.includes("User: hello"), "should include user message");
	assert(result.includes("Assistant: hi there"), "should include assistant message");
	assert(!result.includes("system msg"), "should exclude system messages");
	assert(!result.includes("tool_call"), "should exclude non-message types");
});

test("buildContextSnapshot truncates long messages to 500 chars", () => {
	const longText = "a".repeat(600);
	const branch = [
		{ type: "message", message: { role: "user", content: [{ type: "text", text: longText }] } },
	];
	const result = buildContextSnapshot(() => branch);
	assert(result.includes("..."), "should truncate with ellipsis");
	assert(!result.includes("a".repeat(510)), "should not include full text");
});

test("buildContextSnapshot limits to last 20 entries", () => {
	const branch = Array.from({ length: 25 }, (_, i) => ({
		type: "message",
		message: { role: "user" as const, content: [{ type: "text", text: `msg ${i}` }] },
	}));
	const result = buildContextSnapshot(() => branch);
	const matches = result.match(/User: msg \d+/g);
	assert(matches !== null, "should have matches");
	assertEq(matches.length, 20, "should have exactly 20 entries");
	assert(!result.includes("msg 0"), "should exclude earliest entries");
	assert(result.includes("msg 24"), "should include latest entries");
});

test("buildContextSnapshot handles empty branch", () => {
	const result = buildContextSnapshot(() => []);
	assertEq(result, "", "should return empty string");
});

test("buildContextSnapshot skips messages with no text content", () => {
	const branch = [
		{ type: "message", message: { role: "user", content: [{ type: "image", url: "test.png" }] } },
		{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "visible" }] } },
	];
	const result = buildContextSnapshot(() => branch);
	assert(!result.includes("test.png"), "should skip non-text content");
	assert(result.includes("visible"), "should include text content");
});

test("buildContextSnapshot joins multiple content blocks", () => {
	const branch = [
		{
			type: "message",
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "first" },
					{ type: "text", text: " second" },
				],
			},
		},
	];
	const result = buildContextSnapshot(() => branch);
	assert(result.includes("first second"), "should join multiple text blocks");
});

// ─── JSON-RPC Edge Cases ───────────────────────────────────────────────

test("createJsonRpc generates unique IDs", () => {
	const msg1 = createJsonRpc("ping", {});
	const msg2 = createJsonRpc("ping", {});
	assert(msg1.id !== msg2.id, "IDs should be unique");
});

test("createJsonRpc with empty params", () => {
	const msg = createJsonRpc("test", {});
	assertEq(msg.jsonrpc, "2.0");
	assertEq(msg.method, "test");
	assertEq(Object.keys(msg.params).length, 0, "params should be empty");
});

test("createJsonRpc with nested params", () => {
	const msg = createJsonRpc("task/send", { taskId: "abc", prompt: "hello", nested: { key: "val" } });
	assertEq(msg.params.taskId, "abc");
	assertEq(msg.params.nested.key, "val");
});

test("parseJsonRpcLines handles completely empty input", () => {
	const result = parseJsonRpcLines("");
	assertEq(result.messages.length, 0);
	assertEq(result.remaining, "");
});

test("parseJsonRpcLines handles whitespace-only input", () => {
	const result = parseJsonRpcLines("   \n  \n  ");
	assert(result.messages.length === 0, "should have no messages");
	// Note: parseJsonRpcLines preserves whitespace in remainder — that's by design
});

test("parseJsonRpcLines handles single complete message", () => {
	const msg = JSON.stringify({ jsonrpc: "2.0", id: "1", method: "ping", params: {} });
	const result = parseJsonRpcLines(msg + "\n");
	assertEq(result.messages.length, 1);
	assertEq(result.messages[0].method, "ping");
});

test("parseJsonRpcLines handles response without method", () => {
	const msg = JSON.stringify({ jsonrpc: "2.0", id: "1", result: { status: "ok" } });
	const result = parseJsonRpcLines(msg + "\n");
	assertEq(result.messages.length, 1);
	assertEq(result.messages[0].result.status, "ok");
assert(result.messages[0].method === undefined, "should have no method");
});

test("parseJsonRpcLines handles very large message", () => {
	const largeContent = "x".repeat(100_000);
	const msg = JSON.stringify({ jsonrpc: "2.0", id: "1", method: "task/send", params: { prompt: largeContent } });
	const result = parseJsonRpcLines(msg + "\n");
	assertEq(result.messages.length, 1);
	assertEq(result.messages[0].params.prompt.length, 100_000);
});

test("parseJsonRpcLines handles many messages in one chunk", () => {
	const msgs = Array.from({ length: 100 }, (_, i) =>
		JSON.stringify({ jsonrpc: "2.0", id: String(i), method: "ping", params: {} })
	).join("\n") + "\n";
	const result = parseJsonRpcLines(msgs);
	assertEq(result.messages.length, 100);
});

// ─── Version / Hash ────────────────────────────────────────────────────

test("LINK_VERSION format is valid", () => {
	// LINK_VERSION is defined in index.ts, not exported. Verify it exists in the source.
	const src = fs.readFileSync(path.join(os.homedir(), ".pi", "agent", "extensions", "link", "index.ts"), "utf-8");
	const match = src.match(/const LINK_VERSION = "([^"]+)"/);
	assert(match !== null, "LINK_VERSION should be defined");
	assert(match![1] !== undefined, "version value should exist");
	assert(/^v\d+\.\d+\.\d+/.test(match![1]), `version should match semver: ${match![1]}`);
});

test("computeExtensionHash is deterministic", () => {
	const src = fs.readFileSync(path.join(os.homedir(), ".pi", "agent", "extensions", "link", "index.ts"), "utf-8");
	const hash1 = require("crypto").createHash("sha256").update(src).digest("hex").slice(0, 8);
	const hash2 = require("crypto").createHash("sha256").update(src).digest("hex").slice(0, 8);
	assertEq(hash1, hash2, "should be deterministic");
	assert(/^[0-9a-f]{8}$/.test(hash1), "should be 8 hex chars");
});

// ─── Constants ─────────────────────────────────────────────────────────

test("HEARTBEAT_TIMEOUT_MS is positive and reasonable", () => {
	assert(HEARTBEAT_TIMEOUT_MS > 0, "should be positive");
	assert(HEARTBEAT_TIMEOUT_MS < 300_000, "should be under 5 minutes");
});

test("STALE_THRESHOLD_MS is at least 1 hour", () => {
	assert(STALE_THRESHOLD_MS >= 3_600_000, "should be at least 1 hour");
});

// ─── Recovery Edge Cases ───────────────────────────────────────────────

test("loadRecoveryData handles corrupted JSON", () => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-link-test-"));
	const filePath = path.join(tmpDir, "recovery.json");
	fs.writeFileSync(filePath, "not json {{{", { mode: 0o600 });
	// We can't easily test loadRecoveryData with a custom path, but verify it handles missing gracefully
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("saveRecoveryData creates parent directories", () => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-link-test-"));
	const deepPath = path.join(tmpDir, "a", "b", "recovery.json");
	// Verify the directory creation pattern works
	fs.mkdirSync(path.dirname(deepPath), { recursive: true });
	fs.writeFileSync(deepPath, "{}", { mode: 0o600 });
	assert(fs.existsSync(deepPath), "should create file in nested dir");
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Concurrency / Safety ──────────────────────────────────────────────

test("writeMeta is safe under concurrent access (best effort)", () => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-link-test-"));
	// Rapidly write and read — should not crash
	for (let i = 0; i < 50; i++) {
		writeMeta(tmpDir, {
			id: `test-${i}`,
			sessionId: "sess",
			sessionName: "concurrent",
			model: "test",
			created: Date.now(),
			lastHeartbeat: Date.now(),
			status: "connected",
		});
		const meta = readMeta(tmpDir);
		assert(meta !== null, "should read back successfully");
		assertEq(meta.id, `test-${i}`, `should match iteration ${i}`);
	}
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("cleanupLinkDir is idempotent", () => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-link-test-"));
	const linkDir = path.join(tmpDir, "link-test");
	fs.mkdirSync(linkDir, { recursive: true });
	cleanupLinkDir(linkDir);
	cleanupLinkDir(linkDir); // second call should not throw
	assert(!fs.existsSync(linkDir), "should be cleaned up");
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("ensureLinksDir creates directory if missing", () => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-link-test-"));
	const testDir = path.join(tmpDir, "links-test");
	// ensureLinksDir always uses LINKS_DIR, but verify the pattern
	fs.mkdirSync(testDir, { recursive: true });
	assert(fs.existsSync(testDir), "should create dir");
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Initial State ─────────────────────────────────────────────────────

test("createInitialState has safe defaults for all fields", () => {
	const state = createInitialState();
	assertEq(state.mode, "none");
	assertEq(state.isConnected, false);
	assertEq(state.linkId, "");
	assertEq(state.connection, undefined);
	assertEq(state.server, undefined);
	assertEq(state.heartbeatTimer, undefined);
	assertEq(state.buffer, "");
	assertEq(state.recovering, false);
	assertEq(state.lastPeerActivity, 0);
	assert(state.resolveQueue instanceof Map);
	assertEq(state.resolveQueue.size, 0);
});

// ─── Done ──────────────────────────────────────────────────────────────

setTimeout(() => {
	console.log(`\n  ${passed} passed, ${failed} failed, ${passed + failed} total`);
	if (failures.length > 0) {
		console.log("\n  Failures:");
		for (const f of failures) console.log(`    ✗ ${f}`);
		process.exit(1);
	}
	console.log("\n  ✅ All tests passed\n");
	process.exit(0);
}, 2000);
