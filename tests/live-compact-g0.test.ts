/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
/**
 * G0 of the dynamic compaction plan (docs/live-compact-dynamic-plan.md §10):
 * pin the Pi behavior that global, mid-history edits rely on, in real
 * AgentSessions, and check the provider payloads Pi would send.
 *
 * - G0-1: replacing and omitting complete mid-history spans gives valid
 *   Anthropic and OpenAI Responses payloads; raw entries and reloads hold.
 * - G0-2: which hooks can keep a request from reaching the provider.
 * - G0-3: batch validation, prefix-safe ordering, crash detection, completion.
 * - G0-4: session_before_compact ownership with a second compaction extension.
 */
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message, Model, TranscriptContext } from "@earendil-works/pi-ai";
import { streamSimple as anthropicStream } from "@earendil-works/pi-ai/api/anthropic-messages";
import { streamSimple as responsesStream } from "@earendil-works/pi-ai/api/openai-responses";
import { transformMessages } from "@earendil-works/pi-ai/api/transform-messages";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
	type FauxResponseStep,
} from "@earendil-works/pi-ai/providers/faux";
import {
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionAPI,
	type ExtensionFactory,
	type SessionEntry,
	SessionManager,
	SettingsManager,
	type TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	BATCH_BEGIN,
	BATCH_END,
	batchDrafts,
	completionDrafts,
	findIncompleteBatches,
	orderPrefixSafe,
	type PlannedEdit,
} from "../src/sol-pi/extensions/live-compact/commit.ts";
import { validateToolPairing } from "../src/sol-pi/extensions/live-compact/validator.ts";

// ---------------------------------------------------------------------------------------------
// Session harness

function dumpText(label: string): string {
	return Array.from({ length: 40 }, (_, line) => `${label} line ${line} ${"x".repeat(40)}`).join("\n");
}

const dumpTool: ExtensionFactory = (pi) => {
	pi.registerTool({
		name: "dump",
		label: "Dump",
		description: "Return a deterministic text block.",
		parameters: Type.Object({ label: Type.String() }),
		async execute(_id, params) {
			return { content: [{ type: "text", text: dumpText(params.label) }], details: undefined };
		},
	});
};

const call = (label: string, id = label) =>
	fauxAssistantMessage(fauxToolCall("dump", { label }, { id }), { stopReason: "toolUse" });

type Harness = {
	readonly sessionManager: SessionManager;
	readonly faux: ReturnType<typeof fauxProvider>;
	readonly requests: Message[][];
	readonly errors: string[];
	readonly prompt: (text: string, responses: FauxResponseStep[]) => Promise<void>;
	readonly dispose: () => void;
};

let harnessCount = 0;

async function harness(options: {
	readonly extensions?: ExtensionFactory[];
	readonly sessionManager?: (cwd: string) => SessionManager;
	readonly contextWindow?: number;
	readonly compaction?: { enabled: boolean; reserveTokens: number; keepRecentTokens: number };
}): Promise<Harness & { readonly cwd: string }> {
	harnessCount += 1;
	const name = `g0-${harnessCount}`;
	const cwd = await mkdtemp(join(tmpdir(), "sol-pi-g0-"));
	const agentDir = join(cwd, "agent");
	await mkdir(agentDir);
	const faux = fauxProvider({
		provider: `${name}-provider`,
		api: `${name}-api`,
		models: [{ id: `${name}-model`, contextWindow: options.contextWindow ?? 200_000, maxTokens: 1_024 }],
	});
	const requests: Message[][] = [];
	const providerExtension: ExtensionFactory = (pi) => pi.registerProvider(faux.provider);
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager: SettingsManager.inMemory(),
		extensionFactories: [providerExtension, dumpTool, ...(options.extensions ?? [])].map((factory, index) => ({
			name: `${name}-ext-${index}`,
			factory,
		})),
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPrompt: "G0 test assistant.",
	});
	await resourceLoader.reload();
	expect(resourceLoader.getExtensions().errors).toEqual([]);
	const sessionManager = options.sessionManager ? options.sessionManager(cwd) : SessionManager.inMemory(cwd);
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		model: faux.getModel(),
		thinkingLevel: "off",
		tools: ["dump"],
		resourceLoader,
		sessionManager,
		settingsManager: SettingsManager.inMemory({
			retry: { enabled: false },
			compaction: options.compaction ?? { enabled: false, reserveTokens: 1_024, keepRecentTokens: 1_000 },
		}),
	});
	const errors: string[] = [];
	session.extensionRunner.onError((error) => errors.push(`${error.event}: ${error.error}`));
	await session.bindExtensions({ onError: () => undefined });
	return {
		cwd,
		sessionManager,
		faux,
		requests,
		errors,
		prompt: async (text, responses) => {
			faux.setResponses(
				responses.map((step) => async (context, streamOptions, state, model) => {
					requests.push(structuredClone(context.messages));
					await streamOptions?.onPayload?.({ messages: context.messages }, model);
					return typeof step === "function" ? await step(context, streamOptions, state, model) : step;
				}),
			);
			await session.prompt(text, { expandPromptTemplates: false, source: "interactive" });
		},
		dispose: () => session.dispose(),
	};
}

function textOf(messages: readonly Message[]): string {
	return JSON.stringify(messages);
}

function entryFor(branch: readonly SessionEntry[], predicate: (message: AgentMessage) => boolean): SessionEntry {
	const entry = branch.find((candidate) => candidate.type === "message" && predicate(candidate.message));
	if (!entry) throw new Error("entry not found");
	return entry;
}

const isCall = (id: string) => (message: AgentMessage) =>
	message.role === "assistant" && message.content.some((block) => block.type === "toolCall" && block.id === id);
const isResult = (id: string) => (message: AgentMessage) => message.role === "toolResult" && message.toolCallId === id;
const isAssistantText = (text: string) => (message: AgentMessage) =>
	message.role === "assistant" && message.content.some((block) => block.type === "text" && block.text === text);

const summary = (text: string) => ({ content: [{ type: "text" as const, text }] });
const contentOf = (message: AgentMessage): unknown => (message as { content?: unknown }).content;

/**
 * The G0-1 plan: an episode-level span (task A, between two user messages) carried by its first
 * assistant message, and an intra-episode span (task B rounds b1-b2) carried by b1's tool result.
 */
function plannedEdits(branch: readonly SessionEntry[]): PlannedEdit[] {
	const a1 = entryFor(branch, isCall("a1"));
	const b1 = entryFor(branch, isCall("b1"));
	const b1Call = b1.type === "message" && b1.message.role === "assistant" ? b1.message.content.find((block) => block.type === "toolCall") : undefined;
	return [
		{ targetId: a1.id, replacement: summary("[Live Compact history summary] Task A dumped a1 and a2; finished.") },
		{ targetId: entryFor(branch, isResult("a1")).id, replacement: null },
		{ targetId: entryFor(branch, isCall("a2")).id, replacement: null },
		{ targetId: entryFor(branch, isResult("a2")).id, replacement: null },
		{ targetId: entryFor(branch, isAssistantText("A done")).id, replacement: null },
		// Keep b1's call with compacted arguments so its result can carry the summary.
		{
			targetId: b1.id,
			replacement: { content: [{ ...b1Call!, arguments: { compacted: "see result" } }] },
		},
		{ targetId: entryFor(branch, isResult("b1")).id, replacement: summary("[Live Compact history summary] b1 and b2 dumped; nothing failed.") },
		{ targetId: entryFor(branch, isCall("b2")).id, replacement: null },
		{ targetId: entryFor(branch, isResult("b2")).id, replacement: null },
	];
}

/** An extension that commits `plan` once, at the first turn_end whose tool results include `afterCall`. */
function planner(afterCall: string, plan: (branch: readonly SessionEntry[]) => ReturnType<typeof batchDrafts>): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		let done = false;
		pi.on("turn_end", (event: TurnEndEvent, ctx) => {
			if (done || !event.toolResults.some((result) => result.toolCallId === afterCall)) return;
			done = true;
			return { entries: [...event.entries, ...plan(ctx.sessionManager.getBranch())] };
		});
	};
}

const twoTasks = async (run: Harness) => {
	await run.prompt("task A", [call("a1"), call("a2"), fauxAssistantMessage("A done")]);
	await run.prompt("task B", [call("b1"), call("b2"), call("b3"), fauxAssistantMessage("B done")]);
};

function editedPlan(branch: readonly SessionEntry[]) {
	const byId = new Map(branch.map((entry) => [entry.id, entry]));
	return batchDrafts("batch-g0", orderPrefixSafe(plannedEdits(branch), (id) => byId.get(id)));
}

// ---------------------------------------------------------------------------------------------
// Provider payload capture: a loopback server that records the request body and answers 400.

let server: Server;
let baseUrl = "";
const bodies: unknown[] = [];

beforeAll(async () => {
	server = createServer((request, response) => {
		let body = "";
		request.on("data", (chunk) => {
			body += chunk;
		});
		request.on("end", () => {
			bodies.push(JSON.parse(body));
			response.writeHead(400, { "content-type": "application/json" });
			response.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "captured" } }));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	baseUrl = typeof address === "object" && address ? `http://127.0.0.1:${address.port}` : "";
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

function testModel(api: "anthropic-messages" | "openai-responses"): Model<string> {
	return {
		id: api === "anthropic-messages" ? "claude-g0" : "gpt-g0",
		name: "g0",
		api,
		provider: api === "anthropic-messages" ? "anthropic" : "openai",
		baseUrl: api === "anthropic-messages" ? baseUrl : `${baseUrl}/v1`,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 1_024,
	} as Model<string>;
}

async function capturePayload(api: "anthropic-messages" | "openai-responses", messages: Message[]): Promise<Record<string, unknown>> {
	const before = bodies.length;
	const model = testModel(api);
	const context = { messages } as unknown as TranscriptContext;
	const stream =
		api === "anthropic-messages"
			? anthropicStream(model as never, context, { apiKey: "test-key", maxRetries: 0 } as never)
			: responsesStream(model as never, context, { apiKey: "test-key", maxRetries: 0 } as never);
	for await (const _event of stream) {
		// The 400 ends the stream with an error event; the request body is what matters.
	}
	expect(bodies.length).toBe(before + 1);
	return bodies.at(-1) as Record<string, unknown>;
}

type AnthropicMessage = { role: string; content: Array<Record<string, unknown>> | string };

/** Anthropic: roles alternate and each tool_use is answered by the next user message. */
function checkAnthropic(payload: Record<string, unknown>): void {
	const messages = payload.messages as AnthropicMessage[];
	for (let index = 1; index < messages.length; index += 1) {
		expect(messages[index]!.role, `message ${index}`).not.toBe(messages[index - 1]!.role);
	}
	messages.forEach((message, index) => {
		const blocks = Array.isArray(message.content) ? message.content : [];
		const uses = blocks.filter((block) => block.type === "tool_use").map((block) => block.id);
		const next = messages[index + 1];
		const nextBlocks = next && Array.isArray(next.content) ? next.content : [];
		const results = nextBlocks.filter((block) => block.type === "tool_result").map((block) => block.tool_use_id);
		if (uses.length > 0) expect(results.sort()).toEqual([...uses].sort());
		if (message.role === "user") {
			const own = blocks.filter((block) => block.type === "tool_result").map((block) => block.tool_use_id);
			const previous = messages[index - 1];
			const previousUses =
				previous && Array.isArray(previous.content)
					? previous.content.filter((block) => block.type === "tool_use").map((block) => block.id)
					: [];
			for (const id of own) expect(previousUses).toContain(id);
		}
	});
	expect(JSON.stringify(messages)).not.toContain("No result provided");
}

/** OpenAI Responses: every function_call has exactly one output, and no output lacks its call. */
function checkResponses(payload: Record<string, unknown>): void {
	const input = payload.input as Array<Record<string, unknown>>;
	const calls = input.filter((item) => item.type === "function_call").map((item) => item.call_id);
	const outputs = input.filter((item) => item.type === "function_call_output").map((item) => item.call_id);
	expect([...outputs].sort()).toEqual([...calls].sort());
	expect(JSON.stringify(input)).not.toContain("No result provided");
}

// ---------------------------------------------------------------------------------------------

describe("G0-1: complete mid-history spans can be replaced or omitted", () => {
	it("sends valid Anthropic and OpenAI Responses payloads and keeps raw entries", async () => {
		const run = await harness({ extensions: [planner("b3", editedPlan)] });
		try {
			await twoTasks(run);
			expect(run.errors).toEqual([]);
			// Requests: a1, a2, A done, b1, b2, b3, then the edited request that answers "B done".
			const edited = run.requests.at(-1)!;
			const before = run.requests.at(-2)!;
			expect(textOf(before)).toContain("a1 line 0");
			expect(textOf(edited)).not.toContain("a1 line 0");
			expect(textOf(edited)).not.toContain("b2 line 0");
			expect(textOf(edited)).toContain("b3 line 0");
			expect(textOf(edited)).toContain("Task A dumped a1 and a2");
			expect(textOf(edited)).toContain("b1 and b2 dumped");
			expect(validateToolPairing(edited as AgentMessage[])).toEqual([]);

			// pi-ai synthesizes no result and drops nothing for the edited context.
			const transformed = transformMessages(edited, run.faux.getModel());
			expect(JSON.stringify(transformed)).not.toContain("No result provided");
			checkAnthropic(await capturePayload("anthropic-messages", edited));
			checkResponses(await capturePayload("openai-responses", edited));

			// Raw history is untouched, and the batch is complete.
			const branch = run.sessionManager.getBranch();
			const rawA1 = entryFor(branch, isResult("a1"));
			expect(JSON.stringify(rawA1)).toContain("a1 line 0");
			expect(branch.filter((entry) => entry.type === "custom" && entry.customType === BATCH_BEGIN)).toHaveLength(1);
			expect(branch.filter((entry) => entry.type === "custom" && entry.customType === BATCH_END)).toHaveLength(1);
			expect(findIncompleteBatches(branch)).toEqual([]);
		} finally {
			run.dispose();
			await rm(run.cwd, { recursive: true, force: true });
		}
	});

	it("commits at agent_before_settle, so the next prompt's first request is already edited", async () => {
		const settleEditor: ExtensionFactory = (pi) => {
			let done = false;
			pi.on("agent_before_settle", (event, ctx) => {
				const branch = ctx.sessionManager.getBranch();
				// After task B has settled, edit tasks A and B's old rounds; request no continuation.
				if (done || !branch.some((entry) => entry.type === "message" && isAssistantText("B done")(entry.message))) return;
				done = true;
				return { entries: [...event.entries, ...editedPlan(branch)] };
			});
		};
		const run = await harness({ extensions: [settleEditor] });
		try {
			await twoTasks(run);
			const requestsAfterB = run.requests.length;
			await run.prompt("task C", [fauxAssistantMessage("C done")]);
			expect(run.errors).toEqual([]);
			// No extra request was made at settlement; the next prompt's first request carries the edits.
			expect(run.requests.length).toBe(requestsAfterB + 1);
			const first = run.requests.at(-1)!;
			expect(textOf(first)).not.toContain("a1 line 0");
			expect(textOf(first)).toContain("Task A dumped a1 and a2");
			expect(validateToolPairing(first as AgentMessage[])).toEqual([]);
			checkAnthropic(await capturePayload("anthropic-messages", first));
		} finally {
			run.dispose();
			await rm(run.cwd, { recursive: true, force: true });
		}
	});

	it("keeps the edited projection after the session file is reopened", async () => {
		const run = await harness({
			extensions: [planner("b3", editedPlan)],
			sessionManager: (cwd) => SessionManager.create(cwd, join(cwd, "sessions")),
		});
		try {
			await twoTasks(run);
			const file = run.sessionManager.getSessionFile()!;
			const live = JSON.stringify(run.sessionManager.buildSessionProjection().messages.map(contentOf));
			const reopened = SessionManager.open(file, join(run.cwd, "sessions"));
			expect(JSON.stringify(reopened.buildSessionProjection().messages.map(contentOf))).toBe(live);
			expect(validateToolPairing(reopened.buildSessionProjection().messages)).toEqual([]);
		} finally {
			run.dispose();
			await rm(run.cwd, { recursive: true, force: true });
		}
	});
});

describe("G0-2: keeping a request from reaching the provider", () => {
	it("ctx.abort() at turn_end stops the run before the next provider request", async () => {
		const aborter: ExtensionFactory = (pi) => {
			pi.on("turn_end", (event, ctx) => {
				if (event.toolResults.some((result) => result.toolCallId === "s1")) ctx.abort();
			});
		};
		const run = await harness({ extensions: [aborter] });
		try {
			await run.prompt("stop after one tool", [call("s1"), fauxAssistantMessage("must not be requested")]);
			expect(run.requests).toHaveLength(1);
			expect(run.faux.getPendingResponseCount()).toBe(1);
			// The session stays usable.
			await run.prompt("continue", [fauxAssistantMessage("ok")]);
			expect(run.requests).toHaveLength(2);
		} finally {
			run.dispose();
			await rm(run.cwd, { recursive: true, force: true });
		}
	});

	it("an input handler returning handled starts no run", async () => {
		const gate: ExtensionFactory = (pi) => {
			pi.on("input", (event) => (event.text.length > 1_000 ? { action: "handled" as const } : undefined));
		};
		const run = await harness({ extensions: [gate] });
		try {
			await run.prompt("p".repeat(2_000), [fauxAssistantMessage("must not be requested")]);
			expect(run.requests).toHaveLength(0);
		} finally {
			run.dispose();
			await rm(run.cwd, { recursive: true, force: true });
		}
	});

	it("a throwing before_provider_request handler does not block the request", async () => {
		const thrower: ExtensionFactory = (pi) => {
			pi.on("before_provider_request", () => {
				throw new Error("over budget");
			});
		};
		const run = await harness({ extensions: [thrower] });
		try {
			await run.prompt("hello", [fauxAssistantMessage("still sent")]);
			expect(run.requests).toHaveLength(1);
			expect(run.errors.some((error) => error.includes("over budget"))).toBe(true);
		} finally {
			run.dispose();
			await rm(run.cwd, { recursive: true, force: true });
		}
	});

	it("turn_end continue: false does not suppress the natural next request", async () => {
		const stopper: ExtensionFactory = (pi) => {
			pi.on("turn_end", () => ({ continue: false }));
		};
		const run = await harness({ extensions: [stopper] });
		try {
			await run.prompt("two steps", [call("c1"), fauxAssistantMessage("second request")]);
			expect(run.requests).toHaveLength(2);
		} finally {
			run.dispose();
			await rm(run.cwd, { recursive: true, force: true });
		}
	});
});

describe("G0-3: batches", () => {
	it("Pi rejects a whole batch with one invalid edit and appends nothing", async () => {
		const run = await harness({
			extensions: [
				planner("b3", (branch) => [
					...editedPlan(branch).slice(0, 3),
					{ type: "context_edit", targetId: "missing-entry", replacement: null },
					...editedPlan(branch).slice(3),
				]),
			],
		});
		try {
			await twoTasks(run);
			expect(run.errors.some((error) => error.includes("Invalid boundary entries"))).toBe(true);
			const branch = run.sessionManager.getBranch();
			expect(branch.some((entry) => entry.type === "custom" && entry.customType === BATCH_BEGIN)).toBe(false);
			expect(branch.some((entry) => entry.type === "context_edit")).toBe(false);
			expect(textOf(run.requests.at(-1)!)).toContain("a1 line 0");
		} finally {
			run.dispose();
			await rm(run.cwd, { recursive: true, force: true });
		}
	});

	it("every prefix of a prefix-safe batch leaves no tool result without its call", async () => {
		const run = await harness({});
		try {
			await twoTasks(run);
			const branch = run.sessionManager.getBranch();
			const drafts = editedPlan(branch).filter((draft) => draft.type === "context_edit");
			const header = run.sessionManager.getHeader()!;
			for (let count = 0; count <= drafts.length; count += 1) {
				const manager = SessionManager.inMemory(run.cwd, undefined, [header, ...branch]);
				for (const draft of drafts.slice(0, count)) {
					if (draft.type === "context_edit") manager.appendContextEdit(draft.targetId, draft.replacement);
				}
				const issues = validateToolPairing(manager.buildSessionProjection().messages);
				expect(issues.filter((issue) => issue.kind !== "orphan_call"), `prefix ${count}`).toEqual([]);
				if (count === drafts.length) expect(issues, "complete batch").toEqual([]);
			}
			// The unordered plan is not prefix-safe: omitting b2's call before its result orphans the result.
			const unordered = plannedEdits(branch);
			const manager = SessionManager.inMemory(run.cwd, undefined, [header, ...branch]);
			const firstOmittedCall = unordered.findIndex(
				(edit) => edit.replacement === null && entryFor(branch, isCall("a2")).id === edit.targetId,
			);
			for (const edit of unordered.slice(0, firstOmittedCall + 1)) manager.appendContextEdit(edit.targetId, edit.replacement);
			expect(validateToolPairing(manager.buildSessionProjection().messages).some((issue) => issue.kind === "orphan_result")).toBe(true);
		} finally {
			run.dispose();
			await rm(run.cwd, { recursive: true, force: true });
		}
	});

	it("detects a batch cut short by a crash and completes it at the next boundary", async () => {
		const sessions = (cwd: string) => join(cwd, "sessions");
		const first = await harness({ sessionManager: (cwd) => SessionManager.create(cwd, sessions(cwd)) });
		let file: string;
		let intended: string;
		try {
			await twoTasks(first);
			file = first.sessionManager.getSessionFile()!;
			const branch = first.sessionManager.getBranch();
			const drafts = editedPlan(branch);
			// The intended result, built on a scratch copy.
			const scratch = SessionManager.inMemory(first.cwd, undefined, [first.sessionManager.getHeader()!, ...branch]);
			for (const draft of drafts) if (draft.type === "context_edit") scratch.appendContextEdit(draft.targetId, draft.replacement);
			intended = JSON.stringify(scratch.buildSessionProjection().messages.map(contentOf));
			// Simulate a crash after the begin marker and three edits.
			const begin = drafts[0]!;
			if (begin.type === "custom") first.sessionManager.appendCustomEntry(begin.customType, begin.data);
			for (const draft of drafts.slice(1, 4)) {
				if (draft.type === "context_edit") first.sessionManager.appendContextEdit(draft.targetId, draft.replacement);
			}
		} finally {
			first.dispose();
		}

		const reopened = SessionManager.open(file!, sessions(first.cwd));
		const [incomplete] = findIncompleteBatches(reopened.getBranch());
		expect(incomplete?.landed).toHaveLength(3);
		expect(incomplete?.remaining).toHaveLength(6);
		// The interrupted state is still sendable: only tool calls without results, which pi-ai answers
		// with synthetic error results until the batch completes.
		const partial = validateToolPairing(reopened.buildSessionProjection().messages);
		expect(partial.filter((issue) => issue.kind !== "orphan_call")).toEqual([]);

		const completer: ExtensionFactory = (pi) => {
			pi.on("turn_end", (event, ctx) => {
				const batches = findIncompleteBatches(ctx.sessionManager.getBranch());
				if (batches.length === 0) return;
				return { entries: [...event.entries, ...batches.flatMap(completionDrafts)] };
			});
		};
		const second = await harness({ extensions: [completer], sessionManager: () => SessionManager.open(file!, sessions(first.cwd)) });
		try {
			await second.prompt("task C", [call("c1"), fauxAssistantMessage("C done")]);
			expect(second.errors).toEqual([]);
			const branch = second.sessionManager.getBranch();
			expect(findIncompleteBatches(branch)).toEqual([]);
			const end = branch.filter((entry) => entry.type === "custom" && entry.customType === BATCH_END).at(-1);
			expect(end?.type === "custom" && (end.data as { recovered?: boolean }).recovered).toBe(true);
			// The completed projection matches the intended one, plus task C.
			const contents = second.sessionManager.buildSessionProjection().messages.map(contentOf);
			expect(JSON.stringify(contents).startsWith(intended!.slice(0, -1))).toBe(true);
			expect(validateToolPairing(second.sessionManager.buildSessionProjection().messages)).toEqual([]);
			// The request after the completing boundary carries the complete batch.
			expect(validateToolPairing(second.requests.at(-1)! as AgentMessage[])).toEqual([]);
		} finally {
			second.dispose();
			await rm(first.cwd, { recursive: true, force: true });
		}
	});
});

describe("G0-4: session_before_compact ownership", () => {
	type Observed = { guidanceCalls: number; reasons: string[] };

	function compactionExtensions(observed: Observed) {
		const owner: ExtensionFactory = (pi) => {
			pi.on("session_before_compact", (event) => {
				observed.reasons.push(event.reason);
				return event.reason === "threshold" ? { cancel: true } : undefined;
			});
		};
		// Stands in for pi-compaction-guidance: produces its own summary.
		const guidance: ExtensionFactory = (pi) => {
			pi.on("session_before_compact", (event) => {
				observed.guidanceCalls += 1;
				return {
					compaction: {
						summary: "guidance summary",
						firstKeptEntryId: event.preparation.firstKeptEntryId,
						tokensBefore: event.preparation.tokensBefore,
					},
				};
			});
		};
		return { owner, guidance };
	}

	it.each(["owner-first", "guidance-first"] as const)("cancel wins regardless of order (%s)", async (order) => {
		const observed: Observed = { guidanceCalls: 0, reasons: [] };
		const { owner, guidance } = compactionExtensions(observed);
		const run = await harness({
			extensions: order === "owner-first" ? [owner, guidance] : [guidance, owner],
			contextWindow: 2_048,
			// Pi compacts above 2_048 - 512 tokens; three 40-line dumps cross it.
			compaction: { enabled: true, reserveTokens: 512, keepRecentTokens: 200 },
		});
		try {
			await run.prompt("fill", [call("f1"), call("f2"), call("f3"), fauxAssistantMessage("done")]);
			expect(observed.reasons).toContain("threshold");
			expect(run.sessionManager.getBranch().some((entry) => entry.type === "compaction")).toBe(false);
			// Cancelling is not admission: the request still goes out with the full context.
			expect(run.requests).toHaveLength(4);
			// Ordering decides only whether the other extension wastes its work first.
			if (order === "owner-first") expect(observed.guidanceCalls).toBe(0);
			else expect(observed.guidanceCalls).toBeGreaterThan(0);
		} finally {
			run.dispose();
			await rm(run.cwd, { recursive: true, force: true });
		}
	});
});

// Keep the imported helper referenced for type-only builds.
void fauxText;
