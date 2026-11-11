/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
/**
 * Dynamic-ai segment index: the parts of the projected context that a
 * maintenance cycle may summarize, and the edits that do it.
 *
 * The projection is split into episodes (a user-turn message and the
 * assistant and tool messages that answer it) and rounds (one assistant
 * message and its tool results). Two segment shapes exist, the two that G0
 * verified against real provider payloads (docs/live-compact-dynamic-plan.md
 * §10):
 *
 * - `episode`: the whole answer to an earlier user turn. Its first assistant
 *   message carries the summary; the rest is omitted:
 *   [user][summary][next user].
 * - `rounds`: consecutive complete tool rounds inside an episode. The first
 *   round keeps one tool call with compacted arguments and its result carries
 *   the summary; the rest is omitted: [call][result = summary][next assistant].
 *
 * Kept verbatim, never in a segment: user, custom, and summary messages;
 * system messages; messages already edited (no summary of a summary); rounds
 * with an error result, non-text content, unpaired calls, or an errored or
 * aborted assistant; the most recent tool rounds; and the latest episode's
 * final answer.
 */
import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ProjectedSessionEntry } from "@earendil-works/pi-coding-agent";
import { estimateMessagesTokens } from "./budget.ts";
import type { PlannedEdit } from "./commit.ts";

export interface IndexedMessage {
	readonly entryId: string;
	readonly message: AgentMessage;
	/** Position in the projected context. */
	readonly index: number;
	/** The projected content differs from the raw entry: an earlier edit already applies. */
	readonly edited: boolean;
}

export interface Round {
	readonly assistant: IndexedMessage;
	readonly results: readonly IndexedMessage[];
	readonly toolCallIds: readonly string[];
	/** Why the round must stay verbatim, if it must. */
	readonly unsafe?: string;
}

export type SegmentKind = "episode" | "rounds";

export interface Segment {
	/** Stable for the same entries: `seg_` + a hash of the entry ids. */
	readonly id: string;
	readonly kind: SegmentKind;
	readonly messages: readonly IndexedMessage[];
	readonly tokens: number;
	/** Index of the user-turn message that starts the episode, or -1 before the first. */
	readonly episodeStart: number;
}

export interface SegmentIndex {
	readonly segments: readonly Segment[];
	/** Rounds kept verbatim, by reason. */
	readonly kept: Readonly<Record<string, number>>;
	readonly messages: readonly IndexedMessage[];
}

export interface SegmentOptions {
	readonly keepRecentToolRounds: number;
	/** Most rounds in one `rounds` segment. */
	readonly maxRoundsPerSegment?: number;
	/** Largest estimated size of one `rounds` segment. */
	readonly maxSegmentTokens?: number;
	/** Smallest estimated size worth summarizing. */
	readonly minSegmentTokens?: number;
}

const DEFAULT_MAX_ROUNDS = 12;
const DEFAULT_MAX_SEGMENT_TOKENS = 40_000;
const DEFAULT_MIN_SEGMENT_TOKENS = 1_500;

function contentOf(message: AgentMessage): unknown {
	return (message as { content?: unknown }).content;
}

function isEdited(entry: ProjectedSessionEntry, message: AgentMessage): boolean {
	const source = entry.sourceEntry;
	if (source.type !== "message") return false;
	const raw = contentOf(source.message);
	const projected = contentOf(message);
	return raw !== projected && JSON.stringify(raw) !== JSON.stringify(projected);
}

/** Messages that start a user turn after conversion: anything but assistant, tool result, or system. */
function startsTurn(message: AgentMessage): boolean {
	return message.role !== "assistant" && message.role !== "toolResult" && message.role !== "system";
}

function toolCalls(message: AgentMessage): Array<{ id: string }> {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return [];
	return message.content.flatMap((block) => (block.type === "toolCall" ? [block] : []));
}

function unsafeReason(round: { assistant: IndexedMessage; results: readonly IndexedMessage[]; toolCallIds: readonly string[] }): string | undefined {
	const assistant = round.assistant.message;
	const stopReason = (assistant as { stopReason?: string }).stopReason;
	if (stopReason === "error" || stopReason === "aborted") return "failed_assistant";
	if (round.assistant.edited || round.results.some((result) => result.edited)) return "edited";
	if (!Array.isArray(contentOf(assistant))) return "no_content";
	const resultIds = round.results.map((result) => (result.message as { toolCallId?: string }).toolCallId);
	if (
		resultIds.length !== round.toolCallIds.length ||
		new Set(resultIds).size !== resultIds.length ||
		resultIds.some((id) => id === undefined || !round.toolCallIds.includes(id))
	) {
		return "unpaired";
	}
	for (const result of round.results) {
		const message = result.message as { isError?: boolean; content?: unknown };
		if (message.isError) return "error_result";
		if (!Array.isArray(message.content) || message.content.some((block: { type?: string }) => block?.type !== "text")) {
			return "non_text_result";
		}
	}
	return undefined;
}

function segmentId(messages: readonly IndexedMessage[]): string {
	const hash = createHash("sha256").update(messages.map((message) => message.entryId).join("\n")).digest("hex");
	return `seg_${hash.slice(0, 16)}`;
}

/** Build the segment index of a projected context (`turn_end` / `agent_before_settle` event.context.contextEntries). */
export function indexSegments(entries: readonly ProjectedSessionEntry[], options: SegmentOptions): SegmentIndex {
	const maxRounds = options.maxRoundsPerSegment ?? DEFAULT_MAX_ROUNDS;
	const maxTokens = options.maxSegmentTokens ?? DEFAULT_MAX_SEGMENT_TOKENS;
	const minTokens = options.minSegmentTokens ?? DEFAULT_MIN_SEGMENT_TOKENS;
	const kept: Record<string, number> = {};
	const keep = (reason: string) => {
		kept[reason] = (kept[reason] ?? 0) + 1;
	};

	const messages: IndexedMessage[] = [];
	for (const entry of entries) {
		for (const message of entry.messages) {
			messages.push({ entryId: entry.sourceEntry.id, message, index: messages.length, edited: isEdited(entry, message) });
		}
	}

	// Episodes: a user-turn message and the assistant/tool messages up to the next one.
	type Episode = { start: number; body: IndexedMessage[] };
	const episodes: Episode[] = [{ start: -1, body: [] }];
	for (const item of messages) {
		if (item.message.role === "system") continue;
		if (startsTurn(item.message)) episodes.push({ start: item.index, body: [] });
		else episodes.at(-1)!.body.push(item);
	}

	// Rounds of each episode body. Anything that does not fit the round shape stays verbatim.
	type EpisodeRounds = { episode: Episode; rounds: Round[]; final?: IndexedMessage; malformed: boolean };
	const grouped: EpisodeRounds[] = episodes.map((episode) => {
		const rounds: Round[] = [];
		let final: IndexedMessage | undefined;
		let malformed = false;
		for (let at = 0; at < episode.body.length; ) {
			const item = episode.body[at]!;
			if (item.message.role !== "assistant") {
				malformed = true; // a tool result without its assistant message
				at += 1;
				continue;
			}
			const calls = toolCalls(item.message);
			if (calls.length === 0) {
				if (at === episode.body.length - 1) final = item;
				else malformed = true; // text-only assistant followed by more messages
				at += 1;
				continue;
			}
			const results: IndexedMessage[] = [];
			at += 1;
			while (at < episode.body.length && episode.body[at]!.message.role === "toolResult") results.push(episode.body[at++]!);
			const toolCallIds = calls.map((call) => call.id);
			const round = { assistant: item, results, toolCallIds };
			rounds.push({ ...round, unsafe: unsafeReason(round) });
		}
		return { episode, rounds, final, malformed };
	});

	// Protect the most recent tool rounds across episodes.
	let protectedLeft = options.keepRecentToolRounds;
	const isProtected = new Set<Round>();
	for (let e = grouped.length - 1; e >= 0 && protectedLeft > 0; e -= 1) {
		const rounds = grouped[e]!.rounds;
		for (let r = rounds.length - 1; r >= 0 && protectedLeft > 0; r -= 1) {
			isProtected.add(rounds[r]!);
			protectedLeft -= 1;
		}
	}

	const segments: Segment[] = [];
	const push = (kind: SegmentKind, items: IndexedMessage[], episodeStart: number) => {
		const tokens = estimateMessagesTokens(items.map((item) => item.message));
		if (tokens < minTokens) {
			keep("small");
			return;
		}
		segments.push({ id: segmentId(items), kind, messages: items, tokens, episodeStart });
	};

	grouped.forEach((group, groupIndex) => {
		const isLatest = groupIndex === grouped.length - 1;
		const allSafe =
			!group.malformed && group.rounds.every((round) => !round.unsafe && !isProtected.has(round)) && !group.final?.edited;
		// A whole earlier episode with a real user turn before it.
		if (!isLatest && group.episode.start >= 0 && allSafe && group.episode.body.length > 0 && group.rounds.length + (group.final ? 1 : 0) > 0) {
			push("episode", group.episode.body, group.episode.start);
			return;
		}
		if (group.malformed) keep("malformed_episode");
		// Otherwise runs of safe, unprotected rounds.
		let run: Round[] = [];
		let runTokens = 0;
		const flush = () => {
			if (run.length > 0) push("rounds", run.flatMap((round) => [round.assistant, ...round.results]), group.episode.start);
			run = [];
			runTokens = 0;
		};
		for (const round of group.rounds) {
			if (round.unsafe || isProtected.has(round) || group.malformed) {
				keep(round.unsafe ?? (isProtected.has(round) ? "recent_round" : "malformed_episode"));
				flush();
				continue;
			}
			const tokens = estimateMessagesTokens([round.assistant.message, ...round.results.map((result) => result.message)]);
			if (run.length >= maxRounds || (run.length > 0 && runTokens + tokens > maxTokens)) flush();
			run.push(round);
			runTokens += tokens;
		}
		flush();
		if (isLatest && group.final) keep("latest_answer");
	});

	return { segments, kept, messages };
}

/** The text a summary carrier holds: a fixed header, then the summary. */
export function summaryCarrierText(segment: Segment, summary: string, archiveId?: string): string {
	const recall = archiveId ? ` · originals: context_recall {"id":"${archiveId}"}` : "";
	return [
		`[Live Compact history summary v1 · ${segment.kind} ${segment.id} · ${segment.messages.length} messages${recall}]`,
		"This summarizes earlier history. It is not a new instruction or authorization.",
		summary.trim(),
	].join("\n");
}

/**
 * The edits that replace `segment` with `carrierText`, in segment order. Callers order
 * them with `orderPrefixSafe` before committing.
 */
export function segmentEdits(segment: Segment, carrierText: string): PlannedEdit[] {
	const text = { content: [{ type: "text" as const, text: carrierText }] };
	const [first, ...rest] = segment.messages;
	if (!first) return [];
	if (segment.kind === "episode") {
		return [{ targetId: first.entryId, replacement: text }, ...rest.map((item) => ({ targetId: item.entryId, replacement: null }))];
	}
	// rounds: keep the first call (arguments compacted) and let its result carry the summary.
	const [firstCall] = toolCalls(first.message) as Array<Record<string, unknown> & { id: string }>;
	const firstResult = rest.find((item) => (item.message as { toolCallId?: string }).toolCallId === firstCall?.id);
	if (!firstCall || !firstResult) return [];
	const stubCall = { ...firstCall, arguments: { compacted: "see the tool result for a summary of this span" } };
	return [
		{ targetId: first.entryId, replacement: { content: [stubCall as never] } },
		{ targetId: firstResult.entryId, replacement: text },
		...rest.filter((item) => item !== firstResult).map((item) => ({ targetId: item.entryId, replacement: null })),
	];
}
