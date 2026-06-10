/**
 * Per-link message handling: JSON-RPC parsing, task processing (silent + visible).
 */

import * as crypto from "node:crypto";
import {
	type LinkState,
	type JsonRpcMessage,
	createJsonRpc,
	sendJsonRpc,
	parseJsonRpcLines,
	maybeLinkRole,
	roleIcon,
} from "./types.js";
import type { LinkContext } from "./link-context.js";
import { buildContextSnapshot, runSilentTask } from "./headless.js";

/** Build merged context from sender + our session. */
function buildTaskContext(
	ctx: LinkContext,
	senderContext?: string,
): string | undefined {
	const ourContext = ctx.ctx ? buildContextSnapshot(() => ctx.ctx!.sessionManager.getBranch()) : undefined;
	if (senderContext && ourContext) {
		return `## Sender's context\n\n${senderContext}\n\n## Our context\n\n${ourContext}`;
	}
	return senderContext || ourContext || undefined;
}

function handleMsgForLink(ctx: LinkContext, link: LinkState, msg: JsonRpcMessage): void {
	// Resolve pending promises (ping responses)
	if (!msg.method && msg.id) {
		const resolver = link.resolveQueue.get(msg.id);
		if (resolver) {
			link.resolveQueue.delete(msg.id);
			resolver(msg);
		}
	}

	// Ping
	if (msg.method === "ping") {
		const conn = link.connection;
		if (conn && !conn.destroyed) {
			sendJsonRpc(conn, {
				jsonrpc: "2.0",
				id: msg.id,
				result: {
					sessionId: link.meta.sessionId,
					sessionName: link.meta.sessionName,
					model: link.meta.model,
					hash: ctx.loadTimeHash,
					role: link.selfRole,
				},
			});
		}
		return;
	}

	// Version query
	if (msg.method === "version/get") {
		const conn = link.connection;
		if (conn && !conn.destroyed) {
			sendJsonRpc(conn, {
				jsonrpc: "2.0",
				id: msg.id,
				result: {
					version: "v1.0.0",
					hash: ctx.loadTimeHash,
					sessionName: link.meta.sessionName,
					role: link.selfRole,
				},
			});
		}
		return;
	}

	// Role update (sent by peer when role reverses)
	if (msg.method === "role/update") {
		const p = msg.params as { role?: string } | undefined;
		if (!p?.role) return;

		const newHostRole = maybeLinkRole(p.role);
		link.meta.role = newHostRole;

		if (newHostRole === "symmetric") {
			link.selfRole = "symmetric";
		} else if (link.mode === "host") {
			link.selfRole = newHostRole;
		} else {
			link.selfRole = newHostRole === "interviewer" ? "interviewee" : "interviewer";
		}

		ctx.updateWidget();
		ctx.ctx?.ui.notify(`🔗 Role updated: you're now ${roleIcon(link.selfRole)} ${link.selfRole}`, "info");
		return;
	}

	// Incoming task
	if (msg.method === "task/send") {
		const p = msg.params as { taskId: string; prompt: string; context?: string; replyTo?: string; mode?: string } | undefined;
		if (!p?.prompt) return;

		const mode = p.mode === "visible" ? "visible" as const : "silent" as const;

		// Ack
		const conn = link.connection;
		if (conn && !conn.destroyed) {
			sendJsonRpc(conn, { jsonrpc: "2.0", id: msg.id, result: { taskId: p.taskId, status: "received", mode } });
		}

		if (mode === "silent") {
			processSilentTaskForLink(ctx, link, p);
		} else {
			ctx.processVisibleTaskForLink(link, p);
		}
		return;
	}

	// Incoming stream chunk
	if (msg.method === "task/stream") {
		const p = msg.params as { taskId: string; chunk: string; done: boolean } | undefined;
		if (!p) return;

		if (p.done) {
			ctx.streamBuffers.delete(p.taskId);
			if (ctx.streamBuffers.size === 0) {
				ctx.ctx?.ui.setWidget("link-stream", undefined);
			}
			return;
		}

		if (p.chunk) {
			const existing = ctx.streamBuffers.get(p.taskId) ?? "";
			ctx.streamBuffers.set(p.taskId, existing + p.chunk);

			const content = ctx.streamBuffers.get(p.taskId) ?? "";
			const preview = content.length > 300 ? "..." + content.slice(-300) : content;
			ctx.ctx?.ui.setWidget("link-stream", [
				`⏳ Streaming (${p.taskId.slice(0, 8)})`,
				`  ${preview.split("\n").slice(-3).join("\n")}`,
			]);
		}
		return;
	}

	// Incoming task result
	if (!msg.method && msg.result && typeof msg.result === "object") {
		const r = msg.result as { taskId?: string; status?: string; content?: string };
		if (r.status === "completed" && r.content) {
			ctx.ctx?.ui.notify(`📥 Result from peer (${r.taskId?.slice(0, 8)})`, "success");
			ctx.setActivity(link, "received", `Result received (${r.taskId?.slice(0, 8)})`, r.taskId);
			setTimeout(() => ctx.clearActivity(link), 3000);
			ctx.pi.sendMessage({
				customType: "link-result",
				content: r.content,
				display: true,
				details: { taskId: r.taskId },
			}, { triggerTurn: true, deliverAs: "steer" });
		}
	}
}

async function processSilentTaskForLink(
	ctx: LinkContext,
	link: LinkState,
	p: { taskId: string; prompt: string; context?: string; replyTo?: string; stream?: boolean },
): Promise<void> {
	const shouldReply = p.replyTo === "sender";
	const shouldStream = p.stream === true && link.connection && !link.connection.destroyed;
	ctx.ctx?.ui.notify(`📥 Silent task: ${p.prompt.slice(0, 60)}...${shouldStream ? " [streaming]" : ""}`, "info");
	ctx.setActivity(link, shouldStream ? "streaming" : "receiving", `Processing: ${p.prompt.slice(0, 40)}...`, p.taskId);

	const fullContext = buildTaskContext(ctx, p.context);
	const result = await runSilentTask(
		p.prompt, fullContext, ctx.ctx?.cwd ?? process.cwd(), link.meta.model,
		shouldStream
			? (chunk: string) => {
				sendJsonRpc(link.connection!, {
					jsonrpc: "2.0",
					id: crypto.randomUUID(),
					method: "task/stream",
					params: { taskId: p.taskId, chunk, done: false },
				});
			  }
			: undefined,
	);

	// Send stream done signal
	if (shouldStream) {
		sendJsonRpc(link.connection!, {
			jsonrpc: "2.0",
			id: crypto.randomUUID(),
			method: "task/stream",
			params: { taskId: p.taskId, chunk: "", done: true },
		});
	}

	if (shouldReply) {
		const conn = link.connection;
		if (conn && !conn.destroyed) {
			sendJsonRpc(conn, {
				jsonrpc: "2.0",
				id: crypto.randomUUID(),
				result: { taskId: p.taskId, status: "completed", content: result.output, error: result.error },
			});
			ctx.ctx?.ui.notify(`📤 Silent task result sent (${p.taskId.slice(0, 8)})`, "success");
			ctx.setActivity(link, "received", `Result sent (${p.taskId.slice(0, 8)})`, p.taskId);
			setTimeout(() => ctx.clearActivity(link), 3000);
		}
	}
}

export function initMessageHandler(ctx: LinkContext): void {
	ctx.handleDataForLink = (link: LinkState, data: Buffer): void => {
		link.lastPeerActivity = Date.now();
		link.buffer += data.toString();
		const { messages, remaining } = parseJsonRpcLines(link.buffer);
		link.buffer = remaining;
		for (const msg of messages) handleMsgForLink(ctx, link, msg);
	};

	ctx.processVisibleTaskForLink = (link: LinkState, p: { taskId: string; prompt: string; context?: string; replyTo?: string }): void => {
		let prompt = p.prompt;
		if (p.context) {
			prompt = `## Context from linked session\n\n${p.context}\n\n---\n\n${p.prompt}`;
		}

		if (p.replyTo === "sender" && p.taskId) {
			link.pendingTask = { taskId: p.taskId, replyTo: "sender", mode: "visible", receivedAt: Date.now() };
		}

		ctx.ctx?.ui.notify(`📥 Visible task: ${p.prompt.slice(0, 60)}...`, "info");
		ctx.setActivity(link, "receiving", `Visible: ${p.prompt.slice(0, 40)}...`, p.taskId);
		setTimeout(() => ctx.clearActivity(link), 5000);
		ctx.pi.sendUserMessage(prompt, { deliverAs: "steer" });
	};
}
