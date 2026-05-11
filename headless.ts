import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { getPiInvocation } from "./types.js";

/**
 * Build a context snapshot from recent session messages.
 */
export function buildContextSnapshot(getBranch: () => any[]): string {
	const entries = getBranch();
	const parts: string[] = [];

	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const msg = entry.message;
		if (msg.role !== "user" && msg.role !== "assistant") continue;

		const role = msg.role === "user" ? "User" : "Assistant";
		const text = (msg.content as Array<{ type: string; text?: string }>)
			.filter((c) => c.type === "text")
			.map((c) => c.text ?? "")
			.join("");

		if (!text) continue;
		const preview = text.length > 500 ? text.slice(0, 500) + "..." : text;
		parts.push(`${role}: ${preview}`);
	}

	return parts.slice(-20).join("\n\n");
}

/**
 * Run a task in a headless pi subprocess (silent branch — no context pollution).
 */
export async function runSilentTask(
	task: string,
	contextSnapshot: string | undefined,
	cwd: string,
	model: string | undefined,
): Promise<{ output: string; error?: string }> {
	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	if (model) args.push("--model", model);

	let fullPrompt = task;
	if (contextSnapshot) {
		fullPrompt = `## Context from the session that delegated this task\n\n${contextSnapshot}\n\n---\n\n${task}`;
	}

	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-link-task-"));
	const tmpPrompt = path.join(tmpDir, "prompt.txt");
	await fs.promises.writeFile(tmpPrompt, fullPrompt, { encoding: "utf-8", mode: 0o600 });
	args.push(tmpPrompt);

	return new Promise<{ output: string; error?: string }>((resolve) => {
		const invocation = getPiInvocation(args);
		const proc = spawn(invocation.command, invocation.args, {
			cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let buffer = "";
		let stderr = "";
		let lastAssistantText = "";

		proc.stdout.on("data", (data) => {
			buffer += data.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";

			for (const line of lines) {
				if (!line.trim()) continue;
				let event: any;
				try { event = JSON.parse(line); } catch { continue; }

				if (event.type === "message_end" && event.message?.role === "assistant") {
					const content = (event.message.content as Array<{ type: string; text?: string }>) ?? [];
					lastAssistantText = content
						.filter((c) => c.type === "text")
						.map((c) => c.text ?? "")
						.join("");
				}
			}
		});

		proc.stderr.on("data", (data) => { stderr += data.toString(); });

		proc.on("close", () => {
			try { fs.unlinkSync(tmpPrompt); fs.rmdirSync(tmpDir); } catch { /* best effort */ }

			if (lastAssistantText) {
				resolve({ output: lastAssistantText });
			} else if (stderr) {
				resolve({ output: "", error: stderr.trim().slice(0, 500) });
			} else {
				resolve({ output: "(no output from linked session)" });
			}
		});

		proc.on("error", (err) => {
			resolve({ output: "", error: `Failed to spawn: ${err.message}` });
		});
	});
}
