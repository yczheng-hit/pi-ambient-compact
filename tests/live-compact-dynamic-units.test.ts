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
