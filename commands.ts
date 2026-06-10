/**
 * Command handlers: /link and /link-task with all subcommands.
 */

import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	LINKS_DIR,
	LINK_RECOVERY_DIR,
	STALE_THRESHOLD_MS,
	HTTP_LINK_DEFAULT_PORT,
	type LinkState,
	type LinkRole,
	type LinkRecoveryData,
	type LinkMeta,
	createInitialState,
	createJsonRpc,
	sendJsonRpc,
	ensureLinksDir,
	generateId,
	writeMeta,
	readMeta,
	discoverLinks,
	cleanupLinkDir,
	maybeLinkRole,
	getLinkSecret,
	ensureLinkSecret,
	deleteRecoveryData,
	roleIcon,
	SOCKET_TIMEOUT_MS,
} from "./types.js";
import type { LinkContext } from "./link-context.js";

export function initCommands(ctx: LinkContext): void {
	const pi = ctx.pi;

	pi.registerCommand("link", {
		description: "Manage session links (create, interview, join, status, role, disconnect, purge, version, list, HTTP remote)",
		getArgumentCompletions: (prefix: string) => {
			const cmds = ["new", "join", "interview", "status", "role", "disconnect", "version", "list", "purge"];
			const filtered = cmds.filter((c) => c.startsWith(prefix));
			return filtered.length > 0 ? filtered.map((c) => ({ value: c, label: c })) : null;
		},
		handler: async (args, c) => {
			if (!c.hasUI) { c.ui.notify("/link requires interactive mode", "error"); return; }

			const parts = args.trim().split(/\s+/);
			const sub = parts[0] || "";
			const rest = parts.slice(1).join(" ");

			switch (sub) {
				case "new": return cmdCreate(ctx, rest, c);
				case "join": return cmdJoin(ctx, c);
				case "interview": return cmdJoin(ctx, c, "interviewer", true);
				case "status": return cmdStatus(ctx, c);
				case "role": return cmdRole(ctx, rest, c);
				case "disconnect": return cmdDisconnect(ctx, rest, c);
				case "version": return cmdVersion(ctx, c);
				case "list": return cmdList(ctx, c);
				case "purge": return cmdPurge(ctx, rest, c);
				case "": return cmdAuto(ctx, c);
				default:
					if (sub.startsWith("http://") || sub.startsWith("https://")) {
						return cmdJoinHttp(ctx, sub, c);
					}
					c.ui.notify(`Unknown: ${sub}. Use: /link [new|join|interview|status|role|disconnect|purge|version|list|http://...]`, "error");
			}
		},
	});

	pi.registerCommand("link-task", {
		description: "Send a task to the linked session (--visible to inject, --force to override interview mode guard)",
		handler: async (args, c) => {
			const link = ctx.getActiveLink();
			if (!link?.isConnected) { c.ui.notify("Not linked. Use /link to connect.", "warning"); return; }

			const trimmed = args.trim();
			if (!trimmed) { c.ui.notify("Usage: /link-task [--force] [--visible] <prompt>", "error"); return; }

			const force = /\B--force\b/.test(trimmed);
			const isVisible = /\B--visible\b/.test(trimmed);
			const prompt = trimmed.replace(/--(force|visible)\s*/g, "").trim();
			if (!prompt) { c.ui.notify("Usage: /link-task [--force] [--visible] <prompt>", "error"); return; }

			if (link.selfRole === "interviewee" && !force) {
				c.ui.notify(
					`⚠️ You're the ${roleIcon("interviewee")} interviewee. ` +
					`Tasks flow FROM the ${roleIcon("interviewer")} interviewer TO you.\n` +
					`  To send anyway: /link-task --force <prompt>\n` +
					`  To swap roles:  /link role reverse`,
					"warning"
				);
				return;
			}

			if (link.transport === "http" && link.httpRemoteUrl && link.httpSecret) {
				c.ui.notify("HTTP task sent via /link-task not yet supported. Use the link_send_task tool.", "warning");
				return;
			}

			const conn = link.connection;
			if (!conn || conn.destroyed) { c.ui.notify("Connection lost", "error"); ctx.cleanupLink(link); return; }

			const taskId = generateId();
			sendJsonRpc(conn, createJsonRpc("task/send", {
				taskId,
				prompt,
				mode: isVisible ? "visible" : "silent",
				replyTo: "sender",
			}));

			const badge = isVisible ? "👁 visible" : "🔇 silent";
			c.ui.notify(`📤 Task sent (${badge}) to ${link.meta.sessionName}`, "info");
			ctx.setActivity(link, "sending", `Sent: ${prompt.slice(0, 40)}...`, taskId);
		},
	});
}

// ─── Subcommand implementations ────────────────────────────────────────────

async function cmdCreate(ctx: LinkContext, args: string, c: ExtensionContext): Promise<void> {
	const interviewMode = args.includes("--interview");
	const httpMatch = args.match(/--http(?:\s+(\d+))?/);
	const httpPort = httpMatch ? parseInt(httpMatch[1] || String(HTTP_LINK_DEFAULT_PORT), 10) : undefined;
	const name = args.replace(/--http(?:\s+\d+)?/, "").replace(/--interview/, "").trim();

	ensureLinksDir();
	const linkId = generateId();
	const linkDir = path.join(LINKS_DIR, linkId);
	const sockPath = path.join(linkDir, "link.sock");
	fs.mkdirSync(linkDir, { recursive: true });

	const link = createInitialState();
	link.selfRole = interviewMode ? "interviewer" : "symmetric";
	const meta: LinkMeta = {
		id: linkId,
		sessionId: ctx.state.meta.sessionId,
		sessionName: name || ctx.state.meta.sessionName,
		model: ctx.state.meta.model,
		created: Date.now(),
		lastHeartbeat: Date.now(),
		status: "waiting",
		role: interviewMode ? "interviewer" : undefined,
	};
	link.meta = meta;
	writeMeta(linkDir, meta);

	const server = net.createServer((socket) => {
		link.connection = socket;
		link.isConnected = true;
		link.buffer = "";
		link.lastPeerActivity = Date.now();
		link.meta.status = "connected";
		writeMeta(linkDir, link.meta);

		socket.on("data", (data) => ctx.handleDataForLink(link, data));
		socket.on("close", () => {
			ctx.stopHeartbeatForLink(link);
			link.isConnected = false;
			link.connection = undefined;
			link.meta.status = "waiting";
			writeMeta(linkDir, link.meta);
			c.ui.notify("🔗 Peer disconnected", "warning");
			ctx.updateWidget();
		});
		socket.on("error", (err) => { console.error("Link socket error:", err.message); });

		sendJsonRpc(socket, createJsonRpc("ping", { sessionId: meta.sessionId, sessionName: meta.sessionName }));
		ctx.startHeartbeatForLink(link);
		c.ui.notify("🔗 Peer connected!", "success");
		ctx.updateWidget();
	});

	try { if (fs.existsSync(sockPath)) fs.unlinkSync(sockPath); } catch { /* ignore */ }

	await new Promise<void>((resolve, reject) => {
		server.listen(sockPath, () => { fs.chmodSync(sockPath, 0o600); resolve(); });
		server.on("error", reject);
	});

	link.mode = "host";
	link.transport = httpPort ? "http" : "uds";
	link.linkId = linkId;
	link.socketPath = sockPath;
	link.server = server;

	if (httpPort) {
		const secret = ensureLinkSecret();
		link.httpServer = ctx.startHttpAdapter(link, httpPort, secret);
		link.httpPort = httpPort;
		link.httpSecret = secret;
		c.ui.notify(`🔗 Shared secret: ${secret.slice(0, 8)}... (full: ${path.join(LINKS_DIR, "shared-secret")})`, "info");
	}

	ctx.addLink(link);
	const roleStr = interviewMode ? " 🎤 interview mode" : "";
	c.ui.notify(`🔗 Link created: ${linkId} (${meta.sessionName})${roleStr}${httpPort ? ` [HTTP :${httpPort}]` : ""}`, "success");
	ctx.updateWidget();
}

async function cmdJoin(ctx: LinkContext, c: ExtensionContext, forceRole?: LinkRole, allowCreate = false): Promise<void> {
	const filtered = discoverLinks().filter((l) => l.meta.sessionId !== ctx.state.meta.sessionId);

	if (filtered.length === 0) {
		if (allowCreate) {
			c.ui.notify("No active links found — creating one for you.", "info");
			return cmdCreate(ctx, forceRole === "interviewer" ? "--interview" : "", c);
		}
		c.ui.notify("No active links found. Use /link new to create one.", "warning");
		return;
	}

	const items = filtered.map((l) => {
		const age = Math.round((Date.now() - l.meta.created) / 1000);
		const ageStr = age < 60 ? `${age}s` : age < 3600 ? `${Math.round(age / 60)}m` : `${Math.round(age / 3600)}h`;
		const status = l.meta.status === "connected" ? "🔴 busy" : "🟢 idle";
		const roleHint = l.meta.role ? ` ${roleIcon(maybeLinkRole(l.meta.role))}` : "";
		return { dir: l.dir, label: `${l.meta.sessionName} (${l.meta.model})${roleHint} ${status} — ${ageStr} ago` };
	});

	const labels = items.map((i) => i.label);
	const choice = await c.ui.select("Join a link:", labels);
	if (!choice) { c.ui.notify("Cancelled", "info"); return; }

	const selected = filtered[labels.indexOf(choice)];
	if (!selected) { c.ui.notify("Link not found", "error"); return; }

	const link = createInitialState();
	const socket = new net.Socket();
	socket.setTimeout(SOCKET_TIMEOUT_MS);

	socket.on("data", (data) => ctx.handleDataForLink(link, data));
	socket.on("close", () => {
		link.isConnected = false;
		link.connection = undefined;
		ctx.stopHeartbeatForLink(link);
		c.ui.notify("🔗 Link closed", "warning");
		ctx.cleanupLink(link);
	});
	socket.on("error", (err) => {
		console.error("Link error:", err.message);
		c.ui.notify(`Connection failed: ${err.message}`, "error");
		ctx.removeLink(link.linkId);
		ctx.updateWidget();
	});
	socket.on("timeout", () => { c.ui.notify("Link timed out", "warning"); socket.destroy(); ctx.cleanupLink(link); });

	await new Promise<void>((resolve, reject) => { socket.connect(selected.socketPath, () => resolve()); socket.on("error", reject); });

	link.mode = "guest";
	link.transport = "uds";
	link.linkId = selected.meta.id;
	link.socketPath = selected.socketPath;
	link.meta = selected.meta;
	if (forceRole) {
		link.selfRole = forceRole;
	} else {
		link.selfRole = maybeLinkRole(selected.meta.role);
		if (link.selfRole === "interviewer") link.selfRole = "interviewee";
		else if (link.selfRole === "interviewee") link.selfRole = "interviewer";
	}
	link.connection = socket;
	link.isConnected = true;
	link.buffer = "";
	link.lastPeerActivity = Date.now();

	ctx.addLink(link);

	// If forced role (e.g. /link interview), notify peer of the role assignment
	if (forceRole) {
		const hostRole: LinkRole = forceRole === "interviewer" ? "interviewee" : "interviewer";
		link.meta.role = hostRole;
		const conn = link.connection;
		if (conn && !conn.destroyed) {
			sendJsonRpc(conn, {
				jsonrpc: "2.0",
				id: crypto.randomUUID(),
				method: "role/update",
				params: { role: hostRole },
			});
		}
	}

	sendJsonRpc(socket, createJsonRpc("ping", { sessionId: link.meta.sessionId, sessionName: link.meta.sessionName }));
	ctx.startHeartbeatForLink(link);
	const roleHint = link.selfRole !== "symmetric" ? ` (${roleIcon(link.selfRole)} ${link.selfRole})` : "";
	c.ui.notify(`🔗 Connected to ${selected.meta.sessionName}${roleHint}`, "success");
	ctx.updateWidget();
}

async function cmdAuto(ctx: LinkContext, c: ExtensionContext): Promise<void> {
	// Smart join: discover first, create only if nothing available
	const filtered = discoverLinks().filter((l) => l.meta.sessionId !== ctx.state.meta.sessionId);
	if (filtered.length > 0) {
		return cmdJoin(ctx, c);
	}
	return cmdCreate(ctx, "", c);
}

async function cmdJoinHttp(ctx: LinkContext, url: string, c: ExtensionContext): Promise<void> {
	let secret = getLinkSecret();
	if (!secret) {
		c.ui.notify("No shared secret found. Set PI_LINK_SECRET env var or create ~/.pi/links/shared-secret on both machines.", "warning");
		return;
	}

	try {
		c.ui.notify(`🔗 Connecting to ${url}...`, "info");
		const httpLink = await ctx.connectHttpRemote(url, secret);
		const roleHint = httpLink.selfRole !== "symmetric" ? ` (${roleIcon(httpLink.selfRole)} ${httpLink.selfRole})` : "";
		c.ui.notify(`🔗 Connected (HTTP) → ${ctx.state.meta.sessionName}${roleHint}`, "success");
		ctx.updateWidget();
	} catch (err: any) {
		c.ui.notify(`🔗 HTTP connection failed: ${err.message}`, "error");
	}
}

function cmdList(ctx: LinkContext, c: ExtensionContext): void {
	const lines: string[] = [];

	if (ctx.linksRegistry.size === 0) {
		const localLinks = discoverLinks().filter((l) => l.meta.sessionId !== ctx.state.meta.sessionId);
		if (localLinks.length > 0) {
			lines.push(`No active links. ${localLinks.length} local UDS link(s) available.`);
			for (const l of localLinks) {
				const status = l.meta.status === "connected" ? "🔴 busy" : "🟢 idle";
				const roleHint = l.meta.role ? ` ${roleIcon(maybeLinkRole(l.meta.role))}` : "";
				lines.push(`  ${l.meta.sessionName} (${l.meta.model})${roleHint} ${status} — ${l.meta.id.slice(0, 8)}`);
			}
		} else {
			lines.push("No active links.");
		}
		lines.push("\nTo join a remote link: /link http://host:port");
		c.ui.notify(lines.join("\n"), "info");
		return;
	}

	let i = 0;
	for (const [id, link] of ctx.linksRegistry) {
		const isActive = id === ctx.state.linkId;
		const prefix = isActive ? "→ " : "  ";
		const transport = link.transport === "http" ? " [HTTP]" : " [UDS]";
		const connStatus = link.isConnected ? "🟢 connected" : "🔴 disconnected";
		const roleStr = link.selfRole === "symmetric" ? "" : ` ${roleIcon(link.selfRole)}`;

		lines.push(`${prefix}[${i}] ${link.meta.sessionName}${roleStr}${transport} ${connStatus} (${id.slice(0, 8)})`);
		if (link.peerInfo?.sessionName) lines.push(`    peer: ${link.peerInfo.sessionName}`);
		if (link.transport === "http") {
			if (link.httpPort) lines.push(`    HTTP port: ${link.httpPort}`);
			if (link.httpRemoteUrl) lines.push(`    remote: ${link.httpRemoteUrl}`);
		}
		i++;
	}

	lines.push(`\nActive link: ${ctx.state.linkId ? ctx.state.meta.sessionName : "none"}`);
	lines.push("To switch: /link switch <index>");
	c.ui.notify(lines.join("\n"), "info");
}

function cmdRole(ctx: LinkContext, args: string, c: ExtensionContext): void {
	const link = ctx.getActiveLink();
	if (!link?.isConnected) { c.ui.notify("Not linked.", "warning"); return; }

	const sub = args.trim().toLowerCase();

	if (sub === "reverse") {
		if (link.selfRole === "symmetric") {
			c.ui.notify("Role reverse only applies in interview mode. Use /link interview to start.", "info");
			return;
		}

		const newRole: LinkRole = link.selfRole === "interviewer" ? "interviewee" : "interviewer";

		link.meta.role = link.mode === "host" ? newRole : (newRole === "interviewer" ? "interviewee" : "interviewer");
		link.selfRole = newRole;

		const conn = link.connection;
		if (conn && !conn.destroyed) {
			sendJsonRpc(conn, {
				jsonrpc: "2.0",
				id: crypto.randomUUID(),
				method: "role/update",
				params: { role: link.meta.role ?? "symmetric" },
			});
		}

		if (link.mode === "host" && link.linkId) {
			writeMeta(path.join(LINKS_DIR, link.linkId), link.meta);
		}

		ctx.updateWidget();
		c.ui.notify(`🔗 Role reversed. You're now ${roleIcon(link.selfRole)} ${link.selfRole}.`, "success");
		return;
	}

	if (sub === "symmetric" || sub === "off") {
		link.meta.role = undefined;
		link.selfRole = "symmetric";

		const conn = link.connection;
		if (conn && !conn.destroyed) {
			sendJsonRpc(conn, {
				jsonrpc: "2.0",
				id: crypto.randomUUID(),
				method: "role/update",
				params: { role: "symmetric" },
			});
		}

		if (link.mode === "host" && link.linkId) {
			writeMeta(path.join(LINKS_DIR, link.linkId), link.meta);
		}

		ctx.updateWidget();
		c.ui.notify("🔗 Interview mode disabled. Link is now symmetric (🔗 ↔).", "success");
		return;
	}

	if (sub === "") {
		const roleName = link.selfRole === "symmetric" ? "symmetric" : `${roleIcon(link.selfRole)} ${link.selfRole}`;
		c.ui.notify(
			`Current role: ${roleName}\n` +
			`  /link role reverse    — Swap roles (${roleIcon("interviewer")} ↔ ${roleIcon("interviewee")})\n` +
			`  /link role symmetric  — Disable interview mode, revert to 🔗 ↔`,
			"info"
		);
		return;
	}

	c.ui.notify(`Unknown: /link role ${sub}. Use: /link role [reverse|symmetric]`, "error");
}

function cmdStatus(ctx: LinkContext, c: ExtensionContext): void {
	const link = ctx.getActiveLink();
	if (!link) {
		const available = discoverLinks();
		c.ui.notify(available.length === 0 ? "No active links." : `${available.length} link(s) available. /link to join.`, "info");
		return;
	}

	const roleStr = link.selfRole === "symmetric" ? "🔗 symmetric" : `${roleIcon(link.selfRole)} ${link.selfRole}`;
	const lines = [
		`Role: ${roleStr}`,
		`Mode: ${link.mode} (${link.isConnected ? "connected" : "disconnected"})`,
		`Transport: ${link.transport.toUpperCase()}`,
		`Link ID: ${link.linkId}`,
		`Session: ${link.meta.sessionName}`,
		`Model: ${link.meta.model}`,
	];
	if (link.transport === "http") {
		if (link.httpPort) lines.push(`HTTP port: ${link.httpPort}`);
		if (link.httpRemoteUrl) lines.push(`Remote URL: ${link.httpRemoteUrl}`);
	}
	if (link.recovering) lines.push(`Status: recovering...`);
	if (link.peerInfo?.sessionName) lines.push(`Peer: ${link.peerInfo.sessionName}`);
	if (link.peerInfo?.model) lines.push(`Peer model: ${link.peerInfo.model}`);

	if (ctx.linksRegistry.size > 1) {
		lines.push(`\nTotal links: ${ctx.linksRegistry.size}`);
	}

	c.ui.notify(lines.join("\n"), "info");
}

function cmdDisconnect(ctx: LinkContext, args: string, c: ExtensionContext): void {
	if (ctx.linksRegistry.size === 0) { c.ui.notify("Not linked", "info"); return; }

	const target = args.trim();
	if (target) {
		let foundLink: LinkState | undefined;
		for (const [id, link] of ctx.linksRegistry) {
			if (id.startsWith(target)) { foundLink = link; break; }
		}
		if (!foundLink) {
			const idx = parseInt(target, 10);
			if (!isNaN(idx)) {
				const links = [...ctx.linksRegistry.values()];
				foundLink = links[idx];
			}
		}
		if (foundLink) {
			c.ui.notify(`🔗 Disconnecting ${foundLink.meta.sessionName}...`, "info");
			ctx.cleanupLink(foundLink);
			return;
		}
		c.ui.notify(`Link "${target}" not found. Use /link list to see all links.`, "error");
		return;
	}

	const link = ctx.getActiveLink();
	if (!link) { c.ui.notify("Not linked", "info"); return; }
	c.ui.notify("🔗 Disconnected", "info");
	ctx.cleanupLink(link);
}

function cmdPurge(ctx: LinkContext, args: string, c: ExtensionContext): void {
	const force = args.trim() === "--force";
	const lines: string[] = [];
	let purgedCount = 0;

	for (const [id, link] of ctx.linksRegistry) {
		if (force || !link.isConnected) {
			ctx.stopHeartbeatForLink(link);
			if (link.connection) { link.connection.destroy(); link.connection = undefined; }
			if (link.server) { link.server.close(); link.server = undefined; }
			if (link.httpServer) { link.httpServer.close(); link.httpServer = undefined; link.httpPort = undefined; }
			if (link.meta.sessionId) deleteRecoveryData(link.meta.sessionId);
			lines.push(`  ✗ ${link.meta.sessionName} (${link.isConnected ? "active" : "inactive"})${force ? " [forced]" : ""}`);
			purgedCount++;
		} else {
			lines.push(`  ✓ ${link.meta.sessionName} (active, kept)`);
		}
	}

	if (force) {
		ctx.linksRegistry.clear();
		ctx.streamBuffers.clear();
		ctx.state = createInitialState();
	} else {
		for (const [id, link] of ctx.linksRegistry) {
			if (!link.isConnected) ctx.linksRegistry.delete(id);
		}
		if (!ctx.linksRegistry.has(ctx.state.linkId)) {
			let next: LinkState | undefined;
			for (const l of ctx.linksRegistry.values()) {
				if (l.isConnected) { next = l; break; }
			}
			ctx.state = next ?? createInitialState();
		}
	}

	ensureLinksDir();
	try {
		const entries = fs.readdirSync(LINKS_DIR, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			if (entry.name.startsWith("__test_")) continue;

			const dir = path.join(LINKS_DIR, entry.name);
			const meta = readMeta(dir);

			let isActiveHost = false;
			if (!force) {
				for (const link of ctx.linksRegistry.values()) {
					if (link.mode === "host" && link.linkId === entry.name && link.isConnected) {
						isActiveHost = true;
						break;
					}
				}
			}

			if (isActiveHost) {
				lines.push(`  ✓ ${meta?.sessionName ?? entry.name} (active host dir, kept)`);
				continue;
			}

			if (meta?.sessionId === ctx.state.meta.sessionId && !force) {
				lines.push(`  ✓ ${meta?.sessionName ?? entry.name} (own session, kept)`);
				continue;
			}

			cleanupLinkDir(dir);
			lines.push(`  🗑 ${meta?.sessionName ?? entry.name} (disk dir purged)`);
			purgedCount++;
		}
	} catch {
		// Directory doesn't exist
	}

	try {
		fs.mkdirSync(LINK_RECOVERY_DIR, { recursive: true });
		const recoveryEntries = fs.readdirSync(LINK_RECOVERY_DIR);
		for (const entry of recoveryEntries) {
			if (!entry.endsWith(".json")) continue;
			const filePath = path.join(LINK_RECOVERY_DIR, entry);
			try {
				const raw = fs.readFileSync(filePath, "utf-8");
				const data = JSON.parse(raw) as LinkRecoveryData;
				if (force || Date.now() - data.savedAt > STALE_THRESHOLD_MS) {
					deleteRecoveryData(data.sessionId);
					lines.push(`  🗑 Recovery: ${data.sessionId.slice(0, 8)} (${data.mode})`);
					purgedCount++;
				}
			} catch {
				try { fs.unlinkSync(filePath); } catch { /* ignore */ }
				purgedCount++;
			}
		}
	} catch {
		// No recovery dir
	}

	ctx.stopSpinner();
	ctx.updateWidget();

	if (purgedCount === 0 && lines.length === 0) {
		c.ui.notify("🔗 No stale links to purge. Everything is clean.", "info");
	} else {
		lines.unshift(`🔗 Purge ${force ? "(force)" : "(inactive only)"}:`);
		lines.push(`\n  ${purgedCount} item(s) purged.`);
		c.ui.notify(lines.join("\n"), purgedCount > 0 ? "success" : "info");
	}
}

function cmdVersion(ctx: LinkContext, c: ExtensionContext): void {
	try {
		const content = fs.readFileSync(path.join(os.homedir(), ".pi", "agent", "extensions", "link", "index.ts"), "utf-8");
		const diskHash = crypto.createHash("sha256").update(content).digest("hex").slice(0, 8);
		const localHash = ctx.loadTimeHash;
		const lines: string[] = [];

		if (diskHash !== localHash && localHash !== "unknown") {
			lines.push(`⚠️ You: v1.0.0 loaded:${localHash} disk:${diskHash} (STALE — /reload to update)`);
		} else {
			lines.push(`You: v1.0.0 (${localHash})`);
		}

		const link = ctx.getActiveLink();
		if (link?.isConnected && link.connection && !link.connection.destroyed) {
			const reqId = crypto.randomUUID();
			const timeout = setTimeout(() => {
				link.resolveQueue.delete(reqId);
				lines.push(`Peer: (no response — may be running older version without version/get support)`);
				c.ui.notify(lines.join("\n"), localHash !== diskHash ? "warning" : "info");
			}, 3000);

			link.resolveQueue.set(reqId, (msg: any) => {
				clearTimeout(timeout);
				const peer = msg.result;
				if (peer?.hash) {
					const match = peer.hash === localHash;
					const peerLabel = peer.sessionName ? ` (${peer.sessionName})` : "";
					lines.push(`Peer${peerLabel}: ${peer.version || "?"} (${peer.hash})${match ? "" : " ⚠️ MISMATCH"}`);
					c.ui.notify(lines.join("\n"), match ? "info" : "warning");
				} else {
					lines.push(`Peer: unknown version`);
					c.ui.notify(lines.join("\n"), "info");
				}
			});

			sendJsonRpc(link.connection, { jsonrpc: "2.0", id: reqId, method: "version/get", params: {} });
		} else {
			c.ui.notify(lines.join("\n"), localHash !== diskHash ? "warning" : "info");
		}
	} catch {
		c.ui.notify(`link extension v1.0.0`, "info");
	}
}
