/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
/**
 * Live Compact `dynamic-ai` strategy: once the context reaches the start level,
 * one maintenance cycle reviews the whole projected context, lets a planner
 * pick the segments worth summarizing, archives their originals, and commits
 * one batch of edits. Afterwards history only grows again until the next cycle
 * is due. See docs/live-compact-dynamic-plan.md.
 *
 * Cycles run at the two boundaries G0 verified, `turn_end` (mid-run) and
 * `agent_before_settle` (end of run), where the batch is returned as boundary
 * drafts. A cycle can also run outside a boundary: `/live-compact now`, or an
 * input that would not fit. There only the batch's begin marker is appended
 * (custom entries can be appended at any time); the interrupted-batch path then
 * applies the edits in memory to the next request and persists them at the
 * next boundary.
 *
 * Safety does not depend on a cycle succeeding:
 *
 * - a mid-run context still above the safe input limit stops the run with
 *   `ctx.abort()` rather than sending the request;
 * - an input that cannot fit, even after an immediate cycle, is rejected;
 * - Pi's own threshold compaction is cancelled only while the request fits;
 * - an interrupted batch is completed in memory and at the next boundary.
 *
 * Above the urgent level a failed cycle is retried after URGENT_RETRY_MS
 * without waiting for growth, and at once when the model routes change, so a
 * session at the limit is never locked behind backoff.
 *
 * Nothing here deletes raw history: every edit is a `context_edit`, and the
 * originals of a summarized segment stay readable through `context_recall`.
 */
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionFactory,
	getAgentDir,
	type ProjectedSessionEntry,
	type SessionBoundaryDraft,
	type SessionEntry,
	type TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { findConfigPath } from "../../config.ts";
import type { LiveCompactConfig } from "../../live-compact-config.mjs";
import { runtimeRoot } from "../../runtime-paths.ts";
import { renderSolPiTool } from "../../tui.ts";
import { createLedger, type Ledger } from "../observation-pack/ledger.ts";
import { countLines, hash, readRecallChunk, type RecallChunk } from "../observation-pack/observation.ts";
import { resolveCompactionTokenSettings } from "../online-context-compact/extension.ts";
import { archiveText, type ArchivedSegment, CONTEXT_ARCHIVE_PATTERN, contextArchivePath, rebuildArchive } from "./archive.ts";
import {
	CHARS_PER_TOKEN,
	calibrationSample,
	ema,
	estimateMessagesTokens,
	estimateTextTokens,
	IMAGE_CHARS,
	type PressureLevels,
	pressureLevels,
	requestInputTokens,
} from "./budget.ts";
import type { BatchBegin } from "./commit.ts";
import { BATCH_BEGIN, batchDrafts, completionDrafts, findIncompleteBatches, orderPrefixSafe, type PlannedEdit } from "./commit.ts";
import { LIVE_CARD_HEADER } from "./card.ts";
import type { BatchMeta } from "./archive.ts";
import { type Planner, type PlanUsage, renderSegment, userTurns } from "./planner.ts";
import { describeRoute, parseRouteArgument, ROUTE_KINDS, ROUTES_ENTRY, type RouteKind, RouteStore, writeGlobalRoute } from "./routes.ts";
import { buildLiveCompactSettingFields, canOpenSettingsTui, openLiveCompactSettingsPane } from "./settings-pane.ts";
import { LiveCompactConfigResolver } from "./settings-store.ts";
import { indexSegments, type Segment, segmentEdits, summaryCarrierText } from "./segments.ts";
import { validateToolPairing } from "./validator.ts";

export const DYNAMIC_STATE_ENTRY = "sol-pi-live-compact-dynamic-v1";
export const DYNAMIC_STATUS_KEY = "sol-pi-live-compact";
/** Largest candidate pool handed to one planning call, in real (calibrated) tokens. */
export const MAX_POOL_TOKENS = 150_000;
/** Above the urgent level, a failed cycle is retried after this long without waiting for growth. */
export const URGENT_RETRY_MS = 120_000;

export type CycleOutcome = "committed" | "insufficient" | "no_selection" | "invalid" | "failed" | "aborted";
export type CycleTrigger = "turn_end" | "agent_before_settle" | "command" | "input";

/** Persisted after every cycle that ran the planner, so cooldown and backoff survive restarts. */
export interface DynamicState {
	readonly v: 1;
	/** Assistant messages on the branch when the cycle ran: the real request count. */
	readonly requestCount: number;
	readonly projected: number;
	readonly outcome: CycleOutcome;
	readonly reclaimed: number;
	readonly calls: number;
	/** Wall-clock time of the cycle, for the urgent retry rule. */
	readonly at?: number;
	/** The model routes the cycle used; a change allows an immediate retry. */
	readonly routes?: string;
	readonly batchId?: string;
	readonly note?: string;
}

export interface CycleReport {
	readonly boundary: CycleTrigger;
	readonly projected: number;
	readonly after: number;
	readonly levels: PressureLevels;
	readonly outcome: CycleOutcome | "skipped";
	readonly reason: string;
	readonly segments: number;
	readonly selected: number;
	readonly usage: PlanUsage;
}

export interface DynamicCompactOptions {
	readonly config: LiveCompactConfig;
	readonly planner: Planner;
	/** Test hook. */
	readonly onReport?: (report: CycleReport) => void;
	/** The effective sol-pi.json for global routes; resolved like the startup configuration by default. */
	readonly configPath?: (ctx: ExtensionContext) => string | undefined;
	/** Test hook: wall clock. */
	readonly now?: () => number;
	/** Context of the session_start event when registered dynamically at session_start. */
	readonly initialContext?: ExtensionContext;
}

type BoundaryEvent = TurnEndEvent & { type: string };
type SettingsSource = { readonly getSettings?: () => unknown };
type CycleResult = {
	readonly outcome: CycleOutcome;
	readonly after: number;
	readonly report: CycleReport;
	/** The batch drafts (begin marker, edits, end marker), when committed. */
	readonly batch: SessionBoundaryDraft[];
	readonly state: DynamicState;
};

const RECALL_MAX_BYTES = 16 * 1024;
const RECALL_LIMITS = { maxBytes: RECALL_MAX_BYTES - 512, maxLines: 398 };
const NO_USAGE: PlanUsage = { calls: 0, inputTokens: 0, outputTokens: 0 };

function hasBoundaryApi(event: Partial<BoundaryEvent>): boolean {
	const context = event.context as { contextEntries?: unknown; contextMessages?: unknown } | undefined;
	return Array.isArray(event.entries) && Array.isArray(context?.contextEntries) && Array.isArray(context?.contextMessages);
}

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

function latestState(branch: readonly SessionEntry[]): DynamicState | undefined {
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index]!;
		if (entry.type === "custom" && entry.customType === DYNAMIC_STATE_ENTRY) {
			const data = entry.data as DynamicState | undefined;
			if (data?.v === 1) return data;
		}
	}
	return undefined;
}

function requestCount(branch: readonly SessionEntry[]): number {
	return branch.filter((entry) => entry.type === "message" && entry.message.role === "assistant").length;
}

function contentOf(message: AgentMessage): unknown {
	return (message as { content?: unknown }).content;
}

/**
 * Identity of a not-yet-edited message across Pi's structured clones: role, timestamp, first
 * tool id, and a hash of its content (timestamps alone can collide within a millisecond).
 */
function messageKey(message: AgentMessage): string {
	const record = message as { role: string; timestamp?: unknown; toolCallId?: string };
	const content = contentOf(message);
	const firstCall = Array.isArray(content)
		? (content as Array<{ type?: string; id?: string }>).find((block) => block?.type === "toolCall")?.id
		: undefined;
	return `${record.role}:${String(record.timestamp)}:${record.toolCallId ?? firstCall ?? ""}:${hash(JSON.stringify(content ?? null)).slice(0, 16)}`;
}

function percent(tokens: number | undefined, window: number | undefined): string {
	if (tokens === undefined || !window) return "?";
	return `${Math.round((tokens / window) * 100)}%`;
}

/** Abort signal that fires on the run's signal or after `timeoutMs`. */
function cycleSignal(runSignal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
	const timeout = AbortSignal.timeout(timeoutMs);
	return runSignal ? AbortSignal.any([runSignal, timeout]) : timeout;
}

export function createDynamicCompactExtension(options: DynamicCompactOptions): ExtensionFactory {
	const { config, planner } = options;
	const now = options.now ?? Date.now;
	const configPathOf =
		options.configPath ?? ((ctx: ExtensionContext) => findConfigPath(ctx.cwd, getAgentDir(), ctx.isProjectTrusted()));

	return (pi: ExtensionAPI) => {
		let calibration: number | undefined;
		let levels: PressureLevels | undefined;
		let lastAfter: number | undefined;
		let lastReport: CycleReport | undefined;
		let noGain: { readonly projected: number } | undefined;
		let running = false;
		const routeStore = new RouteStore(config);
		const configResolver = new LiveCompactConfigResolver(config);
		const ledgers = new Map<string, Ledger>();

		const record = async (ctx: ExtensionContext, entry: Record<string, unknown>): Promise<void> => {
			try {
				const root = runtimeRoot(ctx);
				let ledger = ledgers.get(root);
				if (!ledger) {
					ledger = createLedger(join(root, "live-compact", "ledger.jsonl"));
					ledgers.set(root, ledger);
				}
				await ledger(entry);
			} catch (error) {
				console.error(`[live-compact] ledger write failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		};
		const status = (ctx: ExtensionContext, text: string | undefined): void => {
			if (ctx.hasUI && typeof ctx.ui?.setStatus === "function") ctx.ui.setStatus(DYNAMIC_STATUS_KEY, text);
		};
		const notify = (ctx: ExtensionContext, message: string, level: "info" | "warning" | "error"): void => {
			if (ctx.hasUI && typeof ctx.ui?.notify === "function") ctx.ui.notify(message, level);
			else console.error(`[sol-pi] ${message}`);
		};
		const reset = (): void => {
			calibration = undefined;
			lastAfter = undefined;
			noGain = undefined;
		};
		const resetAndShow = (_event: unknown, ctx: ExtensionContext): void => {
			reset();
			configResolver.prime(configPathOf(ctx));
			showBarStatus(ctx);
		};
		pi.on("session_start", resetAndShow);
		pi.on("session_tree", resetAndShow);
		pi.on("session_compact", resetAndShow);
		pi.on("model_select", resetAndShow);
		if (options.initialContext) {
			queueMicrotask(() => resetAndShow(undefined, options.initialContext!));
		}

		const effectiveConfig = (ctx: ExtensionContext): LiveCompactConfig =>
			configResolver.resolve(ctx, configPathOf(ctx), buildLiveCompactSettingFields(ctx)).config;
		const routesFor = (ctx: ExtensionContext) => routeStore.effective(ctx.sessionManager.getBranch(), configPathOf(ctx));
		const routeFingerprint = (ctx: ExtensionContext): string => {
			const routes = routesFor(ctx);
			return ROUTE_KINDS.map((kind) => describeRoute(routes[kind].call)).join(" | ");
		};
		const levelsFor = (ctx: ExtensionContext) =>
			pressureLevels(ctx.model?.contextWindow, ctx.model?.maxTokens, effectiveConfig(ctx), piCompactionReserve(pi, ctx));

		const measureProjection = (
			messages: readonly AgentMessage[],
			updateCalibration: boolean,
		): { readonly projected: number; readonly ratio: number } => {
			const lastAssistant = messages.findLastIndex((message) => message.role === "assistant");
			const realInput = lastAssistant >= 0 ? requestInputTokens(messages[lastAssistant]!) : undefined;
			const sample = calibrationSample(realInput, estimateMessagesTokens(messages.slice(0, Math.max(0, lastAssistant))));
			if (updateCalibration && sample !== undefined) calibration = ema(calibration, sample);
			const ratio = calibration ?? sample ?? 1;
			const projected =
				realInput !== undefined
					? realInput + Math.ceil(estimateMessagesTokens(messages.slice(lastAssistant)) * ratio)
					: Math.ceil(estimateMessagesTokens(messages) * ratio);
			return { projected, ratio };
		};

		function showBarStatus(ctx: ExtensionContext): void {
			if (!ctx.hasUI || typeof ctx.ui?.setStatus !== "function") return;
			if (running) {
				ctx.ui.setStatus(DYNAMIC_STATUS_KEY, "Ambient Compact: reviewing history…");
				return;
			}
			const currentLevels = levels ?? levelsFor(ctx);
			if (!currentLevels) {
				ctx.ui.setStatus(DYNAMIC_STATUS_KEY, "Ambient Compact: dynamic-ai");
				return;
			}
			const window = currentLevels.contextWindow;
			let currentTokens = lastAfter;
			if (currentTokens === undefined && typeof ctx.sessionManager.buildSessionProjection === "function") {
				try {
					currentTokens = measureProjection(ctx.sessionManager.buildSessionProjection().messages, false).projected;
				} catch {
					currentTokens = undefined;
				}
			}
			const pending = findIncompleteBatches(ctx.sessionManager.getBranch()).length > 0;
			ctx.ui.setStatus(
				DYNAMIC_STATUS_KEY,
				`Ambient Compact ${percent(currentTokens, window)} · band ${percent(currentLevels.target, window)}–${percent(currentLevels.start, window)} (urgent ${percent(currentLevels.ceiling, window)})${pending ? " · batch pending" : ""}`,
			);
		}

		/** Calibrated input estimate for the next request, from a boundary preview. */
		const measure = (event: BoundaryEvent): number => {
			const messages = event.context.contextMessages;
			const lastAssistant = messages.findLastIndex((message) => message.role === "assistant");
			const previewUnchanged = event.entries.every(
				(entry: SessionBoundaryDraft) => entry.type !== "context_edit" && entry.type !== "compaction",
			);
			const realInput = lastAssistant >= 0 && previewUnchanged ? requestInputTokens(messages[lastAssistant]!) : undefined;
			const sample = calibrationSample(realInput, estimateMessagesTokens(messages.slice(0, Math.max(0, lastAssistant))));
			if (sample !== undefined) calibration = ema(calibration, sample);
			const ratio = calibration ?? 1;
			return realInput !== undefined
				? realInput + Math.ceil(estimateMessagesTokens(messages.slice(lastAssistant)) * ratio)
				: Math.ceil(estimateMessagesTokens(messages) * ratio);
		};

		const report = (value: CycleReport): void => {
			lastReport = value;
			options.onReport?.(value);
		};

		/**
		 * One maintenance cycle on `entries`. `force` skips cooldown, backoff, and minimum savings
		 * (explicit `/live-compact now`, or an input that would not fit).
		 */
		const runCycle = async (
			ctx: ExtensionContext,
			trigger: CycleTrigger,
			entries: readonly ProjectedSessionEntry[],
			messages: readonly AgentMessage[],
			projected: number,
			currentLevels: PressureLevels,
			force: boolean,
		): Promise<CycleResult | CycleReport> => {
			const window = currentLevels.contextWindow;
			const ratio = calibration ?? 1;
			const branch = ctx.sessionManager.getBranch();
			const skipped = (reason: string, segments = 0): CycleReport => ({
				boundary: trigger,
				projected,
				after: projected,
				levels: currentLevels,
				outcome: "skipped",
				reason,
				segments,
				selected: 0,
				usage: NO_USAGE,
			});

			// Is a cycle due?
			if (!force && projected < currentLevels.start) return skipped("below_start");
			const urgent = projected >= currentLevels.ceiling;
			const requests = requestCount(branch);
			const state = latestState(branch);
			const activeConfig = effectiveConfig(ctx);
			const routes = routeFingerprint(ctx);
			const { cooldownRequests, retryGrowthRatio, minSavingsRatio, timeoutMs } = activeConfig.maintenance;
			if (!force) {
				if (state && !urgent && requests - state.requestCount < cooldownRequests) return skipped("cooldown");
				const routesChanged = state?.routes !== undefined && state.routes !== routes;
				const urgentRetryDue = urgent && state?.at !== undefined && now() - state.at >= URGENT_RETRY_MS;
				if (state && state.outcome !== "committed" && !routesChanged && !urgentRetryDue && projected < state.projected + retryGrowthRatio * window) {
					return skipped("backoff");
				}
				if (!urgent && noGain && projected < noGain.projected + retryGrowthRatio * window) return skipped("no_gain");
			}

			// Candidates, within the real-token pool limit.
			const index = indexSegments(entries, { keepRecentToolRounds: activeConfig.protection.keepRecentToolRounds });
			const minSavings = Math.ceil(minSavingsRatio * window);
			// An explicit or input-driven cycle reclaims at least the minimum, even below the target.
			const goal = Math.max(0, projected - currentLevels.target, force ? minSavings : 0);
			const pool: Segment[] = [];
			let poolTokens = 0;
			for (const segment of index.segments) {
				if (pool.length > 0 && poolTokens * ratio >= goal * 1.5) break;
				if ((poolTokens + segment.tokens) * ratio > MAX_POOL_TOKENS) break;
				pool.push(segment);
				poolTokens += segment.tokens;
			}
			if (pool.length === 0 || (!force && !urgent && poolTokens * ratio * 0.9 < minSavings)) {
				noGain = { projected };
				return skipped(pool.length === 0 ? "no_candidates" : "below_min_savings", index.segments.length);
			}

			// Plan.
			status(ctx, "Ambient Compact: reviewing history…");
			let outcome: CycleOutcome = "failed";
			let note: string | undefined;
			let usage: PlanUsage = NO_USAGE;
			let after = projected;
			let selected = 0;
			let batch: SessionBoundaryDraft[] = [];
			const batchId = `lc_${requests}_${hash(`${now()}:${pool.map((segment) => segment.id).join(",")}`).slice(0, 8)}`;
			const effective = routesFor(ctx);
			try {
				const plan = await planner(
					{
						candidates: pool,
						reclaimTokens: goal,
						userTurns: userTurns(messages),
						signal: cycleSignal(ctx.signal, timeoutMs),
						tokenRatio: ratio,
						routes: { summary: effective.summary.call, verification: effective.verification.call },
					},
					ctx,
				);
				usage = plan.usage;
				note = [plan.failure, ...plan.notes].filter(Boolean).join("; ") || undefined;
				const bySegment = new Map(pool.map((segment) => [segment.id, segment]));
				const chosen = plan.selections.filter((selection) => bySegment.has(selection.segmentId) && selection.summary.trim().length > 0);
				if (plan.failure && chosen.length === 0) {
					outcome = "failed";
				} else if (chosen.length === 0) {
					outcome = "no_selection";
				} else {
					// Archive, edit, and check the result before anything is committed.
					const root = runtimeRoot(ctx);
					const edits: PlannedEdit[] = [];
					const archived: ArchivedSegment[] = [];
					for (const selection of chosen) {
						const segment = bySegment.get(selection.segmentId)!;
						const archiveId = await archiveText(root, renderSegment(segment));
						const segmentEditList = segmentEdits(segment, summaryCarrierText(segment, selection.summary, archiveId));
						if (segmentEditList.length === 0) continue;
						edits.push(...segmentEditList);
						archived.push({ archiveId, segmentId: segment.id, entryIds: segment.messages.map((item) => item.entryId) });
					}
					const byTarget = new Map(edits.map((edit) => [edit.targetId, edit]));
					const editedMessages: AgentMessage[] = [];
					for (const item of index.messages) {
						const edit = byTarget.get(item.entryId);
						if (!edit) editedMessages.push(item.message);
						else if (edit.replacement !== null) editedMessages.push({ ...item.message, content: edit.replacement.content } as AgentMessage);
					}
					const issues = validateToolPairing(editedMessages);
					const preexisting = validateToolPairing(index.messages.map((item) => item.message)).length;
					if (issues.length > preexisting) {
						outcome = "invalid";
						note = `edits would break tool pairing: ${issues.map((issue) => issue.kind).join(", ")}`;
					} else {
						const saved = estimateMessagesTokens(index.messages.map((item) => item.message)) - estimateMessagesTokens(editedMessages);
						after = projected - Math.floor(saved * ratio);
						selected = archived.length;
						if ((!force && !urgent && projected - after < minSavings) || after >= projected) {
							outcome = "insufficient";
							after = projected;
						} else {
							outcome = "committed";
							const entryById = new Map(branch.map((entry) => [entry.id, entry]));
							batch = batchDrafts(batchId, orderPrefixSafe(edits, (id) => entryById.get(id)), { segments: archived });
						}
					}
				}
			} catch (error) {
				outcome = ctx.signal?.aborted ? "aborted" : "failed";
				note = error instanceof Error ? error.message : String(error);
			} finally {
				showBarStatus(ctx);
			}

			const state2: DynamicState = {
				v: 1,
				requestCount: requests,
				projected,
				outcome,
				reclaimed: projected - after,
				calls: usage.calls,
				at: now(),
				routes,
				...(outcome === "committed" ? { batchId } : {}),
				...(note ? { note: note.slice(0, 600) } : {}),
			};
			await record(ctx, {
				event: "cycle",
				trigger,
				outcome,
				projected,
				after,
				target: currentLevels.target,
				segments: index.segments.length,
				pool: pool.length,
				poolTokens: Math.ceil(poolTokens * ratio),
				selected,
				calls: usage.calls,
				inputTokens: usage.inputTokens,
				outputTokens: usage.outputTokens,
				routes,
				...(note ? { note: note.slice(0, 600) } : {}),
			});
			const cycleReport: CycleReport = {
				boundary: trigger,
				projected,
				after,
				levels: currentLevels,
				outcome,
				reason: note ?? outcome,
				segments: index.segments.length,
				selected,
				usage,
			};
			if (outcome === "committed") {
				notify(ctx, `Ambient Compact: summarized ${selected} history segment(s), ${percent(projected, window)} → ${percent(after, window)}.`, "info");
			} else if (outcome !== "aborted") {
				noGain = { projected };
				if (outcome === "failed") notify(ctx, `Ambient Compact: maintenance failed (${(note ?? "").slice(0, 200)}). History is unchanged.`, "warning");
			}
			return { outcome, after, report: cycleReport, batch, state: state2 };
		};

		const isResult = (value: CycleResult | CycleReport): value is CycleResult => "state" in value;

		/** Run a cycle outside a boundary and hand its batch to the interrupted-batch path. */
		const runOutsideBoundary = async (ctx: ExtensionContext, trigger: "command" | "input"): Promise<CycleResult | CycleReport | string> => {
			if (running) return "a maintenance cycle is already running";
			if (findIncompleteBatches(ctx.sessionManager.getBranch()).length > 0) return "a batch is already pending; it applies to the next request";
			const currentLevels = levelsFor(ctx);
			if (!currentLevels) return "the model window is unknown";
			levels = currentLevels;
			const projection = ctx.sessionManager.buildSessionProjection();
			const projected = lastAfter ?? measureProjection(projection.messages, true).projected;
			running = true;
			try {
				const result = await runCycle(ctx, trigger, projection.entries, projection.messages, projected, currentLevels, true);
				if (!isResult(result)) {
					report(result);
					return result;
				}
				const begin = result.batch[0];
				if (result.outcome === "committed" && begin?.type === "custom") {
					pi.appendEntry(begin.customType, begin.data);
					lastAfter = result.after;
				}
				pi.appendEntry(DYNAMIC_STATE_ENTRY, result.state);
				report(result.report);
				return result;
			} finally {
				running = false;
				showBarStatus(ctx);
			}
		};

		const boundary = async (trigger: "turn_end" | "agent_before_settle", event: BoundaryEvent, ctx: ExtensionContext) => {
			if (!hasBoundaryApi(event) || event.outcome !== "completed" || running) return;
			const branch = ctx.sessionManager.getBranch();

			// Finish an interrupted or out-of-boundary batch before anything else.
			const incomplete = findIncompleteBatches(branch);
			if (incomplete.length > 0) {
				await record(ctx, { event: "batch_completed", batches: incomplete.map((batch) => batch.batchId) });
				return { entries: [...event.entries, ...incomplete.flatMap(completionDrafts)] };
			}

			const currentLevels = levelsFor(ctx);
			if (!currentLevels) return;
			levels = currentLevels;
			const projected = measure(event);
			lastAfter = projected;
			const admit = (after: number) => {
				// A mid-run request that cannot fit is not sent.
				if (trigger === "turn_end" && after > currentLevels.safeInputLimit) {
					notify(
						ctx,
						`Ambient Compact: the context (${percent(after, currentLevels.contextWindow)}) is above the safe input limit and could not be reduced; the run is paused. Run /ambient-compact now (optionally after /ambient-compact model summary <provider>/<model>) or /compact.`,
						"warning",
					);
					ctx.abort();
				}
			};

			running = true;
			let result: CycleResult | CycleReport;
			try {
				result = await runCycle(ctx, trigger, event.context.contextEntries, event.context.contextMessages, projected, currentLevels, false);
			} finally {
				running = false;
			}
			if (!isResult(result)) {
				report(result);
				showBarStatus(ctx);
				admit(projected);
				return;
			}
			lastAfter = result.after;
			report(result.report);
			showBarStatus(ctx);
			admit(result.after);
			return {
				entries: [...event.entries, ...result.batch, { type: "custom", customType: DYNAMIC_STATE_ENTRY, data: result.state } as SessionBoundaryDraft],
			};
		};

		pi.on("turn_end", (event, ctx) => boundary("turn_end", event as BoundaryEvent, ctx));
		pi.on("agent_before_settle", (event, ctx) => boundary("agent_before_settle", event as unknown as BoundaryEvent, ctx));

		// Before an interrupted or out-of-boundary batch is persisted, send its edits in memory.
		pi.on("context", (event, ctx) => {
			const branch = ctx.sessionManager.getBranch();
			const incomplete = findIncompleteBatches(branch);
			if (incomplete.length === 0) return;
			const byId = new Map(branch.map((entry) => [entry.id, entry]));
			const replace = new Map<string, unknown>();
			const omit = new Set<string>();
			for (const edit of incomplete.flatMap((batch) => batch.remaining)) {
				const entry = byId.get(edit.targetId);
				if (!entry || entry.type !== "message") continue;
				const key = messageKey(entry.message);
				if (edit.replacement === null) omit.add(key);
				else replace.set(key, edit.replacement.content);
			}
			// Key every message before changing any: a replaced message must not take another's key.
			const keyed = event.messages.map((message) => ({ message, key: messageKey(message) }));
			for (const { message, key } of keyed) {
				const content = replace.get(key);
				if (content !== undefined) (message as { content: unknown }).content = content;
			}
			if (omit.size === 0) return;
			return { messages: keyed.filter(({ key }) => !omit.has(key)).map(({ message }) => message) };
		});

		// An input that cannot fit first gets an immediate cycle; if it still cannot fit, it is not sent.
		pi.on("input", async (event, ctx) => {
			if (!levels || lastAfter === undefined) return;
			const images = Array.isArray((event as { images?: unknown[] }).images) ? (event as { images: unknown[] }).images.length : 0;
			const incoming = Math.ceil((estimateTextTokens(event.text) + (images * IMAGE_CHARS) / CHARS_PER_TOKEN) * (calibration ?? 1));
			if (lastAfter + incoming <= levels.safeInputLimit) return;
			const attempt = await runOutsideBoundary(ctx, "input");
			if (lastAfter + incoming <= levels.safeInputLimit) return;
			notify(
				ctx,
				`Ambient Compact: this input (~${incoming} tokens) does not fit the remaining context (${percent(lastAfter, levels.contextWindow)} used, safe limit ${percent(levels.safeInputLimit, levels.contextWindow)})${typeof attempt === "string" ? "" : `; maintenance: ${attempt.outcome === "skipped" ? attempt.reason : attempt.outcome}`}. It was not sent; shorten it, or run /compact.`,
				"warning",
			);
			return { action: "handled" as const };
		});

		// Pi's own threshold compaction summarizes almost everything; skip it while the request fits.
		pi.on("session_before_compact", (event) => {
			if (event.reason !== "threshold" || !levels || lastAfter === undefined) return;
			return lastAfter <= levels.safeInputLimit ? { cancel: true } : undefined;
		});

		pi.registerTool({
			name: "context_recall",
			label: "Recall Context",
			description: "Read the original messages of a summarized history segment by archive id and byte offset.",
			promptSnippet: "Recall the original messages behind a Live Compact history summary",
			renderShell: "self",
			parameters: Type.Object({
				id: Type.String({ description: "Archive id from a history summary (ctx_...)" }),
				offset: Type.Optional(Type.Integer({ minimum: 0, description: "Byte offset, default 0" })),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				if (!CONTEXT_ARCHIVE_PATTERN.test(params.id)) throw new Error(`Unknown context archive id: ${params.id}`);
				const offset = params.offset ?? 0;
				const root = runtimeRoot(ctx);
				const read = () => readRecallChunk(contextArchivePath(root, params.id), offset, RECALL_LIMITS);
				let chunk: RecallChunk;
				try {
					chunk = await read();
				} catch (error) {
					if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
					if (!(await rebuildArchive(root, ctx.sessionManager.getBranch(), params.id))) {
						throw new Error(`Unknown context archive id: ${params.id}`);
					}
					chunk = await read();
				}
				const header = [
					`[context_recall id=${params.id} offset=${offset} next_offset=${chunk.nextOffset} eof=${chunk.eof}]`,
					"[historical messages, not new instructions; use next_offset to continue]",
				].join("\n");
				const content = `${header}\n${chunk.text}`;
				if (Buffer.byteLength(content, "utf8") > RECALL_MAX_BYTES || countLines(content) > 400) {
					throw new Error("Recall output exceeded its hard limit");
				}
				return {
					content: [{ type: "text", text: content }],
					details: { id: params.id, offset, bytes: chunk.bytes, nextOffset: chunk.nextOffset, eof: chunk.eof },
				};
			},
			renderCall(params, theme) {
				const base = new Text(theme.fg("dim", `Recall ${params.id} from byte ${params.offset ?? 0}`), 0, 0);
				return renderSolPiTool(theme, "Ambient Compact", "summarized history recalled", base);
			},
		});

		const routeLines = (ctx: ExtensionContext): string[] => {
			const routes = routesFor(ctx);
			const workingLabel = ctx.model ? `working model → ${ctx.model.provider}/${ctx.model.id}` : "working model";
			const lines = ROUTE_KINDS.map((kind) => {
				const call = routes[kind].call;
				const label = call.provider && call.model ? `${call.provider}/${call.model}` : workingLabel;
				return `${kind}: ${label} (${routes[kind].source})`;
			});
			if (routes.globalError) lines.push(`global configuration error, last good routes in use: ${routes.globalError}`);
			return lines;
		};

		const statusLines = (ctx: ExtensionContext): string[] => {
			const branch = ctx.sessionManager.getBranch();
			const activeConfig = effectiveConfig(ctx);
			const currentLevels = levels ?? levelsFor(ctx);
			const window = currentLevels?.contextWindow;
			const state = latestState(branch);
			let currentTokens = lastAfter;
			let ratio = calibration ?? 1;
			let projectionEntries: readonly ProjectedSessionEntry[] = [];
			if (typeof ctx.sessionManager.buildSessionProjection === "function") {
				try {
					const projection = ctx.sessionManager.buildSessionProjection();
					projectionEntries = projection.entries;
					const measured = measureProjection(projection.messages, false);
					if (currentTokens === undefined) currentTokens = measured.projected;
					ratio = measured.ratio;
				} catch {
					// Keep fallback values when projection is unavailable in a minimal test double.
				}
			}

			// 1. Candidate pool & protected counts
			const index = indexSegments(projectionEntries, {
				keepRecentToolRounds: activeConfig.protection.keepRecentToolRounds,
			});
			const episodes = index.segments.filter((segment) => segment.kind === "episode").length;
			const roundRuns = index.segments.length - episodes;
			const totalCandidateTokens = Math.ceil(
				index.segments.reduce((sum, segment) => sum + segment.tokens, 0) * ratio,
			);
			const minSavings = currentLevels ? Math.ceil(activeConfig.maintenance.minSavingsRatio * currentLevels.contextWindow) : 0;
			const goal = currentLevels && currentTokens !== undefined ? Math.max(0, currentTokens - currentLevels.target) : 0;
			let poolCount = 0;
			let poolRawTokens = 0;
			for (const segment of index.segments) {
				if (poolCount > 0 && poolRawTokens * ratio >= goal * 1.5) break;
				if ((poolRawTokens + segment.tokens) * ratio > MAX_POOL_TOKENS) break;
				poolCount += 1;
				poolRawTokens += segment.tokens;
			}
			const poolRealTokens = Math.ceil(poolRawTokens * ratio);

			// 2. Next trigger gate
			const incomplete = findIncompleteBatches(branch);
			const requests = requestCount(branch);
			const routes = routeFingerprint(ctx);
			const { cooldownRequests, retryGrowthRatio } = activeConfig.maintenance;
			let gateLine = "gate: waiting for model window";
			if (incomplete.length > 0) {
				const remainingEdits = incomplete.reduce((sum, batch) => sum + batch.remaining.length, 0);
				gateLine = `gate: pending_batch · ${incomplete.length} batch(es) queued (${remainingEdits} edits); applies on next request and persists at next boundary`;
			} else if (currentLevels && currentTokens !== undefined) {
				const urgent = currentTokens >= currentLevels.ceiling;
				const routesChanged = state?.routes !== undefined && state.routes !== routes;
				const urgentRetryDue = urgent && state?.at !== undefined && now() - state.at >= URGENT_RETRY_MS;
				if (currentTokens < currentLevels.start) {
					const delta = currentLevels.start - currentTokens;
					gateLine = `gate: idle · ${delta.toLocaleString("en-US")} tokens (${percent(delta, window)}) below start threshold`;
				} else if (state && !urgent && requests - state.requestCount < cooldownRequests) {
					const left = cooldownRequests - (requests - state.requestCount);
					gateLine = `gate: cooldown · ${left}/${cooldownRequests} request(s) remaining (or cross urgent ${percent(currentLevels.ceiling, window)})`;
				} else if (
					state &&
					state.outcome !== "committed" &&
					!routesChanged &&
					!urgentRetryDue &&
					currentTokens < state.projected + retryGrowthRatio * currentLevels.contextWindow
				) {
					const needed = Math.ceil(state.projected + retryGrowthRatio * currentLevels.contextWindow - currentTokens);
					const waitSec =
						urgent && state.at !== undefined ? Math.max(1, Math.ceil((URGENT_RETRY_MS - (now() - state.at)) / 1_000)) : undefined;
					gateLine = `gate: backoff · needs +${needed.toLocaleString("en-US")} tokens growth${waitSec !== undefined ? ` or ${waitSec}s until urgent retry` : ""}`;
				} else if (poolCount === 0) {
					gateLine = "gate: no_candidates · above start threshold, but no eligible segments to summarize";
				} else if (!urgent && poolRealTokens * 0.9 < minSavings) {
					gateLine = `gate: below_min_savings · pool (~${poolRealTokens.toLocaleString("en-US")} tokens) is below min savings (${minSavings.toLocaleString("en-US")} tokens)`;
				} else {
					gateLine = `gate: ready · eligible for maintenance at next boundary${urgent ? " (urgent)" : ""} (or run /ambient-compact now)`;
				}
			}

			// 3. Session cumulative totals
			let committedCycles = 0;
			let totalReclaimed = 0;
			let summarizedSegments = 0;
			let toolCards = 0;
			for (const entry of branch) {
				if (entry.type === "custom" && entry.customType === DYNAMIC_STATE_ENTRY) {
					const d = entry.data as DynamicState | undefined;
					if (d?.v === 1 && d.outcome === "committed") {
						committedCycles += 1;
						totalReclaimed += Math.max(0, d.reclaimed);
					}
				} else if (entry.type === "custom" && entry.customType === BATCH_BEGIN) {
					const b = entry.data as BatchBegin | undefined;
					const meta = b?.meta as BatchMeta | undefined;
					summarizedSegments += meta?.segments?.length ?? 0;
				} else if (
					entry.type === "context_edit" &&
					entry.replacement !== null &&
					JSON.stringify(entry.replacement).includes(LIVE_CARD_HEADER)
				) {
					toolCards += 1;
				}
			}

			const configPath = configPathOf(ctx);
			const sessionOverrides = Object.keys(
				configResolver.resolve(ctx, configPath, buildLiveCompactSettingFields(ctx)).session.changes,
			).length;

			return [
				"Ambient Compact: dynamic-ai",
				currentLevels
					? `levels: start ${percent(currentLevels.start, window)} (${currentLevels.start.toLocaleString("en-US")}), target ${percent(currentLevels.target, window)} (${currentLevels.target.toLocaleString("en-US")}), urgent ${percent(currentLevels.ceiling, window)} (${currentLevels.ceiling.toLocaleString("en-US")}), safe input ${percent(currentLevels.safeInputLimit, window)} (${currentLevels.safeInputLimit.toLocaleString("en-US")}) of ${window?.toLocaleString("en-US")} tokens`
					: "levels: unknown until the first completed turn with a known model window",
				`context: ${currentTokens !== undefined && window ? `${currentTokens.toLocaleString("en-US")} / ${window.toLocaleString("en-US")} tokens (${percent(currentTokens, window)})` : `${percent(currentTokens, window)} after the last boundary`} · calibration ${ratio.toFixed(2)}x`,
				gateLine,
				`candidates: ${index.segments.length} segment(s) (${episodes} episode(s), ${roundRuns} tool-round run(s)), ~${totalCandidateTokens.toLocaleString("en-US")} tokens (~${poolRealTokens.toLocaleString("en-US")} in next pool, min savings ${minSavings.toLocaleString("en-US")})`,
				`protected: recent rounds ${index.kept.recent_round ?? 0}, already edited ${index.kept.edited ?? 0}, errors ${index.kept.error_result ?? 0}, small ${index.kept.small ?? 0}`,
				...routeLines(ctx),
				`config: ${configPath ?? "defaults (no sol-pi.json)"}${sessionOverrides > 0 ? ` · ${sessionOverrides} session override(s) active (~)` : ""}`,
				`session totals: ${committedCycles} cycle(s) committed, ${summarizedSegments} segment(s) summarized, ${toolCards} tool card(s), ~${totalReclaimed.toLocaleString("en-US")} tokens reclaimed`,
				lastReport
					? `last boundary: ${lastReport.outcome} (${lastReport.reason.slice(0, 200)}); segments ${lastReport.segments}, selected ${lastReport.selected}, model calls ${lastReport.usage.calls}`
					: "last boundary: none yet",
				state
					? `last cycle: ${state.outcome} at request ${state.requestCount}, ${percent(state.projected, window)}, reclaimed ${state.reclaimed.toLocaleString("en-US")} tokens, calls ${state.calls}${state.note ? ` (${state.note.slice(0, 200)})` : ""}`
					: "last cycle: none in this branch",
				"commands: /ambient-compact [settings|status|now|model ...]",
			];
		};

		/** `/live-compact model <kind> <provider/model|default> [--global]` */
		const setRoute = (args: readonly string[], ctx: ExtensionContext): string => {
			const kind = args[0] as RouteKind | undefined;
			if (!kind || !ROUTE_KINDS.includes(kind)) return "usage: /ambient-compact model <summary|verification> <provider>/<model>|default [--global]";
			const global = args.includes("--global");
			const value = args.filter((arg) => !arg.startsWith("--"))[1];
			const route = value === undefined ? undefined : parseRouteArgument(value);
			if (route === undefined) return "expected <provider>/<model> or default";
			if (route && !(ctx.modelRegistry as { find?: (provider: string, model: string) => unknown }).find?.(route.provider!, route.model!)) {
				return `model ${route.provider}/${route.model} is not registered in Pi; nothing changed`;
			}
			if (global) {
				const path = configPathOf(ctx);
				if (!path) return "no sol-pi.json is in effect; nothing changed";
				writeGlobalRoute(path, kind, route);
				return `global ${kind} model: ${route ? describeRoute(route) : "working model"} (written to ${path}; running sessions use it from their next cycle)`;
			}
			pi.appendEntry(ROUTES_ENTRY, { v: 1, [kind]: route });
			return `session ${kind} model: ${route ? describeRoute(route) : "cleared; global or startup setting applies"}`;
		};

		const formatNowResult = (result: CycleResult | CycleReport | string): string =>
			typeof result === "string"
				? result
				: "state" in result
					? `maintenance ${result.outcome}: ${percent(result.report.projected, result.report.levels.contextWindow)} → ${percent(result.after, result.report.levels.contextWindow)}${result.outcome === "committed" ? " (applies from the next request)" : ""}${result.report.reason !== result.outcome ? `; ${result.report.reason.slice(0, 300)}` : ""}`
					: `maintenance skipped: ${result.reason}`;

		const commandSpec: Parameters<ExtensionAPI["registerCommand"]>[1] = {
			description: "Configure Ambient Compact settings, view status, or run maintenance now",
			getArgumentCompletions: (prefix) => {
				const options = [
					"settings",
					"status",
					"now",
					"model",
					"model summary ",
					"model verification ",
					"model summary default",
					"model verification default",
				];
				return options.filter((option) => option.startsWith(prefix)).map((option) => ({ value: option, label: option }));
			},
			handler: async (args, ctx) => {
				const parts = args.trim().split(/\s+/u).filter(Boolean);
				const [command, ...rest] = parts;
				try {
					if (command === "settings" || (!command && canOpenSettingsTui(ctx))) {
						await openLiveCompactSettingsPane(pi, ctx, {
							startupConfig: config,
							getCurrentConfig: effectiveConfig,
							getSessionState: (c, fields) => configResolver.resolve(c, configPathOf(c), fields).session,
							onChange: () => {
								levels = levelsFor(ctx);
								showBarStatus(ctx);
							},
							extraDetails: statusLines,
							runNow: async (c) => formatNowResult(await runOutsideBoundary(c, "command")),
							configPathOverride: options.configPath,
						});
					} else if (!command || command === "status") {
						ctx.ui.notify(statusLines(ctx).join("\n"), "info");
					} else if (command === "now") {
						const result = await runOutsideBoundary(ctx, "command");
						ctx.ui.notify(`Ambient Compact: ${formatNowResult(result)}`, "info");
					} else if (command === "model") {
						ctx.ui.notify(rest.length === 0 ? routeLines(ctx).join("\n") : `Ambient Compact: ${setRoute(rest, ctx)}`, "info");
					} else {
						ctx.ui.notify(`Ambient Compact: unknown subcommand ${command}\n${statusLines(ctx).at(-1)}`, "warning");
					}
				} catch (error) {
					ctx.ui.notify(`Ambient Compact: ${error instanceof Error ? error.message : String(error)}`, "error");
				}
			},
		};
		pi.registerCommand("ambient-compact", commandSpec);
	};
}

// The begin marker type, re-exported for callers that inspect pending batches.
export { BATCH_BEGIN };
