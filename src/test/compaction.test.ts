import * as assert from "assert";
import * as vscode from "vscode";
import {
	CompactionBuffer,
	compactionEffort,
	compactionEfforts,
	compactionFailure,
	compactionMessages,
	detectCompaction,
	prepareCompactionBody,
	validateCompactionInput,
} from "../compaction";
import { StreamOutcome } from "../streamOutcome";
import { backgroundRequest, summaryInstructions, summaryRequest } from "./fixtures/compactionPrompt";

export const message = (role: number, text: string): vscode.LanguageModelChatRequestMessage => ({
	role,
	name: undefined,
	content: [new vscode.LanguageModelTextPart(text)],
});
export const compactionFixture = () => [
	message(0, summaryInstructions),
	message(1, "Historical task and decisions."),
	message(1, summaryRequest),
];

suite("compaction policy", () => {
	const options = { requestInitiator: "GitHub.copilot-chat" } as vscode.ProvideLanguageModelChatResponseOptions;
	test("recognizes pinned full/simple and background prompts, including whitespace and additional instructions", () => {
		assert.strictEqual(detectCompaction(compactionFixture(), options), "separate");
		assert.strictEqual(
			detectCompaction(compactionFixture(), {
				...options,
				tools: [{ name: "read_file", description: "Read a file", inputSchema: {} }],
			}),
			"separate"
		);
		const fixture = compactionFixture();
		fixture[0] = message(
			0,
			summaryInstructions.replace(/\n/g, "   ") + "\n## Additional instructions from the user:\nKeep tests."
		);
		assert.strictEqual(detectCompaction(fixture, options), "separate");
		assert.strictEqual(
			detectCompaction([message(0, "Coding instructions"), message(1, backgroundRequest)], options),
			"background"
		);
	});
	test("never classifies ordinary summaries, quoted/history instructions, other callers or changed formats", () => {
		assert.strictEqual(detectCompaction([message(1, "Summarize the conversation")], options), undefined);
		assert.strictEqual(
			detectCompaction(compactionFixture(), { ...options, requestInitiator: "another.extension" }),
			undefined
		);
		assert.strictEqual(
			detectCompaction([...compactionFixture(), message(1, "Explain those instructions")], options),
			undefined
		);
		assert.strictEqual(
			detectCompaction(
				[message(0, "You are a coding assistant"), message(1, summaryInstructions), message(1, summaryRequest)],
				options
			),
			undefined
		);
		assert.strictEqual(
			detectCompaction([message(0, summaryInstructions), message(1, "Quoted prompt: " + summaryRequest)], options),
			undefined
		);
		assert.strictEqual(detectCompaction([message(1, "Explain this: " + backgroundRequest)], options), undefined);
		assert.strictEqual(
			detectCompaction(
				[
					message(0, summaryInstructions.replace("## Summary Structure", "## New structure")),
					message(1, summaryRequest),
				],
				options
			),
			undefined
		);
	});
	test("effort supports configured values and rejects unsupported adapters/values", () => {
		const model = { id: "fast", owned_by: "test", supported_reasoning_efforts: ["low", "high"] };
		assert.deepStrictEqual(compactionEfforts(model), ["low", "high"]);
		assert.strictEqual(compactionEffort(model, "medium"), undefined);
		assert.strictEqual(compactionEffort(model, "high"), "high");
		assert.deepStrictEqual(compactionEfforts({ ...model, apiMode: "gemini" }), []);
		assert.deepStrictEqual(compactionEfforts({ ...model, apiMode: "ollama" }), []);
	});
	test("request-local final shaping wins over extra overrides without changing saved settings", () => {
		for (const mode of ["openai", "openai-responses", "anthropic", "litellm"]) {
			const body = {
				reasoning_effort: "max",
				reasoning: { effort: "max" },
				output_config: { effort: "max" },
				tools: [{}],
				previous_response_id: "old",
				extra_body: { tools: [{}], reasoning_effort: "max" },
			};
			prepareCompactionBody(body, mode, "low");
			assert.strictEqual((body as Record<string, unknown>).tools, undefined);
			assert.strictEqual((body as Record<string, unknown>).previous_response_id, undefined);
			assert.strictEqual((body.extra_body as Record<string, unknown>).tools, undefined);
			assert.strictEqual(mode === "anthropic" ? body.output_config.effort : body.reasoning.effort, "low");
		}
	});
	test("does not introduce unsupported effort fields into provider-specific extra_body", () => {
		const body = { reasoning_effort: "max", extra_body: { thinking: { type: "enabled" } } };
		prepareCompactionBody(body, "litellm", "low");
		assert.strictEqual(body.reasoning_effort, "low");
		assert.deepStrictEqual(body.extra_body, { thinking: { type: "enabled" } });
	});

	test("strips state/opaque thinking recursively and refuses unsupported media", () => {
		const marker = new vscode.LanguageModelDataPart(new Uint8Array([1]), "application/vnd.oaiproxy.stateful-marker");
		const messages = [
			{
				...message(1, ""),
				content: [
					marker,
					new vscode.LanguageModelThinkingPart("private"),
					new vscode.LanguageModelToolResultPart("call", [marker, new vscode.LanguageModelTextPart("result")]),
				],
			},
		];
		const clean = compactionMessages(messages);
		assert.strictEqual(messages[0].content.length, 3);
		assert.strictEqual(clean[0].content.length, 3);
		assert.ok(clean[0].content.every((part) => part instanceof vscode.LanguageModelTextPart));
		assert.strictEqual((clean[0].content[1] as vscode.LanguageModelTextPart).value, "result");
		assert.ok(!JSON.stringify(clean).includes("private"));
		const media = [
			{ ...message(1, ""), content: [new vscode.LanguageModelDataPart(new Uint8Array([1]), "image/png")] },
		];
		assert.throws(() => validateCompactionInput(media, { id: "text", owned_by: "test" }), /unsupported/);
		assert.doesNotThrow(() => validateCompactionInput(media, { id: "vision", owned_by: "test", vision: true }));
	});
	test("buffer suppresses reasoning/state, keeps text intact, aborts tools and overflow", () => {
		let aborts = 0;
		const output: vscode.LanguageModelResponsePart2[] = [];
		const buffer = new CompactionBuffer(() => aborts++);
		buffer.report(new vscode.LanguageModelTextPart("<summary>"));
		buffer.report(new vscode.LanguageModelThinkingPart("private thinking"));
		buffer.report(new vscode.LanguageModelTextPart("done</summary>"));
		assert.strictEqual(output.length, 0);
		buffer.publish({ report: (part) => output.push(part) });
		assert.strictEqual((output[0] as vscode.LanguageModelTextPart).value, "<summary>done</summary>");
		assert.strictEqual(output.length, 1);
		const overflow = new CompactionBuffer(() => aborts++, 4);
		overflow.report(new vscode.LanguageModelTextPart("好好"));
		assert.throws(
			() =>
				overflow.publish({
					report() {
						assert.fail("must not publish");
					},
				}),
			/buffer limit/
		);
		const tools = new CompactionBuffer(() => aborts++);
		tools.report(new vscode.LanguageModelToolCallPart("call", "read_file", {}));
		assert.throws(() => tools.assertValid(), /tool call/);
		assert.strictEqual(aborts, 2);
	});
	test("failure diagnostics omit arbitrary upstream messages and unsafe cause codes", () => {
		assert.deepStrictEqual(
			compactionFailure(new TypeError("secret response", { cause: { code: "UND_ERR_SOCKET", socket: "secret" } })),
			{
				errorName: "TypeError",
				causeCode: "UND_ERR_SOCKET",
				reason: "Model unavailable, input rejected, or response failed",
			}
		);
		assert.strictEqual(compactionFailure({ cause: { code: "secret url https://example.com" } }).causeCode, undefined);
	});
});

suite("strict compaction stream outcomes", () => {
	const successful = [
		[{ type: "response.completed", response: { status: "completed" } }],
		[{ choices: [{ finish_reason: "stop" }] }],
		[{ type: "message_delta", delta: { stop_reason: "end_turn" } }, { type: "message_stop" }],
		[{ candidates: [{ finishReason: "STOP" }] }],
		[{ done: true, done_reason: "stop" }],
	];
	for (const [index, events] of successful.entries()) {
		test(`accepts explicit successful terminal events for adapter ${index}`, () => {
			const outcome = new StreamOutcome();
			events.forEach((event) => outcome.observe(event));
			assert.doesNotThrow(() => outcome.assertSuccessful());
		});
	}
	for (const [index, events] of [
		[],
		[{ type: "response.incomplete" }],
		[{ choices: [{ finish_reason: "length" }] }],
		[{ type: "message_delta", delta: { stop_reason: "max_tokens" } }, { type: "message_stop" }],
		[{ candidates: [{ finishReason: "SAFETY" }] }],
		[{ done: true, done_reason: "length" }],
		[{ error: { message: "private" } }, ...successful[0]],
		[{ type: "response.refusal.delta" }, ...successful[0]],
	].entries()) {
		test(`rejects incomplete/failed outcome ${index}`, () => {
			const outcome = new StreamOutcome();
			events.forEach((event) => outcome.observe(event));
			assert.throws(() => outcome.assertSuccessful(), /Compaction failed/);
		});
	}
});
