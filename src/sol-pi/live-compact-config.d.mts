/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
/** Types for live-compact-config.mjs. See docs/live-compact-config-plan.md. */

export type OutputTokenLimit = "auto" | number;

export interface LiveCompactModelRoute {
	/** Both omitted: follow the working model. */
	readonly provider?: string;
	readonly model?: string;
}

export interface LiveCompactCallConfig extends LiveCompactModelRoute {
	readonly maxOutputTokens: OutputTokenLimit;
	readonly timeoutMs: number;
}

/** `local-tools`: P1 tool-result condensing. `dynamic-ai`: global AI maintenance (docs/live-compact-dynamic-plan.md). */
export type LiveCompactStrategy = "local-tools" | "dynamic-ai";

export declare const LIVE_COMPACT_STRATEGIES: readonly LiveCompactStrategy[];
export declare const DYNAMIC_DEFAULT_TARGET_RATIO: number;
export interface LiveCompactConfig {
	readonly enabled: boolean;
	readonly strategy: LiveCompactStrategy;
	readonly thresholds: {
		readonly startRatio: number;
		readonly targetRatio: number;
		readonly ceilingRatio: number;
	};
	readonly protection: {
		readonly keepRecentToolRounds: number;
		readonly minFullRequests: number;
	};
	readonly observation: {
		readonly minBytes: number;
		readonly excerptTargetBytes: number;
	};
	readonly summary: LiveCompactCallConfig;
	readonly verification: LiveCompactCallConfig;
	readonly background: {
		readonly enabled: boolean;
		readonly maxConcurrentJobs: number;
		readonly jobTimeoutMs: number;
		readonly foregroundWaitMs: number;
	};
	readonly limits: {
		readonly maxRegenerations: number;
		readonly batchBudgetMs: number;
		readonly maxCandidatesPerPass: number;
	};
	readonly budget: {
		readonly extraReserveTokens: number;
	};
	/** dynamic-ai only: when a maintenance cycle may call the models. */
	readonly maintenance: {
		/** Least reclaim worth a normal cycle, as a share of the context window. */
		readonly minSavingsRatio: number;
		/** Real work requests between attempts. */
		readonly cooldownRequests: number;
		/** After a failed or unprofitable attempt, the growth (share of the window) needed before retrying. */
		readonly retryGrowthRatio: number;
		/** Model calls per cycle: generation and verification, including regenerations. */
		readonly maxCallsPerCycle: number;
		/** Total time for one cycle's model calls, including retries. */
		readonly timeoutMs: number;
	};
}

export declare const DEFAULT_LIVE_COMPACT_CONFIG: LiveCompactConfig;

/** Validate the `liveCompact` object of `sol-pi.json` and apply defaults; throws naming the offending path. */
export declare function parseLiveCompactConfig(value: unknown): LiveCompactConfig;

/** Cross-field rules between `liveCompact` and the effective top-level SoL-Pi switches. */
export declare function checkLiveCompactCombination(
	liveCompact: LiveCompactConfig,
	features: { readonly observationPack: boolean; readonly evidencePreservingReducer: boolean },
): void;
