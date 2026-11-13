/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */

import { getAgentDir, VERSION, type BashToolOptions, type ExtensionAPI, type ExtensionContext, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { loadSolPiConfig, type SolPiConfig } from "./config.ts";
import { createActionFusionExtension } from "./extensions/action-fusion/index.ts";
import { loadActionFusionBashOptions } from "./shell-options.ts";
import { registerEvidencePreservingReducer } from "./extensions/evidence-preserving-reducer/index.ts";
import { registerObservationPack } from "./extensions/observation-pack/index.ts";
import {
	liveCompactSupported,
	registerLiveCompact,
	registerLiveCompactUnsupportedNotice,
} from "./extensions/live-compact/index.ts";
import { createOnlineContextCompactExtension } from "./extensions/online-context-compact/index.ts";

export function registerConfiguredFeatures(
	pi: ExtensionAPI,
	config: SolPiConfig,
	bashOptions?: BashToolOptions,
	piVersion: string = VERSION,
	initialContext?: ExtensionContext,
): void {
	if (config.actionFusion) createActionFusionExtension({ bashOptions })(pi);
	// Decided once at registration, so a session never switches between modes midway.
	const liveCompact = config.liveCompact.enabled && liveCompactSupported(piVersion);
	if (config.liveCompact.enabled && !liveCompact) registerLiveCompactUnsupportedNotice(pi, piVersion);
	// Live Compact owns pressure-driven replacement; ObservationPack keeps the archive and obs_recall.
	if (config.observationPack) registerObservationPack(pi, { legacyProjection: !liveCompact });
	if (config.evidencePreservingReducer) {
		registerEvidencePreservingReducer(pi, {
			reducerModel: config.evidencePreservingReducerModel,
			reducerProvider: config.evidencePreservingReducerProvider,
		});
	}
	if (config.onlineContextCompact) {
		createOnlineContextCompactExtension({
			cacheWriteReadRatio: config.cacheWriteReadRatio,
			// Price-driven boundary compaction would trigger the deep native summary Live Compact avoids.
			economicCompaction: !liveCompact,
		})(pi);
	}
	if (liveCompact) registerLiveCompact(pi, config.liveCompact, initialContext);
}

export type SolPiConfigLoader = (ctx: ExtensionContext) => SolPiConfig;

export function createSolPiExtension(
	loadConfig: SolPiConfigLoader = (ctx) => loadSolPiConfig(ctx.cwd, getAgentDir(), ctx.isProjectTrusted()),
): ExtensionFactory {
	return (pi) => {
		let initialized = false;
		pi.on("session_start", (_event, ctx) => {
			if (initialized) return;
			initialized = true;
			const config = loadConfig(ctx);
			const bashOptions = config.actionFusion
				? loadActionFusionBashOptions(ctx.cwd, ctx.isProjectTrusted())
				: undefined;
			registerConfiguredFeatures(pi, config, bashOptions, VERSION, ctx);
		});
	};
}

export default function solPiExtension(pi: ExtensionAPI): void {
	createSolPiExtension()(pi);
}
