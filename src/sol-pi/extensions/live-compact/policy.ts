/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
/**
 * Live Compact candidate policy: which projected tool results may be condensed.
 *
 * A candidate is a successful, text-only tool result that is larger than the
 * configured size, already seen by enough provider requests, outside the most
 * recent complete tool rounds, unambiguously paired with its tool call, and not
 * already edited. Everything else stays verbatim: user and assistant text,
 * errors, images, mixed content, recalls, reducer receipts, and anything whose
 * pairing is unclear.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { ProjectedSessionEntry } from "@earendil-works/pi-coding-agent";
import type { LiveCompactConfig } from "../../live-compact-config.mjs";
import { containsReducerReceipt, isPureTextResult, textFromResult } from "../observation-pack/observation.ts";

/** Tool results never condensed: they are recalled evidence the agent asked for. */
export const NEVER_CONDENSED_TOOLS: ReadonlySet<string> = new Set(["obs_recall"]);

export interface Candidate {
	/** Session entry whose context contribution would be replaced. */
	readonly entryId: string;
	/** The original, unedited tool result. */
	readonly message: ToolResultMessage;
	readonly bytes: number;
	/** Position in the projected context; lower is older. */
	readonly order: number;
}

export type SkipReason =
	| "edited"
	| "not_pure_text"
	| "error"
	| "recall"
	| "reducer_receipt"
	| "small"
	| "unpaired"
	| "recent_round"
	| "too_few_requests";

export interface CandidateScan {
	readonly candidates: readonly Candidate[];
	readonly skipped: Readonly<Record<SkipReason, number>>;
}

function toolCallIds(message: AgentMessage): string[] {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return [];
	return message.content.flatMap((block) => (block.type === "toolCall" ? [block.id] : []));
}

function sameContent(left: unknown, right: unknown): boolean {
	return left === right || JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Scan the projected context (`turn_end` event.context.contextEntries), oldest
 * first, and return the condensable tool results.
 */
export function scanCandidates(
	entries: readonly ProjectedSessionEntry[],
	config: Pick<LiveCompactConfig, "protection" | "observation">,
): CandidateScan {
	const skipped: Record<SkipReason, number> = {
		edited: 0,
		not_pure_text: 0,
		error: 0,
		recall: 0,
		reducer_receipt: 0,
		small: 0,
		unpaired: 0,
		recent_round: 0,
		too_few_requests: 0,
	};

	const flat: Array<{ entry: ProjectedSessionEntry; message: AgentMessage }> = [];
	for (const entry of entries) for (const message of entry.messages) flat.push({ entry, message });

	// Walk backwards: count the assistant responses after each position, and
	// protect the tool calls of the most recent complete tool rounds. One
	// assistant message with several parallel calls is one round.
	const assistantsAfter = new Array<number>(flat.length);
	const protectedCalls = new Set<string>();
	const knownCalls = new Set<string>();
	let assistants = 0;
	let rounds = 0;
	for (let index = flat.length - 1; index >= 0; index -= 1) {
		assistantsAfter[index] = assistants;
		const message = flat[index]!.message;
		if (message.role !== "assistant") continue;
		assistants += 1;
		const calls = toolCallIds(message);
		for (const id of calls) knownCalls.add(id);
		if (calls.length > 0 && rounds < config.protection.keepRecentToolRounds) {
			rounds += 1;
			for (const id of calls) protectedCalls.add(id);
		}
	}

	const candidates: Candidate[] = [];
	for (let index = 0; index < flat.length; index += 1) {
		const { entry, message } = flat[index]!;
		const source = entry.sourceEntry;
		if (source.type !== "message" || source.message.role !== "toolResult" || message.role !== "toolResult") continue;
		const original = source.message;
		// Cheap checks on the original first; the edit comparison below serializes content.
		// Old or hand-edited sessions can hold null content, which Pi normalizes only in the projection.
		if (!Array.isArray(original.content)) {
			skipped.not_pure_text += 1;
			continue;
		}
		if (original.isError) {
			skipped.error += 1;
			continue;
		}
		if (!isPureTextResult(original)) {
			skipped.not_pure_text += 1;
			continue;
		}
		if (NEVER_CONDENSED_TOOLS.has(original.toolName)) {
			skipped.recall += 1;
			continue;
		}
		const text = textFromResult(original);
		const bytes = Buffer.byteLength(text, "utf8");
		if (bytes <= config.observation.minBytes) {
			skipped.small += 1;
			continue;
		}
		if (!sameContent(message.content, original.content)) {
			skipped.edited += 1;
			continue;
		}
		if (containsReducerReceipt(text)) {
			skipped.reducer_receipt += 1;
			continue;
		}
		if (!knownCalls.has(original.toolCallId)) {
			skipped.unpaired += 1;
			continue;
		}
		if (protectedCalls.has(original.toolCallId)) {
			skipped.recent_round += 1;
			continue;
		}
		if ((assistantsAfter[index] ?? 0) < config.protection.minFullRequests) {
			skipped.too_few_requests += 1;
			continue;
		}
		candidates.push({ entryId: source.id, message: original, bytes, order: index });
	}
	return { candidates, skipped };
}
