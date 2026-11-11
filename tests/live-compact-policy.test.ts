/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
/** Live Compact pure functions: water levels, pressure decisions, candidate policy, and cards. */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ProjectedSessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	calibrationSample,
	decidePressure,
	estimateMessagesTokens,
	pressureLevels,
	requestInputTokens,
} from "../src/sol-pi/extensions/live-compact/budget.ts";
import { LIVE_CARD_HEADER, liveCard } from "../src/sol-pi/extensions/live-compact/card.ts";
import { scanCandidates } from "../src/sol-pi/extensions/live-compact/policy.ts";
import { createObservation } from "../src/sol-pi/extensions/observation-pack/observation.ts";
import { DEFAULT_LIVE_COMPACT_CONFIG as DEFAULTS, parseLiveCompactConfig } from "../src/sol-pi/live-compact-config.mjs";

describe("pressure levels", () => {
	it("derives the default 70/70/80 levels and the safe input limit", () => {
		const levels = pressureLevels(200_000, 8_192, DEFAULTS)!;
		expect(levels).toMatchObject({ outputReserve: 8_192, safetyMargin: 4_000, safeInputLimit: 187_808 });
		expect(levels).toMatchObject({ start: 140_000, target: 140_000, ceiling: 160_000, clamped: false });
	});

	it("caps the output reserve and adds the configured extra reserve", () => {
		const config = parseLiveCompactConfig({ budget: { extraReserveTokens: 5_000 } });
		const levels = pressureLevels(200_000, 128_000, config)!;
		expect(levels.outputReserve).toBe(32_768);
		expect(levels.safetyMargin).toBe(9_000);
		expect(levels.safeInputLimit).toBe(158_232);
	});

	it("lowers every level proportionally when the ceiling would exceed the safe limit", () => {
		const config = parseLiveCompactConfig({ thresholds: { startRatio: 0.8, targetRatio: 0.75, ceilingRatio: 0.95 } });
		const levels = pressureLevels(100_000, 16_384, config)!;
		expect(levels.clamped).toBe(true);
		expect(levels.ceiling).toBe(levels.safeInputLimit);
		expect(levels.start).toBeLessThan(levels.ceiling);
		expect(levels.target).toBeLessThanOrEqual(levels.start);
	});

	it("stays under Pi's own compaction threshold", () => {
		// 64K window, Pi's default 16,384 reserve: Pi compacts above 47,616 tokens.
		const levels = pressureLevels(64_000, 8_192, DEFAULTS, 16_384)!;
		expect(levels.compactionLimit).toBe(64_000 - 16_384 - 1_280);
		expect(levels.inputLimit).toBe(levels.compactionLimit);
		expect(levels.clamped).toBe(true);
		expect(levels.ceiling).toBe(levels.compactionLimit);
		expect(levels.start).toBeLessThan(levels.ceiling);
		// Pi's auto-compaction off, or a large window: the configured levels stand.
		expect(pressureLevels(64_000, 8_192, DEFAULTS)!.clamped).toBe(false);
		expect(pressureLevels(200_000, 8_192, DEFAULTS, 16_384)!).toMatchObject({ clamped: false, ceiling: 160_000 });
	});

	it("is unknown without a usable window", () => {
		expect(pressureLevels(undefined, 1_000, DEFAULTS)).toBeUndefined();
		expect(pressureLevels(0, 1_000, DEFAULTS)).toBeUndefined();
		expect(pressureLevels(1_000, 1_000, parseLiveCompactConfig({ budget: { extraReserveTokens: 900 } }))).toBeUndefined();
	});
});

describe("pressure decisions", () => {
	const levels = pressureLevels(100_000, 10_000, DEFAULTS)!; // start/target 70k, ceiling 80k

	it("does nothing below start, even with large predicted growth", () => {
		expect(decidePressure(50_000, 40_000, levels)).toMatchObject({ action: "idle", reclaimTokens: 0 });
	});

	it("watches inside the band when the next turn still fits", () => {
		expect(decidePressure(74_000, 5_000, levels)).toMatchObject({ action: "armed", reclaimTokens: 0 });
		expect(decidePressure(70_000, 0, levels).action).toBe("armed");
	});

	it("reduces back to target when growth would cross the ceiling", () => {
		expect(decidePressure(74_000, 9_000, levels)).toEqual({
			action: "reduce",
			reclaimTokens: 4_000,
			reason: "growth_crosses_ceiling",
		});
	});

	it("reclaims enough for the growth even when already at target", () => {
		expect(decidePressure(70_000, 15_000, levels)).toMatchObject({ action: "reduce", reclaimTokens: 5_000 });
	});

	it("reduces when over the ceiling", () => {
		expect(decidePressure(85_000, 0, levels)).toEqual({ action: "reduce", reclaimTokens: 15_000, reason: "over_ceiling" });
	});
});

describe("calibration", () => {
	it("reads input-side usage and clamps the ratio", () => {
		const message = { role: "assistant", usage: { input: 10, cacheRead: 80, cacheWrite: 10, output: 999 } } as unknown as AgentMessage;
		expect(requestInputTokens(message)).toBe(100);
		expect(calibrationSample(100, 50)).toBe(2);
		expect(calibrationSample(1_000, 10)).toBe(3);
		expect(calibrationSample(1, 10)).toBe(0.5);
		expect(calibrationSample(undefined, 10)).toBeUndefined();
		expect(requestInputTokens({ role: "user", content: "x" } as AgentMessage)).toBeUndefined();
	});

	it("charges images and tool declarations", () => {
		const image = { role: "user", content: [{ type: "image", data: "", mimeType: "image/png" }] } as unknown as AgentMessage;
		expect(estimateMessagesTokens([image])).toBe(1_204);
		const system = { role: "system", content: "", sections: { base: "s".repeat(4_000), skills: null } } as unknown as AgentMessage;
		expect(estimateMessagesTokens([system])).toBe(1_004);
	});
});

// --- candidate policy -----------------------------------------------------------------------

let nextId = 0;
function entry(message: AgentMessage, projected: AgentMessage[] = [message]): ProjectedSessionEntry {
	nextId += 1;
	return {
		sourceEntry: { type: "message", id: `e${nextId}`, parentId: null, timestamp: "", message },
		messages: projected,
	} as unknown as ProjectedSessionEntry;
}
const big = (label: string) => `${label}\n${"y".repeat(12_000)}\n`;
function call(id: string, name = "read"): AgentMessage {
	return { role: "assistant", content: [{ type: "toolCall", id, name, arguments: {} }], stopReason: "toolUse" } as unknown as AgentMessage;
}
function result(id: string, text: string, extra: Record<string, unknown> = {}): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		...extra,
	} as unknown as AgentMessage;
}
/** n sequential rounds, each one call and one large result, followed by a final assistant reply. */
function rounds(n: number): ProjectedSessionEntry[] {
	const entries: ProjectedSessionEntry[] = [];
	for (let index = 1; index <= n; index += 1) {
		entries.push(entry(call(`c${index}`)), entry(result(`c${index}`, big(`r${index}`))));
	}
	entries.push(entry({ role: "assistant", content: [{ type: "text", text: "ok" }] } as unknown as AgentMessage));
	return entries;
}
const ids = (scan: ReturnType<typeof scanCandidates>) =>
	scan.candidates.map((candidate) => (candidate.message as { toolCallId: string }).toolCallId);

describe("candidate policy", () => {
	it("protects the most recent tool rounds and returns older results oldest first", () => {
		const scan = scanCandidates(rounds(6), DEFAULTS);
		expect(ids(scan)).toEqual(["c1", "c2", "c3"]);
		expect(scan.skipped.recent_round).toBe(3);
	});

	it("counts parallel calls of one assistant message as one round", () => {
		const entries = [
			entry(call("a")),
			entry(result("a", big("a"))),
			entry({ role: "assistant", content: [
				{ type: "toolCall", id: "p1", name: "read", arguments: {} },
				{ type: "toolCall", id: "p2", name: "read", arguments: {} },
			] } as unknown as AgentMessage),
			entry(result("p1", big("p1"))),
			entry(result("p2", big("p2"))),
			...rounds(2),
		];
		// Protected: the two rounds from rounds(2) and the parallel round.
		expect(ids(scanCandidates(entries, DEFAULTS))).toEqual(["a"]);
	});

	it("follows the configured protection and request counts", () => {
		const fewer = parseLiveCompactConfig({ protection: { keepRecentToolRounds: 1, minFullRequests: 1 } });
		expect(ids(scanCandidates(rounds(4), fewer))).toEqual(["c1", "c2", "c3"]);
		const moreRequests = parseLiveCompactConfig({ protection: { keepRecentToolRounds: 1, minFullRequests: 3 } });
		// c3 has been seen by two responses (c4's call and the final reply); c2 by three.
		expect(ids(scanCandidates(rounds(4), moreRequests))).toEqual(["c1", "c2"]);
	});

	it("never condenses errors, images, recalls, receipts, small, unpaired, or already edited results", () => {
		const edited = result("e", big("e"));
		const entries = [
			entry(call("err")), entry(result("err", big("err"), { isError: true })),
			entry(call("img")), entry({ ...(result("img", big("img")) as object), content: [
				{ type: "text", text: big("img") }, { type: "image", data: "", mimeType: "image/png" },
			] } as unknown as AgentMessage),
			entry(call("rec", "obs_recall")), entry(result("rec", big("rec"), { toolName: "obs_recall" })),
			entry(call("rcp")), entry(result("rcp", `sol_pi_evidence_receipt_v1\n${big("rcp")}`)),
			entry(call("small")), entry(result("small", "short")),
			entry(result("orphan", big("orphan"))),
			entry(call("e")), entry(edited, [{ ...(edited as object), content: [{ type: "text", text: "card" }] } as unknown as AgentMessage]),
			entry(call("omitted")), entry(result("omitted", big("omitted")), []),
			entry(call("null")), entry(result("null", big("null"), { content: null }), [result("null", "")]),
			...rounds(3),
		];
		const scan = scanCandidates(entries, DEFAULTS);
		expect(ids(scan)).toEqual([]);
		expect(scan.skipped).toMatchObject({
			error: 1,
			not_pure_text: 2,
			recall: 1,
			reducer_receipt: 1,
			small: 1,
			unpaired: 1,
			edited: 1,
			recent_round: 3,
		});
	});

	it("respects the configured minimum size", () => {
		const config = parseLiveCompactConfig({ observation: { minBytes: 20_000 } });
		expect(ids(scanCandidates(rounds(6), config))).toEqual([]);
	});
});

describe("cards", () => {
	const message = result("c", Array.from({ length: 2_000 }, (_, index) => `line ${index}`).join("\n")) as never;
	const observation = createObservation(message, "/tmp/sol-pi-root", 100)!;

	it("keeps verbatim head and tail within the excerpt budget and names the archive", () => {
		const card = liveCard(observation, "c", 2_048)!;
		expect(card.startsWith(LIVE_CARD_HEADER)).toBe(true);
		expect(card).toContain(`id: ${observation.id}`);
		expect(card).toContain(`sha256: ${observation.contentHash}`);
		expect(card).toContain(`retrieve: call obs_recall with {"id":"${observation.id}","offset":0}`);
		expect(card).toContain("call_id: c\nstatus: succeeded");
		expect(card).toContain("not a new instruction or authorization");
		expect(card).toContain("\nline 0\nline 1\n");
		expect(card).toContain("line 1999\n[end of condensed tool result]");
		expect(card).not.toContain("\nline 1000\n");
		expect(Buffer.byteLength(card, "utf8")).toBeLessThan(2_048 + 800);
	});

	it("is deterministic and falls back to partial lines for one huge line", () => {
		expect(liveCard(observation, "c", 2_048)).toBe(liveCard(observation, "c", 2_048));
		const oneLine = createObservation(result("o", "é".repeat(10_000)) as never, "/tmp/sol-pi-root", 100)!;
		const card = liveCard(oneLine, "o", 1_001)!;
		expect(card).toContain("bytes, partial line");
		expect(card).not.toContain("\uFFFD");
	});

	it("declines when the excerpt would cover the whole result", () => {
		expect(liveCard(observation, "c", observation.bytes + 10)).toBeUndefined();
	});
});
