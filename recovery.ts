/**
 * Recovery: restore link state after pi session reload.
 */

import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import {
	LINKS_DIR,
	STALE_THRESHOLD_MS,
	SOCKET_TIMEOUT_MS,
	type LinkState,
	type LinkRecoveryData,
	type LinkMeta,
	createInitialState,
	createJsonRpc,
	sendJsonRpc,
	ensureLinksDir,
	readMeta,
	writeMeta,
	cleanupLinkDir,
	maybeLinkRole,
	loadRecoveryData,
	deleteRecoveryData,
} from "./types.js";
import type { LinkContext } from "./link-context.js";

async function recoverAsHost(ctx: LinkContext, recovery: LinkRecoveryData, c: any): Promise<void> {
	ensureLinksDir();
	const linkDir = path.join(LINKS_DIR, recovery.linkId);
	const sockPath = path.join(linkDir, "link.sock");

	const link = createInitialState();
	fs.mkdirSync(linkDir, { recursive: true });
	const meta: LinkMeta = {
		...recovery.meta,
		sessionId: ctx.state.meta.sessionId,
		model: ctx.state.meta.model,
		lastHeartbeat: Date.now(),
		status: "waiting",
	};
	link.meta = meta;
	writeMeta(linkDir, meta);

	const server = net.createServer((socket) => {
		link.connection = socket;
		link.isConnected = true;
		link.buffer = "";
		link.lastPeerActivity = Date.now();
		link.recovering = false;
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
		c.ui.notify("🔗 Peer reconnected!", "success");
		ctx.updateWidget();
	});

	try { if (fs.existsSync(sockPath)) fs.unlinkSync(sockPath); } catch { /* ignore */ }

	try {
		await new Promise<void>((resolve, reject) => {
			server.listen(sockPath, () => { fs.chmodSync(sockPath, 0o600); resolve(); });
			server.on("error", reject);
		});

		link.mode = "host";
		link.transport = "uds";
		link.linkId = recovery.linkId;
		link.socketPath = sockPath;
		link.server = server;
		if (recovery.peerInfo) link.peerInfo = recovery.peerInfo;

		ctx.addLink(link);
		c.ui.notify(`🔗 Link recovered (host): ${recovery.linkId}`, "success");
	} catch (err: any) {
		c.ui.notify(`🔗 Link recovery failed: ${err.message}`, "warning");
	}
}

async function recoverAsGuest(ctx: LinkContext, recovery: LinkRecoveryData, c: any): Promise<void> {
	const linkDir = path.join(LINKS_DIR, recovery.linkId);
	const sockPath = path.join(linkDir, "link.sock");

	const hostMeta = readMeta(linkDir);
	if (!hostMeta) {
		c.ui.notify("🔗 Link recovery failed: host link no longer exists", "warning");
		return;
	}

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
		c.ui.notify(`🔗 Reconnection failed: ${err.message}`, "warning");
		link.mode = "none";
		ctx.removeLink(link.linkId);
		ctx.updateWidget();
	});
	socket.on("timeout", () => { c.ui.notify("🔗 Link timed out", "warning"); socket.destroy(); ctx.cleanupLink(link); });

	try {
		await new Promise<void>((resolve, reject) => {
			socket.connect(sockPath, () => resolve());
			socket.on("error", reject);
		});

		link.mode = "guest";
		link.transport = "uds";
		link.linkId = recovery.linkId;
		link.socketPath = sockPath;
		link.meta = hostMeta;
		link.selfRole = maybeLinkRole(hostMeta.role);
		if (link.selfRole === "interviewer") link.selfRole = "interviewee";
		else if (link.selfRole === "interviewee") link.selfRole = "interviewer";
		link.connection = socket;
		link.isConnected = true;
		link.recovering = false;
		link.buffer = "";
		link.lastPeerActivity = Date.now();
		if (recovery.peerInfo) link.peerInfo = recovery.peerInfo;

		ctx.addLink(link);
		sendJsonRpc(socket, createJsonRpc("ping", { sessionId: link.meta.sessionId, sessionName: link.meta.sessionName }));
		ctx.startHeartbeatForLink(link);
		c.ui.notify(`🔗 Link recovered (guest) → ${hostMeta.sessionName}`, "success");
		ctx.updateWidget();
	} catch (err: any) {
		c.ui.notify(`🔗 Link recovery failed: ${err.message}`, "warning");
	}
}

export function initRecovery(ctx: LinkContext): void {
	ctx.attemptRecovery = async (c: any): Promise<void> => {
		const recovery = loadRecoveryData(ctx.state.meta.sessionId);
		if (!recovery) return;

		if (Date.now() - recovery.savedAt > STALE_THRESHOLD_MS) {
			deleteRecoveryData(ctx.state.meta.sessionId);
			return;
		}

		if (!recovery.linkId) {
			deleteRecoveryData(ctx.state.meta.sessionId);
			return;
		}

		ctx.state.recovering = true;
		ctx.updateWidget();

		if (recovery.mode === "host") {
			await recoverAsHost(ctx, recovery, c);
		} else if (recovery.mode === "guest") {
			await recoverAsGuest(ctx, recovery, c);
		}

		deleteRecoveryData(ctx.state.meta.sessionId);
		ctx.state.recovering = false;
		ctx.updateWidget();
	};
}
