/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
/**
 * TUI settings pane for Live Compact (`/live-compact` or `/live-compact settings`),
 * modeled after `/codex-settings`.
 */
import { join } from "node:path";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import type { LiveCompactConfig } from "../../live-compact-config.mjs";
import { parseRouteArgument } from "./routes.ts";
import { type SettingsMenuFactory, settingsMenu, waitForSettingsIdle } from "./settings-menu.ts";
import {
	configToSettingValues,
	LIVE_COMPACT_SESSION_SETTINGS_TYPE,
	readSessionSettings,
	type SettingsField,
	type SettingsSessionState,
	SettingsStore,
	type SettingValues,
	sessionSettingsEntry,
	settingValuesToConfig,
} from "./settings-store.ts";

type ModelLike = { readonly provider: string; readonly id: string };
type RegistryLike = {
	readonly getAvailable?: () => readonly ModelLike[];
	readonly getAll?: () => readonly ModelLike[];
	readonly find?: (provider: string, modelId: string) => unknown;
};

function availableModelRoutes(ctx: ExtensionContext | undefined): string[] {
	const registry = ctx?.modelRegistry as unknown as RegistryLike | undefined;
	const list = registry?.getAvailable?.() ?? registry?.getAll?.() ?? [];
	const seen = new Set<string>();
	const routes: string[] = [];
	for (const model of list) {
		if (typeof model?.provider !== "string" || typeof model?.id !== "string") continue;
		const route = `${model.provider}/${model.id}`;
		if (seen.has(route)) continue;
		seen.add(route);
		routes.push(route);
	}
	return routes;
}

function validateModelRouteInput(
	raw: string,
	ctx: ExtensionContext | undefined,
): { ok: true; value: string } | { ok: false; error: string } {
	const parsed = parseRouteArgument(raw);
	if (!parsed) {
		return { ok: false, error: "Enter a route as <provider>/<model> (or select Working model)." };
	}
	const find = (ctx?.modelRegistry as unknown as RegistryLike | undefined)?.find;
	if (typeof find === "function" && !find.call(ctx?.modelRegistry, parsed.provider!, parsed.model!)) {
		return {
			ok: false,
			error: `Model ${parsed.provider}/${parsed.model} is not registered in Pi.`,
		};
	}
	return { ok: true, value: `${parsed.provider}/${parsed.model}` };
}

export function buildLiveCompactSettingFields(ctx?: ExtensionContext): SettingsField[] {
	const modelChoices = [null, ...availableModelRoutes(ctx)];
	const routeField = (id: "summaryRoute" | "verificationRoute", label: string, description: string): SettingsField => ({
		id,
		label,
		description,
		choices: modelChoices,
		customText: {
			placeholder: "provider/model",
			validate: (raw) => validateModelRouteInput(raw, ctx),
		},
		format: (value) => (value === null ? "Working model" : String(value)),
	});

	return [
		{
			id: "strategy",
			label: "Compaction strategy",
			description: "dynamic-ai summarizes global history segments with AI; local-tools condenses old large tool outputs.",
			choices: ["dynamic-ai", "local-tools"],
		},
		routeField(
			"summaryRoute",
			"Summary model",
			"Model route that selects history segments and generates summaries (dynamic-ai).",
		),
		routeField(
			"verificationRoute",
			"Verification model",
			"Model route that verifies generated summaries against original messages (dynamic-ai).",
		),
		{
			id: "startPercent",
			label: "Start threshold",
			description: "Context usage percentage where maintenance becomes eligible.",
			choices: [50, 60, 65, 70, 75, 80],
			number: { min: 0, max: 100, exclusiveMin: true, exclusiveMax: true, unit: "%" },
			format: (value) => `${value}%`,
		},
		{
			id: "targetPercent",
			label: "Target level",
			description: "Target context usage percentage after maintenance (must be ≤ start threshold).",
			choices: [35, 40, 50, 60, 65, 70],
			number: { min: 0, max: 100, exclusiveMin: true, exclusiveMax: true, unit: "%" },
			format: (value) => `${value}%`,
		},
		{
			id: "ceilingPercent",
			label: "Urgent ceiling",
			description: "Context usage percentage where cooldown and min-savings checks are bypassed (must be > start).",
			choices: [70, 75, 80, 85, 90, 95],
			number: { min: 0, max: 100, exclusiveMin: true, exclusiveMax: true, unit: "%" },
			format: (value) => `${value}%`,
		},
		{
			id: "keepRecentToolRounds",
			label: "Keep recent tool rounds",
			description: "Most recent complete tool rounds protected verbatim.",
			choices: [1, 2, 3, 5, 8, 12],
			number: { min: 1, max: 100, integer: true, unit: "rounds" },
		},
		{
			id: "minFullRequests",
			label: "Min full requests",
			description: "Confirmed provider requests that must see a tool result in full before local-tools condensing.",
			choices: [1, 2, 3, 5],
			number: { min: 1, max: 20, integer: true, unit: "requests" },
		},
		{
			id: "minSavingsPercent",
			label: "Min cycle savings",
			description: "Minimum window percentage a normal dynamic-ai cycle must reclaim.",
			choices: [0, 5, 10, 15, 20],
			number: { min: 0, max: 100, exclusiveMax: true, unit: "%" },
			format: (value) => `${value}%`,
		},
		{
			id: "cooldownRequests",
			label: "Cooldown requests",
			description: "Assistant responses required between normal dynamic-ai maintenance cycles.",
			choices: [0, 6, 12, 20, 30],
			number: { min: 0, max: 1_000, integer: true, unit: "requests" },
		},
		{
			id: "retryGrowthPercent",
			label: "Retry growth after failure",
			description: "Context growth (window percentage) required before retrying a failed or unprofitable cycle.",
			choices: [0, 2, 5, 10, 15],
			number: { min: 0, max: 100, exclusiveMax: true, unit: "%" },
			format: (value) => `${value}%`,
		},
		{
			id: "maxCallsPerCycle",
			label: "Max model calls per cycle",
			description: "Maximum generation + verification model calls in one dynamic-ai cycle.",
			choices: [2, 4, 6, 8],
			number: { min: 2, max: 8, integer: true, unit: "calls" },
		},
		{
			id: "cycleTimeoutSeconds",
			label: "Cycle timeout",
			description: "Total timeout in seconds for model calls in one dynamic-ai maintenance cycle.",
			choices: [60, 120, 180, 300, 600],
			number: { min: 1, max: 1_800, integer: true, unit: "s" },
			format: (value) => `${value}s`,
		},
		{
			id: "callTimeoutSeconds",
			label: "Per-call model timeout",
			description: "Timeout in seconds for a single summary or verification model call.",
			choices: [30, 60, 120, 180, 300],
			number: { min: 1, max: 1_800, integer: true, unit: "s" },
			format: (value) => `${value}s`,
		},
		{
			id: "observationMinBytes",
			label: "Min observation size",
			description: "Minimum tool result size in bytes for local-tools condensing.",
			choices: [4_096, 10_240, 20_480, 51_200],
			number: { min: 1, max: 67_108_864, integer: true, unit: "bytes" },
			format: (value) => `${value} B`,
		},
		{
			id: "excerptTargetBytes",
			label: "Excerpt target size",
			description: "Target head+tail excerpt budget in bytes for local-tools cards.",
			choices: [2_048, 4_096, 8_192, 16_384],
			number: { min: 1, max: 1_048_576, integer: true, unit: "bytes" },
			format: (value) => `${value} B`,
		},
	];
}

export interface OpenLiveCompactSettingsOptions {
	readonly startupConfig: LiveCompactConfig;
	readonly getCurrentConfig: (ctx: ExtensionContext) => LiveCompactConfig;
	readonly getSessionState: (ctx: ExtensionContext, fields: SettingsField[]) => SettingsSessionState;
	readonly onChange: (config: LiveCompactConfig, session: SettingsSessionState) => void;
	readonly extraDetails?: (ctx: ExtensionContext) => readonly string[];
	readonly runNow?: (ctx: ExtensionContext, signal: AbortSignal) => Promise<string>;
	readonly configPathOverride?: (ctx: ExtensionContext) => string | undefined;
}

export function canOpenSettingsTui(ctx: ExtensionContext): boolean {
	const cmdCtx = ctx as Partial<ExtensionCommandContext>;
	return cmdCtx.mode === "tui" && typeof (cmdCtx.ui as { custom?: unknown } | undefined)?.custom === "function";
}

export async function openLiveCompactSettingsPane(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	options: OpenLiveCompactSettingsOptions,
): Promise<void> {
	const cmdCtx = ctx as ExtensionCommandContext & {
		ui: {
			custom: <T>(factory: SettingsMenuFactory<T>) => Promise<T>;
			notify: ExtensionCommandContext["ui"]["notify"];
		};
	};
	if (!canOpenSettingsTui(ctx)) {
		ctx.ui.notify("/live-compact settings requires TUI mode.", "error");
		return;
	}
	try {
		const sessionId =
			typeof ctx.sessionManager.getSessionId === "function" ? ctx.sessionManager.getSessionId() : "default";
		const trusted = typeof ctx.isProjectTrusted === "function" ? ctx.isProjectTrusted() : false;
		const overridePath = options.configPathOverride?.(ctx);
		const globalFile = overridePath ?? join(getAgentDir(), "sol-pi.json");
		const projectFile = overridePath ? undefined : trusted ? join(ctx.cwd, CONFIG_DIR_NAME, "sol-pi.json") : undefined;
		const store = new SettingsStore(globalFile, projectFile, options.startupConfig);
		const snapshot = await store.load();
		const fields = buildLiveCompactSettingFields(ctx);
		const currentConfig = options.getCurrentConfig(ctx);
		const currentValues = configToSettingValues(currentConfig);
		const sessionState = options.getSessionState(ctx, fields);

		await cmdCtx.ui.custom(
			settingsMenu({
				title: "Live Compact Settings",
				store,
				snapshot,
				current: currentValues,
				session: sessionState,
				fields,
				status: (values) => {
					const strategy = values.strategy ?? currentValues.strategy;
					const start = values.startPercent ?? currentValues.startPercent;
					const target = values.targetPercent ?? currentValues.targetPercent;
					const ceiling = values.ceilingPercent ?? currentValues.ceilingPercent;
					const summary = values.summaryRoute ?? "Working model";
					const verify = values.verificationRoute ?? "Working model";
					return strategy === "dynamic-ai"
						? `dynamic-ai · levels ${start}% → ${target}% (urgent ${ceiling}%) · summary: ${summary} · verify: ${verify}`
						: `local-tools · levels ${start}% → ${target}% (ceiling ${ceiling}%) · keep ${values.keepRecentToolRounds ?? 3} rounds`;
				},
				extraDetails: options.extraDetails ? () => options.extraDetails!(ctx) : undefined,
				runNow: options.runNow ? (signal) => options.runNow!(ctx, signal) : undefined,
				prepare: (signal) =>
					typeof cmdCtx.waitForIdle === "function"
						? waitForSettingsIdle(() => cmdCtx.waitForIdle(), signal)
						: Promise.resolve(),
				guard: (values) => {
					const currentSessionId =
						typeof ctx.sessionManager.getSessionId === "function" ? ctx.sessionManager.getSessionId() : "default";
					const currentTrusted = typeof ctx.isProjectTrusted === "function" ? ctx.isProjectTrusted() : false;
					if (sessionId !== currentSessionId || trusted !== currentTrusted) {
						throw new Error("The session or project trust changed. Reopen settings.");
					}
					if (typeof cmdCtx.isIdle === "function" && !cmdCtx.isIdle()) {
						throw new Error("Pi is busy. Retry when idle.");
					}
					// Validate cross-field rules (such as 0 < target <= start < ceiling < 1).
					settingValuesToConfig(values, currentConfig);
				},
				apply: (values, nextSession) => {
					const nextConfig = settingValuesToConfig(values, currentConfig);
					pi.appendEntry(
						LIVE_COMPACT_SESSION_SETTINGS_TYPE,
						sessionSettingsEntry(sessionId, values, nextSession),
					);
					options.onChange(nextConfig, nextSession);
				},
			}),
		);
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : "Could not open Live Compact settings.", "error");
	}
}
