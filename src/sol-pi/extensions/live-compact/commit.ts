/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
/**
 * Batched history edits with crash detection, through Pi's public boundary API.
 *
 * Pi validates a whole boundary proposal before it appends anything, so a
 * semantically invalid batch changes nothing. Appending is not transactional,
 * though: an I/O failure or a crash can persist only a prefix of the batch. A
 * batch is therefore written as
 *
 *   begin marker (with the full intended edit list) → ordered context edits → end marker
 *
 * and ordered so that every prefix leaves a provider-valid context: omitted tool
 * results first, then omitted assistant messages, then content replacements.
 * Replacing a tool-calling assistant message with text removes its calls, so
 * their results must already be gone. A prefix can leave a tool call without
 * its result (pi-ai then sends a synthetic error result for it) but never a
 * result without its call, nor two assistant messages in a row.
 * A begin marker without its end marker is an incomplete batch; the next
 * boundary appends the remaining edits and the end marker.
 */
import type { ContextEditEntryDraft, SessionBoundaryDraft, SessionEntry } from "@earendil-works/pi-coding-agent";

export const BATCH_BEGIN = "sol-pi-live-compact-batch-begin";
export const BATCH_END = "sol-pi-live-compact-batch-end";
export const BATCH_FORMAT_VERSION = 1;

export interface PlannedEdit {
	readonly targetId: string;
	/** `null` omits the target from model context. */
	readonly replacement: ContextEditEntryDraft["replacement"];
}

export interface BatchBegin {
	readonly v: typeof BATCH_FORMAT_VERSION;
	readonly batchId: string;
	readonly edits: readonly PlannedEdit[];
	/** Caller data kept with the batch, for example which archive holds which entries. */
	readonly meta?: unknown;
}

export interface BatchEnd {
	readonly v: typeof BATCH_FORMAT_VERSION;
	readonly batchId: string;
	readonly count: number;
	/** Set when a later boundary completed an interrupted batch. */
	readonly recovered?: boolean;
}

type TargetRole = "assistant" | "toolResult" | "user" | "custom" | undefined;

function roleOf(entry: SessionEntry | undefined): TargetRole {
	if (!entry) return undefined;
	if (entry.type === "custom_message") return "custom";
	if (entry.type !== "message") return undefined;
	const role = entry.message.role;
	return role === "assistant" || role === "toolResult" || role === "user" ? role : undefined;
}

/**
 * Edits in prefix-safe order: omitted tool results, then omitted assistant
 * messages, then replacements, then other omissions. The input order is kept
 * within each group.
 */
export function orderPrefixSafe(
	edits: readonly PlannedEdit[],
	entryById: (id: string) => SessionEntry | undefined,
): PlannedEdit[] {
	const rank = (edit: PlannedEdit): number => {
		const role = roleOf(entryById(edit.targetId));
		if (edit.replacement === null && role === "toolResult") return 0;
		if (edit.replacement === null && role === "assistant") return 1;
		if (edit.replacement !== null) return 2;
		return 3;
	};
	return edits
		.map((edit, index) => ({ edit, index, rank: rank(edit) }))
		.sort((left, right) => left.rank - right.rank || left.index - right.index)
		.map(({ edit }) => edit);
}

function editDraft(edit: PlannedEdit): ContextEditEntryDraft {
	return { type: "context_edit", targetId: edit.targetId, replacement: edit.replacement };
}

/** Boundary drafts for one batch: begin marker, the edits in the given order, end marker. */
export function batchDrafts(batchId: string, orderedEdits: readonly PlannedEdit[], meta?: unknown): SessionBoundaryDraft[] {
	const begin: BatchBegin = { v: BATCH_FORMAT_VERSION, batchId, edits: orderedEdits, ...(meta === undefined ? {} : { meta }) };
	const end: BatchEnd = { v: BATCH_FORMAT_VERSION, batchId, count: orderedEdits.length };
	return [
		{ type: "custom", customType: BATCH_BEGIN, data: begin },
		...orderedEdits.map(editDraft),
		{ type: "custom", customType: BATCH_END, data: end },
	];
}

export interface IncompleteBatch {
	readonly batchId: string;
	readonly edits: readonly PlannedEdit[];
	/** Edits already on the branch, in batch order. */
	readonly landed: readonly PlannedEdit[];
	/** Edits still to append, in batch order. */
	readonly remaining: readonly PlannedEdit[];
}

function customData<T>(entry: SessionEntry, customType: string): T | undefined {
	return entry.type === "custom" && entry.customType === customType ? (entry.data as T) : undefined;
}

function sameReplacement(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Batches on `branch` whose begin marker has no end marker. An edit counts as
 * landed when the branch holds a matching context edit after the begin marker.
 * The landed edits form a prefix of the batch, as Pi appends in order.
 */
export function findIncompleteBatches(branch: readonly SessionEntry[]): IncompleteBatch[] {
	const ended = new Set<string>();
	for (const entry of branch) {
		const end = customData<BatchEnd>(entry, BATCH_END);
		if (end?.v === BATCH_FORMAT_VERSION) ended.add(end.batchId);
	}
	const incomplete: IncompleteBatch[] = [];
	branch.forEach((entry, beginIndex) => {
		const begin = customData<BatchBegin>(entry, BATCH_BEGIN);
		if (begin?.v !== BATCH_FORMAT_VERSION || ended.has(begin.batchId)) return;
		const later = branch.slice(beginIndex + 1);
		let landedCount = 0;
		for (const edit of begin.edits) {
			const found = later.some(
				(candidate) =>
					candidate.type === "context_edit" &&
					candidate.targetId === edit.targetId &&
					sameReplacement(candidate.replacement, edit.replacement),
			);
			if (!found) break;
			landedCount += 1;
		}
		incomplete.push({
			batchId: begin.batchId,
			edits: begin.edits,
			landed: begin.edits.slice(0, landedCount),
			remaining: begin.edits.slice(landedCount),
		});
	});
	return incomplete;
}

/** Drafts that finish an interrupted batch: the remaining edits, then a recovered end marker. */
export function completionDrafts(batch: IncompleteBatch): SessionBoundaryDraft[] {
	const end: BatchEnd = { v: BATCH_FORMAT_VERSION, batchId: batch.batchId, count: batch.edits.length, recovered: true };
	return [...batch.remaining.map(editDraft), { type: "custom", customType: BATCH_END, data: end }];
}
