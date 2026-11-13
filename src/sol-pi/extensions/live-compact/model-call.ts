/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
/**
 * One text completion through a Pi model route, with Pi-managed authentication.
 *
 * A route is an explicit provider/model pair from `liveCompact.summary` or
 * `liveCompact.verification`, or the working model when both are omitted. An
 * explicit route that Pi cannot resolve is an error: Live Compact never falls
 * back to another provider. A response cut off by the output limit
 * (`stopReason: "length"`) is a failure, not a usable result.
 */
import type { Api, AssistantMessage, Context, Model, ProviderStreamOptions } from "@earendil-works/pi-ai";
import { complete as completeCompat } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { LiveCompactModelRoute } from "../../live-compact-config.mjs";

type ResolvedAuth =
	| { readonly ok: true; readonly apiKey?: string; readonly baseUrl?: string; readonly env?: Record<string, string>; readonly headers?: Record<string, string | null> }
	| { readonly ok: false; readonly error: string };
type Registry = {
	readonly find?: (provider: string, modelId: string) => Model<Api> | undefined;
	readonly complete?: (model: Model<Api>, context: Context, options?: ProviderStreamOptions) => Promise<AssistantMessage>;
	readonly getApiKeyAndHeaders?: (model: Model<Api>) => Promise<ResolvedAuth>;
};

export class RouteUnavailableError extends Error {
	override readonly name = "RouteUnavailableError";
}

/** The model a route names, or the working model. Throws when an explicit route is unknown. */
export function resolveRoute(ctx: ExtensionContext, route: LiveCompactModelRoute): Model<Api> {
	if (route.provider !== undefined && route.model !== undefined) {
		const model = (ctx.modelRegistry as unknown as Registry).find?.(route.provider, route.model);
		if (!model) throw new RouteUnavailableError(`Ambient Compact model route is unavailable: ${route.provider}/${route.model}`);
		return model;
	}
	if (!ctx.model) throw new RouteUnavailableError("Ambient Compact has no working model to follow");
	return ctx.model as Model<Api>;
}

export interface CompletionResult {
	readonly text: string;
	readonly ok: boolean;
	readonly stopReason: AssistantMessage["stopReason"];
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly errorMessage?: string;
}

function operationSignal(parent: AbortSignal, timeoutMs: number): { readonly signal: AbortSignal; readonly cleanup: () => void } {
	const controller = new AbortController();
	const relay = () => controller.abort(parent.reason);
	if (parent.aborted) relay();
	else parent.addEventListener("abort", relay, { once: true });
	const timer = setTimeout(() => controller.abort(new DOMException("Ambient Compact model call timed out", "AbortError")), timeoutMs);
	return {
		signal: controller.signal,
		cleanup: () => {
			clearTimeout(timer);
			parent.removeEventListener("abort", relay);
		},
	};
}

function stringHeaders(headers: Record<string, string | null> | undefined): Record<string, string> | undefined {
	if (headers === undefined) return undefined;
	return Object.fromEntries(Object.entries(headers).filter((entry): entry is [string, string] => entry[1] !== null));
}

export async function completeText(
	ctx: ExtensionContext,
	model: Model<Api>,
	request: { readonly system: string; readonly prompt: string; readonly maxTokens: number; readonly signal: AbortSignal; readonly timeoutMs: number },
): Promise<CompletionResult> {
	const registry = ctx.modelRegistry as unknown as Registry;
	const operation = operationSignal(request.signal, request.timeoutMs);
	try {
		const context: Context = {
			systemPrompt: request.system,
			messages: [{ role: "user", content: [{ type: "text", text: request.prompt }], timestamp: Date.now() }],
		};
		const options = {
			cacheRetention: "none" as const,
			maxTokens: Math.max(1, Math.min(request.maxTokens, model.maxTokens || request.maxTokens)),
			signal: operation.signal,
			timeoutMs: request.timeoutMs,
		};
		let response: AssistantMessage;
		if (typeof registry.complete === "function") {
			response = await registry.complete(model, context, options);
		} else {
			const auth = await registry.getApiKeyAndHeaders?.(model);
			if (auth && !auth.ok) throw new Error(auth.error);
			const resolved = auth?.ok && auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;
			const headers = auth?.ok ? stringHeaders(auth.headers) : undefined;
			response = await completeCompat(resolved, context, {
				...options,
				...(auth?.ok && auth.apiKey !== undefined ? { apiKey: auth.apiKey } : {}),
				...(headers === undefined ? {} : { headers }),
				...(auth?.ok && auth.env !== undefined ? { env: auth.env } : {}),
			});
		}
		const text = response.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
		return {
			text,
			ok: response.stopReason === "stop",
			stopReason: response.stopReason,
			inputTokens: response.usage?.input ?? 0,
			outputTokens: response.usage?.output ?? 0,
			...(response.errorMessage ? { errorMessage: response.errorMessage } : {}),
		};
	} finally {
		operation.cleanup();
	}
}
