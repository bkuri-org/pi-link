/**
 * Tests for streaming: chunk delivery, assembly, completion/cleanup
 *
 * Run: npx -y tsx test-streaming.ts
 */

import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import {
	generateId,
	createJsonRpc,
	sendJsonRpc,
	parseJsonRpcLines,
} from "./types.js";
import {
	passed,
	failed,
	test,
	assert,
	assertEq,
} from "./test-helpers.js";

console.log("\n📋 pi-link-extension — streaming tests\n");

// ═══════════════════════════════════════════════════════════════════════════
// 2. STREAMING (8jk) — chunk delivery, assembly, completion/cleanup
// ═══════════════════════════════════════════════════════════════════════════

console.log("── Streaming (8jk) ──");

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

// ─── Summary ─────────────────────────────────────────────────────────────

setTimeout(() => {
	console.log(`\n${"─".repeat(50)}`);
	console.log(`Streaming results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
	if (failed > 0) {
		console.log("\n⚠️  Some tests failed!");
		process.exit(1);
	} else {
		console.log("\n✅ All streaming tests passed!");
		process.exit(0);
	}
}, 3000);
