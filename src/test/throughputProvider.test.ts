import * as assert from "assert";
import * as path from "path";
import * as vscode from "vscode";
import { HuggingFaceChatModelProvider } from "../provider";
import { tokenizerManager, TokenizerManager } from "../tokenizer/tokenizerManager";
import { VISION_BRIDGE_REQUEST_OPTION } from "../visionBridge";
import { getLatestTokenUsageReport } from "../statusBar";

suite("throughput provider integration", () => {
	const originalConfig = vscode.workspace.getConfiguration;
	const originalFetch = globalThis.fetch;
	const originalNow = performance.now;
	let now: number;
	let item: vscode.StatusBarItem;
	let provider: HuggingFaceChatModelProvider;
	let streams: ReadableStreamDefaultController<Uint8Array>[];
	let cancellations: vscode.CancellationTokenSource[];
	let persist: () => Promise<void>;
	const model = (name = "test") => ({ id: name, name, maxInputTokens: 10000, maxOutputTokens: 1000, capabilities: { toolCalling: true } }) as vscode.LanguageModelChatInformation;
	const tooltip = () => (item.tooltip as vscode.MarkdownString).value;
	const send = (index: number, payload: unknown) => streams[index].enqueue(new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`));
	const end = (index: number) => {
		send(index, { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 99999 } });
		streams[index].enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
		streams[index].close();
	};
	const run = (name = "test", options: Record<string, unknown> = {}) => {
		const cancellation = new vscode.CancellationTokenSource();
		cancellations.push(cancellation);
		const parts: vscode.LanguageModelResponsePart2[] = [];
		const done = provider.provideLanguageModelChatResponse(model(name), [vscode.LanguageModelChatMessage.User("hello")],
			{ requestInitiator: "test", toolMode: vscode.LanguageModelChatToolMode.Auto, ...options }, { report: (part) => parts.push(part) }, cancellation.token);
		return { done, parts, cancellation };
	};
	suiteSetup(async () => {
		TokenizerManager.setExtensionPath(path.resolve(__dirname, "../.."));
		await tokenizerManager.getTokenizer();
	});
	setup(() => {
		now = 0;
		performance.now = () => now;
		streams = [];
		cancellations = [];
		persist = async () => {};
		const configuration: Record<string, unknown> = {
			"oaicopilot.baseUrl": "https://test.invalid/v1",
			"oaicopilot.models": ["test", "new"].map((id) => ({ id, owned_by: "test", apiMode: "openai" })),
			"oaicopilot.retry": { enabled: false },
		};
		vscode.workspace.getConfiguration = (() => ({ get: (key: string, fallback: unknown) => configuration[key] ?? fallback })) as typeof originalConfig;
		globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { streams.push(controller); } }), {
			status: 200, headers: { "Content-Type": "text/event-stream" },
		});
		item = { show() {} } as unknown as vscode.StatusBarItem;
		provider = new HuggingFaceChatModelProvider(
			{ get: async () => "synthetic-test-key" } as unknown as vscode.SecretStorage,
			{ get: (_key: string, fallback: unknown) => fallback, update: () => persist() } as unknown as vscode.Memento,
			item
		);
	});
	teardown(() => {
		provider.dispose();
		cancellations.forEach((source) => source.dispose());
		vscode.workspace.getConfiguration = originalConfig;
		globalThis.fetch = originalFetch;
		performance.now = originalNow;
	});

	test("real adapter counts text/thinking, forwards parts and ignores tools and billed totals", async () => {
		const request = run();
		await until(() => streams.length === 1);
		now = 5000; // Initial wait must not enter the speed denominator.
		send(0, { choices: [{ delta: { reasoning_content: "thinking clearly" } }] });
		// Thinking is buffered by the real adapter for 100 ms.
		await until(() => request.parts.some((part) => part instanceof vscode.LanguageModelThinkingPart));
		now += 500;
		send(0, { choices: [{ delta: { content: "Hello world" } }] });
		send(0, { choices: [{ delta: { tool_calls: [{ index: 0, id: "call", function: { name: "read_file", arguments: '{"path":"a-long-tool-payload"}' } }] } }] });
		await until(() => request.parts.some((part) => part instanceof vscode.LanguageModelToolCallPart));
		now += 500;
		end(0);
		await request.done;
		const tokenizer = await tokenizerManager.getTokenizer();
		// The adapter appends a whitespace flush before emitting a tool call.
		const expected = tokenizer.encode("thinking clearly").length + tokenizer.encode("Hello world ").length;
		assert.ok(tooltip().includes(`~${expected} output tokens`), tooltip());
		assert.ok(tooltip().includes("1.0 s measured"));
		assert.ok(tooltip().includes("Completed"));
		assert.ok(!tooltip().includes("99,999"));
		assert.ok(request.parts.some((part) => part instanceof vscode.LanguageModelTextPart && part.value === "Hello world"));
		assert.ok(request.parts.some((part) => part instanceof vscode.LanguageModelDataPart && part.mimeType === "usage"));
	});

	test("newest request retains ownership when an older stream finishes last", async () => {
		const old = run();
		await until(() => streams.length === 1);
		send(0, { choices: [{ delta: { content: "old" } }] });
		await until(() => old.parts.length > 0);
		const current = run("new");
		await until(() => streams.length === 2);
		send(1, { choices: [{ delta: { content: "new output" } }] });
		await until(() => current.parts.length > 0);
		now += 1000;
		end(1);
		await current.done;
		const before = tooltip();
		end(0);
		await old.done;
		assert.strictEqual(tooltip(), before);
		assert.strictEqual(getLatestTokenUsageReport()?.modelId, "new");
	});

	test("connection tests and Vision Bridge requests leave displayed statistics alone", async () => {
		const ordinary = run();
		await until(() => streams.length === 1);
		end(0);
		await ordinary.done;
		const before = tooltip();
		const bridge = run("new", { modelOptions: { [VISION_BRIDGE_REQUEST_OPTION]: true } });
		await until(() => streams.length === 2);
		send(1, { choices: [{ delta: { content: "bridge output" } }] });
		end(1);
		await bridge.done;
		assert.strictEqual(tooltip(), before);
		provider.provideLanguageModelChatInformation = async () => [model()];
		const cancellation = new vscode.CancellationTokenSource();
		cancellations.push(cancellation);
		const diagnostic = provider.testModelConnection("test", cancellation.token);
		await until(() => streams.length === 3);
		send(2, { choices: [{ delta: { content: "OK" } }] });
		end(2);
		await diagnostic;
		assert.strictEqual(tooltip(), before);
	});

	test("cancellation freezes partial output and transport failures preserve failure state", async () => {
		const cancelled = run();
		await until(() => streams.length === 1);
		send(0, { choices: [{ delta: { content: "partial" } }] });
		await until(() => cancelled.parts.length > 0);
		now += 1000;
		cancelled.cancellation.cancel();
		streams[0].close();
		await cancelled.done;
		assert.ok(tooltip().includes("Cancelled (partial)"));
		const failed = run();
		await until(() => streams.length === 2);
		send(1, { choices: [{ delta: { content: "partial" } }] });
		await until(() => failed.parts.length > 0);
		now += 1000;
		const rejected = assert.rejects(failed.done, /broken stream/);
		streams[1].error(new Error("broken stream"));
		await rejected;
		assert.ok(tooltip().includes("Failed (partial)"));
	});

	test("stream duration freezes before usage persistence", async () => {
		let release!: () => void;
		let persisting = false;
		persist = () => new Promise<void>((resolve) => { persisting = true; release = resolve; });
		const request = run();
		await until(() => streams.length === 1);
		send(0, { choices: [{ delta: { content: "OK" } }] });
		await until(() => request.parts.length > 0);
		now += 1000;
		end(0);
		await until(() => persisting);
		const before = tooltip();
		now += 60000;
		release();
		await request.done;
		assert.strictEqual(tooltip(), before);
		assert.ok(tooltip().includes("1.0 s measured"));
	});
});

async function until(condition: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 2000; attempt++) {
		if (condition()) { return; }
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
	assert.fail("Timed out waiting for the synthetic stream");
}
