/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { validateToolPairing } from "../src/sol-pi/extensions/live-compact/validator.ts";

const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] }) as unknown as AgentMessage;
const system = () => ({ role: "system", content: "s" }) as unknown as AgentMessage;
const text = (value: string, stopReason = "stop") =>
	({ role: "assistant", content: [{ type: "text", text: value }], stopReason }) as unknown as AgentMessage;
const calls = (...ids: string[]) =>
	({
		role: "assistant",
		content: ids.map((id) => ({ type: "toolCall", id, name: "t", arguments: {} })),
		stopReason: "toolUse",
	}) as unknown as AgentMessage;
const result = (id: string) =>
	({ role: "toolResult", toolCallId: id, toolName: "t", content: [{ type: "text", text: "r" }], isError: false }) as unknown as AgentMessage;
const kinds = (messages: AgentMessage[]) => validateToolPairing(messages).map((issue) => `${issue.kind}@${issue.index}`);

describe("validateToolPairing", () => {
	it("accepts paired parallel calls, system messages, and alternating turns", () => {
		expect(kinds([system(), user("u"), calls("a", "b"), result("a"), result("b"), text("done"), user("u2"), text("ok")])).toEqual([]);
	});

	it("reports a call without its result, before the next assistant, user, or the end", () => {
		expect(kinds([user("u"), calls("a"), calls("b"), result("b")])).toEqual(["orphan_call@1"]);
		expect(kinds([user("u"), calls("a"), user("u2")])).toEqual(["orphan_call@1"]);
		expect(kinds([user("u"), calls("a")])).toEqual(["orphan_call@1"]);
	});

	it("reports a result without its call in the preceding assistant message", () => {
		expect(kinds([user("u"), result("a")])).toEqual(["orphan_result@1"]);
		expect(kinds([user("u"), calls("a"), result("a"), text("t"), result("a")])).toEqual(["orphan_result@4"]);
	});

	it("reports duplicate call ids and consecutive assistant messages", () => {
		expect(kinds([user("u"), calls("a"), result("a"), calls("a"), result("a")])).toEqual(["duplicate_call@3"]);
		expect(kinds([user("u"), text("one"), text("two")])).toEqual(["consecutive_assistant@2"]);
		expect(kinds([user("u"), text("one"), calls("a"), result("a")])).toEqual(["consecutive_assistant@2"]);
	});

	it("ignores errored and aborted assistant attempts, as Pi drops them before sending", () => {
		expect(kinds([user("u"), text("partial", "error"), text("retry")])).toEqual([]);
		expect(kinds([user("u"), text("partial", "aborted"), calls("a"), result("a")])).toEqual([]);
	});
});
