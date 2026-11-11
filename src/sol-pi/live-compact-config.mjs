/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
/**
 * Live Compact configuration: the single schema shared by the runtime loader
 * (`config.ts`) and the CLI preflight (`scripts/check-sol-pi-config.mjs`).
 *
 * Plain JavaScript with no imports, so it runs unchanged from a checkout, from an
 * installed npm package under node_modules (where Node does not strip types),
 * and inside Pi. Types live in live-compact-config.d.mts; keep the two in step.
 *
 * See docs/live-compact-config-plan.md for field semantics.
 */
const MAX_TIMEOUT_MS = 1_800_000;
export const DEFAULT_LIVE_COMPACT_CONFIG = deepFreeze({
	enabled: false,
	thresholds: { startRatio: 0.7, targetRatio: 0.7, ceilingRatio: 0.8 },
	protection: { keepRecentToolRounds: 3, minFullRequests: 2 },
	observation: { minBytes: 10_240, excerptTargetBytes: 8_192 },
	summary: { maxOutputTokens: "auto", timeoutMs: 120_000 },
	verification: { maxOutputTokens: "auto", timeoutMs: 120_000 },
	background: { enabled: false, maxConcurrentJobs: 1, jobTimeoutMs: 300_000, foregroundWaitMs: 15_000 },
	limits: { maxRegenerations: 1, batchBudgetMs: 50, maxCandidatesPerPass: 8 },
	budget: { extraReserveTokens: 0 },
});
const bool = { kind: "boolean" };
const ratio = { kind: "ratio" };
const int = (min, max) => ({ kind: "integer", min, max });
const callShape = {
	provider: { kind: "routePart" },
	model: { kind: "routePart" },
	maxOutputTokens: { kind: "outputTokens" },
	timeoutMs: int(1_000, MAX_TIMEOUT_MS),
};
const GROUPS = {
	thresholds: { startRatio: ratio, targetRatio: ratio, ceilingRatio: ratio },
	protection: { keepRecentToolRounds: int(1, 100), minFullRequests: int(1, 20) },
	observation: {
		minBytes: int(1, 64 * 1024 * 1024),
		excerptTargetBytes: int(1, 1024 * 1024),
	},
	summary: callShape,
	verification: callShape,
	background: {
		enabled: bool,
		maxConcurrentJobs: int(1, 4),
		jobTimeoutMs: int(1_000, MAX_TIMEOUT_MS),
		foregroundWaitMs: int(0, MAX_TIMEOUT_MS),
	},
	limits: {
		maxRegenerations: int(0, 2),
		batchBudgetMs: int(1, 1_000),
		maxCandidatesPerPass: int(1, 100),
	},
	budget: { extraReserveTokens: int(0, Number.MAX_SAFE_INTEGER) },
};
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function checkField(path, field, value) {
	switch (field.kind) {
		case "boolean":
			if (typeof value !== "boolean")
				throw new Error(`${path} must be boolean`);
			return value;
		case "ratio":
			if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value >= 1) {
				throw new Error(`${path} must be a finite number between 0 and 1 (exclusive); 0.7 means 70%`);
			}
			return value;
		case "integer":
			if (typeof value !== "number" || !Number.isSafeInteger(value) || value < field.min || value > field.max) {
				throw new Error(`${path} must be an integer from ${field.min} to ${field.max}`);
			}
			return value;
		case "outputTokens":
			if (value === "auto")
				return value;
			if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
				throw new Error(`${path} must be "auto" or a positive integer`);
			}
			return value;
		case "routePart":
			if (typeof value !== "string" || value.trim().length === 0) {
				throw new Error(`${path} must be a non-empty string`);
			}
			return value.trim();
		default:
			throw new Error(`${path} has no known schema`);
	}
}
/**
 * Validate the `liveCompact` object of `sol-pi.json` and apply defaults.
 * Throws an Error whose message names the offending `liveCompact.*` path.
 */
export function parseLiveCompactConfig(value) {
	if (value === undefined)
		return DEFAULT_LIVE_COMPACT_CONFIG;
	if (!isRecord(value))
		throw new Error("liveCompact must be a JSON object");
	const result = {};
	for (const key of Object.keys(value)) {
		if (key !== "enabled" && !Object.hasOwn(GROUPS, key))
			throw new Error(`Unknown key: liveCompact.${key}`);
	}
	result.enabled = value.enabled === undefined ? false : checkField("liveCompact.enabled", bool, value.enabled);
	for (const [group, shape] of Object.entries(GROUPS)) {
		const defaults = DEFAULT_LIVE_COMPACT_CONFIG[group];
		const configured = value[group];
		if (configured === undefined) {
			result[group] = defaults;
			continue;
		}
		if (!isRecord(configured))
			throw new Error(`liveCompact.${group} must be a JSON object`);
		const parsed = { ...defaults };
		for (const key of Object.keys(configured)) {
			// Own keys only: `constructor`, `toString`, or `__proto__` must not resolve to Object.prototype.
			const field = Object.hasOwn(shape, key) ? shape[key] : undefined;
			if (!field)
				throw new Error(`Unknown key: liveCompact.${group}.${key}`);
			parsed[key] = checkField(`liveCompact.${group}.${key}`, field, configured[key]);
		}
		result[group] = parsed;
	}
	const config = result;
	const { startRatio, targetRatio, ceilingRatio } = config.thresholds;
	if (!(targetRatio <= startRatio && startRatio < ceilingRatio)) {
		throw new Error("liveCompact.thresholds must satisfy 0 < targetRatio <= startRatio < ceilingRatio < 1 " +
			`(got target ${targetRatio}, start ${startRatio}, ceiling ${ceilingRatio})`);
	}
	for (const name of ["summary", "verification"]) {
		const route = config[name];
		if ((route.provider === undefined) !== (route.model === undefined)) {
			throw new Error(`liveCompact.${name}.provider and liveCompact.${name}.model must be set together or both omitted`);
		}
	}
	if (config.background.foregroundWaitMs > config.background.jobTimeoutMs) {
		throw new Error("liveCompact.background.foregroundWaitMs must not exceed liveCompact.background.jobTimeoutMs");
	}
	if (config.background.enabled) {
		throw new Error("liveCompact.background.enabled is not supported by this SoL-Pi build yet; keep it false");
	}
	return deepFreeze(config);
}
/**
 * Cross-field rules between `liveCompact` and the top-level SoL-Pi switches.
 * `features` holds the effective boolean switches.
 */
export function checkLiveCompactCombination(liveCompact, features) {
	if (!liveCompact.enabled)
		return;
	if (!features.observationPack) {
		throw new Error("liveCompact.enabled requires observationPack: true (Live Compact archives and recalls through it)");
	}
	if (features.evidencePreservingReducer) {
		throw new Error("liveCompact.enabled cannot be combined with evidencePreservingReducer: true in this build; " +
			"the reducer shrinks tool results regardless of context pressure");
	}
}
function deepFreeze(value) {
	if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
		for (const nested of Object.values(value))
			deepFreeze(nested);
		Object.freeze(value);
	}
	return value;
}
