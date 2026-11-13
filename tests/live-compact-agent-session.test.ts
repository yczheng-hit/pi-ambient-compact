/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
/**
 * Live Compact against a real Pi AgentSession: persisted context edits through the
 * public turn_end boundary, recent-round protection, recall of condensed results,
 * and no native compaction while local condensing keeps the context in band.
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionFactory,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type FauxResponseStep,
} from "@earendil-works/pi-ai/providers/faux";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type SolPiConfig } from "../src/sol-pi/config.ts";
import { LIVE_CARD_HEADER } from "../src/sol-pi/extensions/live-compact/card.ts";
import type { LiveCompactSnapshot } from "../src/sol-pi/extensions/live-compact/index.ts";
import { createLiveCompactExtension } from "../src/sol-pi/extensions/live-compact/index.ts";
import { createObservationPackExtension } from "../src/sol-pi/extensions/observation-pack/index.ts";
import { parseLiveCompactConfig } from "../src/sol-pi/live-compact-config.mjs";
import { registerConfiguredFeatures } from "../src/sol-pi/index.ts";

const CONTEXT_WINDOW = 40_000;
/** Pi's own threshold sits above the 80% ceiling: 40_000 - 2_048. */
const COMPACTION = { enabled: true, reserveTokens: 2_048, keepRecentTokens: 20_000 };

function dumpText(label: string, kb: number): string {
	const line = (index: number) => `${label} line ${String(index).padStart(5, "0")} ${"x".repeat(48)}\n`;
	const lines: string[] = [];
	let bytes = 0;
	for (let index = 0; bytes < kb * 1024; index += 1) {
		const next = line(index);
		lines.push(next);
		bytes += next.length;
	}
	return lines.join("");
}

const dumpTool: ExtensionFactory = (pi) => {
	pi.registerTool({
		name: "dump",
		label: "Dump",
		description: "Return a large deterministic text block.",
		parameters: Type.Object({ label: Type.String(), kb: Type.Integer({ minimum: 1 }) }),
		async execute(_id, params) {
			return { content: [{ type: "text", text: dumpText(params.label, params.kb) }], details: undefined };
		},
	});
};

function dumpRounds(count: number, kb = 24): FauxResponseStep[] {
	return Array.from({ length: count }, (_, index) =>
		fauxAssistantMessage(fauxToolCall("dump", { label: `r${index + 1}`, kb }, { id: `call-${index + 1}` }), {
			stopReason: "toolUse",
		}),
	);
}

type Run = {
	readonly sessionManager: SessionManager;
	readonly compactionReasons: string[];
	readonly snapshots: LiveCompactSnapshot[];
	readonly extensionErrors: string[];
	readonly prompt: (text: string, responses: FauxResponseStep[]) => Promise<void>;
};

async function withSession(
	options: {
		readonly name: string;
		readonly live: boolean;
		readonly liveConfig?: unknown;
		readonly compaction?: { enabled: boolean; reserveTokens: number; keepRecentTokens: number };
	},
	body: (run: Run) => Promise<void>,
): Promise<void> {
	const cwd = await mkdtemp(join(tmpdir(), "sol-pi-live-session-"));
	const agentDir = join(cwd, "agent");
	await mkdir(agentDir);
	const faux = fauxProvider({
		provider: `sol-pi-live-${options.name}`,
		api: `sol-pi-live-api-${options.name}`,
		models: [{ id: `sol-pi-live-model-${options.name}`, contextWindow: CONTEXT_WINDOW, maxTokens: 1_024 }],
	});
	const compactionReasons: string[] = [];
	const snapshots: LiveCompactSnapshot[] = [];
	const liveCompact = parseLiveCompactConfig(options.liveConfig ?? { enabled: true });
	const extension: ExtensionFactory = (pi) => {
		pi.registerProvider(faux.provider);
		pi.on("session_before_compact", (event) => {
			compactionReasons.push(event.reason);
			// Deterministic summary, so a native compaction never consumes a scripted response.
			return {
				compaction: {
					summary: "deterministic native summary",
					firstKeptEntryId: event.preparation.firstKeptEntryId,
					tokensBefore: event.preparation.tokensBefore,
				},
			};
		});
		if (options.live) {
			createObservationPackExtension({ legacyProjection: false })(pi);
			createLiveCompactExtension({ config: liveCompact, onSnapshot: (snapshot) => snapshots.push(snapshot) })(pi);
		}
	};

	const settingsManager = SettingsManager.inMemory({ compaction: options.compaction ?? COMPACTION, retry: { enabled: false } });
	const sessionManager = SessionManager.inMemory(cwd);
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		extensionFactories: [
			{ name: `live-dump-${options.name}`, factory: dumpTool },
			{ name: `live-test-${options.name}`, factory: extension },
		],
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPrompt: "You are a deterministic Live Compact test assistant.",
	});
	await resourceLoader.reload();
	expect(resourceLoader.getExtensions().errors).toEqual([]);
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		model: faux.getModel(),
		thinkingLevel: "off",
		tools: options.live ? ["dump", "obs_recall"] : ["dump"],
		resourceLoader,
		sessionManager,
		settingsManager,
	});
	const extensionErrors: string[] = [];
	session.extensionRunner.onError((error) => extensionErrors.push(`${error.event}: ${error.error}`));
	try {
		await body({
			sessionManager,
			compactionReasons,
			snapshots,
			extensionErrors,
			prompt: async (text, responses) => {
				faux.setResponses(responses);
				await session.prompt(text, { expandPromptTemplates: false, source: "interactive" });
				expect(faux.getPendingResponseCount()).toBe(0);
			},
		});
		expect(extensionErrors).toEqual([]);
	} finally {
		session.dispose();
		await rm(cwd, { recursive: true, force: true });
	}
}

function contextEdits(sessionManager: SessionManager) {
	return sessionManager.getBranch().filter((entry) => entry.type === "context_edit");
}

/** Projected text of the tool result for `toolCallId`. */
function projectedResult(sessionManager: SessionManager, toolCallId: string): string | undefined {
	for (const message of sessionManager.buildSessionProjection().messages) {
		if (message.role === "toolResult" && message.toolCallId === toolCallId) {
			return message.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
		}
	}
	return undefined;
}

describe("Live Compact in a Pi AgentSession", () => {
	it("leaves a small context untouched", async () => {
		await withSession({ name: "small", live: true }, async ({ prompt, sessionManager, compactionReasons, snapshots }) => {
			await prompt("dump twice", [...dumpRounds(2), fauxAssistantMessage("done")]);
			expect(contextEdits(sessionManager)).toEqual([]);
			expect(compactionReasons).toEqual([]);
			expect(snapshots.at(-1)?.decision?.action).toBe("idle");
		});
	});

	it("condenses only old results, keeps recent rounds verbatim, and avoids native compaction", async () => {
		await withSession({ name: "pressure", live: true }, async ({ prompt, sessionManager, compactionReasons, snapshots }) => {
			await prompt("dump many times", [...dumpRounds(8), fauxAssistantMessage("done")]);

			expect(compactionReasons).toEqual([]);
			const edits = contextEdits(sessionManager);
			expect(edits.length).toBeGreaterThan(0);

			// The three most recent rounds stay verbatim; condensed ones carry a card.
			for (const call of ["call-6", "call-7", "call-8"]) {
				expect(projectedResult(sessionManager, call)).not.toContain(LIVE_CARD_HEADER);
			}
			expect(projectedResult(sessionManager, "call-1")).toContain(LIVE_CARD_HEADER);
			// Oldest first: no newer result is condensed while an older eligible one is verbatim.
			const condensed = Array.from({ length: 8 }, (_, index) =>
				projectedResult(sessionManager, `call-${index + 1}`)?.includes(LIVE_CARD_HEADER) ?? false,
			);
			expect(condensed.indexOf(false)).toBe(condensed.lastIndexOf(true) + 1);

			// Raw entries are never modified.
			const raw = sessionManager
				.getBranch()
				.find((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === "call-1");
			expect(raw?.type === "message" ? JSON.stringify((raw.message as { content?: unknown }).content) : "").toContain(
				"r1 line 00000",
			);

			const last = snapshots.at(-1)!;
			expect(last.levels?.ceiling).toBe(32_000);
			expect(last.afterTokens).toBeLessThanOrEqual(last.levels!.ceiling);
			expect(snapshots.some((snapshot) => snapshot.decision?.action === "reduce")).toBe(true);
			expect(last.calibration).toBeGreaterThan(0.5);
		});
	});

	it("recalls the exact original of a condensed result", async () => {
		await withSession({ name: "recall", live: true }, async ({ prompt, sessionManager }) => {
			await prompt("dump many times", [...dumpRounds(8), fauxAssistantMessage("done")]);
			const card = projectedResult(sessionManager, "call-1")!;
			const id = /^id: (obs_[a-f0-9]{24})$/mu.exec(card)?.[1] ?? "";
			expect(id).toMatch(/^obs_/u);

			await prompt("recall the first dump", [
				fauxAssistantMessage(fauxToolCall("obs_recall", { id, offset: 0 }, { id: "recall-1" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("recalled"),
			]);
			const recalled = projectedResult(sessionManager, "recall-1")!;
			expect(recalled).toContain(`[obs_recall id=${id} offset=0`);
			expect(recalled).toContain(dumpText("r1", 24).slice(0, 2_000));
		});
	});

	it("follows non-default water levels and reports a shortfall instead of breaking recent-round protection", async () => {
		const liveConfig = { enabled: true, thresholds: { startRatio: 0.5, targetRatio: 0.45, ceilingRatio: 0.6 } };
		await withSession(
			{ name: "levels", live: true, liveConfig },
			async ({ prompt, sessionManager, snapshots, compactionReasons }) => {
				await prompt("dump many times", [...dumpRounds(6), fauxAssistantMessage("done")]);
				const last = snapshots.at(-1)!;
				expect(last.levels?.start).toBe(20_000);
				expect(last.levels?.target).toBe(18_000);
				expect(last.levels?.ceiling).toBe(24_000);
				// The first reduction happens at the configured 50% start, earlier than the default 70% would.
				const first = snapshots.find((snapshot) => snapshot.decision?.action === "reduce")!;
				expect(first.projectedTokens!).toBeGreaterThanOrEqual(20_000);
				expect(first.projectedTokens!).toBeLessThan(28_000);
				// Three protected 24 KiB rounds alone exceed this ceiling: they stay verbatim and the
				// unreclaimable remainder is reported, not hidden.
				// Every eligible older round was condensed before the shortfall was declared.
				for (const call of ["call-1", "call-2", "call-3"]) {
					expect(projectedResult(sessionManager, call)).toContain(LIVE_CARD_HEADER);
				}
				for (const call of ["call-4", "call-5", "call-6"]) {
					expect(projectedResult(sessionManager, call)).not.toContain(LIVE_CARD_HEADER);
				}
				expect(last.afterTokens!).toBeGreaterThan(24_000);
				expect(last.lastShortfallTokens).toBeGreaterThan(0);
				expect(last.afterTokens!).toBeLessThan(last.levels!.safeInputLimit);
				expect(compactionReasons).toEqual([]);
			},
		);
	});

	it("brings the context back into a non-default band when the protected rounds fit", async () => {
		const liveConfig = {
			enabled: true,
			thresholds: { startRatio: 0.5, targetRatio: 0.45, ceilingRatio: 0.6 },
			observation: { excerptTargetBytes: 2_048 },
		};
		await withSession({ name: "band", live: true, liveConfig }, async ({ prompt, sessionManager, snapshots, compactionReasons }) => {
			await prompt("dump many small-ish blocks", [...dumpRounds(12, 12), fauxAssistantMessage("done")]);
			const last = snapshots.at(-1)!;
			expect(snapshots.filter((snapshot) => snapshot.decision?.action === "reduce").length).toBeGreaterThan(1);
			expect(last.afterTokens!).toBeLessThanOrEqual(last.levels!.ceiling);
			expect(last.lastShortfallTokens).toBe(0);
			// The smaller configured excerpt is used: a card stays well under the 12 KiB original.
			const card = projectedResult(sessionManager, "call-1")!;
			expect(card).toContain(LIVE_CARD_HEADER);
			expect(Buffer.byteLength(card, "utf8")).toBeLessThan(3_000);
			expect(compactionReasons).toEqual([]);
		});
	});

	it("keeps its levels under Pi's default compaction threshold, so Pi's native compaction never preempts it", async () => {
		const liveConfig = { enabled: true, observation: { excerptTargetBytes: 2_048 } };
		const compaction = { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 };
		await withSession(
			{ name: "pi-threshold", live: true, liveConfig, compaction },
			async ({ prompt, snapshots, compactionReasons }) => {
				await prompt("dump many blocks", [...dumpRounds(12, 12), fauxAssistantMessage("done")]);
				const last = snapshots.at(-1)!;
				// Pi compacts above 40_000 - 16_384 = 23_616; the 80% ceiling (32_000) would be too late.
				expect(last.levels?.compactionLimit).toBe(23_616 - 800);
				expect(last.levels?.clamped).toBe(true);
				expect(last.levels?.ceiling).toBe(last.levels?.compactionLimit);
				expect(snapshots.some((snapshot) => snapshot.decision?.action === "reduce")).toBe(true);
				expect(compactionReasons).toEqual([]);
			},
		);
	});

	it("baseline: without Live Compact the same session hits Pi's native compaction", async () => {
		await withSession({ name: "baseline", live: false }, async ({ prompt, sessionManager, compactionReasons }) => {
			await prompt("dump many times", [...dumpRounds(8), fauxAssistantMessage("done")]);
			expect(compactionReasons).toContain("threshold");
			expect(contextEdits(sessionManager)).toEqual([]);
		});
	});
});

describe("Live Compact feature wiring", () => {
	type Registered = { tools: string[]; events: string[]; commands: string[] };
	const register = (config: SolPiConfig, piVersion = "1.5.2"): Registered => {
		const registered: Registered = { tools: [], events: [], commands: [] };
		const pi = {
			registerTool: (tool: { name: string }) => registered.tools.push(tool.name),
			on: (event: string) => registered.events.push(event),
			registerCommand: (name: string) => registered.commands.push(name),
			registerMessageRenderer: () => undefined,
			registerShortcut: () => undefined,
			registerFlag: () => undefined,
		};
		registerConfiguredFeatures(pi as never, config, undefined, piVersion);
		return registered;
	};

	it("keeps the legacy mechanisms and registers only a notice on Pi without the boundary API", () => {
		const base = { ...DEFAULT_CONFIG, observationPack: true, onlineContextCompact: true };
		const legacy = register(base);
		const old = register({ ...base, liveCompact: parseLiveCompactConfig({ enabled: true }) }, "0.86.9");
		expect(old.commands).not.toContain("ambient-compact");
		// ObservationPack keeps its context handler; the notice adds one session_start handler.
		expect(old.events.filter((event) => event === "context").length).toBe(
			legacy.events.filter((event) => event === "context").length,
		);
		expect(old.events.filter((event) => event === "turn_end").length).toBe(
			legacy.events.filter((event) => event === "turn_end").length,
		);
		expect(old.events.filter((event) => event === "session_start").length).toBe(
			legacy.events.filter((event) => event === "session_start").length + 1,
		);
		expect(register({ ...base, liveCompact: parseLiveCompactConfig({ enabled: true }) }, "0.87.0").commands).toContain(
			"ambient-compact",
		);
	});

	it("registers the dynamic-ai strategy's recall tool and boundaries", () => {
		const base = { ...DEFAULT_CONFIG, observationPack: true, onlineContextCompact: true };
		const dynamic = register({ ...base, liveCompact: parseLiveCompactConfig({ enabled: true, strategy: "dynamic-ai" }) });
		expect(dynamic.tools).toContain("context_recall");
		expect(dynamic.commands).toEqual(["ambient-compact"]);
		for (const event of ["turn_end", "agent_before_settle", "context", "input", "session_before_compact", "model_select"]) {
			expect(dynamic.events).toContain(event);
		}
		const local = register({ ...base, liveCompact: parseLiveCompactConfig({ enabled: true }) });
		expect(local.tools).not.toContain("context_recall");
		expect(local.events).not.toContain("agent_before_settle");
	});

	it("disables ObservationPack's legacy projection and registers Live Compact only when enabled", () => {
		const base = { ...DEFAULT_CONFIG, observationPack: true, onlineContextCompact: true };
		const legacy = register(base);
		expect(legacy.events).toContain("context");
		expect(legacy.commands).not.toContain("ambient-compact");

		const live = register({ ...base, liveCompact: parseLiveCompactConfig({ enabled: true }) });
		expect(live.tools).toContain("obs_recall");
		expect(live.commands).toEqual(["ambient-compact"]);
		// ObservationPack registers no context handler; OCC still observes context for request counts.
		expect(live.events.filter((event) => event === "context").length).toBe(
			legacy.events.filter((event) => event === "context").length - 1,
		);
	});
});
