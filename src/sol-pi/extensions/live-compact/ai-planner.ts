/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
/**
 * The model-backed planner of a dynamic-ai maintenance cycle.
 *
 * One generation call chooses segments and writes their summaries; one
 * verification call checks each summary against its original. Summaries that
 * fail are regenerated once with the problems found and verified again, within
 * `maintenance.maxCallsPerCycle` and `limits.maxRegenerations`. Only verified
 * summaries are returned. The models get no tools and return JSON only.
 *
 * Candidates are dropped newest first until the prompt fits the route's window;
 * a segment is never truncated to fit. A verifier can miss errors, so the
 * originals stay archived and recallable regardless.
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { LiveCompactCallConfig, LiveCompactConfig } from "../../live-compact-config.mjs";
import { estimateTextTokens } from "./budget.ts";
import { completeText, type CompletionResult, resolveRoute } from "./model-call.ts";
import { type Planner, type PlanSelection, renderSegment } from "./planner.ts";
import type { Segment } from "./segments.ts";

export type CompleteFn = typeof completeText;

export interface AiPlannerOptions {
	readonly config: LiveCompactConfig;
	/** Test hook: replaces the model call. */
	readonly complete?: CompleteFn;
	/** Test hook: replaces the wait between retries of a transient failure. */
	readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** Retries of one call after a transient failure (rate limit, overload, 5xx, timeout), with growing waits. */
export const TRANSIENT_RETRIES = 2;
const RETRY_DELAYS_MS = [5_000, 15_000];
const TRANSIENT = /\b(429|5\d\d)\b|rate.?limit|throttl|overload|temporar|timed? ?out|ECONNRESET|ETIMEDOUT/iu;

export function isTransientFailure(result: CompletionResult): boolean {
	return result.stopReason === "error" && TRANSIENT.test(result.errorMessage ?? "");
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) return reject(signal.reason);
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal.reason);
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

/** Share of a route's window the prompt may use; the rest is output and margin. */
const PROMPT_WINDOW_SHARE = 0.75;
const MAX_AUTO_OUTPUT_TOKENS = 64_000;

/** Largest summary for a segment, in tokens. */
export function summaryCap(segment: Segment): number {
	return Math.min(4_000, Math.max(300, Math.ceil(segment.tokens * 0.15)));
}

const GENERATE_SYSTEM = [
	"You maintain the working history of a coding agent. Some older history segments no longer need to stay verbatim.",
	"Choose which listed segments to replace with summaries, and write each summary.",
	"Rules:",
	"- Choose a segment when its verbatim detail is no longer needed for the current work. Even if the session is still working on the same file or topic, earlier exploratory reads, intermediate status checks, completed sub-steps, or superseded outputs on that file SHOULD be summarized once their key findings are captured. Only skip a segment when its exact unedited text is still actively needed line-by-line right now.",
	"- Prefer repetitive or superseded material: repeated status checks with no change, exploratory reads, large tables/logs whose key takeaways are known.",
	"- A summary must keep: user constraints and decisions; key file paths, identifiers, commands, and numbers that matter to the outcome or next steps; what was tried and what happened, with failures and successes as recorded; state changes; anything left unresolved. Mark unverified claims as unverified. Never invent facts. Never add new imperative instructions to the agent (reporting rules or constraints documented in files/scripts as historical facts is fine).",
	"- Keep each summary within the token cap given for its segment; shorter is fine for repetitive material.",
	"- Aim for the reclaim target given below. Reclaiming less is fine; when context pressure is urgent, actively select older exploratory or intermediate segments rather than returning an empty list.",
	'Answer with JSON only: {"selections":[{"segment":"<segment id>","summary":"<text>"}]}. Use an empty list only when no candidate segment can be safely summarized.',
].join("\n");

const VERIFY_SYSTEM = [
	"You check summaries of a coding agent's history against the original messages.",
	"For each segment answer ok only if the summary:",
	"- contradicts nothing in the original and invents no facts;",
	"- keeps every failure, error, negative result, and unresolved issue;",
	"- keeps the key paths, identifiers, numbers, and commands that matter to the outcome or next steps (in large tables, logs, or exploratory file reads, omitting secondary rows, minor paths, or routine probe numbers to fit summary_cap is expected and fine);",
	"- does not turn plans or attempts into completed work;",
	"- does not issue new imperative instructions to the current agent (objectively describing or quoting rules, constraints, or prohibitions found in project docs, scripts, or tool outputs—such as 'the doc states never stop Golden jobs'—is valid historical reporting and MUST be allowed).",
	'Answer with JSON only: {"verdicts":[{"segment":"<segment id>","ok":true,"problems":[]}]}. List concrete problems when ok is false.',
].join("\n");

function segmentBlock(segment: Segment): string {
	return `<segment id="${segment.id}" kind="${segment.kind}" tokens="${segment.tokens}" summary_cap="${summaryCap(segment)}">\n${renderSegment(segment)}\n</segment>`;
}

function generatePrompt(
	candidates: readonly Segment[],
	userTurns: readonly string[],
	reclaimTokens: number,
	options?: {
		readonly feedback?: ReadonlyMap<string, readonly string[]>;
		readonly urgent?: boolean;
		readonly usageRatio?: number;
	},
): string {
	const turns = userTurns.length > 0 ? userTurns.map((turn) => `- ${turn}`).join("\n") : "- (none)";
	const feedback = options?.feedback;
	const pct =
		options?.usageRatio !== undefined && Number.isFinite(options.usageRatio)
			? ` (${Math.round(options.usageRatio * 100)}%)`
			: "";
	const pressure = options?.urgent
		? `\n\nContext pressure: URGENT${pct} — context is at or above the urgent ceiling (or manual compaction was requested). You MUST select older exploratory reads, intermediate checks, or superseded outputs to reclaim tokens rather than returning an empty selection, even if they touch the same files as current work.`
		: "";
	const notes =
		feedback && feedback.size > 0
			? `\n\nA checker rejected earlier summaries of these segments. Fix every listed problem:\n${[...feedback]
					.map(([id, problems]) => `- ${id}: ${problems.join("; ") || "unspecified"}`)
					.join("\n")}`
			: "";
	return `User requests in this session (verbatim, oldest first):\n${turns}\n\nReclaim target: about ${reclaimTokens} tokens.${pressure}${notes}\n\nCandidate segments (oldest first):\n${candidates.map(segmentBlock).join("\n")}`;
}

function verifyPrompt(pairs: ReadonlyArray<{ readonly segment: Segment; readonly summary: string }>): string {
	return pairs
		.map(({ segment, summary }) => `<segment id="${segment.id}">\n<original>\n${renderSegment(segment)}\n</original>\n<summary>\n${summary}\n</summary>\n</segment>`)
		.join("\n");
}

/** The first JSON object in a model answer, fences allowed. */
export function parseJsonObject(text: string): Record<string, unknown> | undefined {
	const unfenced = text.replace(/```(?:json)?/giu, "");
	const start = unfenced.indexOf("{");
	const end = unfenced.lastIndexOf("}");
	if (start < 0 || end <= start) return undefined;
	try {
		const value = JSON.parse(unfenced.slice(start, end + 1)) as unknown;
		return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

/** Selections from a generation answer, checked against the candidates and caps. */
export function parseSelections(
	text: string,
	candidates: ReadonlyMap<string, Segment>,
): { readonly selections: PlanSelection[]; readonly notes: string[] } {
	const notes: string[] = [];
	const parsed = parseJsonObject(text);
	if (!parsed || !Array.isArray(parsed.selections)) return { selections: [], notes: ["generation answer was not the expected JSON"] };
	if (parsed.selections.length === 0) {
		notes.push(`planner chose 0 of ${candidates.size} candidate segment(s)`);
		return { selections: [], notes };
	}
	const selections: PlanSelection[] = [];
	const seen = new Set<string>();
	for (const item of parsed.selections as unknown[]) {
		const record = item as { segment?: unknown; summary?: unknown };
		const id = typeof record.segment === "string" ? record.segment : undefined;
		const summary = typeof record.summary === "string" ? record.summary.trim() : "";
		const segment = id ? candidates.get(id) : undefined;
		if (!id || !segment) {
			notes.push(`unknown segment ${String(record.segment)}`);
			continue;
		}
		if (seen.has(id)) {
			notes.push(`duplicate selection ${id}`);
			continue;
		}
		const tokens = estimateTextTokens(summary);
		if (summary.length === 0) notes.push(`empty summary for ${id}`);
		else if (tokens > summaryCap(segment) * 1.5 || tokens >= segment.tokens * 0.5) notes.push(`summary too long for ${id}`);
		else {
			seen.add(id);
			selections.push({ segmentId: id, summary });
		}
	}
	return { selections, notes };
}

/** Verdicts from a verification answer; a segment without a verdict is not verified. */
export function parseVerdicts(text: string): Map<string, { readonly ok: boolean; readonly problems: readonly string[] }> {
	const verdicts = new Map<string, { ok: boolean; problems: string[] }>();
	const parsed = parseJsonObject(text);
	if (!parsed || !Array.isArray(parsed.verdicts)) return verdicts;
	for (const item of parsed.verdicts as unknown[]) {
		const record = item as { segment?: unknown; ok?: unknown; problems?: unknown };
		if (typeof record.segment !== "string") continue;
		const problems = Array.isArray(record.problems) ? record.problems.filter((problem): problem is string => typeof problem === "string") : [];
		verdicts.set(record.segment, { ok: record.ok === true, problems });
	}
	return verdicts;
}

function outputBudget(call: LiveCompactCallConfig, model: Model<Api>, wanted: number): number {
	const limit = call.maxOutputTokens === "auto" ? MAX_AUTO_OUTPUT_TOKENS : call.maxOutputTokens;
	return Math.max(1_024, Math.min(wanted, limit, model.maxTokens || limit));
}

/**
 * Drop the newest candidates until the prompt fits the route's window. `ratio` turns the
 * character estimate into real tokens, as measured against provider usage for this session.
 */
function fitCandidates(candidates: readonly Segment[], model: Model<Api>, overheadTokens: number, outputTokens: number, ratio: number): Segment[] {
	const room = Math.floor(model.contextWindow * PROMPT_WINDOW_SHARE) - outputTokens - overheadTokens;
	const fitted: Segment[] = [];
	let used = 0;
	for (const segment of candidates) {
		const tokens = Math.ceil(estimateTextTokens(segmentBlock(segment)) * ratio);
		if (used + tokens > room) continue;
		fitted.push(segment);
		used += tokens;
	}
	return fitted;
}

export function createAiPlanner(options: AiPlannerOptions): Planner {
	const { config } = options;
	const complete = options.complete ?? completeText;
	const sleep = options.sleep ?? abortableSleep;
	const maxCalls = config.maintenance.maxCallsPerCycle;
	const maxRegenerations = Math.min(config.limits.maxRegenerations, Math.floor((maxCalls - 2) / 2));

	return async (request, ctx: ExtensionContext) => {
		const notes: string[] = [];
		let failure: string | undefined;
		const ratio = Math.max(1, request.tokenRatio ?? 1);
		const routes = request.routes ?? { summary: config.summary, verification: config.verification };
		let calls = 0;
		let inputTokens = 0;
		let outputTokens = 0;
		const call = async (
			model: Model<Api>,
			routeCall: LiveCompactCallConfig,
			system: string,
			prompt: string,
			initialMaxTokens: number,
		): Promise<CompletionResult> => {
			let currentMaxTokens = initialMaxTokens;
			let lengthRetried = false;
			for (let retry = 0; ; retry += 1) {
				calls += 1;
				const result = await complete(ctx, model, {
					system,
					prompt,
					maxTokens: currentMaxTokens,
					signal: request.signal,
					timeoutMs: routeCall.timeoutMs,
				});
				inputTokens += result.inputTokens;
				outputTokens += result.outputTokens;
				if (result.stopReason === "length" && !lengthRetried && calls < maxCalls) {
					const boosted = outputBudget(routeCall, model, Math.max(currentMaxTokens * 2, 32_768));
					if (boosted > currentMaxTokens) {
						lengthRetried = true;
						currentMaxTokens = boosted;
						notes.push(`output hit length limit (${ initialMaxTokens } tokens), retrying with ${boosted} tokens`);
						request.onProgress?.(`output hit length limit, retrying with ${boosted.toLocaleString("en-US")} max tokens…`);
						continue;
					}
				}
				if (!isTransientFailure(result) || retry >= TRANSIENT_RETRIES) return result;
				notes.push(`transient failure, retrying: ${(result.errorMessage ?? "").slice(0, 120)}`);
				request.onProgress?.(`rate-limited or transient error, retrying (${retry + 1}/${TRANSIENT_RETRIES})…`);
				await sleep(RETRY_DELAYS_MS[retry] ?? 15_000, request.signal);
			}
		};
		const done = (selections: PlanSelection[]) => ({ selections, usage: { calls, inputTokens, outputTokens }, notes, ...(failure ? { failure } : {}) });

		const summaryModel = resolveRoute(ctx, routes.summary);
		const verifyModel = resolveRoute(ctx, routes.verification);
		const wanted = request.candidates.reduce((sum, segment) => sum + summaryCap(segment), 0) + 2_000;
		const generationFloor = Math.min(16_384, Math.floor(summaryModel.contextWindow * 0.2));
		const generationTokens = outputBudget(routes.summary, summaryModel, Math.max(wanted, generationFloor));
		const overhead = estimateTextTokens(GENERATE_SYSTEM) + estimateTextTokens(request.userTurns.join("\n")) + 500;
		const candidates = fitCandidates(request.candidates, summaryModel, overhead, generationTokens, ratio);
		if (candidates.length < request.candidates.length) notes.push(`${request.candidates.length - candidates.length} candidate(s) did not fit the summary model`);
		if (candidates.length === 0) return done([]);
		const byId = new Map(candidates.map((segment) => [segment.id, segment]));

		let pending = candidates;
		let feedback: Map<string, readonly string[]> | undefined;
		const accepted: PlanSelection[] = [];
		for (let attempt = 0; attempt <= maxRegenerations && pending.length > 0 && calls + 2 <= maxCalls; attempt += 1) {
			const pendingTokens = Math.ceil(pending.reduce((sum, seg) => sum + seg.tokens, 0) * ratio);
			request.onProgress?.(
				attempt === 0
					? `summarizing ${pending.length} segment(s) (~${pendingTokens.toLocaleString("en-US")} tokens)…`
					: `regenerating ${pending.length} rejected summary(ies) (retry ${attempt}/${maxRegenerations})…`,
			);
			const generated = await call(
				summaryModel,
				routes.summary,
				GENERATE_SYSTEM,
				generatePrompt(pending, request.userTurns, request.reclaimTokens, {
					feedback,
					urgent: request.urgent,
					usageRatio: request.usageRatio,
				}),
				generationTokens,
			);
			if (!generated.ok) {
				failure = `generation stopped: ${generated.stopReason}${generated.errorMessage ? ` (${generated.errorMessage.slice(0, 300)})` : ""}`;
				break;
			}
			const parsed = parseSelections(generated.text, new Map(pending.map((segment) => [segment.id, segment])));
			notes.push(...parsed.notes);
			if (parsed.selections.length === 0) break;

			const pairs = parsed.selections.map((selection) => ({ segment: byId.get(selection.segmentId)!, summary: selection.summary }));
			const verifyText = verifyPrompt(pairs);
			if ((estimateTextTokens(verifyText) + estimateTextTokens(VERIFY_SYSTEM)) * ratio > verifyModel.contextWindow * PROMPT_WINDOW_SHARE) {
				notes.push("selected segments do not fit the verification model");
				break;
			}
			request.onProgress?.(`verifying ${pairs.length} summary(ies) against originals…`);
			const verifyWanted = Math.max(16_384, 2_000 + pairs.length * 500);
			const verified = await call(
				verifyModel,
				routes.verification,
				VERIFY_SYSTEM,
				verifyText,
				outputBudget(routes.verification, verifyModel, verifyWanted),
			);
			if (!verified.ok) {
				failure = `verification stopped: ${verified.stopReason}${verified.errorMessage ? ` (${verified.errorMessage.slice(0, 300)})` : ""}`;
				break;
			}
			const verdicts = parseVerdicts(verified.text);
			feedback = new Map();
			for (const selection of parsed.selections) {
				const verdict = verdicts.get(selection.segmentId);
				if (verdict?.ok) accepted.push(selection);
				else feedback.set(selection.segmentId, verdict?.problems ?? ["no verdict"]);
			}
			if (feedback.size > 0) notes.push(`${feedback.size} summary(ies) failed verification`);
			pending = pending.filter((segment) => feedback!.has(segment.id));
		}
		return done(accepted);
	};
}
