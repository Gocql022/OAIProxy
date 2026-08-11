import * as assert from "assert";
import * as vscode from "vscode";
import { AnthropicApi } from "../anthropic/anthropicApi";
import { COPILOT_USAGE_MIME } from "../responseUsage";
import type { HFModelItem } from "../types";

suite("anthropicApi", () => {
	test("maps MiniMax M3 video data parts to Anthropic video blocks", () => {
		const api = new AnthropicApi("MiniMax-M3");
		const messages = api.convertMessages(
			[
				{
					role: vscode.LanguageModelChatMessageRole.User,
					name: undefined,
					content: [
						new vscode.LanguageModelTextPart("Describe this clip."),
						new vscode.LanguageModelDataPart(new Uint8Array([1, 2, 3]), "video/mp4"),
					],
				} as unknown as vscode.LanguageModelChatRequestMessage,
			],
			{ includeReasoningInRequest: false }
		);

		const content = messages[0].content as unknown as Array<Record<string, unknown>>;
		assert.strictEqual(messages[0].role, "user");
		assert.deepStrictEqual(content[0], {
			type: "text",
			text: "Describe this clip.",
		});
		assert.deepStrictEqual(content[1], {
			type: "video",
			source: {
				type: "base64",
				media_type: "video/mp4",
				data: "AQID",
			},
		});
	});

	test("maps Claude Sonnet 4.6 effort to Anthropic adaptive thinking", () => {
		const api = new AnthropicApi("claude-sonnet-4-6");
		const body = api.prepareRequestBody(
			{
				model: "claude-sonnet-4-6",
				messages: [],
				stream: true,
			},
			model({
				id: "claude-sonnet-4-6",
				owned_by: "anthropic",
				apiMode: "anthropic",
				reasoning_effort: "medium",
			})
		);

		assert.deepStrictEqual(body.output_config, { effort: "medium" });
		assert.deepStrictEqual(body.thinking, { type: "adaptive" });
	});

	test("merges start and delta usage before emitting one final part", async () => {
		const api = new AnthropicApi("claude-usage-model");
		const parts: vscode.LanguageModelResponsePart2[] = [];
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(
					new TextEncoder().encode(
						[
							"data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_1\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[],\"model\":\"claude-usage-model\",\"usage\":{\"input_tokens\":50,\"output_tokens\":1,\"cache_read_input_tokens\":100000,\"cache_creation_input_tokens\":20}}}",
							"",
							"data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"answer\"}}",
							"",
							"data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":75}}",
							"",
							"data: {\"type\":\"message_stop\"}",
							"",
						].join("\n")
					)
				);
				controller.close();
			},
		});

		await api.processStreamingResponse(stream, { report: (part) => parts.push(part) }, cancellationToken());

		assert.ok(parts.some((part) => part instanceof vscode.LanguageModelTextPart && part.value === "answer"));
		const usageParts = parts.filter(
			(part): part is vscode.LanguageModelDataPart =>
				part instanceof vscode.LanguageModelDataPart && part.mimeType === COPILOT_USAGE_MIME
		);
		assert.strictEqual(usageParts.length, 1);
		assert.deepStrictEqual(JSON.parse(new TextDecoder().decode(usageParts[0].data)), {
			prompt_tokens: 100070,
			completion_tokens: 75,
			total_tokens: 100145,
			prompt_tokens_details: { cached_tokens: 100000 },
			cache_creation_input_tokens: 20,
		});
	});
});

function model(overrides: Partial<HFModelItem>): HFModelItem {
	return {
		id: "model",
		owned_by: "provider",
		...overrides,
	};
}

function cancellationToken(): vscode.CancellationToken {
	return {
		isCancellationRequested: false,
		onCancellationRequested: () => ({ dispose() {} }),
	} as unknown as vscode.CancellationToken;
}
