/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
/**
 * Live Compact - keep long sessions near a configured context level by
 * condensing only as many older large tool results as the pressure requires.
 *
 * Below the start level nothing is touched. At the `turn_end` boundary the
 * projected context is measured (calibrated against provider usage); when it
 * is over the ceiling, or the next turn's predicted growth would carry it over,
 * the oldest eligible tool results are archived and replaced by verbatim
 * head/tail cards until the context is back at the target.
 *
 * Replacements are persisted as `context_edit` entries through Pi's public
 * boundary API (Pi >= 0.87). Pi's own compaction threshold, forks, tree
 * navigation and resumes therefore see the same condensed context, and the raw
 * session entries stay unmodified. The levels also stay under Pi's own
 * compaction threshold. On older Pi the mechanism is not registered, the
 * legacy ObservationPack and Online Context Compact behavior stays on, and a
 * warning says so.
 *
 * Not yet implemented (see docs/live-compact-plan.md P2-P4): per-request
 * admission, bounded prefix summaries, and background summaries. When local
 * condensing cannot keep the context under Pi's own compaction threshold,
 * Pi's native compaction still runs, and this extension says so.
 */
import { join } from "node:path";
import {
	type ContextEditEntryDraft,
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionFactory,
	getAgentDir,
	type SessionBoundaryDraft,
	type TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import { findConfigPath } from "../../config.ts";
import type { LiveCompactConfig } from "../../live-compact-config.mjs";
import { runtimeRoot } from "../../runtime-paths.ts";
import { createLedger, type Ledger } from "../observation-pack/ledger.ts";
import { createObservation, ensureStored } from "../observation-pack/observation.ts";
import { resolveCompactionTokenSettings } from "../online-context-compact/extension.ts";
import {
	calibrationSample,
	decidePressure,
	ema,
	estimateMessagesTokens,
	estimateTextTokens,
	type PressureDecision,
	type PressureLevels,
	pressureLevels,
	requestInputTokens,
} from "./budget.ts";
import { createAiPlanner } from "./ai-planner.ts";
import { liveCard } from "./card.ts";
import { createDynamicCompactExtension } from "./dynamic.ts";
import { scanCandidates } from "./policy.ts";
import { buildLiveCompactSettingFields, canOpenSettingsTui, openLiveCompactSettingsPane } from "./settings-pane.ts";
import { LiveCompactConfigResolver } from "./settings-store.ts";

export const LIVE_COMPACT_STATUS_KEY = "sol-pi-live-compact";
/** First Pi release with actionable `turn_end` boundary entries (`context_edit` drafts). */
export const LIVE_COMPACT_MIN_PI_VERSION = "0.87.0";

/** Whether Pi `version` provides the boundary API Live Compact needs. */
export function liveCompactSupported(version: string): boolean {
	const parse = (value: string) => value.split(/[.+-]/u).slice(0, 3).map((part) => Number.parseInt(part, 10) || 0);
	const [major = 0, minor = 0, patch = 0] = parse(version);
	const [needMajor = 0, needMinor = 0, needPatch = 0] = parse(LIVE_COMPACT_MIN_PI_VERSION);
	if (major !== needMajor) return major > needMajor;
	if (minor !== needMinor) return minor > needMinor;
	return patch >= needPatch;
}

/** Registered instead of Live Compact on Pi without the boundary API. */
export function registerLiveCompactUnsupportedNotice(pi: ExtensionAPI, version: string): void {
	let shown = false;
	pi.on("session_start", (_event, ctx) => {
		if (shown || !ctx.hasUI) return;
		shown = true;
		ctx.ui.notify(
			`Ambient Compact needs Pi ${LIVE_COMPACT_MIN_PI_VERSION} or newer (running ${version}); it is inactive, ` +
				"and ObservationPack and Online Context Compact keep their standard behavior.",
			"warning",
		);
	});
}

export interface LiveCompactSnapshot {
	readonly supported: boolean | undefined;
	readonly levels: PressureLevels | undefined;
	readonly projectedTokens: number | undefined;
	readonly afterTokens: number | undefined;
	readonly calibration: number | undefined;
	readonly growthTokens: number | undefined;
	readonly decision: PressureDecision | undefined;
	readonly condensedTotal: number;
	readonly reclaimedTotal: number;
	readonly lastShortfallTokens: number;
	readonly nativeCompactions: number;
}

export interface LiveCompactExtensionOptions {
	readonly config: LiveCompactConfig;
	/** Test hook: observe the state after each boundary. */
	readonly onSnapshot?: (snapshot: LiveCompactSnapshot) => void;
	/** Test hook: clock for the batch budget. */
	readonly now?: () => number;
}

type BoundaryContext = NonNullable<TurnEndEvent["context"]>;
type SettingsSource = { readonly getSettings?: () => unknown };

/** Pi's effective compaction reserve for the current model, or `undefined` when auto-compaction is off. */
function piCompactionReserve(pi: ExtensionAPI, ctx: ExtensionContext): number | undefined {
	const getSettings = (pi as SettingsSource).getSettings;
	let settings: unknown;
	try {
		settings = typeof getSettings === "function" ? getSettings.call(pi) : undefined;
	} catch {
		settings = undefined;
	}
	const compaction = (settings as { compaction?: { enabled?: unknown } } | undefined)?.compaction;
	if (compaction?.enabled === false) return undefined;
	return resolveCompactionTokenSettings(settings, ctx.model).reserveTokens;
}

function hasBoundaryApi(event: TurnEndEvent): boolean {
	const candidate = event as Partial<TurnEndEvent>;
	return (
		Array.isArray(candidate.entries) &&
		typeof candidate.context === "object" &&
		candidate.context !== null &&
		Array.isArray((candidate.context as Partial<BoundaryContext>).contextEntries) &&
		Array.isArray((candidate.context as Partial<BoundaryContext>).contextMessages)
	);
}

function percent(tokens: number | undefined, window: number | undefined): string {
	if (tokens === undefined || !window) return "?";
	return `${Math.round((tokens / window) * 100)}%`;
}

export function createLiveCompactExtension(options: LiveCompactExtensionOptions): ExtensionFactory {
	const { config } = options;
	const now = options.now ?? (() => performance.now());

	return (pi: ExtensionAPI) => {
		let supported: boolean | undefined;
		let calibration: number | undefined;
		let growth: number | undefined;
		let lastAfter: number | undefined;
		let levels: PressureLevels | undefined;
		let projected: number | undefined;
		let decision: PressureDecision | undefined;
		let condensedTotal = 0;
		let reclaimedTotal = 0;
		let lastShortfall = 0;
		let nativeCompactions = 0;
		const configResolver = new LiveCompactConfigResolver(config);
		const configPathOf = (ctx: ExtensionContext) => findConfigPath(ctx.cwd, getAgentDir(), ctx.isProjectTrusted());
		const effectiveConfig = (ctx: ExtensionContext): LiveCompactConfig =>
			configResolver.resolve(ctx, configPathOf(ctx), buildLiveCompactSettingFields(ctx)).config;
		const ledgers = new Map<string, Ledger>();

		const ledgerFor = (ctx: ExtensionContext): Ledger => {
			const root = runtimeRoot(ctx);
			let ledger = ledgers.get(root);
			if (!ledger) {
				ledger = createLedger(join(root, "live-compact", "ledger.jsonl"));
				ledgers.set(root, ledger);
			}
			return ledger;
		};
		const record = async (ctx: ExtensionContext, entry: Record<string, unknown>): Promise<void> => {
			try {
				await ledgerFor(ctx)(entry);
			} catch (error) {
				console.error(`[live-compact] ledger write failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		};
		const snapshot = (): LiveCompactSnapshot => ({
			supported,
			levels,
			projectedTokens: projected,
			afterTokens: lastAfter,
			calibration,
			growthTokens: growth,
			decision,
			condensedTotal,
			reclaimedTotal,
			lastShortfallTokens: lastShortfall,
			nativeCompactions,
		});
		const showStatus = (ctx: ExtensionContext): void => {
			if (!ctx.hasUI || typeof ctx.ui?.setStatus !== "function") return;
			const window = levels?.contextWindow;
			ctx.ui.setStatus(
				LIVE_COMPACT_STATUS_KEY,
				supported === false
					? "Ambient Compact inactive (needs Pi >= 0.87)"
					: `Ambient Compact ${percent(lastAfter, window)} · target ${percent(levels?.target, window)} · ceiling ${percent(levels?.ceiling, window)}`,
			);
		};
		const resetMeasurements = (): void => {
			calibration = undefined;
			growth = undefined;
			lastAfter = undefined;
			projected = undefined;
			decision = undefined;
			lastShortfall = 0;
		};

		pi.on("session_start", (_event, ctx) => {
			resetMeasurements();
			configResolver.prime(configPathOf(ctx));
		});
		pi.on("session_tree", resetMeasurements);
		pi.on("session_compact", resetMeasurements);
		// Another model has another tokenizer and window: its first turn is not growth.
		pi.on("model_select", resetMeasurements);

		pi.on("session_before_compact", async (event, ctx) => {
			if (event.reason === "manual" || supported !== true) return;
			// Local condensing could not keep the context under Pi's own threshold. Bounded prefix
			// summaries are not implemented yet, so Pi's native compaction proceeds; say so.
			nativeCompactions += 1;
			await record(ctx, { event: "native_compaction", reason: event.reason, projected, shortfall: lastShortfall });
			if (ctx.hasUI) {
				ctx.ui.notify(
					`Ambient Compact: local condensing could not keep context below Pi's compaction threshold (${event.reason}); ` +
						"Pi's native compaction is running. Bounded prefix summaries are not available in this build yet.",
					"warning",
				);
			}
		});

		pi.on("turn_end", async (event, ctx) => {
			if (!hasBoundaryApi(event)) {
				if (supported === undefined && ctx.hasUI) {
					ctx.ui.notify("Ambient Compact needs Pi 0.87 or newer (turn_end boundary entries); it stays inactive.", "warning");
				}
				supported = false;
				showStatus(ctx);
				return;
			}
			supported = true;
			if (event.outcome !== "completed" || ctx.signal?.aborted) return;

			const activeConfig = effectiveConfig(ctx);
			levels = pressureLevels(ctx.model?.contextWindow, ctx.model?.maxTokens, activeConfig, piCompactionReserve(pi, ctx));
			if (!levels) {
				showStatus(ctx);
				return;
			}

			const messages = event.context.contextMessages;
			const lastAssistant = messages.findLastIndex((message) => message.role === "assistant");
			const previewUnchanged = event.entries.every(
				(entry: SessionBoundaryDraft) => entry.type !== "context_edit" && entry.type !== "compaction",
			);
			const realInput =
				lastAssistant >= 0 && previewUnchanged ? requestInputTokens(messages[lastAssistant]!) : undefined;
			const sample = calibrationSample(realInput, estimateMessagesTokens(messages.slice(0, Math.max(0, lastAssistant))));
			if (sample !== undefined) calibration = ema(calibration, sample);
			const ratio = calibration ?? 1;

			// The provider's count for the last request is exact; only what it has not seen yet is estimated.
			projected =
				realInput !== undefined
					? realInput + Math.ceil(estimateMessagesTokens(messages.slice(lastAssistant)) * ratio)
					: Math.ceil(estimateMessagesTokens(messages) * ratio);
			if (lastAfter !== undefined && projected > lastAfter) growth = ema(growth, projected - lastAfter);

			decision = decidePressure(projected, growth ?? 0, levels);
			let after = projected;
			const drafts: ContextEditEntryDraft[] = [];

			// Right after new context edits Pi drops provider usage and checks its own uncalibrated
			// estimate against its threshold, so that estimate must fit as well.
			let uncalibrated = estimateMessagesTokens(messages);
			const overPiThreshold = () => levels!.compactionLimit !== undefined && uncalibrated > levels!.compactionLimit;

			if (decision.action === "reduce") {
				let scan: ReturnType<typeof scanCandidates>;
				let root: string;
				try {
					scan = scanCandidates(event.context.contextEntries, activeConfig);
					root = runtimeRoot(ctx);
				} catch (error) {
					// Fail open: an unreadable context or runtime root leaves every result verbatim.
					await record(ctx, { event: "scan_failed", reason: error instanceof Error ? error.message : String(error) });
					lastAfter = projected;
					showStatus(ctx);
					options.onSnapshot?.(snapshot());
					return;
				}
				const started = now();
				let reclaimed = 0;
				for (const candidate of scan.candidates) {
					if (reclaimed >= decision.reclaimTokens && !overPiThreshold()) break;
					if (drafts.length >= activeConfig.limits.maxCandidatesPerPass) break;
					if (now() - started > activeConfig.limits.batchBudgetMs) break;
					try {
						const observation = createObservation(candidate.message, root, activeConfig.observation.minBytes);
						if (!observation) continue;
						const card = liveCard(observation, candidate.message.toolCallId, activeConfig.observation.excerptTargetBytes);
						if (!card) continue;
						const rawSaving = observation.tokens - estimateTextTokens(card);
						const saving = Math.floor(rawSaving * ratio);
						if (saving <= 0) continue;
						// Archive first: a card must never name an id that recall cannot serve.
						await ensureStored(observation);
						drafts.push({
							type: "context_edit",
							targetId: candidate.entryId,
							replacement: { content: [{ type: "text", text: card }] },
						});
						reclaimed += saving;
						uncalibrated -= rawSaving;
					} catch (error) {
						// Fail open: keep the original whenever archiving or carding fails.
						await record(ctx, {
							event: "candidate_failed",
							entryId: candidate.entryId,
							reason: error instanceof Error ? error.message : String(error),
						});
					}
				}
				after = projected - reclaimed;
				lastShortfall = Math.max(0, decision.reclaimTokens - reclaimed);
				condensedTotal += drafts.length;
				reclaimedTotal += reclaimed;
				await record(ctx, {
					event: "reduce",
					reason: decision.reason,
					projected,
					target: levels.target,
					ceiling: levels.ceiling,
					safeInputLimit: levels.safeInputLimit,
					reclaimGoal: decision.reclaimTokens,
					reclaimed,
					condensed: drafts.length,
					shortfall: lastShortfall,
					overPiThreshold: overPiThreshold(),
					candidates: scan.candidates.length,
					skipped: scan.skipped,
					calibration: ratio,
				});
			} else {
				lastShortfall = 0;
			}

			lastAfter = after;
			showStatus(ctx);
			options.onSnapshot?.(snapshot());
			if (drafts.length === 0) return;
			return { entries: [...event.entries, ...drafts] };
		});

		const statusLines = (): string[] => {
			const window = levels?.contextWindow;
			return [
				`Ambient Compact: ${supported === false ? "inactive (needs Pi >= 0.87)" : "enabled (local-tools)"}`,
				levels
					? `levels: start ${percent(levels.start, window)}, target ${percent(levels.target, window)}, ceiling ${percent(levels.ceiling, window)}, safe input ${percent(levels.safeInputLimit, window)} of ${window} tokens${levels.clamped ? (levels.inputLimit === levels.compactionLimit ? " (lowered under Pi's compaction threshold)" : " (lowered under the safe limit)") : ""}`
					: "levels: unknown until the first completed turn with a known model window",
				`context: ${percent(projected, window)} before, ${percent(lastAfter, window)} after the last boundary` +
					(decision ? ` (${decision.reason})` : ""),
				`condensed results: ${condensedTotal}; estimated tokens reclaimed: ${reclaimedTotal}`,
				`calibration: ${calibration === undefined ? "none yet" : calibration.toFixed(2)}; growth estimate: ${growth === undefined ? "none yet" : Math.round(growth)}`,
				...(lastShortfall > 0 ? [`last shortfall: ${lastShortfall} tokens could not be reclaimed locally`] : []),
				...(nativeCompactions > 0 ? [`native compactions while enabled: ${nativeCompactions}`] : []),
				"not yet available: per-request admission, bounded prefix summaries, background summaries",
			];
		};

		const commandSpec: Parameters<ExtensionAPI["registerCommand"]>[1] = {
			description: "Configure Ambient Compact settings or view context levels and activity",
			getArgumentCompletions: (prefix) => {
				const options = ["settings", "status"];
				return options.filter((option) => option.startsWith(prefix)).map((option) => ({ value: option, label: option }));
			},
			handler: async (args, ctx) => {
				const command = args.trim().split(/\s+/u)[0];
				if (command === "settings" || (!command && canOpenSettingsTui(ctx))) {
					await openLiveCompactSettingsPane(pi, ctx, {
						startupConfig: config,
						getCurrentConfig: effectiveConfig,
						getSessionState: (c, fields) => configResolver.resolve(c, configPathOf(c), fields).session,
						onChange: (nextConfig) => {
							levels = pressureLevels(
								ctx.model?.contextWindow,
								ctx.model?.maxTokens,
								nextConfig,
								piCompactionReserve(pi, ctx),
							);
							showStatus(ctx);
						},
						extraDetails: () => statusLines(),
					});
					return;
				}
				ctx.ui.notify(statusLines().join("\n"), "info");
			},
		};
		pi.registerCommand("ambient-compact", commandSpec);
	};
}

export function registerLiveCompact(
	pi: ExtensionAPI,
	config: LiveCompactConfig,
	initialContext?: ExtensionContext,
): void {
	if (config.strategy === "dynamic-ai") {
		createDynamicCompactExtension({ config, planner: createAiPlanner({ config }), initialContext, backgroundCycles: true })(pi);
		return;
	}
	createLiveCompactExtension({ config })(pi);
}
