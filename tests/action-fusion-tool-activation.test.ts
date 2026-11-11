/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
/**
 * Action Fusion must keep the active state of edit and write that other extensions chose before
 * it registered its replacements, for example pi-hashline-edit-pro turning edit off for anchored
 * edit tools, or pi-openai-codex-compat turning edit and write off for apply_patch.
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
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/sol-pi/config.ts";
import { createActionFusionExtension } from "../src/sol-pi/extensions/action-fusion/index.ts";
import { createSolPiExtension } from "../src/sol-pi/index.ts";
import { FakePi } from "./helpers.ts";

function hasThenRun(tool: { parameters?: unknown } | undefined): boolean {
	return JSON.stringify(tool?.parameters ?? {}).includes("then_run");
}

/**
 * A FakePi with an active tool set. Like Pi with a tool allowlist, registering a tool activates
 * it regardless of `defaultActive`, which is the case defaultActive alone cannot cover.
 */
class ActiveToolsPi extends FakePi {
	active: string[];
	readonly setCalls: string[][] = [];

	constructor(active: string[], private readonly throwOnRead = false) {
		super();
		this.active = [...active];
	}

	override registerTool(tool: ToolDefinition): void {
		super.registerTool(tool);
		if (!this.active.includes(tool.name)) this.active.push(tool.name);
	}

	getActiveTools(): string[] {
		if (this.throwOnRead) throw new Error("not available while loading");
		return [...this.active];
	}

	setActiveTools(names: string[]): void {
		this.setCalls.push([...names]);
		this.active = [...names];
	}
}

describe("Action Fusion tool activation", () => {
	it("does not re-activate an edit tool another extension turned off; write stays active with then_run", () => {
		const pi = new ActiveToolsPi(["read", "bash", "write", "replace"]);
		createActionFusionExtension()(pi.asExtensionApi());

		expect(pi.active).not.toContain("edit");
		expect(pi.active).toEqual(["read", "bash", "write", "replace"]);
		// Both replacements are registered, so a later setActiveTools(["edit", ...]) gets the fused edit.
		expect(hasThenRun(pi.tool("edit"))).toBe(true);
		expect(hasThenRun(pi.tool("write"))).toBe(true);
		expect((pi.tool("edit") as { defaultActive?: boolean }).defaultActive).toBe(false);
		expect((pi.tool("write") as { defaultActive?: boolean }).defaultActive).toBeUndefined();
	});

	it("keeps both edit and write off when apply_patch replaced them", () => {
		const pi = new ActiveToolsPi(["read", "bash", "apply_patch"]);
		createActionFusionExtension()(pi.asExtensionApi());
		expect(pi.active).toEqual(["read", "bash", "apply_patch"]);
		expect((pi.tool("write") as { defaultActive?: boolean }).defaultActive).toBe(false);
	});

	it("leaves active tools untouched and makes no setActiveTools call when nothing was off", () => {
		const pi = new ActiveToolsPi(["read", "bash", "edit", "write"]);
		createActionFusionExtension()(pi.asExtensionApi());
		expect(pi.active).toEqual(["read", "bash", "edit", "write"]);
		expect(pi.setCalls).toEqual([]);
	});

	it("keeps the previous behavior when the active tool set cannot be read", () => {
		// No getActiveTools at all (the minimal FakePi), or Pi rejecting the call while loading.
		const minimal = new FakePi();
		createActionFusionExtension()(minimal.asExtensionApi());
		expect(minimal.registeredTools.map((tool) => tool.name)).toEqual(["edit", "write"]);
		expect((minimal.tool("edit") as { defaultActive?: boolean }).defaultActive).toBeUndefined();

		const loading = new ActiveToolsPi(["read"], true);
		createActionFusionExtension()(loading.asExtensionApi());
		expect(loading.setCalls).toEqual([]);
		expect((loading.tool("edit") as { defaultActive?: boolean }).defaultActive).toBeUndefined();
	});
});

describe("Action Fusion tool activation in a Pi AgentSession", () => {
	async function activeTools(options: {
		readonly name: string;
		readonly disable: readonly string[];
		readonly tools?: string[];
		readonly solPiFirst?: boolean;
	}): Promise<{ readonly startup: string[]; readonly reload: string[]; readonly editThenRun: boolean; readonly starts: number }> {
		const cwd = await mkdtemp(join(tmpdir(), "sol-pi-af-activation-"));
		const agentDir = join(cwd, "agent");
		await mkdir(agentDir);
		const faux = fauxProvider({
			provider: `af-activation-${options.name}`,
			api: `af-activation-api-${options.name}`,
			models: [{ id: `af-activation-model-${options.name}`, contextWindow: 100_000, maxTokens: 1_000 }],
		});
		let starts = 0;
		// Stands in for pi-hashline-edit-pro / pi-openai-codex-compat: turns tools off at session_start.
		const disabler: ExtensionFactory = (pi) => {
			pi.registerProvider(faux.provider);
			pi.on("session_start", () => {
				starts += 1;
				pi.setActiveTools(pi.getActiveTools().filter((name) => !options.disable.includes(name)));
			});
		};
		const solPi = createSolPiExtension(() => ({ ...DEFAULT_CONFIG, actionFusion: true }));
		const factories = options.solPiFirst ? [solPi, disabler] : [disabler, solPi];
		const settingsManager = SettingsManager.inMemory({ retry: { enabled: false } });
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			extensionFactories: factories.map((factory, index) => ({ name: `af-activation-${options.name}-${index}`, factory })),
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			systemPrompt: "Action Fusion activation test.",
		});
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: faux.getModel(),
			resourceLoader,
			sessionManager: SessionManager.inMemory(cwd),
			settingsManager,
			...(options.tools ? { tools: options.tools } : {}),
		});
		try {
			// A binding makes Pi emit session_start on reload too.
			await session.bindExtensions({ onError: () => undefined });
			const startup = session.getActiveToolNames();
			const editThenRun = hasThenRun(
				session.getAllTools().find((tool) => tool.name === "edit") as { parameters?: unknown } | undefined,
			);
			await session.reload();
			return { startup, reload: session.getActiveToolNames(), editThenRun, starts };
		} finally {
			session.dispose();
			await rm(cwd, { recursive: true, force: true });
		}
	}

	// With a tool allowlist (`--tools`), every registry refresh activates every allowed tool; this
	// is where SoL-Pi's session_start registration used to re-activate a disabled edit or write.
	const allowlist = ["read", "bash", "edit", "write"];

	it.each([
		["edit off (hashline)", ["edit"], ["read", "bash", "write"]],
		["edit and write off (apply_patch)", ["edit", "write"], ["read", "bash"]],
	] as const)("keeps %s across startup and reload with a tool allowlist", async (_label, disable, expected) => {
		const result = await activeTools({ name: disable.join("-"), disable, tools: allowlist });
		expect(result.starts).toBe(2);
		expect([...result.startup].sort()).toEqual([...expected].sort());
		expect([...result.reload].sort()).toEqual([...expected].sort());
		// The fused edit is still registered, ready for an explicit setActiveTools.
		expect(result.editThenRun).toBe(true);
	});

	it.each([false, true])("keeps edit off without an allowlist (SoL-Pi first: %s)", async (solPiFirst) => {
		const result = await activeTools({ name: `default-${solPiFirst}`, disable: ["edit"], solPiFirst });
		expect([...result.startup].sort()).toEqual(["bash", "read", "write"]);
		expect([...result.reload].sort()).toEqual(["bash", "read", "write"]);
	});

	it("still activates the fused edit and write when nothing turned them off", async () => {
		const result = await activeTools({ name: "untouched", disable: [], tools: allowlist });
		expect([...result.startup].sort()).toEqual(["bash", "edit", "read", "write"]);
		expect(result.editThenRun).toBe(true);
	});
});
