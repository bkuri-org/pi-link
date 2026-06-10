/**
 * Activity tracking: spinner animation, activity state, formatting.
 */

import {
	type LinkState,
	type LinkActivity,
} from "./types.js";
import type { LinkContext } from "./link-context.js";

const ACTIVITY_ICONS: Record<string, string> = {
	sending: "📤",
	receiving: "⏳",
	streaming: "📡",
	received: "📥",
	error: "❌",
};

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function initActivity(ctx: LinkContext): void {
	let spinnerFrame = 0;
	let spinnerTimer: ReturnType<typeof setInterval> | undefined;

	function startSpinner(): void {
		if (spinnerTimer) return;
		spinnerTimer = setInterval(() => {
			spinnerFrame = (spinnerFrame + 1) % SPINNER_FRAMES.length;
			ctx.updateWidget();
		}, 150);
	}

	ctx.stopSpinner = (): void => {
		if (spinnerTimer) {
			clearInterval(spinnerTimer);
			spinnerTimer = undefined;
			spinnerFrame = 0;
			ctx.updateWidget();
		}
	};

	ctx.setActivity = (link: LinkState, type: LinkActivity["type"], label: string, taskId?: string): void => {
		link.activity = { type, label, taskId, startedAt: Date.now() };
		link.activityLog.push(link.activity);
		if (link.activityLog.length > 10) link.activityLog = link.activityLog.slice(-10);
		startSpinner();
		ctx.updateWidget();
	};

	ctx.clearActivity = (link: LinkState): void => {
		link.activity = null;
		const anyActive = [...ctx.linksRegistry.values()].some(l => l.activity !== null);
		if (!anyActive) ctx.stopSpinner();
		ctx.updateWidget();
	};

	ctx.formatActivity = (link: LinkState, compact = false): string => {
		const a = link.activity;
		if (!a) return "";
		const icon = ACTIVITY_ICONS[a.type] ?? "•";
		const elapsed = Math.round((Date.now() - a.startedAt) / 1000);
		const timeStr = elapsed < 5 ? "just now" : elapsed < 60 ? `${elapsed}s` : `${Math.round(elapsed / 60)}m${elapsed % 60}s`;
		if (compact) {
			const spinner = (a.type === "sending" || a.type === "receiving" || a.type === "streaming")
				? ` ${SPINNER_FRAMES[spinnerFrame]}` : "";
			return `${icon}${spinner}`;
		}
		const taskInfo = a.taskId ? ` [${a.taskId.slice(0, 6)}]` : "";
		return `${icon} ${a.label}${taskInfo} (${timeStr})`;
	};
}
