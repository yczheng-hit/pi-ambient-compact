/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
/**
 * Live Compact configuration: defaults, validation, and parity between the
 * runtime loader and the CLI preflight on the same fixtures.
 */
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSolPiConfig } from "../src/sol-pi/config.ts";
import { DEFAULT_LIVE_COMPACT_CONFIG, parseLiveCompactConfig } from "../src/sol-pi/live-compact-config.mjs";

const SCRIPT = join(process.cwd(), "scripts/check-sol-pi-config.mjs");
let directory: string;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "sol-pi-live-config-"));
});
afterEach(() => {
	rmSync(directory, { recursive: true, force: true });
});

function writeConfig(value: unknown): string {
	const path = join(directory, "sol-pi.json");
	writeFileSync(path, JSON.stringify(value));
	return path;
}

function runtime(value: unknown): { ok: true; liveCompact: unknown } | { ok: false; error: string } {
	writeConfig(value);
	try {
		return { ok: true, liveCompact: loadSolPiConfig(directory, directory, false).liveCompact };
	} catch (error) {
		return { ok: false, error: (error as Error).message };
	}
}

function cli(value: unknown, script = SCRIPT): { ok: true; liveCompact: unknown } | { ok: false; error: string } {
	const result = spawnSync(process.execPath, [script, "--config", writeConfig(value)], { encoding: "utf8" });
	if (result.status === 0) return { ok: true, liveCompact: JSON.parse(result.stdout).effective_config.liveCompact };
	return { ok: false, error: result.stderr };
}

const BASE = { version: 1, observationPack: true };

const ACCEPTED: Array<[string, unknown]> = [
	["absent", undefined],
	["disabled", { enabled: false }],
	["enabled with defaults", { enabled: true }],
	["custom levels", { enabled: true, thresholds: { startRatio: 0.6, targetRatio: 0.55, ceilingRatio: 0.75 } }],
	["equal start and target", { enabled: true, thresholds: { startRatio: 0.75, targetRatio: 0.75, ceilingRatio: 0.85 } }],
	["summary route", { enabled: true, summary: { provider: "p", model: "m", maxOutputTokens: 4096, timeoutMs: 60_000 } }],
	["verification route", { enabled: true, verification: { provider: "p2", model: "m2" } }],
	["zero values", { enabled: true, limits: { maxRegenerations: 0 }, background: { foregroundWaitMs: 0 }, budget: { extraReserveTokens: 0 } }],
	["protection", { enabled: true, protection: { keepRecentToolRounds: 5, minFullRequests: 1 } }],
	["observation", { enabled: true, observation: { minBytes: 4096, excerptTargetBytes: 16_384 } }],
	["dynamic strategy", { enabled: true, strategy: "dynamic-ai" }],
	["dynamic with routes", { enabled: true, strategy: "dynamic-ai", summary: { provider: "nvidia-inference", model: "nvidia/deepseek-ai/eccn-deepseek-v4.1-flash-1017" } }],
	["maintenance", { enabled: true, strategy: "dynamic-ai", maintenance: { minSavingsRatio: 0, cooldownRequests: 0, retryGrowthRatio: 0.2, maxCallsPerCycle: 2, timeoutMs: 60_000 } }],
];

const REJECTED: Array<[string, unknown, RegExp]> = [
	["not an object", [], /liveCompact must be a JSON object/u],
	["unknown group", { enabled: true, extra: {} }, /Unknown key: liveCompact\.extra/u],
	["unknown field", { thresholds: { startRatio: 0.7, ratio: 1 } }, /Unknown key: liveCompact\.thresholds\.ratio/u],
	["old flat field", { startRatio: 0.7 }, /Unknown key: liveCompact\.startRatio/u],
	["prototype key", { thresholds: { constructor: 0.9 } }, /Unknown key: liveCompact\.thresholds\.constructor/u],
	["prototype method key", { limits: { toString: "x" } }, /Unknown key: liveCompact\.limits\.toString/u],
	["percent instead of ratio", { thresholds: { startRatio: 70 } }, /0\.7 means 70%/u],
	["target above start", { thresholds: { startRatio: 0.6, targetRatio: 0.7, ceilingRatio: 0.8 } }, /targetRatio <= startRatio/u],
	["start equals ceiling", { thresholds: { startRatio: 0.8, targetRatio: 0.7, ceilingRatio: 0.8 } }, /startRatio < ceilingRatio/u],
	["ratio of one", { thresholds: { ceilingRatio: 1 } }, /between 0 and 1/u],
	["string boolean", { enabled: "true" }, /liveCompact\.enabled must be boolean/u],
	["fractional rounds", { protection: { keepRecentToolRounds: 2.5 } }, /keepRecentToolRounds must be an integer/u],
	["zero rounds", { protection: { keepRecentToolRounds: 0 } }, /from 1 to 100/u],
	["half a route", { summary: { provider: "p" } }, /must be set together/u],
	["empty model", { summary: { provider: "p", model: " " } }, /summary\.model must be a non-empty string/u],
	["bad output limit", { verification: { maxOutputTokens: "max" } }, /"auto" or a positive integer/u],
	["short timeout", { summary: { timeoutMs: 10 } }, /timeoutMs must be an integer from 1000/u],
	["too many regenerations", { limits: { maxRegenerations: 5 } }, /from 0 to 2/u],
	["too much concurrency", { background: { maxConcurrentJobs: 8 } }, /from 1 to 4/u],
	["wait above job timeout", { background: { jobTimeoutMs: 10_000, foregroundWaitMs: 20_000 } }, /must not exceed/u],
	["background not implemented", { background: { enabled: true } }, /not supported by this SoL-Pi build yet/u],
	["negative reserve", { budget: { extraReserveTokens: -1 } }, /extraReserveTokens/u],
	["unknown strategy", { strategy: "ai" }, /liveCompact\.strategy must be one of/u],
	["non-string strategy", { strategy: 1 }, /liveCompact\.strategy must be one of/u],
	["savings of one", { maintenance: { minSavingsRatio: 1 } }, /minSavingsRatio must be a finite number from 0/u],
	["one call per cycle", { maintenance: { maxCallsPerCycle: 1 } }, /maxCallsPerCycle must be an integer from 2 to 8/u],
	["unknown maintenance field", { maintenance: { everyMs: 5 } }, /Unknown key: liveCompact\.maintenance\.everyMs/u],
];

describe("Live Compact configuration", () => {
	it("defaults to disabled with the documented values", () => {
		expect(DEFAULT_LIVE_COMPACT_CONFIG).toEqual({
			enabled: false,
			strategy: "local-tools",
			thresholds: { startRatio: 0.7, targetRatio: 0.7, ceilingRatio: 0.8 },
			protection: { keepRecentToolRounds: 3, minFullRequests: 2 },
			observation: { minBytes: 10_240, excerptTargetBytes: 8_192 },
			summary: { maxOutputTokens: "auto", timeoutMs: 120_000 },
			verification: { maxOutputTokens: "auto", timeoutMs: 120_000 },
			background: { enabled: false, maxConcurrentJobs: 1, jobTimeoutMs: 300_000, foregroundWaitMs: 15_000 },
			limits: { maxRegenerations: 1, batchBudgetMs: 50, maxCandidatesPerPass: 8 },
			budget: { extraReserveTokens: 0 },
			maintenance: { minSavingsRatio: 0.1, cooldownRequests: 12, retryGrowthRatio: 0.05, maxCallsPerCycle: 4, timeoutMs: 300_000 },
		});
		expect(Object.isFrozen(DEFAULT_LIVE_COMPACT_CONFIG.thresholds)).toBe(true);
	});

	it("gives dynamic-ai a 0.5 default target and keeps an explicit one", () => {
		expect(parseLiveCompactConfig({ strategy: "dynamic-ai" }).thresholds).toEqual({ startRatio: 0.7, targetRatio: 0.5, ceilingRatio: 0.8 });
		expect(parseLiveCompactConfig({ strategy: "dynamic-ai", thresholds: { targetRatio: 0.7 } }).thresholds.targetRatio).toBe(0.7);
		// The default target never exceeds a lower configured start.
		expect(parseLiveCompactConfig({ strategy: "dynamic-ai", thresholds: { startRatio: 0.4, ceilingRatio: 0.6 } }).thresholds.targetRatio).toBe(0.4);
		// local-tools keeps its 0.7 default.
		expect(parseLiveCompactConfig({ enabled: true }).thresholds.targetRatio).toBe(0.7);
	});

	it("merges partial groups with defaults and trims route strings", () => {
		const parsed = parseLiveCompactConfig({ enabled: true, thresholds: { targetRatio: 0.65 }, summary: { provider: " p ", model: "m" } });
		expect(parsed.thresholds).toEqual({ startRatio: 0.7, targetRatio: 0.65, ceilingRatio: 0.8 });
		expect(parsed.summary).toEqual({ provider: "p", model: "m", maxOutputTokens: "auto", timeoutMs: 120_000 });
		expect(parsed.verification).toEqual(DEFAULT_LIVE_COMPACT_CONFIG.verification);
		expect(Object.isFrozen(parsed.summary)).toBe(true);
	});

	it.each(ACCEPTED)("runtime and CLI accept %s identically", (_name, liveCompact) => {
		const value = liveCompact === undefined ? BASE : { ...BASE, liveCompact };
		const fromRuntime = runtime(value);
		const fromCli = cli(value);
		expect(fromRuntime.ok).toBe(true);
		expect(fromCli).toEqual(fromRuntime);
	});

	it.each(REJECTED)("runtime and CLI reject %s", (_name, liveCompact, message) => {
		const value = { ...BASE, liveCompact };
		const fromRuntime = runtime(value);
		const fromCli = cli(value);
		expect(fromRuntime.ok).toBe(false);
		expect(fromCli.ok).toBe(false);
		if (!fromRuntime.ok) expect(fromRuntime.error).toMatch(message);
		if (!fromCli.ok) expect(fromCli.error).toMatch(message);
	});

	it.each([
		["without ObservationPack", { version: 1, liveCompact: { enabled: true } }, /requires observationPack: true/u],
		[
			"with the Evidence-Preserving Reducer",
			{ version: 1, observationPack: true, evidencePreservingReducer: true, liveCompact: { enabled: true } },
			/cannot be combined with evidencePreservingReducer/u,
		],
	])("runtime and CLI reject Live Compact %s", (_name, value, message) => {
		const fromRuntime = runtime(value);
		const fromCli = cli(value);
		expect(fromRuntime.ok).toBe(false);
		expect(fromCli.ok).toBe(false);
		if (!fromRuntime.ok) expect(fromRuntime.error).toMatch(message);
		if (!fromCli.ok) expect(fromCli.error).toMatch(message);
	});

	it("keeps disabled Live Compact compatible with the other mechanisms", () => {
		const value = { version: 1, evidencePreservingReducer: true, liveCompact: { enabled: false } };
		expect(runtime(value).ok).toBe(true);
		expect(cli(value).ok).toBe(true);
	});

	it("checks the Live Compact profile with --require-live-compact", () => {
		const example = join(process.cwd(), "sol-pi.live-compact.example.json");
		const passing = spawnSync(process.execPath, [SCRIPT, "--config", example, "--require-live-compact"], { encoding: "utf8" });
		expect(passing.status).toBe(0);
		expect(JSON.parse(passing.stdout)).toMatchObject({ ok: true, live_compact_enabled: true, all_enabled: false });

		const disabled = writeConfig({ ...BASE, liveCompact: { enabled: false } });
		const failing = spawnSync(process.execPath, [SCRIPT, "--config", disabled, "--require-live-compact"], { encoding: "utf8" });
		expect(failing.status).toBe(1);
		expect(failing.stderr).toMatch(/liveCompact\.enabled must be true/u);

		const both = spawnSync(
			process.execPath,
			[SCRIPT, "--config", example, "--require-live-compact", "--require-all-enabled"],
			{ encoding: "utf8" },
		);
		expect(both.status).toBe(1);
		expect(both.stderr).toMatch(/select different profiles/u);
	});

	it("ships example configurations that pass the runtime loader", () => {
		for (const name of ["sol-pi.example.json", "sol-pi.live-compact.example.json"]) {
			const value = JSON.parse(readFileSync(join(process.cwd(), name), "utf8"));
			expect(runtime(value).ok).toBe(true);
		}
	});

	it("runs the preflight from an installed package under node_modules", () => {
		// Node refuses to strip types under node_modules; the shared schema is plain JavaScript.
		const packageRoot = join(directory, "project", "node_modules", "sol-pi");
		mkdirSync(join(packageRoot, "scripts"), { recursive: true });
		mkdirSync(join(packageRoot, "src", "sol-pi"), { recursive: true });
		cpSync(SCRIPT, join(packageRoot, "scripts", "check-sol-pi-config.mjs"));
		cpSync(
			join(process.cwd(), "src/sol-pi/live-compact-config.mjs"),
			join(packageRoot, "src", "sol-pi", "live-compact-config.mjs"),
		);
		const result = cli({ ...BASE, liveCompact: { enabled: true } }, join(packageRoot, "scripts", "check-sol-pi-config.mjs"));
		expect(result.ok).toBe(true);
	});
});
