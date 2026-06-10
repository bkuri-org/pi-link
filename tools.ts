/**
 * Tool registration: link_send_task and link_status.
 */

import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import * as crypto from "node:crypto";
import {
	type LinkState,
	createJsonRpc,
	sendJsonRpc,
	httpPostRpc,
	roleIcon,
} from "./types.js";
import type { LinkContext } from "./link-context.js";
import { buildContextSnapshot } from "./headless.js";

/** Resolve a target link by ID prefix, index, or session name. */
function resolveTargetLink(ctx: LinkContext, target: string | undefined): LinkState | undefined {
	if (!target) return ctx.getActiveLink();

	// By ID prefix
	for (const [id, link] of ctx.linksRegistry) {
		if (id.startsWith(target)) return link;
	}

	// By session name
	for (const link of ctx.linksRegistry.values()) {
		if (link.meta.sessionName === target) return link;
	}

	// By peer session name
	for (const link of ctx.linksRegistry.values()) {
		if (link.peerInfo?.sessionName === target) return link;
	}

	// By index
	const idx = parseInt(target, 10);
	if (!isNaN(idx)) {
		return [...ctx.linksRegistry.values()][idx];
	}

	return undefined;
}

export function initTools(ctx: LinkContext): void {
	const pi = ctx.pi;

	pi.registerTool({
		name: "link_send_task",
		label: "Link: Send Task",
		description: [
			"Send a task/prompt to a linked pi session.",
			'Default mode is "silent" — runs headless, peer context untouched.',
			'Use mode "visible" to inject into peer session (collaborative).',
			"Supports both UDS (local) and HTTP (remote) transports.",
		].join(" "),
		promptSnippet: "Send a task to a linked pi session for cross-session collaboration",
		parameters: Type.Object({
			prompt: Type.String({ description: "The task or prompt to send to the linked session" }),
			mode: Type.Optional(Type.String({ description: '"silent" (default) or "visible"', default: "silent" })),
			include_context: Type.Optional(Type.Boolean({ description: "Include recent conversation as context", default: false })),
			reply_to: Type.Optional(Type.String({ description: '"sender" to get result back, "none" to fire-and-forget', default: "sender" })),
			target: Type.Optional(Type.String({ description: "Target link ID prefix, index, or session name (default: active link)" })),
			stream: Type.Optional(Type.Boolean({ description: "Stream intermediate results back (UDS transport only)", default: false })),
			force: Type.Optional(Type.Boolean({ description: "Override interview mode guard (allow interviewee to send)", default: false })),
		}),
		async execute(_id, params, _signal, onUpdate, c) {
			let link = resolveTargetLink(ctx, params.target as string | undefined);
			if (!link?.isConnected) {
				if (params.target) {
					return { content: [{ type: "text", text: `Target link "${params.target}" not found or not connected.` }], details: { connected: false }, isError: true };
				}
				return { content: [{ type: "text", text: "Not linked. Use /link to connect." }], details: { connected: false } };
			}

			if (link.selfRole === "interviewee" && !params.force) {
				return {
					content: [{ type: "text", text: `Cannot send task: you are the ${roleIcon("interviewee")} interviewee. ` +
						`Tasks flow FROM the ${roleIcon("interviewer")} interviewer TO you. ` +
						`Use force: true to override.` }],
					details: { connected: true, role: "interviewee", blocked: true },
					isError: true,
				};
			}

			const taskId = crypto.randomUUID();
			const taskMode = params.mode === "visible" ? "visible" : "silent";

			const wantReply = (params.reply_to ?? "sender") === "sender";
			const includeContext = params.include_context === true || (params.include_context === undefined && wantReply);

			let context: string | undefined;
			if (includeContext) {
				const recent = c.sessionManager.getBranch()
					.filter((e: any) => e.type === "message" && e.message.role === "assistant")
					.slice(-5)
					.map((e: any) => {
						const text = e.message.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
						return text.length > 200 ? text.slice(0, 200) + "..." : text;
					})
					.join("\n\n");
				context = recent || undefined;
			}

			onUpdate?.({ content: [{ type: "text", text: `Sending ${taskMode} task ${taskId.slice(0, 8)} to ${link.meta.sessionName}...` }] });

			// HTTP transport: synchronous request-response
			if (link.transport === "http" && link.httpRemoteUrl && link.httpSecret) {
				try {
					const response = await httpPostRpc(link.httpRemoteUrl, link.httpSecret, createJsonRpc("task/send", {
						taskId,
						prompt: params.prompt,
						context,
						mode: taskMode,
						replyTo: params.reply_to ?? "sender",
						stream: false,
					}));

					const result = response.result as any;
					if (result?.status === "completed" && result.content) {
						return {
							content: [{ type: "text", text: result.content }],
							details: { taskId, peer: link.meta.sessionName, mode: taskMode, sent: true, content: result.content },
						};
					}

					const badge = taskMode === "visible" ? "👁" : "🔇";
					return {
						content: [{ type: "text", text: `Task ${taskId.slice(0, 8)} sent to ${link.meta.sessionName} (${badge}). Status: ${result?.status ?? "unknown"}` }],
						details: { taskId, peer: link.meta.sessionName, mode: taskMode, sent: true },
						terminate: taskMode === "silent",
					};
				} catch (err: any) {
					return {
						content: [{ type: "text", text: `HTTP task failed: ${err.message}` }],
						details: { taskId, sent: false, error: err.message },
						isError: true,
					};
				}
			}

			// UDS transport: async message
			const conn = link.connection;
			if (!conn || conn.destroyed) {
				return { content: [{ type: "text", text: "Connection lost." }], details: { connected: false }, isError: true };
			}

			sendJsonRpc(conn, createJsonRpc("task/send", {
				taskId,
				prompt: params.prompt,
				context,
				mode: taskMode,
				replyTo: params.reply_to ?? "sender",
				stream: params.stream === true,
			}));

			ctx.setActivity(link, "sending", `Sent: ${params.prompt.slice(0, 40)}...`, taskId);

			const willReply = wantReply;
			const isStreaming = params.stream === true;
			const badge = taskMode === "visible" ? "👁" : "🔇";
			const streamBadge = isStreaming ? " 📡" : "";
			return {
				content: [{ type: "text", text: `Task ${taskId.slice(0, 8)} sent to ${link.meta.sessionName} (${badge}${streamBadge}).${willReply ? (isStreaming ? " Streaming result back." : " Result will return.") : " Fire-and-forget."}` }],
				details: { taskId, peer: link.meta.sessionName, mode: taskMode, replyTo: params.reply_to, stream: isStreaming, sent: true },
				terminate: taskMode === "silent" && !isStreaming,
			};
		},
		renderCall(args, theme) {
			const preview = ((args.prompt as string) ?? "...").slice(0, 60);
			const mode = args.mode === "visible" ? theme.fg("warning", "👁") : theme.fg("dim", "🔇");
			const reply = args.reply_to === "sender" ? theme.fg("accent", "↩") : theme.fg("dim", "→");
			const target = args.target ? ` ${theme.fg("dim", `→${args.target}`)}` : "";
			const stream = args.stream ? ` ${theme.fg("info", "📡")}` : "";
			return new Text(theme.fg("toolTitle", theme.bold("link ")) + `${mode} ${reply}${target}${stream} ` + theme.fg("dim", preview), 0, 0);
		},
		renderResult(result, _opts, theme) {
			const d = result.details as { taskId?: string; peer?: string; sent?: boolean; mode?: string } | undefined;
			if (!d?.sent) return new Text(theme.fg("warning", "Not linked"), 0, 0);
			const badge = d.mode === "visible" ? theme.fg("warning", "👁") : theme.fg("dim", "🔇");
			return new Text(`${theme.fg("success", "📤")} ${badge} Task sent to ${theme.fg("accent", d.peer ?? "peer")} (${d.taskId?.slice(0, 8)})`, 0, 0);
		},
	});

	pi.registerTool({
		name: "link_status",
		label: "Link: Status",
		description: "Check the current link connection status and peer information.",
		parameters: Type.Object({}),
		async execute() {
			const allLinks: Record<string, unknown>[] = [];
			for (const [id, link] of ctx.linksRegistry) {
				const info: Record<string, unknown> = {
					id: id.slice(0, 8),
					mode: link.mode,
					transport: link.transport,
					connected: link.isConnected,
					sessionName: link.meta.sessionName,
					model: link.meta.model,
					active: id === ctx.state.linkId,
					peer: link.peerInfo,
				};
				if (link.transport === "http") {
					if (link.httpPort) info.httpPort = link.httpPort;
					if (link.httpRemoteUrl) info.httpRemoteUrl = link.httpRemoteUrl;
				}
				allLinks.push(info);
			}
			return {
				content: [{ type: "text", text: JSON.stringify({ totalLinks: allLinks.length, activeLink: ctx.state.linkId?.slice(0, 8), links: allLinks }, null, 2) }],
				details: { totalLinks: allLinks.length, links: allLinks },
			};
		},
	});
}
