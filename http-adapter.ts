/**
 * HTTP adapter: server creation, RPC handling, remote connection.
 */

import * as http from "node:http";
import {
	type LinkState,
	type JsonRpcMessage,
	type LinkRole,
	HTTP_LINK_DEFAULT_PORT,
	HEARTBEAT_INTERVAL_MS,
	HEARTBEAT_TIMEOUT_MS,
	createJsonRpc,
	createInitialState as createLinkState,
	maybeLinkRole,
	httpPostRpc,
	ensureLinkSecret,
	generateId,
} from "./types.js";
import type { LinkContext } from "./link-context.js";
import { buildContextSnapshot, runSilentTask } from "./headless.js";

function readBody(req: http.IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => resolve(Buffer.concat(chunks).toString()));
		req.on("error", reject);
	});
}

export function initHttpAdapter(ctx: LinkContext): void {
	ctx.startHttpAdapter = (link: LinkState, port: number, secret: string): http.Server => {
		const server = http.createServer(async (req, res) => {
			res.setHeader("Access-Control-Allow-Origin", "*");
			res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
			res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

			if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

			const auth = req.headers["authorization"];
			if (auth !== `Bearer ${secret}`) {
				res.writeHead(401, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: 401, message: "Unauthorized" }, id: null }));
				return;
			}

			if (req.url === "/.well-known/agent.json" && req.method === "GET") {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({
					name: link.meta.sessionName,
					url: `http://0.0.0.0:${port}`,
					model: link.meta.model,
					sessionId: link.meta.sessionId,
					protocol: "pi-link",
					version: "v1.0.0",
					skills: ["task/send", "ping", "version/get"],
				}));
				return;
			}

			if (req.url === "/health" && req.method === "GET") {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ status: "ok", session: link.meta.sessionName, transport: "http" }));
				return;
			}

			if (req.url === "/rpc" && req.method === "POST") {
				try {
					const body = await readBody(req);
					const msg = JSON.parse(body) as JsonRpcMessage;
					const response = await ctx.handleHttpRpcForLink(link, msg);
					res.writeHead(200, { "Content-Type": "application/json" });
					res.end(JSON.stringify(response));
				} catch (err: any) {
					res.writeHead(500, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: err.message }, id: null }));
				}
				return;
			}

			res.writeHead(404);
			res.end("Not found");
		});

		server.listen(port, "0.0.0.0", () => {
			ctx.ctx?.ui.notify(`🔗 HTTP adapter listening on port ${port}`, "info");
		});

		server.on("error", (err) => {
			ctx.ctx?.ui.notify(`🔗 HTTP adapter error: ${err.message}`, "error");
		});

		return server;
	};

	ctx.handleHttpRpcForLink = async (link: LinkState, msg: JsonRpcMessage): Promise<JsonRpcMessage> => {
		if (msg.method === "ping") {
			return {
				jsonrpc: "2.0", id: msg.id,
				result: {
					sessionId: link.meta.sessionId,
					sessionName: link.meta.sessionName,
					model: link.meta.model,
					hash: ctx.loadTimeHash,
					role: link.selfRole,
				},
			};
		}

		if (msg.method === "version/get") {
			return {
				jsonrpc: "2.0", id: msg.id,
				result: { version: "v1.0.0", hash: ctx.loadTimeHash, sessionName: link.meta.sessionName, role: link.selfRole },
			};
		}

		if (msg.method === "task/send") {
			const p = msg.params as { taskId: string; prompt: string; context?: string; replyTo?: string; mode?: string } | undefined;
			if (!p?.prompt) {
				return { jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "Missing prompt parameter" } };
			}

			const mode = p.mode === "visible" ? "visible" as const : "silent" as const;
			ctx.ctx?.ui.notify(`📥 HTTP task: ${p.prompt.slice(0, 60)}...`, "info");

			if (mode === "silent") {
				const ourContext = ctx.ctx ? buildContextSnapshot(() => ctx.ctx!.sessionManager.getBranch()) : undefined;
				let fullContext: string | undefined;
				if (p.context && ourContext) {
					fullContext = `## Sender's context\n\n${p.context}\n\n## Our context\n\n${ourContext}`;
				} else if (p.context) {
					fullContext = p.context;
				} else if (ourContext) {
					fullContext = ourContext;
				}

				const result = await runSilentTask(p.prompt, fullContext, ctx.ctx?.cwd ?? process.cwd(), link.meta.model);
				ctx.ctx?.ui.notify(`📤 HTTP task result sent (${p.taskId.slice(0, 8)})`, "success");
				return {
					jsonrpc: "2.0", id: msg.id,
					result: { taskId: p.taskId, status: "completed", content: result.output, error: result.error },
				};
			} else {
				ctx.processVisibleTaskForLink(link, p);
				return {
					jsonrpc: "2.0", id: msg.id,
					result: { taskId: p.taskId, status: "received", mode: "visible", note: "Injected into session — result not returned over HTTP" },
				};
			}
		}

		return { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } };
	};

	ctx.connectHttpRemote = async (url: string, secret: string): Promise<LinkState> => {
		const agentUrl = url.replace(/\/$/, "") + "/.well-known/agent.json";
		const agentInfo = await new Promise<any>((resolve, reject) => {
			const r = http.request(agentUrl, {
				method: "GET",
				headers: { Authorization: `Bearer ${secret}` },
				timeout: 10_000,
			}, (res) => {
				let data = "";
				res.on("data", (chunk: Buffer) => { data += chunk.toString(); });
				res.on("end", () => {
					if (res.statusCode === 200) {
						try { resolve(JSON.parse(data)); }
						catch { reject(new Error("Invalid agent card")); }
					} else {
						reject(new Error(`HTTP ${res.statusCode}: ${data}`));
					}
				});
			});
			r.on("error", reject);
			r.on("timeout", () => { r.destroy(); reject(new Error("Discovery timed out")); });
			r.end();
		});

		const link = createLinkState();
		const pingResponse = await httpPostRpc(url, secret, createJsonRpc("ping", {
			sessionId: ctx.state.meta.sessionId,
			sessionName: ctx.state.meta.sessionName,
		}));

		const linkId = agentInfo.sessionId ?? generateId();
		link.mode = "guest";
		link.transport = "http";
		link.linkId = linkId;
		link.httpRemoteUrl = url;
		link.httpSecret = secret;
		link.isConnected = true;
		link.lastPeerActivity = Date.now();
		link.meta = {
			id: linkId,
			sessionId: agentInfo.sessionId ?? "",
			sessionName: agentInfo.name ?? "remote",
			model: agentInfo.model ?? "unknown",
			created: Date.now(),
			lastHeartbeat: Date.now(),
			status: "connected",
		};
		const remoteRole = maybeLinkRole(pingResponse.result?.role as string | undefined);
		link.meta.role = remoteRole;
		link.selfRole = remoteRole === "interviewer" ? "interviewee" : remoteRole === "interviewee" ? "interviewer" : "symmetric";
		link.peerInfo = {
			sessionId: pingResponse.result?.sessionId as string ?? "",
			sessionName: pingResponse.result?.sessionName as string ?? agentInfo.name,
			model: pingResponse.result?.model as string ?? agentInfo.model,
		};

		link.heartbeatTimer = setInterval(async () => {
			if (Date.now() - link.lastPeerActivity > HEARTBEAT_TIMEOUT_MS) {
				ctx.handlePeerLostForLink(link, "HTTP heartbeat timeout");
				return;
			}
			try {
				await httpPostRpc(link.httpRemoteUrl!, link.httpSecret!, createJsonRpc("ping", {
					sessionId: link.meta.sessionId,
					sessionName: link.meta.sessionName,
				}), 10_000);
				link.lastPeerActivity = Date.now();
			} catch {
				// Remote unreachable — let timeout handle it
			}
		}, HEARTBEAT_INTERVAL_MS);

		ctx.addLink(link);
		return link;
	};
}

