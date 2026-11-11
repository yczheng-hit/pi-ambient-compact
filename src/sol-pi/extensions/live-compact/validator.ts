/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
/**
 * Structural checks for a projected model context after history edits.
 *
 * pi-ai repairs one kind of breakage silently: an assistant tool call without a
 * result gets a synthetic "No result provided" error result, which tells the
 * model a tool failed when it did not. A tool result without its call is not
 * repaired and providers reject it. Both must be caught before an edit is
 * committed, not discovered in a provider response.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";

export type PairingIssueKind =
	/** A tool call with no result before the next assistant or user message. */
	| "orphan_call"
	/** A tool result whose call is not in the immediately preceding assistant message. */
	| "orphan_result"
	/** A tool call id that appears more than once. */
	| "duplicate_call"
	/** Two answered assistant messages with no user or tool result between them. */
	| "consecutive_assistant";

export interface PairingIssue {
	readonly kind: PairingIssueKind;
	/** Index into the checked message list. */
	readonly index: number;
	readonly toolCallId?: string;
}

function toolCallIds(message: AgentMessage): string[] {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return [];
	return message.content.flatMap((block) => (block.type === "toolCall" ? [block.id] : []));
}

/** Assistant messages Pi drops before conversion: errored or aborted attempts. */
function isSkippedAssistant(message: AgentMessage): boolean {
	if (message.role !== "assistant") return false;
	const stopReason = (message as { stopReason?: string }).stopReason;
	return stopReason === "error" || stopReason === "aborted";
}

/**
 * Pairing and role-order issues of `messages`, in order. Pi's custom and
 * summary messages count as user turns, as they do after conversion.
 */
export function validateToolPairing(messages: readonly AgentMessage[]): PairingIssue[] {
	const issues: PairingIssue[] = [];
	const seenCalls = new Set<string>();
	let pending = new Map<string, number>();
	let previousAssistant: number | undefined;

	const closePending = () => {
		for (const [toolCallId, index] of pending) issues.push({ kind: "orphan_call", index, toolCallId });
		pending = new Map();
	};

	messages.forEach((message, index) => {
		if (message.role === "system") return;
		if (message.role === "assistant") {
			if (isSkippedAssistant(message)) return;
			closePending();
			const calls = toolCallIds(message);
			if (previousAssistant !== undefined) {
				issues.push({ kind: "consecutive_assistant", index });
			}
			for (const toolCallId of calls) {
				if (seenCalls.has(toolCallId)) issues.push({ kind: "duplicate_call", index, toolCallId });
				seenCalls.add(toolCallId);
				pending.set(toolCallId, index);
			}
			// A tool-calling assistant is answered by its results; a text-only one ends the exchange.
			previousAssistant = calls.length === 0 ? index : undefined;
			return;
		}
		if (message.role === "toolResult") {
			if (!pending.delete(message.toolCallId)) {
				issues.push({ kind: "orphan_result", index, toolCallId: message.toolCallId });
			}
			previousAssistant = undefined;
			return;
		}
		// user, custom, and summary messages start a new user turn.
		closePending();
		previousAssistant = undefined;
	});
	closePending();
	return issues;
}
