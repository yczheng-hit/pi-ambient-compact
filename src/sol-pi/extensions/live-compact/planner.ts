/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
/**
 * The planner contract of a dynamic-ai maintenance cycle.
 *
 * A planner sees candidate segments and returns which to summarize and the
 * summary of each. It never returns the context to keep: the controller keeps
 * every unselected message byte for byte and builds the edits itself.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Segment } from "./segments.ts";

export interface PlanRequest {
	readonly candidates: readonly Segment[];
	/** Tokens the cycle should reclaim; a target, not a quota. */
	readonly reclaimTokens: number;
	/** The user's turns, verbatim, so the planner knows what the work is about. */
	readonly userTurns: readonly string[];
	readonly signal: AbortSignal;
}

export interface PlanSelection {
	readonly segmentId: string;
	readonly summary: string;
}

export interface PlanUsage {
	readonly calls: number;
	readonly inputTokens: number;
	readonly outputTokens: number;
}

export interface PlanResult {
	readonly selections: readonly PlanSelection[];
	readonly usage: PlanUsage;
	/** Why nothing was selected, or why some selections were dropped. */
	readonly notes: readonly string[];
}

export type Planner = (request: PlanRequest, ctx: ExtensionContext) => Promise<PlanResult>;

export const NO_USAGE: PlanUsage = Object.freeze({ calls: 0, inputTokens: 0, outputTokens: 0 });

function textOf(message: AgentMessage): string {
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block: Record<string, unknown>) => {
			if (block.type === "text") return String(block.text ?? "");
			if (block.type === "toolCall") return `[tool call ${String(block.name)} ${JSON.stringify(block.arguments ?? {})}]`;
			return "";
		})
		.filter((text) => text.length > 0)
		.join("\n");
}

/** A deterministic transcript of messages: the planner input and the archive text. */
export function renderMessages(items: ReadonlyArray<{ readonly entryId: string; readonly message: AgentMessage }>): string {
	return items
		.map((item) => {
			const message = item.message as { role: string; toolName?: string; toolCallId?: string; isError?: boolean };
			const label =
				message.role === "toolResult"
					? `tool result ${message.toolName ?? ""} (call ${message.toolCallId ?? "?"})${message.isError ? " error" : ""}`
					: message.role;
			return `--- ${label} · entry ${item.entryId} ---\n${textOf(item.message)}`;
		})
		.join("\n");
}

/** The transcript of a segment. */
export function renderSegment(segment: Segment): string {
	return renderMessages(segment.messages);
}

/** The user turns of a projected context, for planner context. */
export function userTurns(messages: readonly AgentMessage[]): string[] {
	return messages.filter((message) => message.role === "user").map(textOf);
}

/**
 * Oldest-first planner with a fixed summary text. For tests and for exercising
 * the cycle without a model; it is not a quality summary.
 */
export function deterministicPlanner(summaryFor: (segment: Segment) => string = (segment) => `Summarized ${segment.kind} with ${segment.messages.length} messages.`): Planner {
	return async (request) => {
		const selections: PlanSelection[] = [];
		let reclaimed = 0;
		for (const segment of request.candidates) {
			if (reclaimed >= request.reclaimTokens) break;
			selections.push({ segmentId: segment.id, summary: summaryFor(segment) });
			reclaimed += segment.tokens;
		}
		return { selections, usage: NO_USAGE, notes: [] };
	};
}
