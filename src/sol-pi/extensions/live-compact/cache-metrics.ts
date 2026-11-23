/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
/**
 * Prompt-cache observability and diagnostics for Ambient Compact (`dynamic-ai`).
 *
 * Computes weighted cache hit rates from the working model's recorded `usage`
 * on the active session branch, separating:
 * - overall working-model weighted hit rate (`Σ cacheRead / Σ totalInput`);
 * - recent window weighted hit rate (last 20 working-model requests);
 * - stable-version hit rate (requests that did not immediately follow a compaction
 *   batch activation or a long idle gap);
 * - post-compaction first-request hit rate (how much of the prefix stayed cached
 *   on the very first request after a batch was committed/activated).
 */
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { BATCH_BEGIN, BATCH_END, type BatchBegin } from "./commit.ts";

export interface UsageTotals {
	readonly requests: number;
	readonly inputTokens: number;
	readonly cacheReadTokens: number;
	readonly cacheWriteTokens: number;
	readonly totalInputTokens: number;
	/** Weighted ratio `cacheReadTokens / totalInputTokens`, or `undefined` when `totalInputTokens === 0`. */
	readonly hitRatio: number | undefined;
}

export interface BatchCacheImpact {
	readonly batchId: string;
	readonly earliestTargetIndex: number | undefined;
	readonly totalEntriesAtCommit: number;
	/** Hit ratio on the very first working request after the batch took effect, when observed. */
	readonly firstRequestHitRatio: number | undefined;
	readonly firstRequestCacheRead: number | undefined;
	readonly firstRequestTotalInput: number | undefined;
}

export interface CacheMetricsSummary {
	readonly overall: UsageTotals;
	readonly recent20: UsageTotals;
	readonly stableRun: UsageTotals;
	readonly postCompaction: UsageTotals;
	readonly lastBatchImpact: BatchCacheImpact | undefined;
}

type RequestSample = {
	readonly entryIndex: number;
	readonly timestampMs: number | undefined;
	readonly input: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly total: number;
	readonly afterBatchId: string | undefined;
	readonly idleMs: number | undefined;
};

const IDLE_GAP_MS = 5 * 60 * 1_000;

function summarizeSamples(samples: readonly RequestSample[]): UsageTotals {
	let inputTokens = 0;
	let cacheReadTokens = 0;
	let cacheWriteTokens = 0;
	for (const sample of samples) {
		inputTokens += sample.input;
		cacheReadTokens += sample.cacheRead;
		cacheWriteTokens += sample.cacheWrite;
	}
	const totalInputTokens = inputTokens + cacheReadTokens + cacheWriteTokens;
	return {
		requests: samples.length,
		inputTokens,
		cacheReadTokens,
		cacheWriteTokens,
		totalInputTokens,
		hitRatio: totalInputTokens > 0 ? cacheReadTokens / totalInputTokens : undefined,
	};
}

function parseTimestampMs(entry: SessionEntry): number | undefined {
	const raw = (entry as { timestamp?: unknown }).timestamp;
	if (typeof raw === "string") {
		const parsed = Date.parse(raw);
		if (Number.isFinite(parsed)) return parsed;
	}
	const msgTs =
		entry.type === "message" ? (entry.message as { timestamp?: unknown } | undefined)?.timestamp : undefined;
	if (typeof msgTs === "number" && Number.isFinite(msgTs)) return msgTs;
	return undefined;
}

export function computeCacheMetrics(branch: readonly SessionEntry[]): CacheMetricsSummary {
	const indexById = new Map<string, number>();
	branch.forEach((entry, index) => {
		if (typeof entry.id === "string") indexById.set(entry.id, index);
	});

	const samples: RequestSample[] = [];
	const batchActivationIndex = new Map<string, { index: number; earliestTargetIndex: number | undefined }>();
	let pendingBatchForNextRequest: string | undefined;
	let previousResponseTs: number | undefined;

	for (let index = 0; index < branch.length; index += 1) {
		const entry = branch[index]!;
		if (entry.type === "custom" && entry.customType === BATCH_BEGIN) {
			const data = entry.data as Partial<BatchBegin> | undefined;
			const batchId = typeof data?.batchId === "string" ? data.batchId : `batch_${index}`;
			const edits = Array.isArray(data?.edits) ? data.edits : [];
			const targetIndices = edits
				.map((edit) => indexById.get(edit.targetId))
				.filter((idx): idx is number => idx !== undefined)
				.sort((a, b) => a - b);
			batchActivationIndex.set(batchId, {
				index,
				earliestTargetIndex: targetIndices[0],
			});
			pendingBatchForNextRequest = batchId;
			continue;
		}
		if (entry.type === "custom" && entry.customType === BATCH_END) {
			const data = entry.data as { batchId?: unknown } | undefined;
			const batchId = typeof data?.batchId === "string" ? data.batchId : undefined;
			if (batchId && !batchActivationIndex.has(batchId)) {
				batchActivationIndex.set(batchId, { index, earliestTargetIndex: undefined });
				pendingBatchForNextRequest = batchId;
			}
			continue;
		}
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const usage = (
			entry.message as unknown as {
				usage?: { input?: unknown; cacheRead?: unknown; cacheWrite?: unknown };
			}
		).usage;
		if (!usage) continue;
		const input = typeof usage.input === "number" && Number.isFinite(usage.input) ? Math.max(0, usage.input) : 0;
		const cacheRead =
			typeof usage.cacheRead === "number" && Number.isFinite(usage.cacheRead) ? Math.max(0, usage.cacheRead) : 0;
		const cacheWrite =
			typeof usage.cacheWrite === "number" && Number.isFinite(usage.cacheWrite) ? Math.max(0, usage.cacheWrite) : 0;
		const total = input + cacheRead + cacheWrite;
		if (total <= 0) continue;

		const ts = parseTimestampMs(entry);
		const idleMs = ts !== undefined && previousResponseTs !== undefined ? Math.max(0, ts - previousResponseTs) : undefined;
		samples.push({
			entryIndex: index,
			timestampMs: ts,
			input,
			cacheRead,
			cacheWrite,
			total,
			afterBatchId: pendingBatchForNextRequest,
			idleMs,
		});
		pendingBatchForNextRequest = undefined;
		if (ts !== undefined) previousResponseTs = ts;
	}

	const overall = summarizeSamples(samples);
	const recent20 = summarizeSamples(samples.slice(-20));
	const postCompactionSamples = samples.filter((sample) => sample.afterBatchId !== undefined);
	const stableSamples = samples.filter(
		(sample) => sample.afterBatchId === undefined && (sample.idleMs === undefined || sample.idleMs < IDLE_GAP_MS),
	);

	let lastBatchImpact: BatchCacheImpact | undefined;
	const lastBatchEntry = [...batchActivationIndex.entries()].at(-1);
	if (lastBatchEntry) {
		const [batchId, meta] = lastBatchEntry;
		const firstAfter = samples.find((sample) => sample.afterBatchId === batchId);
		lastBatchImpact = {
			batchId,
			earliestTargetIndex: meta.earliestTargetIndex,
			totalEntriesAtCommit: meta.index,
			firstRequestHitRatio: firstAfter ? firstAfter.cacheRead / firstAfter.total : undefined,
			firstRequestCacheRead: firstAfter?.cacheRead,
			firstRequestTotalInput: firstAfter?.total,
		};
	}

	return {
		overall,
		recent20,
		stableRun: summarizeSamples(stableSamples),
		postCompaction: summarizeSamples(postCompactionSamples),
		lastBatchImpact,
	};
}

function formatPct(ratio: number | undefined): string {
	if (ratio === undefined || !Number.isFinite(ratio)) return "n/a";
	return `${(ratio * 100).toFixed(1)}%`;
}

export function formatCacheMetricsLine(metrics: CacheMetricsSummary): string {
	if (metrics.overall.requests === 0) {
		return "cache: no provider usage recorded yet";
	}
	const parts = [
		`overall ${formatPct(metrics.overall.hitRatio)} (${metrics.overall.requests} reqs)`,
		`recent-20 ${formatPct(metrics.recent20.hitRatio)}`,
		`stable ${formatPct(metrics.stableRun.hitRatio)}`,
	];
	if (metrics.postCompaction.requests > 0) {
		parts.push(`post-compact 1st-req ${formatPct(metrics.postCompaction.hitRatio)} (${metrics.postCompaction.requests})`);
	}
	if (metrics.lastBatchImpact?.earliestTargetIndex !== undefined && metrics.lastBatchImpact.totalEntriesAtCommit > 0) {
		const prefixShare = Math.round(
			(metrics.lastBatchImpact.earliestTargetIndex / metrics.lastBatchImpact.totalEntriesAtCommit) * 100,
		);
		parts.push(`last edit at ~${prefixShare}% of history`);
	}
	return `cache: ${parts.join(" · ")}`;
}
