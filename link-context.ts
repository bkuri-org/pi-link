/**
 * Shared context bag for the link extension.
 *
 * All modules receive this context and attach their methods during initialization.
 * The bag is mutable — modules populate it in dependency order during init.
 */

import * as fs from "node:fs";
import * as net from "node:net";
import * as http from "node:http";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type LinkState,
	type LinkActivity,
	type JsonRpcMessage,
	type LinkRecoveryData,
	createInitialState,
} from "./types.js";

export interface LinkContext {
	// ─── Extension API ─────────────────────────────────────────────────
	pi: ExtensionAPI;
	ctx: ExtensionContext | undefined;
	loadTimeHash: string;

	// ─── Multi-link state ─────────────────────────────────────────────
	linksRegistry: Map<string, LinkState>;
	state: LinkState;
	streamBuffers: Map<string, string>;

	// ─── State management (set by init) ────────────────────────────────
	setActiveLink: (id: string) => void;
	addLink: (link: LinkState) => void;
	removeLink: (linkId: string) => void;
	getActiveLink: () => LinkState | undefined;

	// ─── Activity tracking (set by activity.init) ────────────────────────
	setActivity: (link: LinkState, type: LinkActivity["type"], label: string, taskId?: string) => void;
	clearActivity: (link: LinkState) => void;
	formatActivity: (link: LinkState, compact?: boolean) => string;
	stopSpinner: () => void;

	// ─── Widget (set by widget.init) ────────────────────────────────────
	updateWidget: () => void;

	// ─── Message handling (set by message-handler.init) ─────────────────
	handleDataForLink: (link: LinkState, data: Buffer) => void;
	processVisibleTaskForLink: (link: LinkState, p: { taskId: string; prompt: string; context?: string; replyTo?: string }) => void;

	// ─── Lifecycle (set by lifecycle.init) ──────────────────────────────
	startHeartbeatForLink: (link: LinkState) => void;
	stopHeartbeatForLink: (link: LinkState) => void;
	handlePeerLostForLink: (link: LinkState, reason: string) => void;
	cleanupLink: (link: LinkState) => void;
	cleanupAll: () => void;

	// ─── HTTP adapter (set by http-adapter.init) ───────────────────────
	startHttpAdapter: (link: LinkState, port: number, secret: string) => http.Server;
	handleHttpRpcForLink: (link: LinkState, msg: JsonRpcMessage) => Promise<JsonRpcMessage>;
	connectHttpRemote: (url: string, secret: string) => Promise<LinkState>;

	// ─── Recovery (set by recovery.init) ───────────────────────────────
	attemptRecovery: (c: ExtensionContext) => Promise<void>;
}
