/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
/**
 * Effective summary and verification model routes of the dynamic-ai planner.
 *
 * Precedence, per route kind:
 *   1. this session's override, set with `/live-compact model <kind> <provider>/<model>` and kept
 *      as a custom session entry (it travels with forks; `default` clears it);
 *   2. the global default in the effective `sol-pi.json`, re-read whenever the file changes, so
 *      a `--global` change made in one session applies to every running session's next cycle;
 *   3. the configuration loaded at startup.
 * An empty route follows the working model.
 */
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	checkLiveCompactCombination,
	type LiveCompactCallConfig,
	type LiveCompactConfig,
	type LiveCompactModelRoute,
	parseLiveCompactConfig,
} from "../../live-compact-config.mjs";

export const ROUTES_ENTRY = "sol-pi-live-compact-routes-v1";
export type RouteKind = "summary" | "verification";
export const ROUTE_KINDS: readonly RouteKind[] = ["summary", "verification"];

/** A session override: a route, or `null` to follow the working model; absent keys are not overridden. */
export interface RoutesOverride {
	readonly v: 1;
	readonly summary?: LiveCompactModelRoute | null;
	readonly verification?: LiveCompactModelRoute | null;
}

export type RouteSource = "session" | "global" | "startup";

export interface EffectiveRoute {
	readonly call: LiveCompactCallConfig;
	readonly source: RouteSource;
}

export function describeRoute(route: LiveCompactModelRoute): string {
	return route.provider && route.model ? `${route.provider}/${route.model}` : "working model";
}

/** `provider/model` (the model id may contain slashes) or `default`. */
export function parseRouteArgument(text: string): LiveCompactModelRoute | null | undefined {
	const value = text.trim();
	if (value === "default") return null;
	const slash = value.indexOf("/");
	if (slash <= 0 || slash === value.length - 1) return undefined;
	return { provider: value.slice(0, slash), model: value.slice(slash + 1) };
}

function sessionOverride(branch: readonly SessionEntry[], kind: RouteKind): LiveCompactModelRoute | null | undefined {
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index]!;
		if (entry.type !== "custom" || entry.customType !== ROUTES_ENTRY) continue;
		const data = entry.data as RoutesOverride | undefined;
		if (data?.v === 1 && Object.hasOwn(data, kind)) return data[kind];
	}
	return undefined;
}

function withRoute(call: LiveCompactCallConfig, route: LiveCompactModelRoute | null): LiveCompactCallConfig {
	const { provider: _provider, model: _model, ...rest } = call;
	return route?.provider && route.model ? { ...rest, provider: route.provider, model: route.model } : rest;
}

type GlobalCache = { readonly path: string; readonly mtimeMs: number; readonly config?: LiveCompactConfig; readonly error?: string };

/** Route resolution with a re-read-on-change cache of the global configuration file. */
export class RouteStore {
	private cache: GlobalCache | undefined;
	private lastGood: LiveCompactConfig | undefined;

	private readonly startup: LiveCompactConfig;

	constructor(startup: LiveCompactConfig) {
		this.startup = startup;
	}

	/** The liveCompact configuration of `path` as it is now; the last good one if it became invalid. */
	global(path: string | undefined): { readonly config?: LiveCompactConfig; readonly error?: string } {
		if (!path || !existsSync(path)) return { config: this.lastGood };
		const mtimeMs = statSync(path).mtimeMs;
		if (!this.cache || this.cache.path !== path || this.cache.mtimeMs !== mtimeMs) {
			try {
				const record = JSON.parse(readFileSync(path, "utf8")) as { liveCompact?: unknown };
				const config = parseLiveCompactConfig(record.liveCompact);
				this.cache = { path, mtimeMs, config };
				this.lastGood = config;
			} catch (error) {
				this.cache = { path, mtimeMs, error: error instanceof Error ? error.message : String(error) };
			}
		}
		return this.cache.error ? { config: this.lastGood, error: this.cache.error } : { config: this.cache.config };
	}

	effective(branch: readonly SessionEntry[], configPath: string | undefined): Record<RouteKind, EffectiveRoute> & { readonly globalError?: string } {
		const global = this.global(configPath);
		const resolve = (kind: RouteKind): EffectiveRoute => {
			const base = global.config?.[kind] ?? this.startup[kind];
			const override = sessionOverride(branch, kind);
			if (override !== undefined) return { call: withRoute(base, override), source: "session" };
			if (global.config) return { call: global.config[kind], source: "global" };
			return { call: this.startup[kind], source: "startup" };
		};
		return { summary: resolve("summary"), verification: resolve("verification"), ...(global.error ? { globalError: global.error } : {}) };
	}
}

/**
 * Set or clear (`null`) a route in the global configuration file, validating the whole file
 * first and replacing it atomically. Other keys and route options (timeouts, output limits) keep
 * their values.
 */
export function writeGlobalRoute(path: string, kind: RouteKind, route: LiveCompactModelRoute | null): void {
	const record = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown> & { liveCompact?: Record<string, unknown> };
	const liveCompact = { ...(record.liveCompact ?? {}) };
	const current = { ...((liveCompact[kind] as Record<string, unknown> | undefined) ?? {}) };
	delete current.provider;
	delete current.model;
	const next = route?.provider && route.model ? { ...current, provider: route.provider, model: route.model } : current;
	if (Object.keys(next).length === 0) delete liveCompact[kind];
	else liveCompact[kind] = next;
	const updated: Record<string, unknown> = { ...record, liveCompact };
	const parsed = parseLiveCompactConfig(updated.liveCompact);
	checkLiveCompactCombination(parsed, {
		observationPack: updated.observationPack === true,
		evidencePreservingReducer: updated.evidencePreservingReducer === true,
	});
	const temporary = `${path}.tmp-${process.pid}`;
	writeFileSync(temporary, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
	renameSync(temporary, path);
}
