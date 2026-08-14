import * as assert from "assert";
import * as vscode from "vscode";
import { LiteLLMApi } from "../litellm/litellmApi";
import { getLatestCacheUsage, resetCacheUsageForTests } from "../cacheUsage";
import { COPILOT_USAGE_MIME } from "../responseUsage";
import type { HFModelItem } from "../types";

suite("litellmApi", () => {
	setup(() => {
		resetCacheUsageForTests();
	});

	test("maps thinking configuration into extra_body", () => {
		const body = prepare({
			thinking: {
				type: "enabled",
				clear_thinking: false,
			},
			thinking_budget: 4096,
		});

		assert.deepStrictEqual(body.extra_body, {
			thinking: {
				type: "enabled",
				budget_tokens: 4096,
				clear_thinking: false,
			},
		});
		assert.strictEqual(body.thinking, undefined);
		assert.strictEqual(body.thinking_budget, undefined);
	});

	test("maps enable_thinking fallback into extra_body", () => {
		const body = prepare({
			enable_thinking: false,
		});

		assert.deepStrictEqual(body.extra_body, {
			thinking: {
				type: "disabled",
			},
		});
		assert.strictEqual(body.enable_thinking, undefined);
	});

	test("puts OpenRouter reasoning configuration into extra_body", () => {
		const body = prepare({
			reasoning: {
				effort: "high",
				exclude: true,
			},
		});

		assert.deepStrictEqual(body.extra_body, {
			reasoning: {
				effort: "high",
				exclude: true,
			},
		});
		assert.strictEqual(body.reasoning, undefined);
	});

	test("merges explicit extra_body last while preserving top-level extra", () => {
		const body = prepare({
			max_tokens: 2000,
			thinking: {
				type: "enabled",
			},
			extra: {
				user: "trace-user",
				extra_body: {
					metadata: {
						tags: ["from-extra"],
					},
					thinking: {
						keep: "all",
					},
				},
			},
			extra_body: {
				thinking: {
					type: "disabled",
				},
				allowed_openai_params: ["tools"],
			},
		});

		assert.strictEqual(body.max_tokens, 2000);
		assert.strictEqual(body.user, "trace-user");
		assert.deepStrictEqual(body.extra_body, {
			metadata: {
				tags: ["from-extra"],
			},
			thinking: {
				type: "disabled",
				keep: "all",
			},
			allowed_openai_params: ["tools"],
		});
	});

	test("records cache usage with LiteLLM API mode label", async () => {
		const api = new LiteLLMApi("litellm-cache-test");
		const parts: vscode.LanguageModelResponsePart2[] = [];
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(
					new TextEncoder().encode(
						[
							"data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}],\"usage\":{\"prompt_tokens\":90,\"completion_tokens\":4,\"total_tokens\":94}}",
							"",
							"data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":100,\"completion_tokens\":5,\"total_tokens\":105,\"prompt_tokens_details\":{\"cached_tokens\":80}}}",
							"",
							"data: [DONE]",
							"",
						].join("\n")
					)
				);
				controller.close();
			},
		});

		await api.processStreamingResponse(
			stream,
			{
				report(part) {
					parts.push(part);
				},
			},
			{
				isCancellationRequested: false,
				onCancellationRequested: () => ({ dispose() {} }),
			} as unknown as vscode.CancellationToken
		);

		const latest = getLatestCacheUsage("litellm-cache-test");
		assert.strictEqual(latest?.apiMode, "litellm");
		assert.strictEqual(latest?.cacheHitTokens, 80);

		const usageParts = parts.filter(
			(part): part is vscode.LanguageModelDataPart =>
				part instanceof vscode.LanguageModelDataPart && part.mimeType === COPILOT_USAGE_MIME
		);
		assert.strictEqual(usageParts.length, 1);
		assert.deepStrictEqual(JSON.parse(new TextDecoder().decode(usageParts[0].data)), {
			prompt_tokens: 100,
			completion_tokens: 5,
			total_tokens: 105,
			prompt_tokens_details: { cached_tokens: 80 },
		});
	});
});

function prepare(overrides: Partial<HFModelItem>): Record<string, unknown> {
	const api = new LiteLLMApi("model");
	return api.prepareRequestBody(
		{
			model: "model",
			messages: [],
			stream: true,
			stream_options: { include_usage: true },
		},
		model(overrides)
	);
}

function model(overrides: Partial<HFModelItem>): HFModelItem {
	return {
		id: "model",
		owned_by: "litellm",
		apiMode: "litellm",
		...overrides,
	};
}
