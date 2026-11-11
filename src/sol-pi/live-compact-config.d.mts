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

export interface LiveCompactConfig {
	readonly enabled: boolean;
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
}

export declare const DEFAULT_LIVE_COMPACT_CONFIG: LiveCompactConfig;

/** Validate the `liveCompact` object of `sol-pi.json` and apply defaults; throws naming the offending path. */
export declare function parseLiveCompactConfig(value: unknown): LiveCompactConfig;

/** Cross-field rules between `liveCompact` and the effective top-level SoL-Pi switches. */
export declare function checkLiveCompactCombination(
	liveCompact: LiveCompactConfig,
	features: { readonly observationPack: boolean; readonly evidencePreservingReducer: boolean },
): void;
