import * as assert from "assert";
import * as vscode from "vscode";
import { png } from "./fixtures/image";
import { OpenaiApi } from "../openai/openaiApi";
import { OpenaiResponsesApi } from "../openai/openaiResponsesApi";
import { AnthropicApi } from "../anthropic/anthropicApi";
import { GeminiApi } from "../gemini/geminiApi";
import { OllamaApi } from "../ollama/ollamaApi";
import { collectToolResultText } from "../utils";
import { normalizeContent, serializeUnknownContent } from "../messageContent";

const context = { includeReasoningInRequest: false };
function message(role: number, content: unknown[]): vscode.LanguageModelChatRequestMessage {
	return { role, name: undefined, content } as vscode.LanguageModelChatRequestMessage;
}
function imageResult(id: string, bytes: Uint8Array): vscode.LanguageModelChatRequestMessage {
	return message(1, [
		new vscode.LanguageModelToolResultPart(id, [new vscode.LanguageModelDataPart(bytes, "image/png")]),
	]);
}

suite("binary-safe message content", () => {
	test("all adapters preserve images, IDs and parallel tool-result order without byte JSON", () => {
		const bytes = png(744, 1053, 150 * 1024);
		const input = [
			message(2, [
				new vscode.LanguageModelToolCallPart("a", "view_image", {}),
				new vscode.LanguageModelToolCallPart("b", "view_image", {}),
			]),
			imageResult("a", bytes),
			imageResult("b", bytes),
		];
		const chat = new OpenaiApi("gpt-6-astra").convertMessages(input, context);
		assert.deepStrictEqual(
			chat.slice(0, 3).map((m) => m.role),
			["assistant", "tool", "tool"]
		);
		assert.strictEqual(chat[1].tool_call_id, "a");
		assert.strictEqual(chat[2].tool_call_id, "b");
		assert.strictEqual(chat[3].role, "user");
		const responses = new OpenaiResponsesApi("gpt-6-astra").convertMessages(input, context, {
			codexEasyInput: true,
			replayResponsesItemIds: false,
		});
		assert.deepStrictEqual(
			responses.slice(0, 4).map((part) => part.type),
			["function_call", "function_call", "function_call_output", "function_call_output"]
		);
		const anthropic = new AnthropicApi("claude-opus-4-7").convertMessages(input, context);
		const gemini = new GeminiApi("gemini-3.1-pro").convertMessages(input, context);
		const ollama = new OllamaApi("vision").convertMessages(input, context);
		for (const converted of [chat, responses, anthropic, gemini, ollama]) {
			const serialized = JSON.stringify(converted);
			assert.ok(!serialized.includes('\\"0\\":137'));
			assert.ok(serialized.includes(Buffer.from(bytes).toString("base64")));
			assert.ok(serialized.length < bytes.length * 3);
		}
		const images = (chat[3].content as Array<{ image_url?: { url: string } }>).filter((part) => part.image_url);
		assert.strictEqual(images.length, 2);
		assert.deepStrictEqual(Buffer.from(images[0].image_url!.url.split(",")[1], "base64"), Buffer.from(bytes));
		const blocks = anthropic[1].content as Array<{ type: string; content: Array<{ type: string }> }>;
		assert.strictEqual(blocks[0].type, "tool_result");
		assert.strictEqual(blocks[0].content[0].type, "image");
		assert.strictEqual(gemini[1].parts.filter((part) => "functionResponse" in part).length, 2);
	});

	test("decodes UTF-8, safely serializes unknown objects, and preserves ordinary long text", () => {
		assert.strictEqual(
			collectToolResultText({ content: [vscode.LanguageModelDataPart.text("hello 世界")] }),
			"hello 世界"
		);
		assert.strictEqual(
			collectToolResultText({ content: [vscode.LanguageModelDataPart.json({ ok: true })] }),
			'{"ok":true}'
		);
		const value: Record<string, unknown> = {
			a: new Uint8Array(150000),
			b: Buffer.alloc(20),
			c: new ArrayBuffer(30),
			d: { type: "Buffer", data: [1, 2, 3] },
		};
		value.self = value;
		const text = serializeUnknownContent(value);
		for (const length of [150000, 20, 30, 3]) {
			assert.ok(text.includes(`[binary ${length} bytes]`));
		}
		assert.ok(text.includes("[circular]"));
		assert.ok(serializeUnknownContent({ value: "x".repeat(10000) }, 128).endsWith("[serialized part truncated]"));
		assert.ok(serializeUnknownContent({ value: "x".repeat(10000) }, 128).length <= 128);
		const longText = "x".repeat(250000);
		assert.strictEqual(collectToolResultText({ content: [new vscode.LanguageModelTextPart(longText)] }), longText);
		const omitted = collectToolResultText({
			content: [new vscode.LanguageModelDataPart(new Uint8Array(150000), "application/pdf")],
		});
		assert.ok(omitted.length < 200);
		assert.strictEqual(
			normalizeContent([new vscode.LanguageModelDataPart(new Uint8Array(100), "usage")], {}, true).length,
			0
		);
	});

	test("mixed Anthropic result content follows native tool-result blocks", () => {
		const input = [
			message(1, [
				new vscode.LanguageModelTextPart("continue"),
				new vscode.LanguageModelToolResultPart("a", [new vscode.LanguageModelDataPart(png(), "image/png")]),
			]),
		];
		const output = new AnthropicApi("claude-opus-4-7").convertMessages(input, context);
		const blocks = output[0].content as Array<{ type: string }>;
		assert.deepStrictEqual(
			blocks.map((part) => part.type),
			["tool_result", "text"]
		);
	});

	test("unknown serialization never invokes accessors or toJSON", () => {
		const object = {
			get secret() {
				throw new Error("must not read");
			},
			toJSON() {
				throw new Error("must not invoke");
			},
		};
		assert.ok(serializeUnknownContent(object).includes("[accessor omitted]"));
		assert.ok(
			serializeUnknownContent(
				Array.from({ length: 100000 }, () => 1),
				100
			).length <= 100
		);
	});
});
