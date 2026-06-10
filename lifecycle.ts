/**
 * Per-link lifecycle: heartbeat, peer lost detection, cleanup.
 */

import * as net from "node:net";
import {
	type LinkState,
	HEARTBEAT_INTERVAL_MS,
	HEARTBEAT_TIMEOUT_MS,
	createJsonRpc,
	sendJsonRpc,
	writeMeta,
	cleanupLinkDir,
	deleteRecoveryData,
	createInitialState,
	LINKS_DIR,
} from "./types.js";
import type { LinkContext } from "./link-context.js";

export function initLifecycle(ctx: LinkContext): void {
	ctx.startHeartbeatForLink = (link: LinkState): void => {
		link.lastPeerActivity = Date.now();
		link.heartbeatTimer = setInterval(() => {
			const conn = link.connection;
			if (!conn || conn.destroyed) return;

			if (link.lastPeerActivity > 0 && Date.now() - link.lastPeerActivity > HEARTBEAT_TIMEOUT_MS) {
				ctx.handlePeerLostForLink(link, "heartbeat timeout — no response from peer");
				return;
			}

			sendJsonRpc(conn, createJsonRpc("ping", {
				sessionId: link.meta.sessionId,
				sessionName: link.meta.sessionName,
			}));
			link.meta.lastHeartbeat = Date.now();

			if (link.mode === "host" && link.isConnected) {
				writeMeta(LINKS_DIR + "/" + link.linkId, link.meta);
			}
		}, HEARTBEAT_INTERVAL_MS);
	};

	ctx.stopHeartbeatForLink = (link: LinkState): void => {
		if (link.heartbeatTimer) {
			clearInterval(link.heartbeatTimer);
			link.heartbeatTimer = undefined;
		}
	};

	ctx.handlePeerLostForLink = (link: LinkState, reason: string): void => {
		ctx.stopHeartbeatForLink(link);
		if (link.connection) { link.connection.destroy(); link.connection = undefined; }
		link.isConnected = false;

		if (link.mode === "host") {
			link.meta.status = "waiting";
			writeMeta(LINKS_DIR + "/" + link.linkId, link.meta);
		} else {
			link.socketPath = "";
			link.meta.status = "waiting";
		}

		ctx.ctx?.ui.notify(`🔗 Peer lost: ${reason}`, "warning");
		ctx.updateWidget();
	};

	ctx.cleanupLink = (link: LinkState): void => {
		ctx.stopHeartbeatForLink(link);
		if (link.connection) { link.connection.destroy(); link.connection = undefined; }
		if (link.server) { link.server.close(); link.server = undefined; }
		if (link.httpServer) {
			link.httpServer.close();
			link.httpServer = undefined;
			link.httpPort = undefined;
		}
		if (link.mode === "host" && link.linkId) {
			cleanupLinkDir(LINKS_DIR + "/" + link.linkId);
		}
		if (link.meta.sessionId) {
			deleteRecoveryData(link.meta.sessionId);
		}
		ctx.removeLink(link.linkId);
		ctx.updateWidget();
	};

	ctx.cleanupAll = (): void => {
		for (const link of ctx.linksRegistry.values()) {
			ctx.stopHeartbeatForLink(link);
			if (link.connection) { link.connection.destroy(); link.connection = undefined; }
			if (link.server) { link.server.close(); link.server = undefined; }
			if (link.httpServer) { link.httpServer.close(); link.httpServer = undefined; }
			if (link.mode === "host" && link.linkId) {
				cleanupLinkDir(LINKS_DIR + "/" + link.linkId);
			}
			if (link.meta.sessionId) {
				deleteRecoveryData(link.meta.sessionId);
			}
		}
		ctx.linksRegistry.clear();
		ctx.streamBuffers.clear();
		ctx.state = createInitialState();
		ctx.updateWidget();
	};
}
