/**
 * Tests for multi-link support in pi-link-extension
 *
 * Tests linksRegistry add/remove/get, target resolution, and multi-link isolation.
 * Run: npx -y tsx test-new-features.ts
 */

import * as crypto from "node:crypto";
import { type LinkState, createInitialState } from "./types.js";

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

// ─── Helpers: replicate the registry logic from index.ts ────────────────

function makeLink(overrides: Partial<LinkState> & { linkId: string }): LinkState {
	const link = createInitialState();
	Object.assign(link, overrides);
	if (overrides.meta) Object.assign(link.meta, overrides.meta);
	return link;
}

/**
 * Replicate the addLink logic from index.ts:
 *   linksRegistry.set(link.linkId, link)
 *   state = link
 */
function addLink(
	registry: Map<string, LinkState>,
	link: LinkState,
	active: { current: LinkState },
): void {
	registry.set(link.linkId, link);
	active.current = link;
}

/**
 * Replicate the removeLink logic from index.ts:
 *   linksRegistry.delete(linkId)
 *   If active was removed, pick next connected, then first available, then initial state
 */
function removeLink(
	registry: Map<string, LinkState>,
	linkId: string,
	active: { current: LinkState },
): void {
	registry.delete(linkId);
	if (active.current.linkId === linkId) {
		let next: LinkState | undefined;
		for (const l of registry.values()) {
			if (l.isConnected) { next = l; break; }
		}
		if (!next) next = registry.values().next().value;
		active.current = next ?? createInitialState();
	}
}

/**
 * Replicate the resolveTargetLink logic from index.ts.
 * Resolves by: ID prefix → session name → peer session name → index
 */
function resolveTargetLink(
	registry: Map<string, LinkState>,
	active: LinkState,
	target: string | undefined,
): LinkState | undefined {
	if (!target) {
		return active.mode !== "none" ? active : undefined;
	}

	// By ID prefix
	for (const [id, link] of registry) {
		if (id.startsWith(target)) return link;
	}

	// By session name
	for (const link of registry.values()) {
		if (link.meta.sessionName === target) return link;
	}

	// By peer session name
	for (const link of registry.values()) {
		if (link.peerInfo?.sessionName === target) return link;
	}

	// By index
	const idx = parseInt(target, 10);
	if (!isNaN(idx)) {
		const links = [...registry.values()];
		return links[idx];
	}

	return undefined;
}

// ─── Tests ───────────────────────────────────────────────────────────────

console.log("\n📋 Multi-link support tests\n");

// ═══════════════════════════════════════════════════════════════════════════
// 1. linksRegistry add/remove/get operations
// ═══════════════════════════════════════════════════════════════════════════

console.log("linksRegistry add/remove/get:");

test("addLink inserts into registry and sets active", () => {
	const registry = new Map<string, LinkState>();
	const active = { current: createInitialState() };

	const link = makeLink({
		linkId: "aaa11111",
		mode: "host",
		isConnected: true,
		meta: { sessionName: "session-alpha", sessionId: "s1", model: "m1", created: 1, lastHeartbeat: 1, status: "connected" },
	});

	addLink(registry, link, active);

	assertEq(registry.size, 1, "registry should have 1 link");
	assert(registry.has("aaa11111"), "registry should contain link by ID");
	assertEq(active.current.linkId, "aaa11111", "active should be the new link");
});

test("addLink multiple links each become active", () => {
	const registry = new Map<string, LinkState>();
	const active = { current: createInitialState() };

	const linkA = makeLink({
		linkId: "aaa11111",
		mode: "host",
		isConnected: true,
		meta: { sessionName: "alpha", sessionId: "s1", model: "m1", created: 1, lastHeartbeat: 1, status: "connected" },
	});
	const linkB = makeLink({
		linkId: "bbb22222",
		mode: "guest",
		isConnected: true,
		meta: { sessionName: "beta", sessionId: "s2", model: "m2", created: 2, lastHeartbeat: 2, status: "connected" },
	});

	addLink(registry, linkA, active);
	assertEq(active.current.linkId, "aaa11111", "first link should be active");

	addLink(registry, linkB, active);
	assertEq(active.current.linkId, "bbb22222", "second link should become active");
	assertEq(registry.size, 2, "registry should have 2 links");
});

test("removeLink removes from registry", () => {
	const registry = new Map<string, LinkState>();
	const active = { current: createInitialState() };

	const link = makeLink({
		linkId: "aaa11111",
		mode: "host",
		isConnected: true,
		meta: { sessionName: "alpha", sessionId: "s1", model: "m1", created: 1, lastHeartbeat: 1, status: "connected" },
	});
	addLink(registry, link, active);
	assertEq(registry.size, 1);

	removeLink(registry, "aaa11111", active);
	assertEq(registry.size, 0, "registry should be empty after removal");
	assertEq(active.current.mode, "none", "active should reset to initial state");
});

test("removeLink non-active link keeps active unchanged", () => {
	const registry = new Map<string, LinkState>();
	const active = { current: createInitialState() };

	const linkA = makeLink({
		linkId: "aaa11111",
		mode: "host",
		isConnected: true,
		meta: { sessionName: "alpha", sessionId: "s1", model: "m1", created: 1, lastHeartbeat: 1, status: "connected" },
	});
	const linkB = makeLink({
		linkId: "bbb22222",
		mode: "guest",
		isConnected: true,
		meta: { sessionName: "beta", sessionId: "s2", model: "m2", created: 2, lastHeartbeat: 2, status: "connected" },
	});

	addLink(registry, linkA, active);
	addLink(registry, linkB, active);
	assertEq(active.current.linkId, "bbb22222", "B should be active");

	// Remove A (not active)
	removeLink(registry, "aaa11111", active);
	assertEq(registry.size, 1, "registry should have 1 link");
	assertEq(active.current.linkId, "bbb22222", "active should still be B");
});

test("removeLink active link falls back to next connected", () => {
	const registry = new Map<string, LinkState>();
	const active = { current: createInitialState() };

	const linkA = makeLink({
		linkId: "aaa11111",
		mode: "host",
		isConnected: true,
		meta: { sessionName: "alpha", sessionId: "s1", model: "m1", created: 1, lastHeartbeat: 1, status: "connected" },
	});
	const linkB = makeLink({
		linkId: "bbb22222",
		mode: "guest",
		isConnected: true,
		meta: { sessionName: "beta", sessionId: "s2", model: "m2", created: 2, lastHeartbeat: 2, status: "connected" },
	});
	const linkC = makeLink({
		linkId: "ccc33333",
		mode: "guest",
		isConnected: false,
		meta: { sessionName: "gamma", sessionId: "s3", model: "m3", created: 3, lastHeartbeat: 3, status: "waiting" },
	});

	addLink(registry, linkA, active);
	addLink(registry, linkB, active);
	addLink(registry, linkC, active);
	assertEq(active.current.linkId, "ccc33333", "C should be active (last added)");

	// Remove active (C) — should fall back to A (first connected)
	removeLink(registry, "ccc33333", active);
	assertEq(active.current.linkId, "aaa11111", "should fall back to first connected link (A)");
});

test("removeLink active with no connected falls back to first available", () => {
	const registry = new Map<string, LinkState>();
	const active = { current: createInitialState() };

	const linkA = makeLink({
		linkId: "aaa11111",
		mode: "host",
		isConnected: false,
		meta: { sessionName: "alpha", sessionId: "s1", model: "m1", created: 1, lastHeartbeat: 1, status: "waiting" },
	});
	const linkB = makeLink({
		linkId: "bbb22222",
		mode: "guest",
		isConnected: false,
		meta: { sessionName: "beta", sessionId: "s2", model: "m2", created: 2, lastHeartbeat: 2, status: "waiting" },
	});

	addLink(registry, linkA, active);
	addLink(registry, linkB, active);

	// Remove active (B) — no connected links, falls back to first available (A)
	removeLink(registry, "bbb22222", active);
	assertEq(active.current.linkId, "aaa11111", "should fall back to first available (A)");
});

test("removeLink last link resets to initial state", () => {
	const registry = new Map<string, LinkState>();
	const active = { current: createInitialState() };

	const link = makeLink({
		linkId: "aaa11111",
		mode: "host",
		isConnected: true,
		meta: { sessionName: "alpha", sessionId: "s1", model: "m1", created: 1, lastHeartbeat: 1, status: "connected" },
	});
	addLink(registry, link, active);
	removeLink(registry, "aaa11111", active);

	assertEq(registry.size, 0);
	assertEq(active.current.mode, "none");
	assertEq(active.current.isConnected, false);
	assertEq(active.current.linkId, "");
});

test("get by registry.get returns correct link", () => {
	const registry = new Map<string, LinkState>();
	const active = { current: createInitialState() };

	const linkA = makeLink({
		linkId: "aaa11111",
		mode: "host",
		isConnected: true,
		meta: { sessionName: "alpha", sessionId: "s1", model: "m1", created: 1, lastHeartbeat: 1, status: "connected" },
	});
	const linkB = makeLink({
		linkId: "bbb22222",
		mode: "guest",
		isConnected: true,
		meta: { sessionName: "beta", sessionId: "s2", model: "m2", created: 2, lastHeartbeat: 2, status: "connected" },
	});

	addLink(registry, linkA, active);
	addLink(registry, linkB, active);

	const retrieved = registry.get("aaa11111");
	assert(retrieved !== undefined, "should retrieve link by exact ID");
	assertEq(retrieved!.meta.sessionName, "alpha");
	assertEq(retrieved!.mode, "host");

	const missing = registry.get("zzz99999");
	assertEq(missing, undefined, "missing ID should return undefined");
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Target resolution by ID prefix, name, or index
// ═══════════════════════════════════════════════════════════════════════════

console.log("\nTarget resolution:");

test("resolveTargetLink undefined target returns active link", () => {
	const registry = new Map<string, LinkState>();
	const active = createInitialState();
	active.mode = "host";
	active.linkId = "aaa11111";
	active.isConnected = true;

	const result = resolveTargetLink(registry, active, undefined);
	assert(result !== undefined, "should return active link");
	assertEq(result!.linkId, "aaa11111");
});

test("resolveTargetLink undefined target returns undefined when no active link", () => {
	const registry = new Map<string, LinkState>();
	const active = createInitialState(); // mode: "none"

	const result = resolveTargetLink(registry, active, undefined);
	assertEq(result, undefined, "should return undefined when no active link");
});

test("resolveTargetLink by full ID", () => {
	const registry = new Map<string, LinkState>();
	const active = createInitialState();
	const link = makeLink({
		linkId: "abc12345",
		mode: "host",
		isConnected: true,
		meta: { sessionName: "target", sessionId: "s1", model: "m1", created: 1, lastHeartbeat: 1, status: "connected" },
	});
	registry.set(link.linkId, link);

	const result = resolveTargetLink(registry, active, "abc12345");
	assert(result !== undefined);
	assertEq(result!.linkId, "abc12345");
});

test("resolveTargetLink by ID prefix (shortest unique)", () => {
	const registry = new Map<string, LinkState>();
	const active = createInitialState();

	const linkA = makeLink({
		linkId: "aaaa1111",
		mode: "host",
		isConnected: true,
		meta: { sessionName: "alpha", sessionId: "s1", model: "m1", created: 1, lastHeartbeat: 1, status: "connected" },
	});
	const linkB = makeLink({
		linkId: "bbbb2222",
		mode: "guest",
		isConnected: true,
		meta: { sessionName: "beta", sessionId: "s2", model: "m2", created: 2, lastHeartbeat: 2, status: "connected" },
	});

	registry.set(linkA.linkId, linkA);
	registry.set(linkB.linkId, linkB);

	// "a" should match aaaa1111
	const resultA = resolveTargetLink(registry, active, "a");
	assert(resultA !== undefined, "should find link with prefix 'a'");
	assertEq(resultA!.meta.sessionName, "alpha");

	// "b" should match bbbb2222
	const resultB = resolveTargetLink(registry, active, "b");
	assert(resultB !== undefined, "should find link with prefix 'b'");
	assertEq(resultB!.meta.sessionName, "beta");

	// "aa" should still match aaaa1111
	const resultAA = resolveTargetLink(registry, active, "aa");
	assert(resultAA !== undefined);
	assertEq(resultAA!.meta.sessionName, "alpha");
});

test("resolveTargetLink by ID prefix returns first match", () => {
	const registry = new Map<string, LinkState>();
	const active = createInitialState();

	const linkA = makeLink({
		linkId: "ab111111",
		mode: "host",
		isConnected: true,
		meta: { sessionName: "first-ab", sessionId: "s1", model: "m1", created: 1, lastHeartbeat: 1, status: "connected" },
	});
	const linkB = makeLink({
		linkId: "ab222222",
		mode: "guest",
		isConnected: true,
		meta: { sessionName: "second-ab", sessionId: "s2", model: "m2", created: 2, lastHeartbeat: 2, status: "connected" },
	});

	registry.set(linkA.linkId, linkA);
	registry.set(linkB.linkId, linkB);

	// "ab" prefix matches both — should return first (insertion order)
	const result = resolveTargetLink(registry, active, "ab");
	assert(result !== undefined, "should find a match for prefix 'ab'");
	assertEq(result!.meta.sessionName, "first-ab", "should return first match by insertion order");
});

test("resolveTargetLink by session name", () => {
	const registry = new Map<string, LinkState>();
	const active = createInitialState();

	const link = makeLink({
		linkId: "zzz99999",
		mode: "host",
		isConnected: true,
		meta: { sessionName: "my-special-session", sessionId: "s1", model: "m1", created: 1, lastHeartbeat: 1, status: "connected" },
	});
	registry.set(link.linkId, link);

	// No ID prefix match — falls through to session name
	const result = resolveTargetLink(registry, active, "my-special-session");
	assert(result !== undefined);
	assertEq(result!.linkId, "zzz99999");
});

test("resolveTargetLink by peer session name", () => {
	const registry = new Map<string, LinkState>();
	const active = createInitialState();

	const link = makeLink({
		linkId: "zzz99999",
		mode: "guest",
		isConnected: true,
		peerInfo: { sessionId: "peer-s1", sessionName: "remote-builder", model: "peer/m1" },
		meta: { sessionName: "local-session", sessionId: "s1", model: "m1", created: 1, lastHeartbeat: 1, status: "connected" },
	});
	registry.set(link.linkId, link);

	// No ID prefix or session name match — falls through to peer session name
	const result = resolveTargetLink(registry, active, "remote-builder");
	assert(result !== undefined);
	assertEq(result!.linkId, "zzz99999");
});

test("resolveTargetLink by numeric index", () => {
	const registry = new Map<string, LinkState>();
	const active = createInitialState();

	const linkA = makeLink({
		linkId: "first",
		mode: "host",
		isConnected: true,
		meta: { sessionName: "link-zero", sessionId: "s0", model: "m0", created: 1, lastHeartbeat: 1, status: "connected" },
	});
	const linkB = makeLink({
		linkId: "second",
		mode: "guest",
		isConnected: true,
		meta: { sessionName: "link-one", sessionId: "s1", model: "m1", created: 2, lastHeartbeat: 2, status: "connected" },
	});
	const linkC = makeLink({
		linkId: "third",
		mode: "guest",
		isConnected: true,
		meta: { sessionName: "link-two", sessionId: "s2", model: "m2", created: 3, lastHeartbeat: 3, status: "connected" },
	});

	registry.set(linkA.linkId, linkA);
	registry.set(linkB.linkId, linkB);
	registry.set(linkC.linkId, linkC);

	const result0 = resolveTargetLink(registry, active, "0");
	assert(result0 !== undefined);
	assertEq(result0!.meta.sessionName, "link-zero");

	const result1 = resolveTargetLink(registry, active, "1");
	assert(result1 !== undefined);
	assertEq(result1!.meta.sessionName, "link-one");

	const result2 = resolveTargetLink(registry, active, "2");
	assert(result2 !== undefined);
	assertEq(result2!.meta.sessionName, "link-two");
});

test("resolveTargetLink index out of bounds returns undefined", () => {
	const registry = new Map<string, LinkState>();
	const active = createInitialState();

	const link = makeLink({
		linkId: "only",
		mode: "host",
		isConnected: true,
		meta: { sessionName: "solo", sessionId: "s1", model: "m1", created: 1, lastHeartbeat: 1, status: "connected" },
	});
	registry.set(link.linkId, link);

	assertEq(resolveTargetLink(registry, active, "5"), undefined, "index 5 should be undefined");
	assertEq(resolveTargetLink(registry, active, "-1"), undefined, "negative index should be undefined");
});

test("resolveTargetLink no match returns undefined", () => {
	const registry = new Map<string, LinkState>();
	const active = createInitialState();

	const link = makeLink({
		linkId: "aaa11111",
		mode: "host",
		isConnected: true,
		meta: { sessionName: "alpha", sessionId: "s1", model: "m1", created: 1, lastHeartbeat: 1, status: "connected" },
	});
	registry.set(link.linkId, link);

	assertEq(resolveTargetLink(registry, active, "nonexistent"), undefined);
	assertEq(resolveTargetLink(registry, active, "zzz"), undefined);
});

test("resolveTargetLink priority: ID prefix > session name > peer name > index", () => {
	const registry = new Map<string, LinkState>();
	const active = createInitialState();

	// Create a link whose ID starts with "0" and whose session name is "1"
	const link = makeLink({
		linkId: "0abc1234",
		mode: "host",
		isConnected: true,
		peerInfo: { sessionId: "p1", sessionName: "2", model: "pm" },
		meta: { sessionName: "1", sessionId: "s1", model: "m1", created: 1, lastHeartbeat: 1, status: "connected" },
	});
	registry.set(link.linkId, link);

	// "0" matches ID prefix — should take priority over index 0
	const result = resolveTargetLink(registry, active, "0");
	assert(result !== undefined);
	assertEq(result!.linkId, "0abc1234", "ID prefix '0' should match, not index 0");
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Multiple simultaneous links don't interfere
// ═══════════════════════════════════════════════════════════════════════════

console.log("\nMulti-link isolation:");

test("modifying one link's meta does not affect others", () => {
	const registry = new Map<string, LinkState>();
	const active = { current: createInitialState() };

	const linkA = makeLink({
		linkId: "aaa11111",
		mode: "host",
		isConnected: true,
		meta: { sessionName: "alpha", sessionId: "s1", model: "m1", created: 1, lastHeartbeat: 1, status: "connected" },
	});
	const linkB = makeLink({
		linkId: "bbb22222",
		mode: "guest",
		isConnected: true,
		meta: { sessionName: "beta", sessionId: "s2", model: "m2", created: 2, lastHeartbeat: 2, status: "connected" },
	});

	addLink(registry, linkA, active);
	addLink(registry, linkB, active);

	// Mutate linkA's meta
	registry.get("aaa11111")!.meta.sessionName = "alpha-modified";
	registry.get("aaa11111")!.isConnected = false;

	// linkB should be unaffected
	const b = registry.get("bbb22222")!;
	assertEq(b.meta.sessionName, "beta", "B's session name should be unchanged");
	assertEq(b.isConnected, true, "B's connection state should be unchanged");
	assertEq(b.mode, "guest", "B's mode should be unchanged");
});

test("removing one link does not affect the other", () => {
	const registry = new Map<string, LinkState>();
	const active = { current: createInitialState() };

	const linkA = makeLink({
		linkId: "aaa11111",
		mode: "host",
		isConnected: true,
		meta: { sessionName: "alpha", sessionId: "s1", model: "m1", created: 1, lastHeartbeat: 1, status: "connected" },
	});
	const linkB = makeLink({
		linkId: "bbb22222",
		mode: "guest",
		isConnected: true,
		meta: { sessionName: "beta", sessionId: "s2", model: "m2", created: 2, lastHeartbeat: 2, status: "connected" },
	});

	addLink(registry, linkA, active);
	addLink(registry, linkB, active);

	// Remove A
	removeLink(registry, "aaa11111", active);

	// B should still be intact
	const b = registry.get("bbb22222");
	assert(b !== undefined, "B should still exist in registry");
	assertEq(b!.meta.sessionName, "beta");
	assertEq(b!.isConnected, true);
	assertEq(b!.linkId, "bbb22222");
});

test("resolveTargetLink picks correct link among many", () => {
	const registry = new Map<string, LinkState>();
	const active = createInitialState();

	const links = [
		makeLink({ linkId: "link0001", mode: "host", isConnected: true, meta: { sessionName: "dev", sessionId: "s1", model: "m1", created: 1, lastHeartbeat: 1, status: "connected" } }),
		makeLink({ linkId: "link0002", mode: "guest", isConnected: true, meta: { sessionName: "build", sessionId: "s2", model: "m2", created: 2, lastHeartbeat: 2, status: "connected" } }),
		makeLink({ linkId: "link0003", mode: "guest", isConnected: true, meta: { sessionName: "test", sessionId: "s3", model: "m3", created: 3, lastHeartbeat: 3, status: "connected" } }),
		makeLink({ linkId: "link0004", mode: "guest", isConnected: false, meta: { sessionName: "monitor", sessionId: "s4", model: "m4", created: 4, lastHeartbeat: 4, status: "waiting" } }),
	];

	for (const link of links) {
		registry.set(link.linkId, link);
	}

	// Resolve by session name
	assertEq(resolveTargetLink(registry, active, "dev")!.linkId, "link0001");
	assertEq(resolveTargetLink(registry, active, "build")!.linkId, "link0002");
	assertEq(resolveTargetLink(registry, active, "test")!.linkId, "link0003");
	assertEq(resolveTargetLink(registry, active, "monitor")!.linkId, "link0004");

	// Resolve by index
	assertEq(resolveTargetLink(registry, active, "0")!.linkId, "link0001");
	assertEq(resolveTargetLink(registry, active, "3")!.linkId, "link0004");

	// Resolve by ID prefix
	assertEq(resolveTargetLink(registry, active, "link0")!.linkId, "link0001");
	assertEq(resolveTargetLink(registry, active, "link0003")!.linkId, "link0003");
});

test("each link has independent resolveQueue", () => {
	const registry = new Map<string, LinkState>();
	const active = { current: createInitialState() };

	const linkA = makeLink({
		linkId: "aaa11111",
		mode: "host",
		isConnected: true,
		meta: { sessionName: "alpha", sessionId: "s1", model: "m1", created: 1, lastHeartbeat: 1, status: "connected" },
	});
	const linkB = makeLink({
		linkId: "bbb22222",
		mode: "guest",
		isConnected: true,
		meta: { sessionName: "beta", sessionId: "s2", model: "m2", created: 2, lastHeartbeat: 2, status: "connected" },
	});

	addLink(registry, linkA, active);
	addLink(registry, linkB, active);

	// Add entries to each queue
	linkA.resolveQueue.set("req-a1", () => {});
	linkA.resolveQueue.set("req-a2", () => {});
	linkB.resolveQueue.set("req-b1", () => {});

	assertEq(linkA.resolveQueue.size, 2, "A should have 2 queued items");
	assertEq(linkB.resolveQueue.size, 1, "B should have 1 queued item");

	// Clear A's queue
	linkA.resolveQueue.clear();
	assertEq(linkA.resolveQueue.size, 0, "A's queue should be empty");
	assertEq(linkB.resolveQueue.size, 1, "B's queue should be unaffected");
});

test("each link has independent buffer", () => {
	const registry = new Map<string, LinkState>();
	const active = { current: createInitialState() };

	const linkA = makeLink({
		linkId: "aaa11111",
		mode: "host",
		isConnected: true,
		meta: { sessionName: "alpha", sessionId: "s1", model: "m1", created: 1, lastHeartbeat: 1, status: "connected" },
	});
	const linkB = makeLink({
		linkId: "bbb22222",
		mode: "guest",
		isConnected: true,
		meta: { sessionName: "beta", sessionId: "s2", model: "m2", created: 2, lastHeartbeat: 2, status: "connected" },
	});

	addLink(registry, linkA, active);
	addLink(registry, linkB, active);

	linkA.buffer = "partial-data-from-alpha";
	linkB.buffer = "partial-data-from-beta";

	assert(linkA.buffer.includes("alpha"), "A's buffer should contain alpha data");
	assert(linkB.buffer.includes("beta"), "B's buffer should contain beta data");
	assert(!linkA.buffer.includes("beta"), "A's buffer should NOT contain beta data");
	assert(!linkB.buffer.includes("alpha"), "B's buffer should NOT contain alpha data");
});

test("active link switching preserves all link state", () => {
	const registry = new Map<string, LinkState>();
	const active = { current: createInitialState() };

	const linkA = makeLink({
		linkId: "aaa11111",
		mode: "host",
		isConnected: true,
		peerInfo: { sessionId: "p1", sessionName: "peer-a", model: "pm1" },
		meta: { sessionName: "alpha", sessionId: "s1", model: "m1", created: 1, lastHeartbeat: 1, status: "connected" },
	});
	const linkB = makeLink({
		linkId: "bbb22222",
		mode: "guest",
		isConnected: true,
		peerInfo: { sessionId: "p2", sessionName: "peer-b", model: "pm2" },
		meta: { sessionName: "beta", sessionId: "s2", model: "m2", created: 2, lastHeartbeat: 2, status: "connected" },
	});

	addLink(registry, linkA, active);
	addLink(registry, linkB, active);

	// Both links should retain their full state
	const a = registry.get("aaa11111")!;
	const b = registry.get("bbb22222")!;

	assertEq(a.mode, "host");
	assertEq(a.peerInfo?.sessionName, "peer-a");
	assertEq(a.meta.model, "m1");

	assertEq(b.mode, "guest");
	assertEq(b.peerInfo?.sessionName, "peer-b");
	assertEq(b.meta.model, "m2");
});

test("removeAll clears everything", () => {
	const registry = new Map<string, LinkState>();
	const active = { current: createInitialState() };

	const links = [
		makeLink({ linkId: "a", mode: "host", isConnected: true, meta: { sessionName: "x", sessionId: "s1", model: "m1", created: 1, lastHeartbeat: 1, status: "connected" } }),
		makeLink({ linkId: "b", mode: "guest", isConnected: true, meta: { sessionName: "y", sessionId: "s2", model: "m2", created: 2, lastHeartbeat: 2, status: "connected" } }),
		makeLink({ linkId: "c", mode: "guest", isConnected: false, meta: { sessionName: "z", sessionId: "s3", model: "m3", created: 3, lastHeartbeat: 3, status: "waiting" } }),
	];

	for (const link of links) addLink(registry, link, active);

	// Simulate cleanupAll
	registry.clear();
	active.current = createInitialState();

	assertEq(registry.size, 0);
	assertEq(active.current.mode, "none");
	assertEq(active.current.linkId, "");
});

// ─── Teardown + Summary ──────────────────────────────────────────────────

setTimeout(() => {
	console.log(`\n${"─".repeat(40)}`);
	console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
	if (failed > 0) {
		console.log("\n⚠️  Some tests failed!");
		process.exit(1);
	} else {
		console.log("\n✅ All tests passed!");
		process.exit(0);
	}
}, 500);
