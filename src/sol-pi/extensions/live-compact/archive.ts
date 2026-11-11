/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
/**
 * Content-addressed archive of summarized history segments, read back by
 * `context_recall`.
 *
 * The archive text is the deterministic transcript of the raw messages of a
 * segment. Its id is derived from the text, so a fork, clone, or moved session
 * whose archive file is missing rebuilds the text from the raw entries on its
 * own branch, named by the batch marker, and accepts it only when the hash
 * matches. Nothing is looked up in other sessions.
 */
import { join } from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { countLines, ensureStored, hash, type Observation } from "../observation-pack/observation.ts";
import { BATCH_BEGIN, type BatchBegin } from "./commit.ts";
import { renderMessages } from "./planner.ts";
import { estimateTextTokens } from "./budget.ts";

export const CONTEXT_ARCHIVE_PATTERN = /^ctx_[a-f0-9]{24}$/u;

/** Batch metadata: which archive holds which raw entries. */
export interface ArchivedSegment {
	readonly archiveId: string;
	readonly segmentId: string;
	readonly entryIds: readonly string[];
}

export interface BatchMeta {
	readonly segments: readonly ArchivedSegment[];
}

export function contextArchivePath(runtimeRoot: string, id: string): string {
	return join(runtimeRoot, "live-compact", "segments", `${id}.txt`);
}

export function contextArchiveId(text: string): string {
	return `ctx_${hash(text).slice(0, 24)}`;
}

/** The archive object for `text`, in the shape the content-addressed store writes. */
export function contextArchiveObject(runtimeRoot: string, text: string): Observation {
	const id = contextArchiveId(text);
	return {
		id,
		contentHash: hash(text),
		filePath: contextArchivePath(runtimeRoot, id),
		toolName: "live-compact",
		text,
		bytes: Buffer.byteLength(text, "utf8"),
		lines: countLines(text),
		tokens: estimateTextTokens(text),
	};
}

/** Store `text` (idempotent; an existing object is verified byte for byte) and return its id. */
export async function archiveText(runtimeRoot: string, text: string): Promise<string> {
	const object = contextArchiveObject(runtimeRoot, text);
	await ensureStored(object);
	return object.id;
}

/** The archive text of raw entries, rendered as at archive time. Undefined when an entry is missing. */
export function renderRawEntries(branch: readonly SessionEntry[], entryIds: readonly string[]): string | undefined {
	const byId = new Map(branch.map((entry) => [entry.id, entry]));
	const items = [];
	for (const entryId of entryIds) {
		const entry = byId.get(entryId);
		if (!entry || entry.type !== "message") return undefined;
		items.push({ entryId, message: entry.message });
	}
	return renderMessages(items);
}

/**
 * Re-archive `id` from the current branch: find the batch that archived it, render its
 * raw entries, and store the text only when it hashes to `id`.
 */
export async function rebuildArchive(runtimeRoot: string, branch: readonly SessionEntry[], id: string): Promise<boolean> {
	for (const entry of branch) {
		if (entry.type !== "custom" || entry.customType !== BATCH_BEGIN) continue;
		const meta = (entry.data as BatchBegin | undefined)?.meta as BatchMeta | undefined;
		const archived = meta?.segments?.find((segment) => segment.archiveId === id);
		if (!archived) continue;
		const text = renderRawEntries(branch, archived.entryIds);
		if (text === undefined || contextArchiveId(text) !== id) return false;
		await ensureStored(contextArchiveObject(runtimeRoot, text));
		return true;
	}
	return false;
}
