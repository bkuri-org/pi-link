/**
 * Tests for multi-link: linksRegistry CRUD, target resolution, list output
 *
 * Run: npx -y tsx test-multi-link.ts
 */

import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import {
	type LinkState,
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
	makeLink,
	createRegistry,
} from "./test-helpers.js";

console.log("\n📋 pi-link-extension — multi-link tests\n");

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

// ─── Summary ─────────────────────────────────────────────────────────────

setTimeout(() => {
	console.log(`\n${"─".repeat(50)}`);
	console.log(`Multi-link results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
	if (failed > 0) {
		console.log("\n⚠️  Some tests failed!");
		process.exit(1);
	} else {
		console.log("\n✅ All multi-link tests passed!");
		process.exit(0);
	}
}, 500);
