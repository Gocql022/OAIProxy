import * as assert from "assert";
import * as http from "http";
import * as path from "path";
import * as vscode from "vscode";
import { HuggingFaceChatModelProvider } from "../provider";
import { TokenizerManager } from "../tokenizer/tokenizerManager";
import type { HFModelItem } from "../types";
import { summaryInstructions, summaryRequest, backgroundRequest } from "./fixtures/compactionPrompt";
import { logger } from "../logger";
import { PROVIDER_CONFIG_STORAGE_KEY } from "../providerTransport";

suite("compaction routing integration", () => {
	let server: http.Server;
	let configuration: Record<string, unknown>;
	let models: HFModelItem[];
	let provider: HuggingFaceChatModelProvider;
	let received: Array<{ body: Record<string, unknown>; url: string; authorization: string | undefined }>;
	let state: Map<string, unknown>;
	let respond: (request: http.IncomingMessage, response: http.ServerResponse, body: Record<string, unknown>) => void;
	let keys: Set<string>;
	let oauthCredential: string | undefined;
	let events: Array<{ tag: string; data: Record<string, unknown> }>;
	const originalConfig = vscode.workspace.getConfiguration;
	const originalInfo = logger.info;
	const originalWarn = logger.warn;
	const originalStatus = vscode.window.setStatusBarMessage;
	const originalInput = vscode.window.showInputBox;
	const coding = {
		id: "coding::main",
		name: "Coding",
		maxInputTokens: 120000,
		maxOutputTokens: 8000,
		capabilities: { imageInput: true, toolCalling: true },
	} as vscode.LanguageModelChatInformation;
	const message = (role: number, text: string): vscode.LanguageModelChatRequestMessage => ({
		role,
		name: undefined,
		content: [new vscode.LanguageModelTextPart(text)],
	});
	const fixture = () => [
		message(0, summaryInstructions),
		message(1, "Important past decisions"),
		message(1, summaryRequest),
	];
	const emit = (response: http.ServerResponse, events: unknown[]) =>
		response.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
	const success = (response: http.ServerResponse, text = "<summary>complete</summary>") =>
		emit(response, [{ choices: [{ delta: { content: text }, finish_reason: "stop" }] }]);

	setup(async () => {
		TokenizerManager.setExtensionPath(path.resolve(__dirname, "../.."));
		received = [];
		state = new Map();
		events = [];
		oauthCredential = undefined;
		keys = new Set(["oaicopilot.apiKey.source", "oaicopilot.apiKey.target"]);
		respond = (_request, response) => success(response);
		server = http.createServer((request, response) => {
			let body = "";
			request.on("data", (chunk) => (body += chunk.toString()));
			request.on("end", () => {
				const parsed = JSON.parse(body);
				received.push({ body: parsed, url: request.url!, authorization: request.headers.authorization });
				response.setHeader("Content-Type", "text/event-stream");
				respond(request, response, parsed);
			});
		});
		await new Promise<void>((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
		const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
		models = [
			{
				id: "coding",
				configId: "main",
				owned_by: "source",
				baseUrl: base + "/source",
				context_length: 128000,
				max_tokens: 8000,
				reasoning_effort: "max",
				apiMode: "openai",
				vision: true,
			},
			{
				id: "fast",
				configId: "summary",
				owned_by: "target",
				baseUrl: base + "/target",
				context_length: 128000,
				max_tokens: 8000,
				reasoning_effort: "high",
				apiMode: "openai",
				supported_reasoning_efforts: ["low", "high"],
			},
		];
		configuration = {
			"oaicopilot.models": models,
			"oaicopilot.compactionModel": "fast::summary",
			"oaicopilot.compactionReasoningEffort": "low",
			"oaicopilot.retry": { enabled: false },
		};
		vscode.workspace.getConfiguration = (() => ({
			get: (key: string, fallback: unknown) => configuration[key] ?? fallback,
		})) as typeof originalConfig;
		logger.info = (tag, data) => events.push({ tag, data });
		logger.warn = (tag, data) => events.push({ tag, data });
		vscode.window.setStatusBarMessage = (() => ({ dispose() {} })) as typeof originalStatus;
		vscode.window.showInputBox = (() => {
			assert.fail("compaction must not open credential prompts");
		}) as typeof originalInput;
		provider = new HuggingFaceChatModelProvider(
			{
				get: async (key: string) =>
					key === "oaicopilot.oauth.openai" ? oauthCredential : keys.has(key) ? "test-" + key : undefined,
			} as unknown as vscode.SecretStorage,
			{
				get: (key: string, fallback: unknown) => state.get(key) ?? fallback,
				keys: () => [...state.keys()],
				update: async (key: string, value: unknown) => {
					state.set(key, value);
				},
			} as unknown as vscode.Memento,
			{ show() {} } as vscode.StatusBarItem
		);
	});
	teardown(async () => {
		provider?.dispose();
		vscode.workspace.getConfiguration = originalConfig;
		logger.info = originalInfo;
		logger.warn = originalWarn;
		vscode.window.setStatusBarMessage = originalStatus;
		vscode.window.showInputBox = originalInput;
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	async function run(
		messages = fixture(),
		token?: vscode.CancellationToken,
		output: vscode.LanguageModelResponsePart2[] = []
	) {
		const source = new vscode.CancellationTokenSource();
		try {
			await provider.provideLanguageModelChatResponse(
				coding,
				messages,
				{
					requestInitiator: "github.copilot-chat",
					modelConfiguration: { reasoningEffort: "max" },
					modelOptions: { reasoningEffort: "max" },
					tools: [{ name: "read_file", description: "Read a file", inputSchema: {} }],
					toolMode: vscode.LanguageModelChatToolMode.Auto,
				},
				{ report: (part) => output.push(part) },
				token ?? source.token
			);
			return output
				.filter((part) => part instanceof vscode.LanguageModelTextPart)
				.map((part) => part.value)
				.join("");
		} finally {
			source.dispose();
		}
	}

	test("normal coding surrounds compaction without changing selection, credentials or effort", async () => {
		models[1].extra = { reasoning_effort: "max", tools: [{}] };
		await run([message(1, "Code the feature")]);
		await run();
		await run([message(1, "Continue coding from the summary")]);
		assert.deepStrictEqual(
			received.map((r) => r.body.model),
			["coding", "fast", "coding"]
		);
		assert.deepStrictEqual(
			received.map((r) => r.body.reasoning_effort),
			["max", "low", "max"]
		);
		assert.ok(received[0].body.tools);
		assert.strictEqual(received[1].body.tools, undefined);
		assert.ok(received[2].body.tools);
		assert.strictEqual(received[1].url, "/target/chat/completions");
		assert.strictEqual(received[1].authorization, "Bearer test-oaicopilot.apiKey.target");
		assert.strictEqual(models[1].extra.reasoning_effort, "max");
		assert.strictEqual(coding.id, "coding::main");
	});
	test("routes background compaction too; disabled setting leaves existing behavior", async () => {
		await run([message(0, "Coding instructions"), message(1, backgroundRequest)]);
		configuration["oaicopilot.compactionModel"] = "";
		await run();
		assert.deepStrictEqual(
			received.map((r) => r.body.model),
			["fast", "coding"]
		);
	});
	test("holds partial text until completion", async () => {
		let finish!: () => void;
		const started = new Promise<void>((resolve) => {
			respond = (_request, response) => {
				response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "<summary>" } }] })}\n\n`);
				finish = () => success(response, "done</summary>");
				resolve();
			};
		});
		const output: vscode.LanguageModelResponsePart2[] = [];
		const running = run(fixture(), undefined, output);
		await started;
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.strictEqual(output.length, 0);
		finish();
		assert.strictEqual(await running, "<summary>done</summary>");
	});
	for (const failure of ["eof", "terminated", "length", "provider-error", "malformed", "tools", "empty"]) {
		test(`discards ${failure} attempt and uses coding model once`, async () => {
			respond = (_request, response, body) => {
				if (body.model === "coding") {
					success(response, "fallback-summary");
					return;
				}
				const partial = {
					choices: [{ delta: { content: "do-not-leak" }, finish_reason: failure === "length" ? "length" : null }],
				};
				if (failure === "terminated") {
					response.write(`data: ${JSON.stringify(partial)}\n\n`);
					setTimeout(() => response.destroy(), 10);
				} else if (failure === "provider-error") {
					emit(response, [
						partial,
						{ error: { message: "private failure" } },
						{ choices: [{ finish_reason: "stop" }] },
					]);
				} else if (failure === "malformed") {
					response.end(
						`data: invalid-json\n\ndata: ${JSON.stringify({ choices: [{ delta: { content: "bad" }, finish_reason: "stop" }] })}\n\n`
					);
				} else if (failure === "tools") {
					emit(response, [
						{
							choices: [
								{
									delta: { tool_calls: [{ index: 0, id: "call", function: { name: "read_file", arguments: "{}" } }] },
									finish_reason: "tool_calls",
								},
							],
						},
					]);
				} else if (failure === "empty") {
					emit(response, [{ choices: [{ finish_reason: "stop" }] }]);
				} else {
					emit(response, [partial]);
				}
			};
			assert.strictEqual(await run(), "fallback-summary");
			assert.deepStrictEqual(
				received.map((r) => r.body.model),
				["fast", "coding"]
			);
			assert.strictEqual(received[1].body.reasoning_effort, "max");
			assert.strictEqual(events.filter((event) => event.tag === "compaction.fallback").length, 1);
		});
	}
	test("fallback failure does not return a partial summary or loop", async () => {
		respond = (_request, response) => emit(response, [{ choices: [{ delta: { content: "partial" } }] }]);
		const output: vscode.LanguageModelResponsePart2[] = [];
		await assert.rejects(run(fixture(), undefined, output), /both the selected model and the coding model/);
		assert.strictEqual(received.length, 2);
		assert.strictEqual(output.length, 0);
	});
	test("cancellation aborts pending stream without fallback or partial output", async () => {
		const cancellation = new vscode.CancellationTokenSource();
		respond = (_request, response) => {
			response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "partial" } }] })}\n\n`);
			setTimeout(() => cancellation.cancel(), 20);
		};
		try {
			assert.strictEqual(await run(fixture(), cancellation.token), "");
			assert.strictEqual(received.length, 1);
		} finally {
			cancellation.dispose();
		}
	});
	for (const unavailable of ["capacity", "missing", "auth", "vision"]) {
		test(`${unavailable} target falls back before contacting target`, async () => {
			if (unavailable === "capacity") {
				models[1].context_length = 150;
				models[1].max_tokens = 50;
			}
			if (unavailable === "missing") {
				models[1].configId = "different"; // Same upstream ID must not be selected leniently.
			}
			if (unavailable === "auth") {
				keys.delete("oaicopilot.apiKey.target");
			}
			const input = fixture();
			if (unavailable === "vision") {
				(input[1].content as unknown[]).push(new vscode.LanguageModelDataPart(new Uint8Array([1]), "image/png"));
			}
			await run(input);
			assert.deepStrictEqual(
				received.map((r) => r.body.model),
				["coding"]
			);
			assert.ok(events.some((event) => event.tag === "compaction.fallback"));
		});
	}
	test("resolves provider-inherited target transport and authentication", async () => {
		state.set(PROVIDER_CONFIG_STORAGE_KEY, [{ provider: "target", baseUrl: models[1].baseUrl, apiMode: "openai" }]);
		delete models[1].baseUrl;
		models[1].inheritProvider = true;
		await run();
		assert.strictEqual(received[0].url, "/target/chat/completions");
		assert.strictEqual(received[0].authorization, "Bearer test-oaicopilot.apiKey.target");
	});
	for (const mode of ["openai-responses", "anthropic", "gemini", "ollama", "litellm", "azure-foundry"] as const) {
		test(`uses ${mode} adapter and its explicit completion`, async () => {
			models[1].apiMode = mode;
			respond = (_request, response, body) => {
				assert.ok(!body.tools);
				assert.ok(!body.tool_choice);
				if (mode === "openai-responses") {
					assert.strictEqual((body.reasoning as { effort: string }).effort, "low");
					emit(response, [
						{ type: "response.output_text.delta", delta: "summary" },
						{ type: "response.completed", response: { id: "target-response", status: "completed" } },
					]);
				} else if (mode === "anthropic") {
					assert.strictEqual((body.output_config as { effort: string }).effort, "low");
					emit(response, [
						{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "summary" } },
						{ type: "message_delta", delta: { stop_reason: "end_turn" } },
						{ type: "message_stop" },
					]);
				} else if (mode === "gemini") {
					emit(response, [
						{ candidates: [{ content: { role: "model", parts: [{ text: "summary" }] }, finishReason: "STOP" }] },
					]);
				} else if (mode === "ollama") {
					response.end(
						JSON.stringify({ message: { role: "assistant", content: "summary" }, done: true, done_reason: "stop" }) +
							"\n"
					);
				} else {
					success(response, "summary");
				}
			};
			assert.strictEqual(await run(), "summary");
			assert.strictEqual(received.length, 1);
		});
	}
	test("Responses compaction excludes previous IDs and never overwrites coding state", async () => {
		models[0].apiMode = "openai-responses";
		models[1].apiMode = "openai-responses";
		models[1].extra = { previous_response_id: "saved-id", reasoning: { effort: "max" } };
		respond = (_request, response, body) =>
			emit(response, [
				{ type: "response.output_text.delta", delta: "summary" },
				{
					type: "response.completed",
					response: { id: body.model === "fast" ? "compaction-id" : "coding-id", status: "completed" },
				},
			]);
		const normal = [message(1, "Code this")];
		const normalOutput: vscode.LanguageModelResponsePart2[] = [];
		await run(normal, undefined, normalOutput);
		const stateStore = (provider as unknown as { _openaiResponsesState: { size: number } })._openaiResponsesState;
		assert.strictEqual(stateStore.size, 1);
		const output: vscode.LanguageModelResponsePart2[] = [];
		const input = fixture();
		(input[1].content as unknown[]).push(
			...normalOutput.filter((part) => part instanceof vscode.LanguageModelDataPart)
		);
		await run(input, undefined, output);
		assert.strictEqual(stateStore.size, 1);
		assert.strictEqual(received[1].body.previous_response_id, undefined);
		assert.strictEqual((received[1].body.reasoning as { effort: string }).effort, "low");
		assert.ok(!JSON.stringify(received[1].body).includes("coding-id"));
		assert.ok(output.every((part) => !(part instanceof vscode.LanguageModelDataPart)));
		await run([...normal, message(2, "summary"), message(1, "Continue")]);
		assert.strictEqual(received[2].body.previous_response_id, "coding-id");
	});
	test("same coding model supports independent effort without repeating identical failed configuration", async () => {
		configuration["oaicopilot.compactionModel"] = "coding::main";
		models[0].supported_reasoning_efforts = ["low", "max"];
		await run();
		assert.strictEqual(received[0].body.reasoning_effort, "low");
		configuration["oaicopilot.compactionReasoningEffort"] = "max";
		respond = (_request, response) => emit(response, [{ choices: [{ delta: { content: "partial" } }] }]);
		await assert.rejects(run(), /terminal event/);
		assert.strictEqual(received.length, 2);
		assert.ok(!events.some((event) => event.tag === "compaction.fallback"));
	});

	test("concurrent compactions isolate their buffers and use settings captured at entry", async () => {
		let waiting = 0;
		let ready!: () => void;
		const started = new Promise<void>((resolve) => {
			ready = resolve;
		});
		const pending: http.ServerResponse[] = [];
		respond = (_request, response, body) => {
			if (body.model === "coding") {
				success(response, "original-source");
				return;
			}
			pending.push(response);
			response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `summary-${++waiting}` } }] })}\n\n`);
			if (waiting === 2) {
				ready();
			}
		};
		const first = run();
		const second = run();
		await started;
		configuration["oaicopilot.compactionModel"] = "changed::selection";
		models[0].baseUrl = "http://127.0.0.1:1/must-not-use-new-settings";
		success(pending[0], "-done");
		pending[1].end();
		assert.deepStrictEqual(await Promise.all([first, second]), ["summary-1-done", "original-source"]);
		assert.strictEqual(received[2].url, "/source/chat/completions");
		const attempts = events.filter((event) => event.tag === "compaction.attempt");
		assert.strictEqual(new Set(attempts.map((event) => event.data.routeId)).size, 2);
	});

	test("cancels transport backoff immediately without sending another attempt", async () => {
		configuration["oaicopilot.retry"] = { enabled: true, max_attempts: 3, interval_ms: 5000 };
		const cancellation = new vscode.CancellationTokenSource();
		respond = (_request, response) => {
			response.writeHead(503);
			response.end("temporary");
			setTimeout(() => cancellation.cancel(), 30);
		};
		const start = Date.now();
		try {
			assert.strictEqual(await run(fixture(), cancellation.token), "");
			assert.ok(Date.now() - start < 1000);
			assert.strictEqual(received.length, 1);
			assert.ok(
				events.some((event) => event.tag === "retry.attempt"),
				"must actually enter backoff before cancellation"
			);
		} finally {
			cancellation.dispose();
		}
	});

	test("full tool history reaches the target without enabling new tools or replacing the prompt", async () => {
		models[1].extra = {
			model: "wrong-model",
			messages: [],
			instructions: "wrong-instructions",
			extra_body: { input: [], tools: [{}], previous_response_id: "foreign-state" },
		};
		const saved = JSON.stringify(models[1]);
		const input = fixture();
		input.splice(
			2,
			0,
			{ ...message(2, ""), content: [new vscode.LanguageModelToolCallPart("call", "read_file", { path: "task.ts" })] },
			{
				...message(1, ""),
				content: [
					new vscode.LanguageModelToolResultPart("call", [new vscode.LanguageModelTextPart("historical-result")]),
				],
			}
		);
		await run(input);
		const body = received[0].body;
		assert.strictEqual(body.model, "fast");
		assert.ok(JSON.stringify(body.messages).includes("historical-result"));
		assert.ok(JSON.stringify(body.messages).includes("task.ts"));
		assert.strictEqual(body.tools, undefined);
		assert.strictEqual((body.extra_body as Record<string, unknown>).input, undefined);
		assert.strictEqual(JSON.stringify(models[1]), saved);
	});

	test("a progress consumer failure after publication never triggers replay", async () => {
		const cancellation = new vscode.CancellationTokenSource();
		let published = 0;
		try {
			await assert.rejects(
				provider.provideLanguageModelChatResponse(
					coding,
					fixture(),
					{
						requestInitiator: "github.copilot-chat",
						toolMode: vscode.LanguageModelChatToolMode.Auto,
					},
					{
						report: () => {
							published++;
							throw new Error("consumer closed");
						},
					},
					cancellation.token
				),
				/consumer closed/
			);
			assert.strictEqual(received.length, 1);
			assert.strictEqual(published, 1);
		} finally {
			cancellation.dispose();
		}
	});

	test("model-default effort follows the target profile default, independent of source effort", async () => {
		configuration["oaicopilot.compactionReasoningEffort"] = "default";
		delete models[1].reasoning_effort;
		models[1].default_reasoning_effort = "low";
		await run();
		assert.strictEqual(received[0].body.reasoning_effort, "low");
	});

	test("OpenAI OAuth target uses its OAuth credential and isolated Codex session", async () => {
		const originalFetch = globalThis.fetch;
		const localTarget = models[1].baseUrl!;
		models[1].owned_by = "openai-oauth";
		models[1].baseUrl = "https://chatgpt.com/backend-api/codex";
		models[1].authMode = "oauth";
		models[1].apiMode = "openai-responses";
		oauthCredential = JSON.stringify({
			accessToken: "fake-oauth-access",
			refreshToken: "fake-refresh",
			expiresAt: Date.now() + 3600000,
			accountId: "fake-account",
		});
		const sessions: string[] = [];
		globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
			assert.strictEqual(String(url), "https://chatgpt.com/backend-api/codex/responses");
			const headers = new Headers(init?.headers);
			assert.strictEqual(headers.get("Authorization"), "Bearer fake-oauth-access");
			assert.strictEqual(headers.get("ChatGPT-Account-Id"), "fake-account");
			sessions.push(headers.get("session_id")!);
			return originalFetch(localTarget + "/responses", init);
		}) as typeof fetch;
		respond = (_request, response, body) => {
			assert.strictEqual(body.store, false);
			assert.strictEqual(body.max_output_tokens, undefined);
			assert.strictEqual(body.previous_response_id, undefined);
			emit(response, [
				{ type: "response.output_text.delta", delta: "summary" },
				{ type: "response.completed", response: { id: "codex-response", status: "completed" } },
			]);
		};
		try {
			assert.strictEqual(await run(), "summary");
			assert.strictEqual(await run(), "summary");
			assert.strictEqual(sessions.length, 2);
			assert.ok(sessions.every((session) => session.length === 64));
			assert.notStrictEqual(sessions[0], sessions[1]);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
	test("Gemini compaction receives complete textual tool history without signed call state", async () => {
		models[1].apiMode = "gemini";
		const metadata = (provider as unknown as { _geminiToolCallMetaByCallId: Map<string, unknown> })
			._geminiToolCallMetaByCallId;
		metadata.set("call", { name: "read_file", thoughtSignature: "private-signed-state" });
		const input = fixture();
		input.splice(
			2,
			0,
			{ ...message(2, ""), content: [new vscode.LanguageModelToolCallPart("call", "read_file", { path: "task.ts" })] },
			{
				...message(1, ""),
				content: [
					new vscode.LanguageModelToolResultPart("call", [
						new vscode.LanguageModelTextPart("complete historical result"),
					]),
				],
			}
		);
		respond = (_request, response, body) => {
			const text = JSON.stringify(body.contents);
			assert.ok(text.includes("complete historical result"));
			assert.ok(text.includes("task.ts"));
			assert.ok(!text.includes("functionCall"));
			assert.ok(!text.includes("private-signed-state"));
			emit(response, [
				{ candidates: [{ content: { role: "model", parts: [{ text: "summary" }] }, finishReason: "STOP" }] },
			]);
		};
		assert.strictEqual(await run(input), "summary");
		assert.strictEqual(metadata.size, 1);
		assert.deepStrictEqual(metadata.get("call"), { name: "read_file", thoughtSignature: "private-signed-state" });
	});
});
