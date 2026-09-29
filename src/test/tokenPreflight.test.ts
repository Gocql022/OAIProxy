import * as assert from "assert";
import * as http from "http";
import * as path from "path";
import * as vscode from "vscode";
import { HuggingFaceChatModelProvider } from "../provider";
import { TokenizerManager } from "../tokenizer/tokenizerManager";
import { getLatestTokenUsageReport } from "../statusBar";
import { logger } from "../logger";
import { OpenaiResponsesApi } from "../openai/openaiResponsesApi";
import { png } from "./fixtures/image";

suite("prepared request preflight integration", () => {
	let server: http.Server;
	let baseUrl: string;
	let received: Record<string, unknown>[];
	let configuration: Record<string, unknown>;
	let provider: HuggingFaceChatModelProvider;
	let logs: Array<{ tag: string; data: Record<string, unknown> }>;
	const originalConfig = vscode.workspace.getConfiguration;
	const originalDebug = logger.debug;
	let state: Map<string, unknown>;
	let contextBudget: number;
	let incomplete: boolean;
	let delayedStream: boolean;

	setup(async () => {
		TokenizerManager.setExtensionPath(path.resolve(__dirname, "../.."));
		received = [];
		logs = [];
		state = new Map();
		contextBudget = 872000;
		incomplete = false;
		delayedStream = false;
		server = http.createServer((request, response) => {
			let body = "";
			request.on("data", (chunk) => {
				body += chunk.toString();
			});
			request.on("end", () => {
				received.push(JSON.parse(body));
				response.writeHead(200, { "Content-Type": "text/event-stream" });
				if (delayedStream) {
					response.flushHeaders();
					setTimeout(() => {
						response.write(": keepalive\n\n");
						setTimeout(() => response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "OK" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`), 20);
					}, 20);
					return;
				}
				if (request.url?.endsWith("/responses")) {
					response.end(
						`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "OK" })}\n\ndata: ${JSON.stringify({ type: "response.completed", response: { id: `resp_${received.length}`, usage: { input_tokens: 3000, output_tokens: 2, input_tokens_details: { cached_tokens: 1000 } } } })}\n\n`
					);
				} else {
					response.end(
						`data: ${JSON.stringify({ choices: [{ delta: { content: "OK" }, finish_reason: incomplete ? null : "stop" }], usage: { prompt_tokens: 3000, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 1000 } } })}\n\n${incomplete ? "" : "data: [DONE]\n\n"}`
					);
				}
			});
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});
		baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
		configuration = {
			"oaicopilot.models": [
				{
					id: "gpt-6-astra",
					owned_by: "test",
					baseUrl,
					vision: true,
					apiMode: "openai",
					include_reasoning_in_request: false,
				},
			],
			"oaicopilot.debug.tokenBreakdown": true,
		};
		vscode.workspace.getConfiguration = (() => ({
			get: (key: string, fallback: unknown) => configuration[key] ?? fallback,
		})) as typeof originalConfig;
		logger.debug = (tag, data) => {
			logs.push({ tag, data });
		};
		provider = new HuggingFaceChatModelProvider(
			{ get: async () => "local-test-only" } as unknown as vscode.SecretStorage,
			{
				get: (key: string, fallback: unknown) => state.get(key) ?? fallback,
				keys: () => [...state.keys()],
				update: async (key: string, value: unknown) => {
					state.set(key, value);
				},
			} as unknown as vscode.Memento,
			{ show: () => undefined } as vscode.StatusBarItem
		);
	});
	teardown(async () => {
		provider?.dispose();
		vscode.workspace.getConfiguration = originalConfig;
		logger.debug = originalDebug;
		server.closeAllConnections();
		await new Promise<void>((resolve) => {
			server.close(() => resolve());
		});
	});
	const model = () =>
		({
			id: "gpt-6-astra",
			name: "Astra",
			maxInputTokens: contextBudget,
			maxOutputTokens: 128000,
			capabilities: { imageInput: true, toolCalling: true },
		}) as vscode.LanguageModelChatInformation;
	const msg = (role: number, content: unknown[]) =>
		({ role, name: undefined, content }) as vscode.LanguageModelChatRequestMessage;
	const run = async (messages: vscode.LanguageModelChatRequestMessage[]) => {
		const cancellation = new vscode.CancellationTokenSource();
		const output: vscode.LanguageModelResponsePart2[] = [];
		try {
			await provider.provideLanguageModelChatResponse(
				model(),
				messages,
				{ requestInitiator: "test" } as vscode.ProvideLanguageModelChatResponseOptions,
				{ report: (part) => output.push(part) },
				cancellation.token
			);
			return output;
		} finally {
			cancellation.dispose();
		}
	};

	test("actual HTTP body carries three images and logs usage without content", async () => {
		const images = [0, 1, 2].map(
			(i) =>
				new vscode.LanguageModelToolResultPart(`call_${i}`, [
					new vscode.LanguageModelDataPart(png(744, 1053, 150000), "image/png"),
				])
		);
		await run([
			msg(
				2,
				images.map((image) => new vscode.LanguageModelToolCallPart(image.callId, "view_image", {}))
			),
			msg(1, images),
		]);
		assert.strictEqual(received.length, 1);
		assert.ok(JSON.stringify(received[0]).includes("data:image/png;base64,"));
		assert.ok(!JSON.stringify(received[0]).includes('\\"0\\":137'));
		const report = getLatestTokenUsageReport()!;
		assert.ok(report.inputTokens < 4000);
		assert.strictEqual(report.categories.find((c) => c.id === "media")!.tokens, 2853);
		const comparison = logs.find((entry) => entry.tag === "request.tokenComparison")!.data;
		assert.strictEqual(comparison.actual, 3000);
		assert.strictEqual(comparison.calibrationEligible, false);
		const diagnostics = logs.filter((entry) => entry.tag.startsWith("request.token"));
		assert.ok(!JSON.stringify(diagnostics).includes("base64"));
		assert.ok(!JSON.stringify(diagnostics).includes("local-test-only"));
		assert.deepStrictEqual(
			new Set(report.largestParts!.filter((part) => part.type === "image").map((part) => part.callId)),
			new Set(["call_0", "call_1", "call_2"])
		);
	});

	test("guard blocks real oversized text before HTTP and reports largest tool result", async () => {
		contextBudget = 100;
		const privateText = "private-large-result ".repeat(500);
		await assert.rejects(
			run([msg(1, [new vscode.LanguageModelToolResultPart("large", [new vscode.LanguageModelTextPart(privateText)])])]),
			/Largest parts:.*large/s
		);
		assert.strictEqual(received.length, 0);
		assert.ok(!logs.some((entry) => entry.tag === "request.timing" && entry.data.phase === "dispatch"));
		assert.ok(
			!JSON.stringify(logs.filter((entry) => entry.tag.startsWith("request.token"))).includes("private-large-result")
		);
	});

	test("provideTokenCount respects reasoning configuration and text-only image omission", async () => {
		const input = msg(2, [
			new vscode.LanguageModelTextPart("answer"),
			new vscode.LanguageModelThinkingPart("private reasoning ".repeat(100)),
		]);
		const token = { isCancellationRequested: false } as vscode.CancellationToken;
		const without = await provider.provideTokenCount(model(), input, token);
		(configuration["oaicopilot.models"] as Array<Record<string, unknown>>)[0].include_reasoning_in_request = true;
		const withThinking = await provider.provideTokenCount(model(), input, token);
		assert.ok(withThinking > without + 100);
		(configuration["oaicopilot.models"] as Array<Record<string, unknown>>)[0].vision = false;
		const result = msg(1, [
			new vscode.LanguageModelToolResultPart("image", [new vscode.LanguageModelDataPart(png(), "image/png")]),
		]);
		assert.ok((await provider.provideTokenCount(model(), result, token)) < 100);
		await run([result]);
		assert.ok(JSON.stringify(received[0]).includes("image omitted"));
		assert.ok(!JSON.stringify(received[0]).includes("base64"));
	});

	test("incomplete streams never train calibration", async () => {
		incomplete = true;
		await run([msg(1, [new vscode.LanguageModelTextPart("hello")])]);
		assert.strictEqual(
			logs.filter((entry) => entry.tag === "request.tokenComparison").at(-1)!.data.calibrationEligible,
			false
		);
		assert.strictEqual(state.size, 0);
	});

	test("bridge descriptions are recounted before the final target request", async () => {
		const originalSelect = vscode.lm.selectChatModels;
		const models = configuration["oaicopilot.models"] as Array<Record<string, unknown>>;
		models[0].vision = false;
		models.push({ id: "vision-preflight-test", vision: true, owned_by: "test", baseUrl });
		vscode.lm.selectChatModels = (async () => [
			{
				id: "vision-preflight-test",
				sendRequest: async () => ({
					text: (async function* () {
						yield "bridge description ".repeat(500);
					})(),
				}),
			},
		]) as unknown as typeof originalSelect;
		try {
			contextBudget = 100;
			await assert.rejects(
				run([
					msg(1, [
						new vscode.LanguageModelToolResultPart("bridge", [
							new vscode.LanguageModelDataPart(png(101, 202), "image/png"),
						]),
					]),
				]),
				/blocked this request/
			);
			assert.strictEqual(received.length, 0);
			assert.ok(getLatestTokenUsageReport()!.inputTokens > 100);
		} finally {
			vscode.lm.selectChatModels = originalSelect;
		}
	});

	test("timing separates headers, first stream data and visible text with concurrent request IDs", async () => {
		delayedStream = true;
		await Promise.all([run([msg(1, [new vscode.LanguageModelTextPart("private prompt one")])]),
			run([msg(1, [new vscode.LanguageModelTextPart("private prompt two")])])]);
		const timings = logs.filter((entry) => entry.tag === "request.timing").map((entry) => entry.data);
		const ids = new Set(timings.map((entry) => entry.requestId));
		assert.strictEqual(ids.size, 2);
		for (const id of ids) {
			const events = timings.filter((entry) => entry.requestId === id);
			const phases = events.map((entry) => entry.phase);
			const expected = ["entry", "preflight.start", "estimate.start", "estimate.end", "preflight.end", "dispatch", "headers", "stream.start", "firstChunk", "firstText", "stream.end", "complete"];
			assert.deepStrictEqual(phases, expected);
			const elapsed = (phase: string) => Number(events.find((entry) => entry.phase === phase)!.elapsedMs);
			assert.ok(elapsed("firstChunk") > elapsed("headers"));
			assert.ok(elapsed("firstText") > elapsed("firstChunk"));
			assert.ok(events.every((entry) => Number.isFinite(entry.elapsedMs)));
		}
		assert.ok(!JSON.stringify(timings).includes("private prompt"));
		assert.ok(!JSON.stringify(timings).includes("local-test-only"));
	});

	test("token callback diagnostics pair by ID and omit text", async () => {
		const text = "private counter input";
		const tokens = await provider.provideTokenCount(model(), text, { isCancellationRequested: false } as vscode.CancellationToken);
		const events = logs.filter((entry) => entry.tag.startsWith("tokenCount."));
		assert.deepStrictEqual(events.map((entry) => entry.tag), ["tokenCount.start", "tokenCount.end"]);
		assert.strictEqual(events[0].data.countId, events[1].data.countId);
		assert.strictEqual(events[0].data.textLength, text.length);
		assert.strictEqual(events[1].data.tokens, tokens);
		assert.ok(!JSON.stringify(events).includes(text));
	});

	test("Responses delta still budgets full history and disables calibration", async () => {
		(configuration["oaicopilot.models"] as Array<Record<string, unknown>>)[0].apiMode = "openai-responses";
		const first = msg(1, [new vscode.LanguageModelTextPart("history ".repeat(200))]);
		await run([first]);
		await run([
			first,
			msg(2, [new vscode.LanguageModelTextPart("OK")]),
			msg(1, [new vscode.LanguageModelTextPart("next")]),
		]);
		assert.strictEqual(received.length, 2);
		assert.strictEqual(received[1].previous_response_id, "resp_1");
		const expectedFull = new OpenaiResponsesApi("gpt-6-astra").convertMessages(
			[first, msg(2, [new vscode.LanguageModelTextPart("OK")]), msg(1, [new vscode.LanguageModelTextPart("next")])],
			{ includeReasoningInRequest: false }
		);
		assert.ok((received[1].input as unknown[]).length < expectedFull.length);
		const breakdown = logs.filter((entry) => entry.tag === "request.tokenBreakdown").at(-1)!.data;
		assert.ok(Number(breakdown.inputTokens) > Number(breakdown.transmittedInputTokens) + 150);
		assert.strictEqual(
			logs.filter((entry) => entry.tag === "request.tokenComparison").at(-1)!.data.calibrationEligible,
			false
		);
	});
});
