/**
 * Session Namer
 *
 * Custom tool that lets the agent name the current session from the
 * conversation thread, enforcing a configurable naming convention.
 *
 * The agent is steered (via `promptSnippet` / `promptGuidelines`) to call
 * `set_session_name` once the thread's main goal is clear. The tool
 * sanitizes the proposed name against the convention below and persists it
 * with `pi.setSessionName()`, which writes a `session_info` entry that shows
 * up in `/resume`, `pi -r`, and `/session` instead of the raw first message.
 *
 * Install: copy to ~/.pi/agent/extensions/ (global) or .pi/extensions/ (project),
 * or test with `pi -e ./session-namer.ts`.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// --- Naming convention -------------------------------------------------
// Adjust these to your team's convention.
const CONVENTION = {
	// Optional type prefix, rendered as "type: subject".
	// Set to [] to disable type prefixes entirely.
	types: ["feat", "fix", "chore", "docs", "refactor", "test"] as const,
	// Whether the agent must pick a type from the list above.
	requireType: false,
	// Max final name length; longer names are truncated with an ellipsis.
	maxLength: 60,
	// Wrap the agent-supplied ticket in brackets, e.g. "[ABC-123] subject".
	// Set to false to render "ABC-123 subject" instead.
	ticketBrackets: true,
	// Tickets must match this shape to be accepted (JIRA-style prefix-number).
	ticketPattern: /^[A-Za-z][A-Za-z0-9]*-\d+$/,
};
// -----------------------------------------------------------------------

function sanitizeSubject(s: string): string {
	return s
		.replace(/\s+/g, " ") // collapse whitespace
		.trim()
		.replace(/[.?!:;,]+$/, ""); // strip trailing punctuation
}

function applyConvention(input: { name: string; type?: string; ticket?: string }): string {
	const subject = sanitizeSubject(input.name);
	if (!subject) return "";

	const parts: string[] = [];
	if (input.ticket && CONVENTION.ticketPattern.test(input.ticket)) {
		parts.push(CONVENTION.ticketBrackets ? `[${input.ticket}]` : input.ticket);
	}
	parts.push(subject);

	let name = parts.join(" ");
	if (input.type && (CONVENTION.types as readonly string[]).includes(input.type)) {
		name = `${input.type}: ${name}`;
	}

	if (name.length > CONVENTION.maxLength) {
		name = name.slice(0, CONVENTION.maxLength - 1).trimEnd() + "…";
	}
	return name;
}

export default function (pi: ExtensionAPI) {
	const typeParam =
		CONVENTION.types.length > 0
			? Type.Optional(
					StringEnum(CONVENTION.types, {
						description: "Type prefix to apply per the naming convention",
					}),
				)
			: Type.Optional(Type.String({ description: "Type prefix (ignored)" }));

	pi.registerTool({
		name: "set_session_name",
		label: "Set Session Name",
		description:
			"Set a short, descriptive display name for the current session based on the conversation thread. " +
			"Call this once the thread's main goal is clear, usually after the first meaningful exchange. " +
			"Session names appear in the session picker (/resume and pi -r) instead of the raw first message, " +
			"so keep them specific enough to tell sessions apart.",
		promptSnippet: "Name the current session from the thread topic",
		promptGuidelines: [
			"Call set_session_name when the conversation's main goal is clear, ideally early in the session.",
			'Base the name on the actual thread content and keep it specific ("fix refund webhook retries"), not generic ("fix bug").',
			"If the thread spans multiple topics, name it after the dominant or earliest goal.",
			"When the naming convention applies, pass the matching type and ticket so the tool formats the final name.",
		],
		parameters: Type.Object({
			name: Type.String({
				description: 'Proposed session name (subject), e.g. "Refactor auth module"',
			}),
			type: typeParam,
			ticket: Type.Optional(
				Type.String({
					description: "Ticket reference (e.g. ABC-123) to prepend to the name",
				}),
			),
		}),
		prepareArguments(args: unknown): { name: string; type?: string; ticket?: string } {
			if (!args || typeof args !== "object") return { name: "" };
			const input = args as Record<string, unknown>;
			// Accept an older/alternate param name when resuming old sessions.
			if (typeof input.proposedName === "string" && input.name === undefined) {
				return { ...input, name: input.proposedName } as { name: string; type?: string; ticket?: string };
			}
			return args as { name: string; type?: string; ticket?: string };
		},
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const name = applyConvention(params);
			if (!name) {
				throw new Error("Session name is empty after applying the naming convention");
			}

			const current = pi.getSessionName();
			if (current === name) {
				return {
					content: [{ type: "text", text: `Session is already named "${name}"` }],
					details: { name, changed: false },
				};
			}

			pi.setSessionName(name);
			ctx.ui.notify(`Session named: ${name}`, "info");

			return {
				content: [{ type: "text", text: `Session renamed to "${name}"` }],
				details: { name, changed: true },
			};
		},
	});
}
