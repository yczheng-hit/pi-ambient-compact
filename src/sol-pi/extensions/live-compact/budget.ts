/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
/**
 * Live Compact budget arithmetic: token estimates, provider-usage calibration,
 * and the start / target / ceiling water levels bounded by the safe input limit.
 *
 * Everything here is a pure function. Estimates are deliberately conservative
 * character counts (4 characters per token, images at a fixed cost) scaled by a
 * calibration ratio learned from real provider usage.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { LiveCompactConfig } from "../../live-compact-config.mjs";

export const CHARS_PER_TOKEN = 4;
/** Pi's own estimator charges an image as 4800 characters (1200 tokens). */
export const IMAGE_CHARS = 4_800;
/** Per-message framing (role, separators) not visible in content. */
const MESSAGE_OVERHEAD_CHARS = 16;
/** Output reserve used when the model declares no maxTokens; matches Pi's default compaction reserve. */
export const DEFAULT_OUTPUT_RESERVE_TOKENS = 16_384;
/** Upper bound on the output reserve, so a model's huge maxTokens cannot consume the window. */
export const MAX_OUTPUT_RESERVE_TOKENS = 32_768;
/** Automatic margin for tokenizer differences and late declarations, as a share of the window. */
export const AUTO_MARGIN_RATIO = 0.02;
export const MIN_CALIBRATION = 0.5;
export const MAX_CALIBRATION = 3;

function contentChars(content: unknown): number {
	if (typeof content === "string") return content.length;
	if (!Array.isArray(content)) return 0;
	let chars = 0;
	for (const block of content as Array<Record<string, unknown>>) {
		switch (block?.type) {
			case "text":
				chars += typeof block.text === "string" ? block.text.length : 0;
				break;
			case "thinking":
				chars += typeof block.thinking === "string" ? block.thinking.length : 0;
				break;
			case "toolCall":
				chars += String(block.name ?? "").length + JSON.stringify(block.arguments ?? {}).length;
				break;
			case "image":
				chars += IMAGE_CHARS;
				break;
			default:
				chars += JSON.stringify(block ?? null).length;
		}
	}
	return chars;
}

/** Estimated provider-visible characters of one projected message. */
export function estimateMessageChars(message: AgentMessage): number {
	const record = message as unknown as Record<string, unknown>;
	let chars = MESSAGE_OVERHEAD_CHARS + contentChars(record.content);
	for (const key of ["summary", "command", "output"] as const) {
		if (typeof record[key] === "string") chars += (record[key] as string).length;
	}
	// Pi >= 1.5 keeps the system prompt text in `sections`, as Pi's own estimator counts it.
	if (typeof record.sections === "object" && record.sections !== null) {
		for (const section of Object.values(record.sections as Record<string, unknown>)) {
			if (typeof section === "string") chars += section.length;
		}
	}
	// Mid-conversation system messages carry tool declarations.
	for (const key of ["toolsAdded", "toolsRemoved"] as const) {
		if (record[key] !== undefined) chars += JSON.stringify(record[key]).length;
	}
	return chars;
}

export function estimateTextTokens(text: string): number {
	return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Uncalibrated token estimate of a message list. */
export function estimateMessagesTokens(messages: readonly AgentMessage[]): number {
	let chars = 0;
	for (const message of messages) chars += estimateMessageChars(message);
	return Math.ceil(chars / CHARS_PER_TOKEN);
}

/** Input-side tokens of the request that produced `message`, when the provider reported them. */
export function requestInputTokens(message: AgentMessage): number | undefined {
	if (message.role !== "assistant") return undefined;
	const usage = (message as unknown as { usage?: Record<string, unknown> }).usage;
	if (!usage) return undefined;
	let total = 0;
	for (const key of ["input", "cacheRead", "cacheWrite"] as const) {
		const value = usage[key];
		if (typeof value === "number" && Number.isFinite(value) && value > 0) total += value;
	}
	return total > 0 ? total : undefined;
}

/**
 * Ratio of real to estimated input tokens for one request, clamped to a sane
 * range; `undefined` when either side is missing.
 */
export function calibrationSample(realInputTokens: number | undefined, estimatedTokens: number): number | undefined {
	if (realInputTokens === undefined || estimatedTokens <= 0) return undefined;
	return Math.min(MAX_CALIBRATION, Math.max(MIN_CALIBRATION, realInputTokens / estimatedTokens));
}

/** Exponential moving average used for both calibration and growth. */
export function ema(previous: number | undefined, sample: number, weight = 0.5): number {
	return previous === undefined ? sample : previous + weight * (sample - previous);
}

export interface PressureLevels {
	readonly contextWindow: number;
	readonly outputReserve: number;
	readonly safetyMargin: number;
	/** H: largest input that still leaves the output reserve and margin. */
	readonly safeInputLimit: number;
	/**
	 * Pi's own compaction threshold (window minus Pi's reserve) less the margin, when Pi's
	 * auto-compaction is on. Above it Pi runs its native compaction before the next request.
	 */
	readonly compactionLimit: number | undefined;
	/** Largest input the levels may use: the lower of `safeInputLimit` and `compactionLimit`. */
	readonly inputLimit: number;
	readonly start: number;
	readonly target: number;
	readonly ceiling: number;
	/** The configured ceiling exceeded `inputLimit`, so every level was lowered proportionally. */
	readonly clamped: boolean;
}

/**
 * Water levels in tokens for one model. Returns `undefined` when the window is
 * unknown or leaves no room for input after the reserves. `piCompactionReserve`
 * is Pi's effective `compaction.reserveTokens`, or `undefined` when Pi's
 * auto-compaction is off.
 */
export function pressureLevels(
	contextWindow: number | undefined,
	modelMaxTokens: number | undefined,
	config: Pick<LiveCompactConfig, "thresholds" | "budget">,
	piCompactionReserve?: number,
): PressureLevels | undefined {
	if (contextWindow === undefined || !Number.isFinite(contextWindow) || contextWindow <= 0) return undefined;
	const declared =
		modelMaxTokens !== undefined && Number.isFinite(modelMaxTokens) && modelMaxTokens > 0
			? modelMaxTokens
			: DEFAULT_OUTPUT_RESERVE_TOKENS;
	const outputReserve = Math.min(declared, MAX_OUTPUT_RESERVE_TOKENS, Math.floor(contextWindow / 4));
	const safetyMargin = Math.ceil(contextWindow * AUTO_MARGIN_RATIO) + config.budget.extraReserveTokens;
	const safeInputLimit = contextWindow - outputReserve - safetyMargin;
	const compactionLimit =
		piCompactionReserve === undefined ? undefined : contextWindow - piCompactionReserve - safetyMargin;
	const inputLimit = Math.min(safeInputLimit, compactionLimit ?? safeInputLimit);
	if (inputLimit <= 0) return undefined;

	const { startRatio, targetRatio, ceilingRatio } = config.thresholds;
	let start = Math.floor(contextWindow * startRatio);
	let target = Math.floor(contextWindow * targetRatio);
	let ceiling = Math.floor(contextWindow * ceilingRatio);
	const clamped = ceiling > inputLimit;
	if (clamped) {
		// Keep the configured proportions, scaled under the limit.
		const scale = inputLimit / ceiling;
		start = Math.floor(start * scale);
		target = Math.floor(target * scale);
		ceiling = inputLimit;
	}
	return {
		contextWindow,
		outputReserve,
		safetyMargin,
		safeInputLimit,
		compactionLimit,
		inputLimit,
		start,
		target,
		ceiling,
		clamped,
	};
}

export type PressureAction = "idle" | "armed" | "reduce";

export interface PressureDecision {
	readonly action: PressureAction;
	/** Tokens to reclaim to reach the target; 0 unless reducing. */
	readonly reclaimTokens: number;
	readonly reason: "below_start" | "within_band" | "over_ceiling" | "growth_crosses_ceiling";
}

/**
 * Below start: do nothing. In the band: watch. Over the ceiling now, or
 * predicted to cross it with the next turn's growth: reclaim back to target.
 */
export function decidePressure(
	projectedTokens: number,
	predictedGrowthTokens: number,
	levels: PressureLevels,
): PressureDecision {
	if (projectedTokens < levels.start) return { action: "idle", reclaimTokens: 0, reason: "below_start" };
	const growth = Math.ceil(Math.max(0, predictedGrowthTokens));
	if (projectedTokens <= levels.ceiling && projectedTokens + growth <= levels.ceiling) {
		return { action: "armed", reclaimTokens: 0, reason: "within_band" };
	}
	// Back to target, and at least enough that the predicted growth lands under the ceiling.
	const reclaimTokens = Math.max(projectedTokens - levels.target, projectedTokens + growth - levels.ceiling, 0);
	return {
		action: "reduce",
		reclaimTokens,
		reason: projectedTokens > levels.ceiling ? "over_ceiling" : "growth_crosses_ceiling",
	};
}
