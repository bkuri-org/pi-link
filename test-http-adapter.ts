/**
 * Tests for HTTP adapter: auth, RPC, discovery, health, UDS fallback
 *
 * Run: npx -y tsx test-http-adapter.ts
 */

import * as net from "node:net";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import {
	type JsonRpcMessage,
	generateId,
	createJsonRpc,
	ensureLinkSecret,
	httpPostRpc,
} from "./types.js";
import {
	passed,
	failed,
	test,
	assert,
	assertEq,
	getFreePort,
	createTestHttpServer,
	httpGet,
	httpPost,
	testSecret,
	testLink,
} from "./test-helpers.js";

console.log("\n📋 pi-link-extension — HTTP adapter tests\n");

// ═══════════════════════════════════════════════════════════════════════════
// 3. HTTP ADAPTER (b6e) — auth, RPC, discovery, health, UDS fallback
// ═══════════════════════════════════════════════════════════════════════════

console.log("── HTTP Adapter (b6e) ──");

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

	try {
		const secret = ensureLinkSecret();
		assert(secret.length > 0, "should return a non-empty secret");
		assert(/^[0-9a-f]+$/.test(secret), "secret should be hex");
	} finally {
		if (originalSecret !== undefined) process.env.PI_LINK_SECRET = originalSecret;
	}
});

// ─── Summary ─────────────────────────────────────────────────────────────

setTimeout(() => {
	console.log(`\n${"─".repeat(50)}`);
	console.log(`HTTP adapter results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
	if (failed > 0) {
		console.log("\n⚠️  Some tests failed!");
		process.exit(1);
	} else {
		console.log("\n✅ All HTTP adapter tests passed!");
		process.exit(0);
	}
}, 3000);
