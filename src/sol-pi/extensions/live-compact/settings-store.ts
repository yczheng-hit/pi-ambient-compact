/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
/**
 * File-backed and session-scoped settings store for Live Compact's TUI settings
 * pane, following the same interaction and conflict-detection contract as
 * `/codex-settings`.
 *
 * Each setting field maps to a nested path inside `sol-pi.json`'s `liveCompact`
 * object while exposing a flat `SettingValues` record to the TUI menu. Saving
 * acquires a `.settings-lock` file, verifies that edited fields did not change
 * on disk since the baseline was observed, validates the resulting `sol-pi.json`
 * with `parseLiveCompactConfig` and `checkLiveCompactCombination`, and writes
 * atomically via a synced temporary file and rename.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout } from "node:timers/promises";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	checkLiveCompactCombination,
	DEFAULT_LIVE_COMPACT_CONFIG,
	type LiveCompactCallConfig,
	type LiveCompactConfig,
	parseLiveCompactConfig,
} from "../../live-compact-config.mjs";

export type SettingValue = string | number | boolean | null;
export type SettingValues = Record<string, SettingValue>;
export type SettingChanges = Record<string, SettingValue | undefined>;
type Document = Record<string, unknown>;
type FileState = {
	readonly text: string | undefined;
	/** Flat map of explicitly configured field ids in this file. */
	readonly data: Document;
	/** Raw parsed JSON document of `sol-pi.json`. */
	readonly raw: Document;
};

export type SettingsSnapshot = {
	file: string;
	values: SettingValues;
	inherited: SettingValues;
	sources: Record<string, string>;
	global: FileState;
	project: FileState;
	observed?: Record<string, [string, string]>;
};

export type SettingsSessionState = {
	changes: SettingChanges;
	baseline?: SettingsSnapshot;
};

export type SettingsField = {
	id: string;
	label: string;
	description: string;
	choices: SettingValue[];
	number?: {
		min: number;
		max: number;
		integer?: boolean;
		exclusiveMin?: boolean;
		exclusiveMax?: boolean;
		unit: string;
	};
	customText?: {
		placeholder: string;
		validate: (raw: string) => { ok: true; value: string } | { ok: false; error: string };
	};
	format?: (value: SettingValue) => string;
};

export const LIVE_COMPACT_SESSION_SETTINGS_TYPE = "sol-pi:live-compact-settings-v1";

function isDocument(value: unknown): value is Document {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function roundPercent(ratio: number): number {
	return Number((ratio * 100).toFixed(4));
}

function routeString(call: LiveCompactCallConfig | undefined): string | null {
	return call?.provider && call?.model ? `${call.provider}/${call.model}` : null;
}

/** Convert a validated `LiveCompactConfig` into flat `SettingValues` for the menu. */
export function configToSettingValues(config: LiveCompactConfig): SettingValues {
	return {
		strategy: config.strategy,
		summaryRoute: routeString(config.summary),
		verificationRoute: routeString(config.verification),
		startPercent: roundPercent(config.thresholds.startRatio),
		targetPercent: roundPercent(config.thresholds.targetRatio),
		ceilingPercent: roundPercent(config.thresholds.ceilingRatio),
		keepRecentToolRounds: config.protection.keepRecentToolRounds,
		minFullRequests: config.protection.minFullRequests,
		minSavingsPercent: roundPercent(config.maintenance.minSavingsRatio),
		cooldownRequests: config.maintenance.cooldownRequests,
		retryGrowthPercent: roundPercent(config.maintenance.retryGrowthRatio),
		maxCallsPerCycle: config.maintenance.maxCallsPerCycle,
		cycleTimeoutSeconds: Math.round(config.maintenance.timeoutMs / 1_000),
		callTimeoutSeconds: Math.round(config.summary.timeoutMs / 1_000),
		observationMinBytes: config.observation.minBytes,
		excerptTargetBytes: config.observation.excerptTargetBytes,
	};
}

/** Extract only the flat setting keys that are explicitly present in a raw `sol-pi.json` document. */
export function extractExplicitFlatSettings(raw: Document): Document {
	const lc = isDocument(raw.liveCompact) ? raw.liveCompact : {};
	const out: Document = {};
	if (typeof lc.strategy === "string") out.strategy = lc.strategy;
	if (isDocument(lc.summary) && typeof lc.summary.provider === "string" && typeof lc.summary.model === "string") {
		out.summaryRoute = `${lc.summary.provider}/${lc.summary.model}`;
	}
	if (
		isDocument(lc.verification) &&
		typeof lc.verification.provider === "string" &&
		typeof lc.verification.model === "string"
	) {
		out.verificationRoute = `${lc.verification.provider}/${lc.verification.model}`;
	}
	if (isDocument(lc.thresholds)) {
		if (typeof lc.thresholds.startRatio === "number") out.startPercent = roundPercent(lc.thresholds.startRatio);
		if (typeof lc.thresholds.targetRatio === "number") out.targetPercent = roundPercent(lc.thresholds.targetRatio);
		if (typeof lc.thresholds.ceilingRatio === "number") out.ceilingPercent = roundPercent(lc.thresholds.ceilingRatio);
	}
	if (isDocument(lc.protection)) {
		if (typeof lc.protection.keepRecentToolRounds === "number") {
			out.keepRecentToolRounds = lc.protection.keepRecentToolRounds;
		}
		if (typeof lc.protection.minFullRequests === "number") {
			out.minFullRequests = lc.protection.minFullRequests;
		}
	}
	if (isDocument(lc.maintenance)) {
		if (typeof lc.maintenance.minSavingsRatio === "number") {
			out.minSavingsPercent = roundPercent(lc.maintenance.minSavingsRatio);
		}
		if (typeof lc.maintenance.cooldownRequests === "number") {
			out.cooldownRequests = lc.maintenance.cooldownRequests;
		}
		if (typeof lc.maintenance.retryGrowthRatio === "number") {
			out.retryGrowthPercent = roundPercent(lc.maintenance.retryGrowthRatio);
		}
		if (typeof lc.maintenance.maxCallsPerCycle === "number") {
			out.maxCallsPerCycle = lc.maintenance.maxCallsPerCycle;
		}
		if (typeof lc.maintenance.timeoutMs === "number") {
			out.cycleTimeoutSeconds = Math.round(lc.maintenance.timeoutMs / 1_000);
		}
	}
	if (isDocument(lc.summary) && typeof lc.summary.timeoutMs === "number") {
		out.callTimeoutSeconds = Math.round(lc.summary.timeoutMs / 1_000);
	} else if (isDocument(lc.verification) && typeof lc.verification.timeoutMs === "number") {
		out.callTimeoutSeconds = Math.round(lc.verification.timeoutMs / 1_000);
	}
	if (isDocument(lc.observation)) {
		if (typeof lc.observation.minBytes === "number") out.observationMinBytes = lc.observation.minBytes;
		if (typeof lc.observation.excerptTargetBytes === "number") {
			out.excerptTargetBytes = lc.observation.excerptTargetBytes;
		}
	}
	return out;
}

function setNestedRoute(lc: Document, key: "summary" | "verification", value: SettingValue | undefined): void {
	const group = isDocument(lc[key]) ? { ...lc[key] } : {};
	if (typeof value === "string" && value.includes("/")) {
		const slash = value.indexOf("/");
		group.provider = value.slice(0, slash);
		group.model = value.slice(slash + 1);
	} else {
		delete group.provider;
		delete group.model;
	}
	if (Object.keys(group).length === 0) delete lc[key];
	else lc[key] = group;
}

function setNestedField(lc: Document, groupKey: string, fieldKey: string, value: unknown): void {
	const group = isDocument(lc[groupKey]) ? { ...lc[groupKey] } : {};
	if (value === undefined) delete group[fieldKey];
	else group[fieldKey] = value;
	if (Object.keys(group).length === 0) delete lc[groupKey];
	else lc[groupKey] = group;
}

/** Apply flat `SettingChanges` onto a raw `sol-pi.json` document without losing other keys. */
export function applyFlatChangesToDocument(raw: Document, changes: SettingChanges): Document {
	const next: Document = {
		version: raw.version ?? 1,
		...(Object.hasOwn(raw, "observationPack") ? {} : { observationPack: true }),
		...raw,
	};
	const lc: Document = isDocument(raw.liveCompact) ? { ...raw.liveCompact } : { enabled: true };
	if (lc.enabled === undefined) lc.enabled = true;

	for (const [id, value] of Object.entries(changes)) {
		switch (id) {
			case "strategy":
				if (value === undefined) delete lc.strategy;
				else lc.strategy = value;
				break;
			case "summaryRoute":
				setNestedRoute(lc, "summary", value);
				break;
			case "verificationRoute":
				setNestedRoute(lc, "verification", value);
				break;
			case "startPercent":
				setNestedField(lc, "thresholds", "startRatio", typeof value === "number" ? value / 100 : undefined);
				break;
			case "targetPercent":
				setNestedField(lc, "thresholds", "targetRatio", typeof value === "number" ? value / 100 : undefined);
				break;
			case "ceilingPercent":
				setNestedField(lc, "thresholds", "ceilingRatio", typeof value === "number" ? value / 100 : undefined);
				break;
			case "keepRecentToolRounds":
				setNestedField(lc, "protection", "keepRecentToolRounds", value);
				break;
			case "minFullRequests":
				setNestedField(lc, "protection", "minFullRequests", value);
				break;
			case "minSavingsPercent":
				setNestedField(lc, "maintenance", "minSavingsRatio", typeof value === "number" ? value / 100 : undefined);
				break;
			case "cooldownRequests":
				setNestedField(lc, "maintenance", "cooldownRequests", value);
				break;
			case "retryGrowthPercent":
				setNestedField(lc, "maintenance", "retryGrowthRatio", typeof value === "number" ? value / 100 : undefined);
				break;
			case "maxCallsPerCycle":
				setNestedField(lc, "maintenance", "maxCallsPerCycle", value);
				break;
			case "cycleTimeoutSeconds":
				setNestedField(lc, "maintenance", "timeoutMs", typeof value === "number" ? Math.round(value * 1_000) : undefined);
				break;
			case "callTimeoutSeconds": {
				const ms = typeof value === "number" ? Math.round(value * 1_000) : undefined;
				setNestedField(lc, "summary", "timeoutMs", ms);
				setNestedField(lc, "verification", "timeoutMs", ms);
				break;
			}
			case "observationMinBytes":
				setNestedField(lc, "observation", "minBytes", value);
				break;
			case "excerptTargetBytes":
				setNestedField(lc, "observation", "excerptTargetBytes", value);
				break;
		}
	}
	next.liveCompact = lc;
	return next;
}

/** Build and validate a `LiveCompactConfig` from flat `SettingValues` on top of `baseConfig`. */
export function settingValuesToConfig(values: SettingValues, baseConfig: LiveCompactConfig = DEFAULT_LIVE_COMPACT_CONFIG): LiveCompactConfig {
	const rawBase: Document = {
		version: 1,
		observationPack: true,
		liveCompact: {
			enabled: baseConfig.enabled,
			strategy: baseConfig.strategy,
			thresholds: { ...baseConfig.thresholds },
			protection: { ...baseConfig.protection },
			observation: { ...baseConfig.observation },
			summary: { ...baseConfig.summary },
			verification: { ...baseConfig.verification },
			background: { ...baseConfig.background },
			limits: { ...baseConfig.limits },
			budget: { ...baseConfig.budget },
			maintenance: { ...baseConfig.maintenance },
		},
	};
	const updated = applyFlatChangesToDocument(rawBase, values);
	return parseLiveCompactConfig(updated.liveCompact);
}

export function observedSetting(snapshot: SettingsSnapshot, id: string): [string, string] {
	return (
		snapshot.observed?.[id] ?? [
			createHash("sha256")
				.update(JSON.stringify(snapshot.global.data[id]) ?? "undefined")
				.digest("hex"),
			createHash("sha256")
				.update(JSON.stringify(snapshot.project.data[id]) ?? "undefined")
				.digest("hex"),
		]
	);
}

/** Retain conflict evidence for session overrides across menu reopenings. */
export function sessionBaseline(snapshot: SettingsSnapshot, session: SettingsSessionState): SettingsSnapshot {
	const baseline = session.baseline;
	if (!baseline) return snapshot;
	return {
		...snapshot,
		file: baseline.file,
		observed: Object.fromEntries(Object.keys(session.changes).map((id) => [id, observedSetting(baseline, id)])),
	};
}

async function read(file: string): Promise<FileState> {
	let text: string;
	try {
		text = await readFile(file, "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") {
			return { text: undefined, data: {}, raw: {} };
		}
		throw new Error(`Cannot read ${file}. Check file permissions.`, { cause: error });
	}
	try {
		const raw: unknown = JSON.parse(text);
		if (!isDocument(raw)) throw new Error("Expected an object.");
		return { text, data: extractExplicitFlatSettings(raw), raw };
	} catch (error) {
		throw new Error(`Invalid settings in ${file}. Fix the JSON object and reopen the menu.`, {
			cause: error,
		});
	}
}

function resolveDocToValues(raw: Document, fallback: LiveCompactConfig): SettingValues {
	if (!isDocument(raw.liveCompact)) return configToSettingValues(fallback);
	const parsed = parseLiveCompactConfig({ enabled: true, ...raw.liveCompact });
	return configToSettingValues(parsed);
}

export class SettingsStore {
	readonly globalFile: string;
	readonly projectFile: string | undefined;
	readonly locked: Record<string, string> = {};
	private readonly startup: LiveCompactConfig;

	constructor(globalFile: string, projectFile: string | undefined, startup: LiveCompactConfig) {
		this.globalFile = globalFile;
		this.projectFile = projectFile;
		this.startup = startup;
	}

	/** In SoL-Pi, a project file replaces the global file when present. */
	private resolveRaw(globalRaw: Document, projectRaw: Document, hasProject: boolean): SettingValues {
		const effectiveRaw = hasProject ? projectRaw : globalRaw;
		if (Object.keys(effectiveRaw).length === 0) return configToSettingValues(this.startup);
		return resolveDocToValues(effectiveRaw, this.startup);
	}

	async load(): Promise<SettingsSnapshot> {
		const global = await read(this.globalFile);
		const project = this.projectFile ? await read(this.projectFile) : { text: undefined, data: {}, raw: {} };
		const isProject = this.projectFile !== undefined && project.text !== undefined;
		const values = this.resolveRaw(global.raw, project.raw, isProject);
		// When editing a project file, inherited values come from the global file; when editing global, from defaults.
		const defaultConfig = parseLiveCompactConfig({
			enabled: true,
			strategy: values.strategy === "dynamic-ai" ? "dynamic-ai" : "local-tools",
		});
		const inherited = isProject && global.text !== undefined
			? resolveDocToValues(global.raw, defaultConfig)
			: configToSettingValues(defaultConfig);
		const sources: Record<string, string> = {};
		for (const id of Object.keys(values)) {
			sources[id] = Object.hasOwn(project.data, id)
				? "project"
				: Object.hasOwn(global.data, id)
					? "global"
					: "default";
		}
		return {
			file: isProject && this.projectFile ? this.projectFile : this.globalFile,
			values,
			inherited,
			sources,
			global,
			project,
		};
	}

	async save(
		baseline: SettingsSnapshot,
		changes: SettingChanges,
		signal: AbortSignal,
		guard: (values: SettingValues) => void,
	): Promise<SettingsSnapshot> {
		const keys = Object.keys(changes);
		if (keys.length === 0) return baseline;
		if (baseline.file !== this.globalFile && baseline.file !== this.projectFile) {
			throw new Error("The settings scope changed. Review the configuration before saving.");
		}
		await mkdir(dirname(baseline.file), { recursive: true });
		const lockPath = `${baseline.file}.settings-lock`;
		let lock;
		for (let attempt = 0; attempt < 40; attempt += 1) {
			signal.throwIfAborted();
			try {
				lock = await open(lockPath, "wx", 0o600);
				break;
			} catch (error) {
				if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
				await setTimeout(50, undefined, { signal });
			}
		}
		if (!lock) {
			throw new Error(`Settings are locked at ${lockPath}. Wait for the other writer or review the stale lock.`);
		}
		const temporary = `${baseline.file}.${randomUUID()}.tmp`;
		let temporaryCreated = false;
		try {
			const current = await this.load();
			if (current.file !== baseline.file) {
				throw new Error("The settings scope changed. Reopen the menu to review the save target.");
			}
			for (const id of keys) {
				if (JSON.stringify(observedSetting(current, id)) !== JSON.stringify(observedSetting(baseline, id))) {
					throw new Error(`Setting ${id} changed on disk. Reopen the menu to review it.`);
				}
			}
			const isProject = current.file !== this.globalFile;
			const target = isProject ? current.project : current.global;
			const nextRaw = applyFlatChangesToDocument(target.raw, changes);
			const parsed = parseLiveCompactConfig(nextRaw.liveCompact);
			checkLiveCompactCombination(parsed, {
				observationPack: nextRaw.observationPack === true,
				evidencePreservingReducer: nextRaw.evidencePreservingReducer === true,
			});
			const values = configToSettingValues(parsed);
			guard(values);
			signal.throwIfAborted();
			const mode = await stat(current.file).then(
				(metadata) => metadata.mode & 0o777,
				(error: unknown) => {
					if (error instanceof Error && "code" in error && error.code === "ENOENT") return 0o600;
					throw error;
				},
			);
			const serialized = `${JSON.stringify(nextRaw, null, 2)}\n`;
			await open(temporary, "wx", mode).then(async (handle) => {
				temporaryCreated = true;
				try {
					await handle.writeFile(serialized);
					await handle.sync();
				} finally {
					await handle.close();
				}
			});
			const verified = await this.load();
			if (
				verified.file !== current.file ||
				verified.global.text !== current.global.text ||
				verified.project.text !== current.project.text
			) {
				throw new Error("Settings changed while saving. Reopen the menu to review them.");
			}
			signal.throwIfAborted();
			guard(values);
			await rename(temporary, current.file);
			temporaryCreated = false;
			const savedData = extractExplicitFlatSettings(nextRaw);
			const saved: FileState = { text: serialized, data: savedData, raw: nextRaw };
			return {
				...current,
				values,
				sources: {
					...current.sources,
					...Object.fromEntries(
						keys.map((id) => [
							id,
							changes[id] === undefined
								? isProject && Object.hasOwn(current.global.data, id)
									? "global"
									: "default"
								: isProject
									? "project"
									: "global",
						]),
					),
				},
				global: isProject ? current.global : saved,
				project: isProject ? saved : current.project,
			};
		} finally {
			if (temporaryCreated) await unlink(temporary);
			await lock.close();
			await unlink(lockPath);
		}
	}
}

export type SettingsSessionContext = {
	sessionManager: Pick<ExtensionContext["sessionManager"], "getSessionId" | "getEntries" | "getBranch">;
};

function valid(field: SettingsField, value: unknown): value is SettingValue {
	if (field.choices.some((choice) => choice === value)) return true;
	if (field.customText && typeof value === "string") return field.customText.validate(value).ok;
	const rule = field.number;
	return Boolean(
		rule &&
			typeof value === "number" &&
			Number.isFinite(value) &&
			(!rule.integer || Number.isInteger(value)) &&
			(rule.exclusiveMin ? value > rule.min : value >= rule.min) &&
			(rule.exclusiveMax ? value < rule.max : value <= rule.max),
	);
}

/** Session-wide preferences keyed by sessionId so a new session or fork starts from configuration files. */
export function readSessionSettings(
	ctx: SettingsSessionContext,
	fields: SettingsField[],
): { values: SettingValues; session: SettingsSessionState } {
	const entries = typeof ctx.sessionManager.getEntries === "function"
		? ctx.sessionManager.getEntries()
		: ctx.sessionManager.getBranch();
	const currentSessionId = typeof ctx.sessionManager.getSessionId === "function"
		? ctx.sessionManager.getSessionId()
		: "default";
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry?.type !== "custom" || entry.customType !== LIVE_COMPACT_SESSION_SETTINGS_TYPE) continue;
		const data: unknown = entry.data;
		if (isDocument(data) && typeof data.sessionId === "string" && data.sessionId !== currentSessionId) {
			continue;
		}
		if (
			!isDocument(data) ||
			data.sessionId !== currentSessionId ||
			data.version !== 1 ||
			!isDocument(data.values) ||
			!isDocument(data.changes) ||
			!isDocument(data.observed)
		) {
			continue;
		}
		const values: SettingValues = {};
		const session: SettingsSessionState = { changes: {} };
		for (const [id, value] of Object.entries(data.values)) {
			const field = fields.find((candidate) => candidate.id === id);
			if (field && valid(field, value)) values[id] = value;
		}
		const observed: Record<string, [string, string]> = {};
		for (const [id, change] of Object.entries(data.changes)) {
			if (!Array.isArray(change) || change.length > 1) continue;
			const field = fields.find((candidate) => candidate.id === id);
			if (!field || !Object.hasOwn(values, id)) continue;
			const value: unknown = change[0];
			let next: SettingValue | undefined;
			if (change.length !== 0) {
				if (!valid(field, value)) continue;
				next = value;
			}
			const hashes = data.observed[id];
			if (!Array.isArray(hashes) || hashes.length !== 2) continue;
			const [globalHash, projectHash] = hashes;
			if (typeof globalHash !== "string" || typeof projectHash !== "string") continue;
			session.changes[id] = next;
			observed[id] = [globalHash, projectHash];
		}
		if (Object.keys(session.changes).length > 0 && typeof data.file === "string") {
			session.baseline = {
				file: data.file,
				observed,
				values: {},
				inherited: {},
				sources: {},
				global: { text: undefined, data: {}, raw: {} },
				project: { text: undefined, data: {}, raw: {} },
			};
		}
		return { values, session };
	}
	return { values: {}, session: { changes: {} } };
}

export function sessionSettingsEntry(
	sessionId: string,
	values: SettingValues,
	session: SettingsSessionState,
) {
	const changes = Object.entries(session.changes);
	return {
		version: 1,
		sessionId,
		values: { ...values },
		changes: Object.fromEntries(changes.map(([id, value]) => [id, value === undefined ? [] : [value]])),
		file: session.baseline?.file,
		observed: Object.fromEntries(
			changes.map(([id]) => {
				if (!session.baseline) throw new Error("Missing session settings conflict baseline.");
				return [id, observedSetting(session.baseline, id)];
			}),
		),
	};
}

/**
 * Dynamic runtime configuration resolver: re-reads `sol-pi.json` when its mtime changes so
 * other running sessions pick up saved global/project changes, then overlays this session's
 * applied settings (and any `/live-compact model` route overrides) on top.
 */
export class LiveCompactConfigResolver {
	private readonly baselineTexts = new Map<string, string>();
	private cache: { path: string; text: string; config?: LiveCompactConfig; error?: string } | undefined;
	private lastGood: LiveCompactConfig;

	constructor(startup: LiveCompactConfig, initialPath?: string) {
		this.lastGood = startup;
		if (initialPath) this.prime(initialPath);
	}

	/** Record the current on-disk text of `path` so only later changes replace the startup config. */
	prime(path: string | undefined): void {
		if (!path || this.baselineTexts.has(path)) return;
		try {
			this.baselineTexts.set(path, existsSync(path) ? readFileSync(path, "utf8") : "");
		} catch {
			this.baselineTexts.set(path, "");
		}
	}

	readDisk(path: string | undefined): { config: LiveCompactConfig; error?: string } {
		if (!path || !existsSync(path)) return { config: this.lastGood };
		let text: string;
		try {
			text = readFileSync(path, "utf8");
		} catch {
			return { config: this.lastGood };
		}
		if (!this.baselineTexts.has(path)) {
			this.baselineTexts.set(path, text);
			return { config: this.lastGood };
		}
		if (this.baselineTexts.get(path) === text && !this.cache) {
			return { config: this.lastGood };
		}
		if (!this.cache || this.cache.path !== path || this.cache.text !== text) {
			try {
				const raw = JSON.parse(text) as { liveCompact?: unknown };
				const config = parseLiveCompactConfig(
					isDocument(raw.liveCompact) ? { enabled: true, ...raw.liveCompact } : { enabled: true },
				);
				this.cache = { path, text, config };
				this.lastGood = config;
			} catch (error) {
				this.cache = { path, text, error: error instanceof Error ? error.message : String(error) };
			}
		}
		return {
			config: this.cache.config ?? this.lastGood,
			...(this.cache.error ? { error: this.cache.error } : {}),
		};
	}

	resolve(
		ctx: SettingsSessionContext,
		configPath: string | undefined,
		fields: SettingsField[],
	): { config: LiveCompactConfig; session: SettingsSessionState; diskError?: string } {
		const disk = this.readDisk(configPath);
		const saved = readSessionSettings(ctx, fields);
		if (Object.keys(saved.session.changes).length === 0) {
			return { config: disk.config, session: saved.session, ...(disk.error ? { diskError: disk.error } : {}) };
		}
		try {
			const mergedValues: SettingValues = { ...configToSettingValues(disk.config) };
			for (const [id, change] of Object.entries(saved.session.changes)) {
				mergedValues[id] = change !== undefined ? change : (saved.values[id] ?? mergedValues[id] ?? null);
			}
			const config = settingValuesToConfig(mergedValues, disk.config);
			return { config, session: saved.session, ...(disk.error ? { diskError: disk.error } : {}) };
		} catch {
			return { config: disk.config, session: saved.session, ...(disk.error ? { diskError: disk.error } : {}) };
		}
	}
}
