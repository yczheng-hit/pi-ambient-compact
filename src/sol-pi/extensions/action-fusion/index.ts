/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
/**
 * Action Fusion - fuse a file mutation and its follow-up command into one turn.
 *
 * Base pi rollouts repeatedly showed the same pair of turns: edit or write a
 * file, then run a command to test, build, or start it. This extension replaces
 * the built-in `edit` and `write` tools with versions that take an optional
 * `then_run` object, apply the mutation, run the command, and return one
 * combined observation. The model decision between the two turns disappears.
 *
 * Everything else about `edit` and `write` is inherited from the built-in
 * definitions: their schemas, prompt text, argument shims, and renderers.
 *
 * This standalone version composes only Pi's public tool definitions.
 */

import {
	type BashToolOptions,
	createEditToolDefinition,
	createWriteToolDefinition,
	type EditToolDetails,
	type EditToolOptions,
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionFactory,
	type WriteToolOptions,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { resolveToolPath } from "./file-queue.ts";
import { isNestedToolCallId, renderSolPiTool, showSolPiSavings } from "../../tui.ts";
import { createThenRunSchema, runFusedMutation, type ThenRunInput, type ThenRunStatus } from "./then-run.ts";

const EDIT_THEN_RUN_DESCRIPTION =
	"Command to run next on this file after the edit succeeds — e.g. run, build, start/restart, install, or check it; optional timeout in seconds. Skipped if the edit fails; a non-zero exit is reported but keeps the edit.";
const WRITE_THEN_RUN_DESCRIPTION =
	"Command to run next on this file after the write succeeds — e.g. run, build, start/restart, install, or check it; optional timeout in seconds. Skipped if the write fails; a non-zero exit is reported but keeps the write.";

export interface ActionFusionOptions {
	/** Optional programmatic bash overrides, primarily for tests and embedded runtimes. */
	readonly bashOptions?: BashToolOptions;
	/** Overrides for the underlying built-in `edit` tool. */
	readonly editOptions?: EditToolOptions;
	/** Overrides for the underlying built-in `write` tool. */
	readonly writeOptions?: WriteToolOptions;
}

/**
 * Built-in tool definitions capture their cwd in closures, so keep one per
 * working directory instead of rebuilding them on every call and every redraw.
 */
function memoizeByCwd<T>(create: (cwd: string) => T): (cwd: string) => T {
	const cache = new Map<string, T>();
	return (cwd) => {
		const cached = cache.get(cwd);
		if (cached) return cached;
		const created = create(cwd);
		cache.set(cwd, created);
		return created;
	};
}

/**
 * Announce the avoided round-trip only when the command actually succeeded,
 * as reported by the fusion itself, never by matching command output. Calls
 * from a codemode script (`<parent id>/<n>`) save no model round-trip of their
 * own: the script already chains tools inside one model call.
 */
function announceSavings(status: ThenRunStatus, toolCallId: string, ctx: ExtensionContext): void {
	if (status !== "succeeded" || isNestedToolCallId(toolCallId)) return;
	showSolPiSavings(ctx, "Action Fusion", "1 model round-trip avoided");
}

/**
 * Show the savings banner on a fused call unless it settled as an error: a
 * failed or skipped command avoided no round-trip. Pi redraws the call row
 * with the settled `isError` as well, so both renderers drop it together.
 */
function showsSavingsBanner(thenRun: unknown, context: { readonly isError?: boolean }): boolean {
	return Boolean(thenRun) && !context.isError;
}

/** The tools Action Fusion replaces. */
const FUSED_TOOLS = ["edit", "write"] as const;

/**
 * Pi's active tool names, or `undefined` when they cannot be read: minimal test
 * doubles have no `getActiveTools`, and Pi rejects the call while it is still
 * loading extensions.
 */
function readActiveTools(pi: ExtensionAPI): string[] | undefined {
	const getActiveTools = (pi as Partial<Pick<ExtensionAPI, "getActiveTools">>).getActiveTools;
	if (typeof getActiveTools !== "function") return undefined;
	try {
		const names = getActiveTools.call(pi);
		return Array.isArray(names) ? names : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Restore the inactive state of fused tools that another extension had turned off before Action
 * Fusion registered its replacements. Re-registering a tool refreshes Pi's tool registry, and
 * while a tool allowlist is set (`--tools`) that refresh activates every allowed tool, whatever
 * `defaultActive` says. Tools that were active stay active.
 */
function restoreInactiveFusedTools(pi: ExtensionAPI, activeBefore: ReadonlySet<string>): void {
	const after = readActiveTools(pi);
	const setActiveTools = (pi as Partial<Pick<ExtensionAPI, "setActiveTools">>).setActiveTools;
	if (!after || typeof setActiveTools !== "function") return;
	const reactivated = new Set<string>(FUSED_TOOLS.filter((name) => !activeBefore.has(name) && after.includes(name)));
	if (reactivated.size === 0) return;
	try {
		setActiveTools.call(
			pi,
			after.filter((name) => !reactivated.has(name)),
		);
	} catch {
		// Leave Pi's state alone when it refuses the update.
	}
}

/** A fused tool that another extension's same-name tool shadows. */
export interface ShadowedFusedTool {
	readonly name: (typeof FUSED_TOOLS)[number];
	/** The owner Pi reports for the effective tool: its source, or its path when known. */
	readonly owner: string;
}

function declaresThenRun(parameters: unknown): boolean {
	const properties = (parameters as { properties?: Record<string, unknown> } | undefined)?.properties;
	return typeof properties === "object" && properties !== null && Object.hasOwn(properties, "then_run");
}

/**
 * Fused tools whose effective definition is not Action Fusion's. Pi keeps the first registration
 * of a tool name in extension load order, so an extension loaded earlier that registers `edit` or
 * `write` wins even when Action Fusion registers later; its tool then has no `then_run`.
 * Returns an empty list when Pi cannot report its tools.
 */
export function findShadowedFusedTools(pi: ExtensionAPI): ShadowedFusedTool[] {
	const getAllTools = (pi as Partial<Pick<ExtensionAPI, "getAllTools">>).getAllTools;
	if (typeof getAllTools !== "function") return [];
	let tools: ReturnType<ExtensionAPI["getAllTools"]>;
	try {
		tools = getAllTools.call(pi);
	} catch {
		return [];
	}
	if (!Array.isArray(tools)) return [];
	return FUSED_TOOLS.flatMap((name) => {
		const tool = tools.find((candidate) => candidate?.name === name);
		if (!tool || declaresThenRun(tool.parameters)) return [];
		const source = tool.sourceInfo;
		return [{ name, owner: source?.path || source?.source || "another extension" }];
	});
}

function shadowedNotice(shadowed: readonly ShadowedFusedTool[]): string {
	const parts = shadowed.map((tool) => `${tool.name} is provided by ${tool.owner}`);
	return (
		`SoL-Pi Action Fusion: ${parts.join("; ")}, so then_run is unavailable for ` +
		`${shadowed.map((tool) => tool.name).join(" and ")}. ` +
		"Load SoL-Pi before that extension to use Action Fusion, or set actionFusion: false in sol-pi.json."
	);
}

export function createActionFusionExtension(options: ActionFusionOptions = {}): ExtensionFactory {
	const baseEdit = memoizeByCwd((cwd: string) => createEditToolDefinition(cwd, options.editOptions));
	const baseWrite = memoizeByCwd((cwd: string) => createWriteToolDefinition(cwd, options.writeOptions));

	return (pi: ExtensionAPI) => {
		const editTemplate = baseEdit(process.cwd());
		const writeTemplate = baseWrite(process.cwd());

		const editParameters = Type.Object({
			...editTemplate.parameters.properties,
			then_run: createThenRunSchema(EDIT_THEN_RUN_DESCRIPTION),
		});
		const writeParameters = Type.Object({
			...writeTemplate.parameters.properties,
			then_run: createThenRunSchema(WRITE_THEN_RUN_DESCRIPTION),
		});

		// Another extension may have turned edit or write off before this runs, for example
		// pi-hashline-edit-pro (anchored edit tools) or pi-openai-codex-compat (apply_patch). Keep
		// that state: registering a replacement must never re-activate a disabled tool.
		const activeNames = readActiveTools(pi);
		const activeBefore = activeNames ? new Set(activeNames) : undefined;
		const keepInactive = (name: (typeof FUSED_TOOLS)[number]) =>
			activeBefore && !activeBefore.has(name) ? { defaultActive: false } : {};

		pi.registerTool<typeof editParameters, EditToolDetails | undefined>({
			...editTemplate,
			...keepInactive("edit"),
			parameters: editParameters,
			async execute(toolCallId, input, signal, onUpdate, ctx) {
				const { then_run, ...editInput } = input as typeof input & { then_run?: ThenRunInput };
				const { result, status } = await runFusedMutation({
					toolCallId,
					absolutePath: resolveToolPath(ctx.cwd, input.path),
					thenRun: then_run,
					bashOptions: options.bashOptions,
					signal,
					ctx,
					mutate: () => baseEdit(ctx.cwd).execute(toolCallId, editInput, signal, onUpdate, ctx),
				});
				announceSavings(status, toolCallId, ctx);
				return result;
			},
			renderCall: (args, theme, context) => {
				const base = baseEdit(context.cwd).renderCall!(args, theme, context);
				return showsSavingsBanner(args.then_run, context)
					? renderSolPiTool(theme, "Action Fusion", "1 model round-trip avoided", base)
					: base;
			},
			renderResult: (result, resultOptions, theme, context) => {
				const base = baseEdit(context.cwd).renderResult!(result, resultOptions, theme, context);
				return showsSavingsBanner(context.args.then_run, context)
					? renderSolPiTool(theme, "Action Fusion", "1 model round-trip avoided", base)
					: base;
			},
		});

		pi.registerTool<typeof writeParameters, undefined>({
			...writeTemplate,
			...keepInactive("write"),
			parameters: writeParameters,
			async execute(toolCallId, input, signal, onUpdate, ctx) {
				const { then_run, ...writeInput } = input as typeof input & { then_run?: ThenRunInput };
				const { result, status } = await runFusedMutation({
					toolCallId,
					absolutePath: resolveToolPath(ctx.cwd, input.path),
					thenRun: then_run,
					bashOptions: options.bashOptions,
					signal,
					ctx,
					mutate: () => baseWrite(ctx.cwd).execute(toolCallId, writeInput, signal, onUpdate, ctx),
				});
				announceSavings(status, toolCallId, ctx);
				return result;
			},
			renderCall: (args, theme, context) => {
				const base = baseWrite(context.cwd).renderCall!(args, theme, context);
				return showsSavingsBanner(args.then_run, context)
					? renderSolPiTool(theme, "Action Fusion", "1 model round-trip avoided", base)
					: base;
			},
			renderResult: (result, resultOptions, theme, context) => {
				const base = baseWrite(context.cwd).renderResult!(result, resultOptions, theme, context);
				return showsSavingsBanner(context.args.then_run, context)
					? renderSolPiTool(theme, "Action Fusion", "1 model round-trip avoided", base)
					: base;
			},
		});

		if (activeBefore) restoreInactiveFusedTools(pi, activeBefore);

		// Check ownership once every extension has finished starting: some register their own
		// write after session_start, so the first prompt is the earliest reliable point.
		// Minimal test doubles provide only registerTool.
		if (typeof (pi as Partial<Pick<ExtensionAPI, "on">>).on !== "function") return;
		let ownershipChecked = false;
		pi.on("before_agent_start", (_event, ctx) => {
			if (ownershipChecked) return;
			ownershipChecked = true;
			const shadowed = findShadowedFusedTools(pi);
			if (shadowed.length === 0) return;
			const notice = shadowedNotice(shadowed);
			if (ctx.hasUI) ctx.ui.notify(notice, "warning");
			else console.error(`[sol-pi] ${notice}`);
		});
	};
}

export type { ThenRunInput } from "./then-run.ts";
export {
	assertUnchangedBeforeCommand,
	executeMutationThenRun,
	THEN_RUN_FAILED,
	THEN_RUN_SKIPPED,
	THEN_RUN_SUCCEEDED,
} from "./then-run.ts";

export function registerActionFusion(pi: ExtensionAPI): void {
	createActionFusionExtension()(pi);
}

export default registerActionFusion;
