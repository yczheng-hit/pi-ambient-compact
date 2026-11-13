/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
/**
 * Live Compact dynamic-ai in real Pi AgentSessions: maintenance cycles, cooldown and backoff,
 * recall, crash completion, request admission, native compaction, and the AI planner through
 * Pi's model registry with a separate faux summary provider.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
	readonly notices: string[];
	readonly statuses: string[];
	readonly prompt: (text: string, responses: FauxResponseStep[]) => Promise<void>;
	readonly pending: () => number;
	readonly dispose: () => Promise<void>;
};

let runs = 0;

async function session(options: {
	readonly live?: Record<string, unknown>;
	readonly planner?: Planner;
	/** Builds the planner from the separate faux summary provider's route. */
	readonly plannerFactory?: (summaryProvider: string, summaryModel: string) => Planner;
	readonly summaryResponses?: FauxResponseStep[];
	readonly sessionManager?: (cwd: string) => SessionManager;
	readonly compaction?: { enabled: boolean; reserveTokens: number; keepRecentTokens: number };
	readonly cwd?: string;
	/** Route summary and verification to the separate faux summary provider. */
	readonly summaryRoutes?: boolean;
	readonly now?: () => number;
	readonly configPath?: string;
	readonly withUi?: boolean;
	readonly backgroundCycles?: boolean;
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
	const summaryRoute = { provider: `${name}-summary`, model: `${name}-summary-model` };
	const live = parseLiveCompactConfig({
		enabled: true,
		strategy: "dynamic-ai",
		...(options.summaryRoutes ? { summary: summaryRoute, verification: summaryRoute } : {}),
		...(options.live ?? {}),
	});
	const planner = options.plannerFactory
		? options.plannerFactory(`${name}-summary`, `${name}-summary-model`)
		: (options.planner ?? deterministicPlanner());
	const extension: ExtensionFactory = (pi) => {
		pi.registerProvider(faux.provider);
		pi.registerProvider(summary.provider);
		pi.on("session_before_compact", (event) => {
			compactions.push(event.reason);
		});
		createDynamicCompactExtension({
			config: live,
			planner,
			onReport: (report) => reports.push(report),
			configPath: () => options.configPath,
			...(options.now ? { now: options.now } : {}),
			...(options.backgroundCycles ? { backgroundCycles: true } : {}),
		})(pi);
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
	const notices: string[] = [];
	const statuses: string[] = [];
	agent.extensionRunner.onError((error) => errors.push(`${error.event}: ${error.error}`));
	await agent.bindExtensions({
		onError: () => undefined,
		...(options.withUi
			? {
					uiContext: {
						notify: (msg: string) => notices.push(msg),
						setStatus: (_key: string, val: string | undefined) => {
							if (val) statuses.push(val);
						},
					} as never,
				}
			: {}),
	});
	return {
		cwd,
		sessionManager,
		requests,
		reports,
		errors,
		compactions,
		notices,
		statuses,
		pending: () => faux.getPendingResponseCount(),
		prompt: async (text, responses) => {
			faux.setResponses(
				responses.map((step) => async (context, streamOptions, state, model) => {
					requests.push(structuredClone(context.messages));
					return typeof step === "function" ? await step(context, streamOptions, state, model) : step;
				}),
			);
			// Extension commands are recognized only with template expansion on.
			await agent.prompt(text, { expandPromptTemplates: text.startsWith("/"), source: "interactive" });
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
			plannerFactory: (provider: string, model: string) =>
				createAiPlanner({
					config: parseLiveCompactConfig({
						enabled: true,
						strategy: "dynamic-ai",
						summary: { provider, model },
						verification: { provider, model },
					}),
				}),
			summaryResponses: [generation, verification],
			summaryRoutes: true,
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

describe("dynamic-ai commands and recovery at the limit", () => {
	it("/ambient-compact now commits a batch that the next request already uses, then persists it", async () => {
		const run = await session({ live: { protection: { keepRecentToolRounds: 1 } } });
		try {
			await run.prompt("task A", [...dumps("a", 3), fauxAssistantMessage("A done")]);
			await run.prompt("task B", [fauxAssistantMessage("B done")]);
			expect(run.reports.every((report) => report.outcome === "skipped")).toBe(true);
			await run.prompt("/ambient-compact now", []);
			const manual = run.reports.at(-1)!;
			expect(manual).toMatchObject({ boundary: "command", outcome: "committed" });
			expect(findIncompleteBatches(run.sessionManager.getBranch())).toHaveLength(1);

			await run.prompt("task C", [fauxAssistantMessage("C done")]);
			const first = run.requests.at(-1)!;
			expect(textOf(first)).toContain("Live Compact history summary v1");
			expect(textOf(first)).not.toContain("a1 line 0000");
			expect(validateToolPairing(first as AgentMessage[])).toEqual([]);
			expect(findIncompleteBatches(run.sessionManager.getBranch())).toEqual([]);
		} finally {
			await run.dispose();
		}
	});

	it("retries a failed urgent cycle after the retry interval, without growth", async () => {
		let clock = 1_000_000;
		let calls = 0;
		const deterministic = deterministicPlanner();
		const flaky: Planner = async (request, ctx) => {
			calls += 1;
			if (calls === 1) return { selections: [], usage: { calls: 1, inputTokens: 0, outputTokens: 0 }, notes: [], failure: "generation stopped: error (429)" };
			return deterministic(request, ctx);
		};
		// Urgent from 7_000 tokens on; no cooldown, so only backoff and the retry rule apply.
		const run = await session({
			planner: flaky,
			now: () => clock,
			// Backoff waits for 20% growth, which this test never reaches.
			live: { thresholds: { startRatio: 0.3, targetRatio: 0.2, ceilingRatio: 0.35 }, maintenance: { cooldownRequests: 0, retryGrowthRatio: 0.2 } },
		});
		try {
			await run.prompt("task A", [...dumps("a", 4), fauxAssistantMessage("A done")]);
			await run.prompt("task B", [...dumps("b", 2), fauxAssistantMessage("B done")]);
			const failed = run.reports.find((report) => report.outcome === "failed");
			expect(failed).toBeDefined();
			// Tiny growth keeps it in backoff...
			await run.prompt("task C", [dump("c1", 1), fauxAssistantMessage("C done")]);
			expect(run.reports.slice(run.reports.indexOf(failed!) + 1).some((report) => report.reason === "backoff")).toBe(true);
			expect(calls).toBe(1);
			// ...until the urgent retry interval has passed.
			clock += 3 * 60_000;
			await run.prompt("task D", [dump("d1", 1), fauxAssistantMessage("D done")]);
			expect(calls).toBe(2);
			expect(run.reports.some((report) => report.outcome === "committed")).toBe(true);
		} finally {
			await run.dispose();
		}
	});

	it("retries at once after the summary route is changed with /ambient-compact model", async () => {
		const routesSeen: string[] = [];
		const failing: Planner = async (request) => {
			routesSeen.push(`${request.routes?.summary.provider ?? "working"}/${request.routes?.summary.model ?? "model"}`);
			return { selections: [], usage: { calls: 1, inputTokens: 0, outputTokens: 0 }, notes: [], failure: "generation stopped: error (429)" };
		};
		const run = await session({ planner: failing, live: { maintenance: { cooldownRequests: 0 } } });
		try {
			await threeTasks(run);
			const before = routesSeen.length;
			expect(before).toBeGreaterThan(0);
			const summaryRoute = `dyn-${runs}-summary/dyn-${runs}-summary-model`;
			await run.prompt(`/ambient-compact model summary ${summaryRoute}`, []);
			await run.prompt("task D", [dump("d1", 1), fauxAssistantMessage("D done")]);
			expect(routesSeen.length).toBe(before + 1);
			expect(routesSeen.at(-1)).toBe(summaryRoute);
			// An unknown model is refused and changes nothing.
			await run.prompt("/ambient-compact model summary nowhere/none", []);
			await run.prompt("task E", [dump("e1", 1), fauxAssistantMessage("E done")]);
			expect(routesSeen.at(-1)).toBe(summaryRoute);
		} finally {
			await run.dispose();
		}
	});

	it("writes a --global route that another running session uses from its next cycle", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "sol-pi-dynamic-global-"));
		const configPath = join(cwd, "sol-pi.json");
		await writeFile(configPath, JSON.stringify({ version: 1, observationPack: true, liveCompact: { enabled: true, strategy: "dynamic-ai" } }));
		const seen: string[] = [];
		const watching: Planner = async (request) => {
			seen.push(request.routes?.summary.model ?? "working");
			return { selections: [], usage: { calls: 1, inputTokens: 0, outputTokens: 0 }, notes: [] };
		};
		const writer = await session({ cwd, configPath, planner: deterministicPlanner() });
		const other = await session({ cwd, configPath, planner: watching, live: { maintenance: { cooldownRequests: 0, retryGrowthRatio: 0 } } });
		try {
			const route = `dyn-${runs - 1}-summary/dyn-${runs - 1}-summary-model`;
			await writer.prompt(`/ambient-compact model summary ${route} --global`, []);
			const written = JSON.parse(await readFile(configPath, "utf8"));
			expect(written.liveCompact.summary).toEqual({ provider: `dyn-${runs - 1}-summary`, model: `dyn-${runs - 1}-summary-model` });
			expect(written.liveCompact.strategy).toBe("dynamic-ai");
			await threeTasks(other);
			expect(seen.at(-1)).toBe(`dyn-${runs - 1}-summary-model`);
		} finally {
			await writer.dispose();
			await other.dispose();
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("makes room for an input that would not fit, then sends it", async () => {
		const run = await session({});
		try {
			await run.prompt("task A", [...dumps("a", 4), fauxAssistantMessage("A done")]);
			await run.prompt("task B", [...dumps("b", 3), fauxAssistantMessage("B done")]);
			const before = run.requests.length;
			// ~9_000 tokens on top of ~11_000: over the 18_576 safe limit until history is summarized.
			await run.prompt(`paste: ${"q".repeat(36_000)}`, [fauxAssistantMessage("got it")]);
			expect(run.reports.some((report) => report.boundary === "input" && report.outcome === "committed")).toBe(true);
			expect(run.requests.length).toBe(before + 1);
			const sent = run.requests.at(-1)!;
			expect(textOf(sent)).toContain("Live Compact history summary v1");
			expect(validateToolPairing(sent as AgentMessage[])).toEqual([]);
		} finally {
			await run.dispose();
		}
	});

	it("reports live 5-section diagnostic status via /ambient-compact status and updates the status bar", async () => {
		const run = await session({ withUi: true, live: { protection: { keepRecentToolRounds: 1 } } });
		try {
			await run.prompt("task A", [...dumps("a", 3), fauxAssistantMessage("A done")]);
			await run.prompt("task B", [fauxAssistantMessage("B done")]);
			await run.prompt("/ambient-compact now", []);
			expect(run.statuses.some((st) => st.includes("batch pending"))).toBe(true);
			await run.prompt("task C", [fauxAssistantMessage("C done")]);

			await run.prompt("/ambient-compact status", []);
			const statusText = run.notices.at(-1)!;
			expect(statusText).toContain("Ambient Compact: dynamic-ai");
			expect(statusText).toContain("levels: start 70% (14,000), target 50% (10,000), urgent 80% (16,000)");
			expect(statusText).toContain("context:");
			expect(statusText).toContain("gate:");
			expect(statusText).toContain("candidates:");
			expect(statusText).toContain("protected: recent rounds");
			expect(statusText).toContain("summary: working model");
			expect(statusText).toContain("session totals: 1 cycle(s) committed, 1 segment(s) summarized");
			expect(run.statuses.at(-1)).toMatch(/^Ambient Compact \d+% · band 50%–70% \(urgent 80%\)$/u);
		} finally {
			await run.dispose();
		}
	});

	it("runs boundary maintenance in the background without blocking foreground prompts when backgroundCycles is enabled", async () => {
		let resolvePlanner!: () => void;
		const plannerStarted = new Promise<void>((resolve) => {
			resolvePlanner = resolve;
		});
		let allowPlannerFinish!: () => void;
		const plannerGate = new Promise<void>((resolve) => {
			allowPlannerFinish = resolve;
		});
		const basePlanner = deterministicPlanner();
		const slowPlanner: Planner = async (req, ctx) => {
			resolvePlanner();
			await plannerGate;
			return basePlanner(req, ctx);
		};
		const run = await session({ backgroundCycles: true, planner: slowPlanner });
		try {
			await run.prompt("task A", [...dumps("a", 4), fauxAssistantMessage("A done")]);
			await run.prompt("task B", [...dumps("b", 4), fauxAssistantMessage("B done")]);
			// Task C crosses the 70% start threshold and triggers a background cycle, but prompt() returns immediately!
			await run.prompt("task C", [...dumps("c", 5), fauxAssistantMessage("C done")]);
			await plannerStarted;
			// Foreground prompt is already settled while the background planner is still waiting on plannerGate!
			allowPlannerFinish();
			await new Promise((resolve) => setTimeout(resolve, 30));
			expect(run.reports.some((r) => r.outcome === "committed")).toBe(true);
			expect(findIncompleteBatches(run.sessionManager.getBranch())).toHaveLength(1);

			// Next user prompt ("你加上吧") runs immediately, receives the compacted context in memory, and persists the batch!
			await run.prompt("你加上吧", [fauxAssistantMessage("applied")]);
			const lastReq = run.requests.at(-1)!;
			expect(textOf(lastReq)).toContain("Live Compact history summary v1");
			expect(textOf(lastReq)).not.toContain("a1 line 0000");
			expect(findIncompleteBatches(run.sessionManager.getBranch())).toEqual([]);
		} finally {
			await run.dispose();
		}
	});

});
