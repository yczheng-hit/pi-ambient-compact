/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
/** dynamic-ai pure parts: the segment index, segment edits, and the AI planner with a fake model. */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionContext, ProjectedSessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { createAiPlanner, parseSelections, parseVerdicts, summaryCap, type CompleteFn } from "../src/sol-pi/extensions/live-compact/ai-planner.ts";
import { RouteUnavailableError } from "../src/sol-pi/extensions/live-compact/model-call.ts";
import { indexSegments, type Segment, segmentEdits, summaryCarrierText } from "../src/sol-pi/extensions/live-compact/segments.ts";
import { validateToolPairing } from "../src/sol-pi/extensions/live-compact/validator.ts";
import { parseLiveCompactConfig } from "../src/sol-pi/live-compact-config.mjs";

let ids = 0;
const big = (label: string) => `${label}\n${"y".repeat(8_000)}`;
function entry(message: AgentMessage, projected: AgentMessage[] = [message]): ProjectedSessionEntry {
	ids += 1;
	return { sourceEntry: { type: "message", id: `e${ids}`, parentId: null, timestamp: "", message }, messages: projected } as unknown as ProjectedSessionEntry;
}
const user = (text: string) => entry({ role: "user", content: [{ type: "text", text }], timestamp: ids } as unknown as AgentMessage);
const call = (id: string, extra: Record<string, unknown> = {}) =>
	entry({ role: "assistant", content: [{ type: "text", text: `calling ${id}` }, { type: "toolCall", id, name: "dump", arguments: { label: id } }], stopReason: "toolUse", timestamp: ids, ...extra } as unknown as AgentMessage);
const result = (id: string, extra: Record<string, unknown> = {}) =>
	entry({ role: "toolResult", toolCallId: id, toolName: "dump", content: [{ type: "text", text: big(id) }], isError: false, timestamp: ids, ...extra } as unknown as AgentMessage);
const answer = (text: string) => entry({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp: ids } as unknown as AgentMessage);
const system = () => entry({ role: "system", content: "", sections: { base: "s" }, timestamp: ids } as unknown as AgentMessage);

/** Task A (3 rounds, done), task B (5 rounds, running). */
function twoTasks(): ProjectedSessionEntry[] {
	return [
		system(),
		user("task A"),
		...["a1", "a2", "a3"].flatMap((id) => [call(id), result(id)]),
		answer("A done"),
		user("task B"),
		...["b1", "b2", "b3", "b4", "b5"].flatMap((id) => [call(id), result(id)]),
	];
}

function applyEdits(entries: readonly ProjectedSessionEntry[], segment: Segment, text: string): AgentMessage[] {
	const edits = new Map(segmentEdits(segment, text).map((edit) => [edit.targetId, edit]));
	return entries.flatMap((item) =>
		item.messages.flatMap((message) => {
			const edit = edits.get(item.sourceEntry.id);
			if (!edit) return [message];
			if (edit.replacement === null) return [];
			return [{ ...message, content: edit.replacement.content } as AgentMessage];
		}),
	);
}

describe("segment index", () => {
	it("offers the finished episode whole and the running episode's older rounds", () => {
		const entries = twoTasks();
		const index = indexSegments(entries, { keepRecentToolRounds: 3 });
		expect(index.segments.map((segment) => [segment.kind, segment.messages.length])).toEqual([
			["episode", 7],
			["rounds", 4],
		]);
		expect(index.kept.recent_round).toBe(3);
	});

	it("produces edits that keep tool pairing and role order for both shapes", () => {
		const entries = twoTasks();
		for (const segment of indexSegments(entries, { keepRecentToolRounds: 3 }).segments) {
			const edited = applyEdits(entries, segment, summaryCarrierText(segment, "summary"));
			expect(validateToolPairing(edited), segment.kind).toEqual([]);
			expect(JSON.stringify(edited)).toContain("Live Compact history summary v1");
		}
	});

	it("keeps unsafe rounds verbatim and splits runs around them", () => {
		const entries = [
			user("task"),
			call("r1"), result("r1"),
			call("r2"), result("r2", { isError: true }),
			call("r3"), result("r3"),
			call("r4"), result("r4", { content: [{ type: "text", text: big("r4") }, { type: "image", data: "", mimeType: "image/png" }] }),
			call("r5"), result("r5"),
			call("p1"), result("p1"),
		];
		const index = indexSegments(entries, { keepRecentToolRounds: 1, minSegmentTokens: 1 });
		expect(index.kept).toMatchObject({ error_result: 1, non_text_result: 1, recent_round: 1 });
		expect(index.segments.map((segment) => segment.messages.map((item) => (item.message as { toolCallId?: string }).toolCallId).filter(Boolean))).toEqual([
			["r1"],
			["r3"],
			["r5"],
		]);
	});

	it("never offers edited messages, user turns, or the latest answer", () => {
		const editedResult = result("a2");
		const entries = [
			user("task A"),
			call("a1"), result("a1"),
			call("a2"),
			{ ...editedResult, messages: [{ ...editedResult.messages[0]!, content: [{ type: "text", text: "card" }] } as AgentMessage] },
			answer("A done"),
			user("task B"),
			call("b1"), result("b1"),
			answer("B done"),
		];
		const index = indexSegments(entries, { keepRecentToolRounds: 0, minSegmentTokens: 1 });
		// Task A has an edited round, so only its unedited round is offered; task B's answer stays.
		const offered = index.segments.flatMap((segment) => segment.messages.map((item) => item.message.role + ":" + JSON.stringify(item.message).slice(0, 0)));
		expect(index.segments.some((segment) => segment.kind === "episode")).toBe(false);
		expect(index.kept.edited).toBe(1);
		expect(offered.length).toBeGreaterThan(0);
		for (const segment of index.segments) {
			for (const item of segment.messages) {
				expect(item.message.role).not.toBe("user");
				expect(JSON.stringify(item.message)).not.toContain("B done");
			}
		}
	});

	it("caps rounds per segment and skips segments too small to matter", () => {
		const entries = [user("task"), ...Array.from({ length: 10 }, (_, i) => [call(`r${i}`), result(`r${i}`)]).flat()];
		const index = indexSegments(entries, { keepRecentToolRounds: 0, maxRoundsPerSegment: 4 });
		expect(index.segments.map((segment) => segment.messages.length)).toEqual([8, 8, 4]);
		expect(indexSegments(entries, { keepRecentToolRounds: 0, minSegmentTokens: 1_000_000 }).segments).toEqual([]);
	});
});

// ---------------------------------------------------------------------------------------------

const config = parseLiveCompactConfig({ enabled: true, strategy: "dynamic-ai" });
const model = { provider: "p", id: "m", contextWindow: 200_000, maxTokens: 16_000 };
const ctx = { model, modelRegistry: { find: () => undefined } } as unknown as ExtensionContext;
const segments = indexSegments(twoTasks(), { keepRecentToolRounds: 3 }).segments;
const request = (signal = new AbortController().signal) => ({ candidates: segments, reclaimTokens: 3_000, userTurns: ["task A", "task B"], signal });

type Answer = { text: string; stopReason?: "stop" | "length" | "error" };
function fakeComplete(answers: Answer[]): { complete: CompleteFn; prompts: string[] } {
	const prompts: string[] = [];
	const complete: CompleteFn = async (_ctx, _model, call) => {
		prompts.push(call.prompt);
		const next = answers.shift();
		if (!next) throw new Error("unexpected model call");
		return { text: next.text, ok: (next.stopReason ?? "stop") === "stop", stopReason: next.stopReason ?? "stop", inputTokens: 10, outputTokens: 5 };
	};
	return { complete, prompts };
}
const select = (...items: Array<[string, string]>) => JSON.stringify({ selections: items.map(([segment, summary]) => ({ segment, summary })) });
const verdicts = (...items: Array<[string, boolean, string[]?]>) =>
	JSON.stringify({ verdicts: items.map(([segment, ok, problems]) => ({ segment, ok, problems: problems ?? [] })) });

describe("AI planner", () => {
	const [episode, rounds] = segments as [Segment, Segment];

	it("returns only verified summaries in two calls", async () => {
		const { complete, prompts } = fakeComplete([
			{ text: "```json\n" + select([episode.id, "Task A dumped a1-a3; done."], [rounds.id, "b1-b2 dumped."]) + "\n```" },
			{ text: verdicts([episode.id, true], [rounds.id, true]) },
		]);
		const plan = await createAiPlanner({ config, complete })(request(), ctx);
		expect(plan.selections.map((selection) => selection.segmentId)).toEqual([episode.id, rounds.id]);
		expect(plan.usage).toEqual({ calls: 2, inputTokens: 20, outputTokens: 10 });
		// The generation prompt carries the user turns and segment transcripts; verification gets the original.
		expect(prompts[0]).toContain("- task A");
		expect(prompts[0]).toContain(`<segment id="${episode.id}" kind="episode"`);
		expect(prompts[1]).toContain("<original>");
		expect(prompts[1]).toContain("a1\nyyyy");
	});

	it("regenerates a rejected summary once with the problems and verifies it again", async () => {
		const { complete, prompts } = fakeComplete([
			{ text: select([episode.id, "Task A succeeded."], [rounds.id, "b1-b2 dumped."]) },
			{ text: verdicts([episode.id, false, ["claims success not in the original"]], [rounds.id, true]) },
			{ text: select([episode.id, "Task A dumped a1-a3."]) },
			{ text: verdicts([episode.id, true]) },
		]);
		const plan = await createAiPlanner({ config, complete })(request(), ctx);
		expect(plan.selections.map((selection) => selection.segmentId).sort()).toEqual([episode.id, rounds.id].sort());
		expect(plan.usage.calls).toBe(4);
		expect(prompts[2]).toContain("claims success not in the original");
		expect(prompts[2]).not.toContain(`<segment id="${rounds.id}"`);
	});

	it("stops at the call budget and drops summaries still unverified", async () => {
		const tight = parseLiveCompactConfig({ enabled: true, strategy: "dynamic-ai", maintenance: { maxCallsPerCycle: 2 } });
		const { complete } = fakeComplete([
			{ text: select([episode.id, "x"]) },
			{ text: verdicts([episode.id, false, ["wrong"]]) },
		]);
		const plan = await createAiPlanner({ config: tight, complete })(request(), ctx);
		expect(plan.selections).toEqual([]);
		expect(plan.usage.calls).toBe(2);
	});

	it("treats a truncated, malformed, or verdict-less answer as no result", async () => {
		const truncated = fakeComplete([{ text: select([episode.id, "x"]), stopReason: "length" }]);
		expect((await createAiPlanner({ config, complete: truncated.complete })(request(), ctx)).selections).toEqual([]);
		const malformed = fakeComplete([{ text: "I would summarize episode one." }]);
		const plan = await createAiPlanner({ config, complete: malformed.complete })(request(), ctx);
		expect(plan.selections).toEqual([]);
		expect(plan.notes).toContain("generation answer was not the expected JSON");
		const missing = fakeComplete([{ text: select([episode.id, "x"]) }, { text: verdicts() }, { text: select() }]);
		expect((await createAiPlanner({ config, complete: missing.complete })(request(), ctx)).selections).toEqual([]);
	});

	it("rejects unknown, duplicate, empty, and oversized summaries", () => {
		const byId = new Map(segments.map((segment) => [segment.id, segment]));
		const parsed = parseSelections(
			select(["seg_unknown", "x"], [episode.id, "fine"], [episode.id, "again"], [rounds.id, ""], [rounds.id, "w ".repeat(summaryCap(rounds) * 4)]),
			byId,
		);
		expect(parsed.selections).toEqual([{ segmentId: episode.id, summary: "fine" }]);
		expect(parsed.notes).toEqual([
			"unknown segment seg_unknown",
			`duplicate selection ${episode.id}`,
			`empty summary for ${rounds.id}`,
			`summary too long for ${rounds.id}`,
		]);
		expect(parseVerdicts("not json").size).toBe(0);
		expect(parseVerdicts(verdicts([episode.id, "yes" as unknown as boolean])).get(episode.id)?.ok).toBe(false);
	});

	it("fails clearly when an explicit route is not registered, without trying another provider", async () => {
		const routed = parseLiveCompactConfig({ enabled: true, strategy: "dynamic-ai", summary: { provider: "nvidia-inference", model: "nvidia/deepseek-ai/eccn-deepseek-v4.1-flash-1017" } });
		const { complete } = fakeComplete([]);
		await expect(createAiPlanner({ config: routed, complete })(request(), ctx)).rejects.toBeInstanceOf(RouteUnavailableError);
	});

	it("drops the newest candidates that do not fit a small summary model window", async () => {
		const small = { ...ctx, model: { ...model, contextWindow: 17_000 } } as unknown as ExtensionContext;
		const { complete, prompts } = fakeComplete([{ text: select([episode.id, "x"]) }, { text: verdicts([episode.id, true]) }]);
		const plan = await createAiPlanner({ config, complete })(request(), small);
		expect(prompts[0]).toContain(episode.id);
		expect(prompts[0]).not.toContain(rounds.id);
		expect(plan.notes).toContain("1 candidate(s) did not fit the summary model");
	});
});

// ---------------------------------------------------------------------------------------------

import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { isTransientFailure } from "../src/sol-pi/extensions/live-compact/ai-planner.ts";
import { parseRouteArgument, ROUTES_ENTRY, RouteStore, writeGlobalRoute } from "../src/sol-pi/extensions/live-compact/routes.ts";

describe("model routes", () => {
	const routeEntry = (data: unknown) => ({ type: "custom", id: `r${ids++}`, parentId: null, timestamp: "", customType: ROUTES_ENTRY, data }) as unknown as SessionEntry;
	const fileConfig = (summary?: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
		version: 1,
		observationPack: true,
		liveCompact: { enabled: true, strategy: "dynamic-ai", ...(summary ? { summary } : {}) },
		...extra,
	});

	it("parses provider/model ids with slashes, default, and rejects the rest", () => {
		expect(parseRouteArgument("nvidia-inference/nvidia/deepseek-ai/eccn-deepseek-v4.1-flash-1017")).toEqual({
			provider: "nvidia-inference",
			model: "nvidia/deepseek-ai/eccn-deepseek-v4.1-flash-1017",
		});
		expect(parseRouteArgument("default")).toBeNull();
		for (const bad of ["", "nomodel", "/model", "provider/"]) expect(parseRouteArgument(bad)).toBeUndefined();
	});

	it("applies session over global over startup, and re-reads the global file when it changes", () => {
		const dir = mkdtempSync(join(tmpdir(), "lc-routes-"));
		try {
			const path = join(dir, "sol-pi.json");
			writeFileSync(path, JSON.stringify(fileConfig({ provider: "g", model: "one", timeoutMs: 60_000 })));
			const store = new RouteStore(parseLiveCompactConfig({ enabled: true, strategy: "dynamic-ai", summary: { provider: "s", model: "start" } }));
			expect(store.effective([], undefined).summary).toMatchObject({ source: "startup", call: { provider: "s", model: "start" } });
			expect(store.effective([], path).summary).toMatchObject({ source: "global", call: { provider: "g", model: "one", timeoutMs: 60_000 } });
			// A session override wins and keeps the global route options; null follows the working model.
			const session = store.effective([routeEntry({ v: 1, summary: { provider: "x", model: "sess" } })], path).summary;
			expect(session).toMatchObject({ source: "session", call: { provider: "x", model: "sess", timeoutMs: 60_000 } });
			const cleared = store.effective([routeEntry({ v: 1, summary: null })], path).summary;
			expect(cleared.source).toBe("session");
			expect(cleared.call.provider).toBeUndefined();
			// The latest override of a kind wins; another kind is untouched.
			const branch = [routeEntry({ v: 1, summary: { provider: "x", model: "a" } }), routeEntry({ v: 1, verification: { provider: "x", model: "v" } })];
			expect(store.effective(branch, path).summary.call.model).toBe("a");
			expect(store.effective(branch, path).verification).toMatchObject({ source: "session", call: { model: "v" } });
			// Another session changes the global file: the next read sees it.
			writeFileSync(path, JSON.stringify(fileConfig({ provider: "g", model: "two" })));
			utimesSync(path, new Date(), new Date(Date.now() + 5_000));
			expect(store.effective([], path).summary.call.model).toBe("two");
			// A broken file keeps the last good routes and reports the error.
			writeFileSync(path, "{ not json");
			utimesSync(path, new Date(), new Date(Date.now() + 10_000));
			const broken = store.effective([], path);
			expect(broken.summary.call.model).toBe("two");
			expect(broken.globalError).toBeDefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("writes a global route atomically, keeps other settings, and refuses an invalid file", () => {
		const dir = mkdtempSync(join(tmpdir(), "lc-routes-"));
		try {
			const path = join(dir, "sol-pi.json");
			writeFileSync(path, JSON.stringify(fileConfig({ timeoutMs: 60_000 }, { actionFusion: false })));
			writeGlobalRoute(path, "summary", { provider: "p", model: "m/x" });
			const written = JSON.parse(readFileSync(path, "utf8"));
			expect(written.actionFusion).toBe(false);
			expect(written.liveCompact.summary).toEqual({ timeoutMs: 60_000, provider: "p", model: "m/x" });
			writeGlobalRoute(path, "summary", null);
			expect(JSON.parse(readFileSync(path, "utf8")).liveCompact.summary).toEqual({ timeoutMs: 60_000 });
			writeGlobalRoute(path, "verification", null);
			expect(JSON.parse(readFileSync(path, "utf8")).liveCompact.verification).toBeUndefined();
			// A file that would not load is left unchanged.
			const invalid = JSON.stringify(fileConfig(undefined, { evidencePreservingReducer: true }));
			writeFileSync(path, invalid);
			expect(() => writeGlobalRoute(path, "summary", { provider: "p", model: "m" })).toThrow(/cannot be combined/u);
			expect(readFileSync(path, "utf8")).toBe(invalid);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("AI planner robustness", () => {
	const [episode] = segments as [Segment, Segment];
	const rateLimited = { text: "", stopReason: "error" as const, errorMessage: "429: Rate limit exceeded" };

	it("recognizes transient failures only", () => {
		expect(isTransientFailure({ ...rateLimited, ok: false, inputTokens: 0, outputTokens: 0 })).toBe(true);
		expect(isTransientFailure({ text: "", ok: false, stopReason: "error", errorMessage: "503 Service Unavailable", inputTokens: 0, outputTokens: 0 })).toBe(true);
		expect(isTransientFailure({ text: "", ok: false, stopReason: "error", errorMessage: "401 invalid api key", inputTokens: 0, outputTokens: 0 })).toBe(false);
		expect(isTransientFailure({ text: "", ok: false, stopReason: "length", inputTokens: 0, outputTokens: 0 })).toBe(false);
	});

	function failingThen(answers: Array<{ text: string; stopReason?: "stop" | "error"; errorMessage?: string }>): { complete: CompleteFn; calls: () => number } {
		let calls = 0;
		const complete: CompleteFn = async () => {
			calls += 1;
			const next = answers.shift();
			if (!next) throw new Error("unexpected model call");
			const stopReason = next.stopReason ?? "stop";
			return { text: next.text, ok: stopReason === "stop", stopReason, inputTokens: 1, outputTokens: 1, ...(next.errorMessage ? { errorMessage: next.errorMessage } : {}) };
		};
		return { complete, calls: () => calls };
	}

	it("retries a rate-limited call with growing waits, then succeeds", async () => {
		const waits: number[] = [];
		const { complete, calls } = failingThen([rateLimited, rateLimited, { text: select([episode.id, "ok"]) }, { text: verdicts([episode.id, true]) }]);
		const plan = await createAiPlanner({ config, complete, sleep: async (ms) => void waits.push(ms) })(request(), ctx);
		expect(plan.selections.map((selection) => selection.segmentId)).toEqual([episode.id]);
		expect(plan.failure).toBeUndefined();
		expect(waits).toEqual([5_000, 15_000]);
		expect(calls()).toBe(4);
	});

	it("reports a failure, not a declined plan, when retries run out", async () => {
		const { complete, calls } = failingThen([rateLimited, rateLimited, rateLimited]);
		const plan = await createAiPlanner({ config, complete, sleep: async () => undefined })(request(), ctx);
		expect(plan.selections).toEqual([]);
		expect(plan.failure).toMatch(/generation stopped: error \(429: Rate limit exceeded\)/u);
		expect(calls()).toBe(3);
	});

	it("fits candidates to the route window in real tokens", async () => {
		const window = { ...ctx, model: { ...model, contextWindow: 40_000 } } as unknown as ExtensionContext;
		const loose = fakeComplete([{ text: select() }]);
		await createAiPlanner({ config, complete: loose.complete })({ ...request(), tokenRatio: 1 }, window);
		const tight = fakeComplete([{ text: select() }]);
		const plan = await createAiPlanner({ config, complete: tight.complete })({ ...request(), tokenRatio: 3 }, window);
		expect(loose.prompts[0]).toContain(segments[1]!.id);
		// With 3 real tokens per estimated token, only the first candidate fits.
		expect(tight.prompts[0]).not.toContain(segments[1]!.id);
		expect(plan.notes).toContain("1 candidate(s) did not fit the summary model");
	});

	it("uses the routes of the request over its own configuration", async () => {
		const seen: string[] = [];
		const complete: CompleteFn = async (_ctx, routeModel) => {
			seen.push(`${routeModel.provider}/${routeModel.id}`);
			return { text: select(), ok: true, stopReason: "stop", inputTokens: 0, outputTokens: 0 };
		};
		const registry = { find: (provider: string, id: string) => ({ ...model, provider, id }) };
		const routed = { ...ctx, modelRegistry: registry } as unknown as ExtensionContext;
		await createAiPlanner({ config, complete })(
			{ ...request(), routes: { summary: { ...config.summary, provider: "q", model: "fast" }, verification: config.verification } },
			routed,
		);
		expect(seen).toEqual(["q/fast"]);
	});
});

// ---------------------------------------------------------------------------------------------

import { Key } from "@earendil-works/pi-tui";
import { settingsMenu } from "../src/sol-pi/extensions/live-compact/settings-menu.ts";
import { buildLiveCompactSettingFields } from "../src/sol-pi/extensions/live-compact/settings-pane.ts";
import {
	configToSettingValues,
	LIVE_COMPACT_SESSION_SETTINGS_TYPE,
	LiveCompactConfigResolver,
	SettingsStore,
	sessionSettingsEntry,
	settingValuesToConfig,
} from "../src/sol-pi/extensions/live-compact/settings-store.ts";

describe("codex-settings style TUI settings menu & store", () => {
	const fakeTheme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	};
	const fakeKeys = {
		matches: (data: string, id: string) => {
			if (id === "tui.select.confirm") return data === "\r";
			if (id === "tui.select.cancel") return data === "\u001b";
			if (id === "tui.select.up") return data === "\u001b[A";
			if (id === "tui.select.down") return data === "\u001b[B";
			if (id === "tui.input.tab") return data === "\t";
			if (id === "tui.editor.deleteCharBackward") return data === "\u007f";
			return false;
		},
		getKeys: (id: string) => [id],
	};

	it("applies session settings without touching disk, saves to disk with Ctrl+S, and hot-reloads in other sessions", async () => {
		const dir = mkdtempSync(join(tmpdir(), "lc-settings-pane-"));
		try {
			const globalPath = join(dir, "sol-pi.json");
			writeFileSync(
				globalPath,
				JSON.stringify(
					{
						version: 1,
						actionFusion: false,
						observationPack: true,
						onlineContextCompact: true,
						liveCompact: { enabled: true, strategy: "dynamic-ai" },
					},
					null,
					2,
				),
			);
			const startup = parseLiveCompactConfig({ enabled: true, strategy: "dynamic-ai" });
			const store = new SettingsStore(globalPath, undefined, startup);
			const snapshot = await store.load();
			const fakeCtx = {
				modelRegistry: {
					getAvailable: () => [
						{ provider: "nvidia-inference", id: "nvidia/deepseek-ai/eccn-deepseek-v4.1-flash-1017" },
						{ provider: "nvidia-inference", id: "gcp/google/eccn-gemini-4-argon" },
					],
					find: (provider: string, id: string) => provider === "nvidia-inference" && id.length > 0,
				},
			} as unknown as ExtensionContext;
			const fields = buildLiveCompactSettingFields(fakeCtx);
			const sessionEntriesA: SessionEntry[] = [];
			const sessionEntriesB: SessionEntry[] = [];
			const sessionState = { changes: {} };
			let closed = false;
			let ranNow = 0;

			const factory = settingsMenu({
				title: "Ambient Compact Settings",
				store,
				snapshot,
				current: configToSettingValues(startup),
				session: sessionState,
				fields,
				status: (values) => `strategy=${values.strategy} summary=${values.summaryRoute ?? "working"}`,
				extraDetails: () => ["extra status line"],
				runNow: async () => {
					ranNow += 1;
					return "maintenance committed: 80% → 48%";
				},
				prepare: async () => undefined,
				guard: (values) => {
					settingValuesToConfig(values, startup);
				},
				apply: (values, nextSession) => {
					sessionEntriesA.push({
						type: "custom",
						id: `s-${sessionEntriesA.length}`,
						parentId: null,
						timestamp: "",
						customType: LIVE_COMPACT_SESSION_SETTINGS_TYPE,
						data: sessionSettingsEntry("sess-A", values, nextSession),
					} as unknown as SessionEntry);
				},
			});

			const comp = factory(
				{ requestRender: () => undefined, terminal: { rows: 30 } },
				fakeTheme as never,
				fakeKeys as never,
				() => {
					closed = true;
				},
			);
			comp. render(100);

			// Move down to "Summary model" (second field) and press Enter to open model picker.
			comp.handleInput!("\u001b[B");
			comp.handleInput!("\r");
			let rendered = comp.render(100).join("\n");
			expect(rendered).toContain("Summary model: Working model");
			expect(rendered).toContain("nvidia-inference/nvidia/deepseek-ai/eccn-deepseek-v4.1-flash-1017");

			// Move down to the DeepSeek model and select it with Enter (stages draft *).
			comp.handleInput!("\u001b[B");
			comp.handleInput!("\r");
			rendered = comp.render(100).join("\n");
			expect(rendered).toContain("1 draft change(s). Not applied.");
			expect(rendered).toContain("nvidia-inference/nvidia/deepseek-ai/eccn-deepseek-v4.1-flash-1017 *");

			// Tab once from results to reach actions ("Apply to session" is selected first) and press Enter.
			comp.handleInput!("\t");
			comp.handleInput!("\r");
			await new Promise((resolve) => setTimeout(resolve, 20));
			rendered = comp.render(100).join("\n");
			expect(rendered).toContain("Applied to session. Configuration files unchanged.");
			expect(rendered).toContain("nvidia-inference/nvidia/deepseek-ai/eccn-deepseek-v4.1-flash-1017 ~");

			// Disk file is still untouched, while Session A resolves the session override.
			expect(JSON.parse(readFileSync(globalPath, "utf8")).liveCompact.summary).toBeUndefined();
			const resolverA = new LiveCompactConfigResolver(startup);
			const resolverB = new LiveCompactConfigResolver(startup);
			const ctxA = {
				sessionManager: {
					getSessionId: () => "sess-A",
					getEntries: () => sessionEntriesA,
					getBranch: () => sessionEntriesA,
				},
			};
			const ctxB = {
				sessionManager: {
					getSessionId: () => "sess-B",
					getEntries: () => sessionEntriesB,
					getBranch: () => sessionEntriesB,
				},
			};
			expect(resolverA.resolve(ctxA, globalPath, fields).config.summary.model).toBe(
				"nvidia/deepseek-ai/eccn-deepseek-v4.1-flash-1017",
			);
			expect(resolverB.resolve(ctxB, globalPath, fields).config.summary.model).toBeUndefined();

			// Press Ctrl+S to persist the session override to disk; Session B hot-reloads it on its next resolve.
			comp.handleInput!("\x13");
			await new Promise((resolve) => setTimeout(resolve, 30));
			rendered = comp.render(100).join("\n");
			expect(rendered).toContain("Saved and applied.");
			const savedJson = JSON.parse(readFileSync(globalPath, "utf8"));
			expect(savedJson.actionFusion).toBe(false);
			expect(savedJson.liveCompact.summary).toEqual({
				provider: "nvidia-inference",
				model: "nvidia/deepseek-ai/eccn-deepseek-v4.1-flash-1017",
			});
			utimesSync(globalPath, new Date(), new Date(Date.now() + 5_000));
			expect(resolverB.resolve(ctxB, globalPath, fields).config.summary.model).toBe(
				"nvidia/deepseek-ai/eccn-deepseek-v4.1-flash-1017",
			);

			// Select "Run maintenance now" from actions (index 2: down twice) and press Enter.
			comp.handleInput!("\u001b[B");
			comp.handleInput!("\u001b[B");
			comp.handleInput!("\r");
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(ranNow).toBe(1);
			expect(comp.render(100).join("\n")).toContain("maintenance committed: 80% → 48%");

			// Press F1 to open details, then Escape to return, then Escape to close.
			comp.handleInput!("\u001bOP"); // F1
			expect(comp.render(100).join("\n")).toContain("extra status line");
			comp.handleInput!("\u001b");
			comp.handleInput!("\u001b");
			expect(closed).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
