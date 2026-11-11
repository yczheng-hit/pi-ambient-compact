/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
/**
 * Live Compact dynamic-ai in real Pi AgentSessions: maintenance cycles, cooldown and backoff,
 * recall, crash completion, request admission, native compaction, and the AI planner through
 * Pi's model registry with a separate faux summary provider.
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import {
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionFactory,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { createAiPlanner } from "../src/sol-pi/extensions/live-compact/ai-planner.ts";
import { contextArchivePath } from "../src/sol-pi/extensions/live-compact/archive.ts";
import { batchDrafts, findIncompleteBatches, orderPrefixSafe } from "../src/sol-pi/extensions/live-compact/commit.ts";
import { type CycleReport, createDynamicCompactExtension, DYNAMIC_STATE_ENTRY } from "../src/sol-pi/extensions/live-compact/dynamic.ts";
import { deterministicPlanner, type Planner } from "../src/sol-pi/extensions/live-compact/planner.ts";
import { indexSegments, segmentEdits, summaryCarrierText } from "../src/sol-pi/extensions/live-compact/segments.ts";
import { validateToolPairing } from "../src/sol-pi/extensions/live-compact/validator.ts";
import { parseLiveCompactConfig } from "../src/sol-pi/live-compact-config.mjs";
import { runtimeRoot } from "../src/sol-pi/runtime-paths.ts";

const WINDOW = 20_000; // start 14_000, target 10_000, urgent 16_000, safe input 18_576

function dumpText(label: string, kb: number): string {
	const lines: string[] = [];
	for (let index = 0, bytes = 0; bytes < kb * 1024; index += 1) {
		const line = `${label} line ${String(index).padStart(4, "0")} ${"x".repeat(40)}\n`;
		lines.push(line);
		bytes += line.length;
	}
	return lines.join("");
}

const dumpTool: ExtensionFactory = (pi) => {
	pi.registerTool({
		name: "dump",
		label: "Dump",
		description: "Return a deterministic text block.",
		parameters: Type.Object({ label: Type.String(), kb: Type.Integer({ minimum: 1 }) }),
		async execute(_id, params) {
			return { content: [{ type: "text", text: dumpText(params.label, params.kb) }], details: undefined };
		},
	});
};

const dump = (label: string, kb = 6) =>
	fauxAssistantMessage(fauxToolCall("dump", { label, kb }, { id: label }), { stopReason: "toolUse" });
const dumps = (prefix: string, count: number, kb = 6) => Array.from({ length: count }, (_, index) => dump(`${prefix}${index + 1}`, kb));

type Run = {
	readonly cwd: string;
	readonly sessionManager: SessionManager;
	readonly requests: Message[][];
	readonly reports: CycleReport[];
	readonly errors: string[];
	readonly compactions: string[];
	readonly prompt: (text: string, responses: FauxResponseStep[]) => Promise<void>;
	readonly pending: () => number;
	readonly dispose: () => Promise<void>;
};

let runs = 0;

async function session(options: {
	readonly live?: Record<string, unknown>;
	readonly planner?: Planner | ((summaryProvider: string, summaryModel: string) => Planner);
	readonly summaryResponses?: FauxResponseStep[];
	readonly sessionManager?: (cwd: string) => SessionManager;
	readonly compaction?: { enabled: boolean; reserveTokens: number; keepRecentTokens: number };
	readonly cwd?: string;
}): Promise<Run> {
	runs += 1;
	const name = `dyn-${runs}`;
	const cwd = options.cwd ?? (await mkdtemp(join(tmpdir(), "sol-pi-dynamic-")));
	const agentDir = join(cwd, `agent-${runs}`);
	await mkdir(agentDir, { recursive: true });
	const faux = fauxProvider({ provider: `${name}-work`, api: `${name}-api`, models: [{ id: `${name}-model`, contextWindow: WINDOW, maxTokens: 1_024 }] });
	const summary = fauxProvider({ provider: `${name}-summary`, api: `${name}-summary-api`, models: [{ id: `${name}-summary-model`, contextWindow: 200_000, maxTokens: 8_000 }] });
	if (options.summaryResponses) summary.setResponses(options.summaryResponses);
	const requests: Message[][] = [];
	const reports: CycleReport[] = [];
	const compactions: string[] = [];
	const live = parseLiveCompactConfig({ enabled: true, strategy: "dynamic-ai", ...(options.live ?? {}) });
	const planner =
		typeof options.planner === "function" && options.planner.length === 2
			? (options.planner as (provider: string, model: string) => Planner)(`${name}-summary`, `${name}-summary-model`)
			: ((options.planner as Planner | undefined) ?? deterministicPlanner());
	const extension: ExtensionFactory = (pi) => {
		pi.registerProvider(faux.provider);
		pi.registerProvider(summary.provider);
		pi.on("session_before_compact", (event) => {
			compactions.push(event.reason);
		});
		createDynamicCompactExtension({ config: live, planner, onReport: (report) => reports.push(report) })(pi);
	};
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager: SettingsManager.inMemory(),
		extensionFactories: [dumpTool, extension].map((factory, index) => ({ name: `${name}-${index}`, factory })),
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPrompt: "Dynamic Live Compact test assistant.",
	});
	await resourceLoader.reload();
	expect(resourceLoader.getExtensions().errors).toEqual([]);
	const sessionManager = options.sessionManager ? options.sessionManager(cwd) : SessionManager.inMemory(cwd);
	const { session: agent } = await createAgentSession({
		cwd,
		agentDir,
		model: faux.getModel(),
		thinkingLevel: "off",
		tools: ["dump", "context_recall"],
		resourceLoader,
		sessionManager,
		settingsManager: SettingsManager.inMemory({
			retry: { enabled: false },
			compaction: options.compaction ?? { enabled: false, reserveTokens: 1_024, keepRecentTokens: 1_000 },
		}),
	});
	const errors: string[] = [];
	agent.extensionRunner.onError((error) => errors.push(`${error.event}: ${error.error}`));
	await agent.bindExtensions({ onError: () => undefined });
	return {
		cwd,
		sessionManager,
		requests,
		reports,
		errors,
		compactions,
		pending: () => faux.getPendingResponseCount(),
		prompt: async (text, responses) => {
			faux.setResponses(
				responses.map((step) => async (context, streamOptions, state, model) => {
					requests.push(structuredClone(context.messages));
					return typeof step === "function" ? await step(context, streamOptions, state, model) : step;
				}),
			);
			await agent.prompt(text, { expandPromptTemplates: false, source: "interactive" });
		},
		dispose: async () => {
			agent.dispose();
			if (!options.cwd) await rm(cwd, { recursive: true, force: true });
		},
	};
}

const textOf = (messages: readonly Message[]) => JSON.stringify(messages);
const states = (run: Run) =>
	run.sessionManager.getBranch().flatMap((entry) => (entry.type === "custom" && entry.customType === DYNAMIC_STATE_ENTRY ? [entry.data as { outcome: string; requestCount: number }] : []));

async function threeTasks(run: Run): Promise<void> {
	await run.prompt("task A", [...dumps("a", 4), fauxAssistantMessage("A done")]);
	await run.prompt("task B", [...dumps("b", 4), fauxAssistantMessage("B done")]);
	await run.prompt("task C", [...dumps("c", 4), fauxAssistantMessage("C done")]);
}

describe("dynamic-ai maintenance cycles", () => {
	it("commits one cycle at the start level, then only appends", async () => {
		const run = await session({});
		try {
			await run.prompt("task A", [...dumps("a", 2, 2), fauxAssistantMessage("A done")]);
			expect(run.reports.every((report) => report.reason === "below_start")).toBe(true);

			await run.prompt("task B", [...dumps("b", 4), fauxAssistantMessage("B done")]);
			await run.prompt("task C", [...dumps("c", 5), fauxAssistantMessage("C done")]);
			expect(run.errors).toEqual([]);
			const committed = run.reports.filter((report) => report.outcome === "committed");
			expect(committed).toHaveLength(1);
			expect(committed[0]!.projected).toBeGreaterThanOrEqual(14_000);
			expect(committed[0]!.after).toBeLessThan(committed[0]!.projected - 2_000);

			// The request after the cycle carries summaries, keeps pairing, and no longer replays the old dumps.
			const index = run.requests.findIndex((request) => textOf(request).includes("Live Compact history summary v1"));
			expect(index).toBeGreaterThan(0);
			const edited = run.requests[index]!;
			expect(textOf(run.requests[index - 1]!)).toContain("b1 line 0000");
			expect(textOf(edited)).not.toContain("b1 line 0000");
			expect(validateToolPairing(edited as AgentMessage[])).toEqual([]);
			// The last user turn's work and the latest answer stay verbatim.
			expect(textOf(run.requests.at(-1)!)).toContain("c5 line 0000");

			// The cycle is persisted; later boundaries are below the start level again.
			expect(states(run).map((state) => state.outcome)).toEqual(["committed"]);
			const after = run.reports.slice(run.reports.indexOf(committed[0]!) + 1);
			expect(after.every((report) => report.outcome === "skipped")).toBe(true);
			expect(findIncompleteBatches(run.sessionManager.getBranch())).toEqual([]);
		} finally {
			await run.dispose();
		}
	});

	it("waits out the cooldown instead of maintaining again right away", async () => {
		// A high target leaves the context above the start level after the first cycle.
		const run = await session({ live: { thresholds: { startRatio: 0.6, targetRatio: 0.58, ceilingRatio: 0.9 }, maintenance: { cooldownRequests: 50 } } });
		try {
			await threeTasks(run);
			expect(run.reports.filter((report) => report.outcome === "committed")).toHaveLength(1);
			expect(run.reports.some((report) => report.reason === "cooldown")).toBe(true);
			expect(states(run)).toHaveLength(1);
		} finally {
			await run.dispose();
		}
	});

	it("backs off after a failed cycle until the context has grown", async () => {
		let calls = 0;
		const failing: Planner = async () => {
			calls += 1;
			throw new Error("summary model unavailable");
		};
		// No cooldown, so the next boundaries meet the backoff rule.
		const run = await session({ planner: failing, live: { maintenance: { cooldownRequests: 0 } } });
		try {
			await run.prompt("task A", [...dumps("a", 4), fauxAssistantMessage("A done")]);
			await run.prompt("task B", [...dumps("b", 4), fauxAssistantMessage("B done")]);
			await run.prompt("task C", [...dumps("c", 6, 1), fauxAssistantMessage("C done")]);
			const failed = states(run).filter((state) => state.outcome === "failed");
			expect(failed.length).toBeGreaterThan(0);
			expect(run.reports.some((report) => report.reason === "backoff")).toBe(true);
			// Backoff limits retries to real growth: fewer planner calls than boundaries above start.
			const aboveStart = run.reports.filter((report) => report.projected >= 14_000).length;
			expect(calls).toBeLessThan(aboveStart);
			// Nothing was edited.
			expect(run.sessionManager.getBranch().some((entry) => entry.type === "context_edit")).toBe(false);
		} finally {
			await run.dispose();
		}
	});

	it("recalls the originals of a summarized segment, also after the archive file is gone", async () => {
		const run = await session({});
		try {
			await threeTasks(run);
			const summaryText = textOf(run.requests.at(-1)!);
			const id = /context_recall \{\\"id\\":\\"(ctx_[a-f0-9]{24})\\"\}/u.exec(summaryText)?.[1];
			expect(id).toMatch(/^ctx_/u);
			// Simulate a fork or moved session: the archive file is missing.
			await rm(contextArchivePath(runtimeRoot({ sessionManager: run.sessionManager } as never), id!), { force: true });
			await run.prompt("recall", [
				fauxAssistantMessage(fauxToolCall("context_recall", { id: id! }, { id: "recall-1" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("recalled"),
			]);
			const recalled = run.sessionManager.getBranch().find((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === "recall-1");
			const text = JSON.stringify(recalled);
			expect(text).toContain(`[context_recall id=${id} offset=0`);
			expect(text).toMatch(/[ab]1 line 0000/u);
		} finally {
			await run.dispose();
		}
	});
});

describe("dynamic-ai safety", () => {
	it("pauses a run instead of sending a request above the safe input limit", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const run = await session({});
		try {
			// One protected 80 KiB result cannot be summarized and does not fit.
			await run.prompt("huge", [dump("h1", 80), fauxAssistantMessage("must not be requested")]);
			expect(run.requests).toHaveLength(1);
			expect(run.pending()).toBe(1);
			expect(error.mock.calls.some((call) => String(call[0]).includes("the run is paused"))).toBe(true);
		} finally {
			error.mockRestore();
			await run.dispose();
		}
	});

	it("rejects one input that cannot fit, before any request", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const run = await session({});
		try {
			await run.prompt("task A", [...dumps("a", 2), fauxAssistantMessage("A done")]);
			const before = run.requests.length;
			await run.prompt("p".repeat(90_000), [fauxAssistantMessage("must not be requested")]);
			expect(run.requests).toHaveLength(before);
			expect(error.mock.calls.some((call) => String(call[0]).includes("It was not sent"))).toBe(true);
		} finally {
			error.mockRestore();
			await run.dispose();
		}
	});

	it("cancels Pi's threshold compaction while the request fits", async () => {
		const none: Planner = async () => ({ selections: [], usage: { calls: 1, inputTokens: 0, outputTokens: 0 }, notes: [] });
		const run = await session({ planner: none, compaction: { enabled: true, reserveTokens: 5_000, keepRecentTokens: 1_000 } });
		try {
			await threeTasks(run);
			expect(run.compactions).toContain("threshold");
			expect(run.sessionManager.getBranch().some((entry) => entry.type === "compaction")).toBe(false);
			expect(run.pending()).toBe(0);
		} finally {
			await run.dispose();
		}
	});

	it("sends the intended edits before an interrupted batch is completed", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "sol-pi-dynamic-crash-"));
		const sessions = join(cwd, "sessions");
		let file: string;
		// A session with an interrupted batch: begin marker and the first two edits only.
		const first = await session({ cwd, live: { enabled: false }, sessionManager: (dir) => SessionManager.create(dir, sessions) });
		try {
			await first.prompt("task A", [...dumps("a", 3), fauxAssistantMessage("A done")]);
			await first.prompt("task B", [fauxAssistantMessage("B done")]);
			file = first.sessionManager.getSessionFile()!;
			const branch = first.sessionManager.getBranch();
			const [segment] = indexSegments(first.sessionManager.buildSessionProjection().entries, { keepRecentToolRounds: 0 }).segments;
			const byId = new Map(branch.map((entry) => [entry.id, entry]));
			const drafts = batchDrafts("lc_crash", orderPrefixSafe(segmentEdits(segment!, summaryCarrierText(segment!, "Task A dumped a1-a3.")), (id) => byId.get(id)));
			const begin = drafts[0]!;
			if (begin.type === "custom") first.sessionManager.appendCustomEntry(begin.customType, begin.data as never);
			for (const draft of drafts.slice(1, 3)) if (draft.type === "context_edit") first.sessionManager.appendContextEdit(draft.targetId, draft.replacement);
		} finally {
			await first.dispose();
		}
		const second = await session({ cwd, sessionManager: () => SessionManager.open(file!, sessions) });
		try {
			expect(findIncompleteBatches(second.sessionManager.getBranch())).toHaveLength(1);
			await second.prompt("task C", [fauxAssistantMessage("C done")]);
			// The first request already carries the whole batch: no synthetic results, no old dumps.
			const firstRequest = second.requests[0]!;
			expect(validateToolPairing(firstRequest as AgentMessage[])).toEqual([]);
			expect(textOf(firstRequest)).not.toContain("a1 line 0000");
			expect(textOf(firstRequest)).toContain("Task A dumped a1-a3.");
			// The settle boundary then persisted the rest.
			expect(findIncompleteBatches(second.sessionManager.getBranch())).toEqual([]);
		} finally {
			await second.dispose();
			await rm(cwd, { recursive: true, force: true });
		}
	});
});

describe("dynamic-ai with the AI planner through Pi's model registry", () => {
	const segmentIds = (context: { messages: Message[] }) => [...JSON.stringify(context.messages).matchAll(/segment id=\\"(seg_[a-f0-9]{16})\\"/gu)].map((match) => match[1]!);

	it("summarizes and verifies with a separate summary route, then commits", async () => {
		const generation: FauxResponseStep = async (context) => {
			const [first] = segmentIds(context);
			return fauxAssistantMessage(JSON.stringify({ selections: [{ segment: first, summary: "Task A dumped a1-a4 with deterministic text; finished." }] }));
		};
		const verification: FauxResponseStep = async (context) => {
			const [first] = segmentIds(context);
			return fauxAssistantMessage(JSON.stringify({ verdicts: [{ segment: first, ok: true, problems: [] }] }));
		};
		const run = await session({
			planner: (provider: string, model: string) =>
				createAiPlanner({
					config: parseLiveCompactConfig({
						enabled: true,
						strategy: "dynamic-ai",
						summary: { provider, model },
						verification: { provider, model },
					}),
				}),
			summaryResponses: [generation, verification],
		});
		try {
			await threeTasks(run);
			expect(run.errors).toEqual([]);
			const committed = run.reports.find((report) => report.outcome === "committed");
			expect(committed?.usage.calls).toBe(2);
			expect(textOf(run.requests.at(-1)!)).toContain("Task A dumped a1-a4 with deterministic text; finished.");
			expect(textOf(run.requests.at(-1)!)).not.toContain("a1 line 0000");
			expect(validateToolPairing(run.requests.at(-1)! as AgentMessage[])).toEqual([]);
		} finally {
			await run.dispose();
		}
	});
});
