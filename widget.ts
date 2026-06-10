/**
 * Widget rendering: TUI widget and status bar updates for link state.
 */

import { Text } from "@earendil-works/pi-tui";
import {
	type LinkState,
	roleIcon,
} from "./types.js";
import type { LinkContext } from "./link-context.js";

function renderRoleLabel(link: LinkState): string {
	if (link.selfRole === "symmetric") return "🔗 ↔";
	const arrow = link.selfRole === "interviewer" ? "→" : "←";
	return `${roleIcon(link.selfRole)} ${arrow}`;
}

function renderRolePeerName(link: LinkState): string {
	if (link.selfRole === "symmetric") {
		return link.mode === "host"
			? (link.peerInfo?.sessionName ?? "peer")
			: (link.meta.sessionName || link.meta.id);
	}
	if (link.selfRole === "interviewer") {
		return link.peerInfo?.sessionName ?? "interviewee";
	}
	return link.meta.sessionName || "interviewer";
}

function renderSingleLinkWidget(ctx: LinkContext, link: LinkState): void {
	const c = ctx.ctx;
	if (!c) return;

	if (link.mode === "none") {
		c.ui.setWidget("link", undefined);
		c.ui.setStatus("link", undefined);
		return;
	}

	const activityStr = ctx.formatActivity(link);
	const widgetIcon = roleIcon(link.selfRole);
	const roleLabel = renderRoleLabel(link);
	const peerName = renderRolePeerName(link);
	const transport = link.transport === "http"
		? (link.mode === "host" ? ` [HTTP :${link.httpPort}]` : " [HTTP]")
		: "";

	if (link.recovering) {
		c.ui.setWidget("link", [`${widgetIcon} Recovering link...`, `  ${link.meta.sessionName}`]);
		c.ui.setStatus("link", `${widgetIcon} recovering...`);
		return;
	}

	if (!link.isConnected) {
		if (link.mode === "host") {
			c.ui.setWidget("link", [`${widgetIcon} Waiting for peer...${transport}`, `  ${link.meta.sessionName}`, `  ${link.meta.model}`]);
			c.ui.setStatus("link", `${widgetIcon} waiting...`);
		} else {
			c.ui.setWidget("link", undefined);
			c.ui.setStatus("link", undefined);
		}
		return;
	}

	const lines: string[] = [];

	if (link.selfRole === "symmetric") {
		lines.push(`${roleLabel} ${peerName}${transport}`);
		lines.push(`  ${link.mode === "host" ? link.meta.model : (link.peerInfo?.model ?? "")}`);
		if (activityStr) lines.push(activityStr);
		c.ui.setWidget("link", lines);
		c.ui.setStatus("link", `${widgetIcon} ${ctx.formatActivity(link, true) || peerName}`);
	} else {
		const roleName = link.selfRole === "interviewer" ? "Interviewer" : "Interviewee";
		lines.push(`${roleLabel} ${peerName} (${roleName})${transport}`);
		lines.push(`  ${link.mode === "host" ? link.meta.model : (link.peerInfo?.model ?? "")}`);
		if (activityStr) lines.push(activityStr);
		c.ui.setWidget("link", lines);
		c.ui.setStatus("link", `${widgetIcon} ${ctx.formatActivity(link, true) || peerName}`);
	}
}

export function initWidget(ctx: LinkContext): void {
	ctx.updateWidget = (): void => {
		if (!ctx.ctx) return;

		if (ctx.linksRegistry.size === 0) {
			ctx.ctx.ui.setWidget("link", undefined);
			ctx.ctx.ui.setStatus("link", undefined);
			return;
		}

		if (ctx.linksRegistry.size === 1) {
			const link = ctx.linksRegistry.values().next().value;
			if (link) renderSingleLinkWidget(ctx, link);
			return;
		}

		const lines: string[] = [`🔗 Links (${ctx.linksRegistry.size})`];
		for (const [id, link] of ctx.linksRegistry) {
			const prefix = id === ctx.state.linkId ? "→ " : "  ";
			if (link.isConnected) {
				const peer = link.peerInfo?.sessionName ?? link.meta.sessionName;
				const transport = link.transport === "http" ? " [HTTP]" : "";
				const icon = roleIcon(link.selfRole);
				const arrow = link.selfRole === "symmetric" ? "↔" : link.selfRole === "interviewer" ? "→" : "←";
				lines.push(`${prefix}${icon} ${arrow} ${peer}${transport}`);
			} else if (link.mode === "host") {
				lines.push(`${prefix}⏳ ${link.meta.sessionName} (waiting)`);
			} else {
				lines.push(`${prefix}❌ ${link.meta.sessionName} (disconnected)`);
			}
		}
		ctx.ctx.ui.setWidget("link", lines);
		const connectedCount = [...ctx.linksRegistry.values()].filter(l => l.isConnected).length;
		ctx.ctx.ui.setStatus("link", `🔗 ${connectedCount}/${ctx.linksRegistry.size}`);
	};
}
