import * as assert from "assert";
import * as vscode from "vscode";
import { OllamaApi } from "../ollama/ollamaApi";
import { COPILOT_USAGE_MIME } from "../responseUsage";

suite("ollamaApi", () => {
	test("emits usage from the final native stream chunk", async () => {
		const api = new OllamaApi("ollama-usage-model");
		const parts: vscode.LanguageModelResponsePart2[] = [];
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(
					new TextEncoder().encode(
						`${JSON.stringify({
							model: "ollama-usage-model",
							created_at: "2026-08-11T00:00:00Z",
							message: { role: "assistant", content: "answer" },
							done: true,
							prompt_eval_count: 90,
							eval_count: 10,
						})}\n`
					)
				);
				controller.close();
			},
		});

		await api.processStreamingResponse(stream, { report: (part) => parts.push(part) }, cancellationToken());

		assert.ok(parts.some((part) => part instanceof vscode.LanguageModelTextPart && part.value === "answer"));
		const usagePart = parts.find(
			(part): part is vscode.LanguageModelDataPart =>
				part instanceof vscode.LanguageModelDataPart && part.mimeType === COPILOT_USAGE_MIME
		);
		assert.ok(usagePart);
		assert.deepStrictEqual(JSON.parse(new TextDecoder().decode(usagePart.data)), {
			prompt_tokens: 90,
			completion_tokens: 10,
			total_tokens: 100,
			prompt_tokens_details: { cached_tokens: 0 },
		});
	});
});

function cancellationToken(): vscode.CancellationToken {
	return {
		isCancellationRequested: false,
		onCancellationRequested: () => ({ dispose() {} }),
	} as unknown as vscode.CancellationToken;
}
