import * as assert from "assert";
import * as path from "path";
import * as vscode from "vscode";
import { HuggingFaceChatModelProvider } from "../provider";
import { logger } from "../logger";
import { tokenizerManager, TokenizerManager } from "../tokenizer/tokenizerManager";
import { png } from "./fixtures/image";
import { PROVIDER_CONFIG_STORAGE_KEY } from "../providerTransport";

suite("token count responsiveness", () => {
	const originalConfig = vscode.workspace.getConfiguration;
	const originalChange = vscode.workspace.onDidChangeConfiguration;
	const originalDebug = logger.debug;
	let changes: vscode.EventEmitter<vscode.ConfigurationChangeEvent>;
	let configuration: Record<string, unknown>;
	let state: Map<string, unknown>;
	let provider: HuggingFaceChatModelProvider;
	let reads: number;
	let logs: Array<{ tag: string; data: Record<string, unknown> }>;
	const token = { isCancellationRequested: false } as vscode.CancellationToken;
	const model = (id = "test") => ({ id, capabilities: { imageInput: true } }) as vscode.LanguageModelChatInformation;
	const message = (parts: unknown[]) =>
		({ role: 1, name: undefined, content: parts }) as vscode.LanguageModelChatRequestMessage;
	const image = () => message([new vscode.LanguageModelDataPart(png(), "image/png")]);
	const changed = () =>
		changes.fire({
			affectsConfiguration: (section: string) => section === "oaicopilot",
		} as vscode.ConfigurationChangeEvent);

	suiteSetup(async () => {
		TokenizerManager.setExtensionPath(path.resolve(__dirname, "../.."));
		await tokenizerManager.countTokens("private-field");
	});
	setup(() => {
		reads = 0;
		logs = [];
		state = new Map();
		configuration = {
			"oaicopilot.models": [{ id: "test", vision: true }],
			"oaicopilot.tokenEstimation": { image: { strategy: "fixed", fixedTokens: 111 } },
		};
		changes = new vscode.EventEmitter<vscode.ConfigurationChangeEvent>();
		(vscode.workspace as { onDidChangeConfiguration: typeof originalChange }).onDidChangeConfiguration = changes.event;
		vscode.workspace.getConfiguration = (() => {
			reads++;
			return { get: (key: string, fallback: unknown) => configuration[key] ?? fallback };
		}) as typeof originalConfig;
		logger.debug = (tag, data) => {
			logs.push({ tag, data });
		};
		provider = new HuggingFaceChatModelProvider(
			{} as vscode.SecretStorage,
			{ get: (key: string, fallback: unknown) => state.get(key) ?? fallback } as vscode.Memento,
			{} as vscode.StatusBarItem
		);
	});
	teardown(() => {
		provider.dispose();
		changes.dispose();
		vscode.workspace.getConfiguration = originalConfig;
		(vscode.workspace as { onDidChangeConfiguration: typeof originalChange }).onDidChangeConfiguration = originalChange;
		logger.debug = originalDebug;
	});

	test("a burst reuses configuration, preserves counts, and aggregates diagnostics", async () => {
		const expected = await tokenizerManager.countTokens("private-field");
		for (let i = 0; i < 1000; i++) {
			assert.strictEqual(await provider.provideTokenCount(model(), "private-field", token), expected);
		}
		assert.strictEqual(reads, 2, "context is built once, not once per string");
		provider.dispose();
		const counts = logs.filter((entry) => entry.tag.startsWith("tokenCount."));
		assert.ok(counts.length < 10, "must not emit two log writes per callback");
		assert.ok(counts.every((entry) => entry.tag === "tokenCount.summary"));
		assert.strictEqual(
			counts.reduce((sum, entry) => sum + Number(entry.data.calls), 0),
			1000
		);
		assert.strictEqual(
			counts.reduce((sum, entry) => sum + Number(entry.data.tokens), 0),
			1000 * expected
		);
		assert.ok(!JSON.stringify(counts).includes("private-field"));
	});

	test("configuration events immediately invalidate image and reasoning settings", async () => {
		const original = await provider.provideTokenCount(model(), image(), token);
		configuration["oaicopilot.tokenEstimation"] = { image: { strategy: "fixed", fixedTokens: 333 } };
		changed();
		assert.strictEqual(await provider.provideTokenCount(model(), image(), token), original + 222);
		const reasoning = message([new vscode.LanguageModelThinkingPart("reason ".repeat(100))]);
		assert.strictEqual(await provider.provideTokenCount(model(), reasoning, token), 4);
		configuration["oaicopilot.models"] = [{ id: "test", vision: true, include_reasoning_in_request: true }];
		changed();
		assert.ok((await provider.provideTokenCount(model(), reasoning, token)) > 90);
	});

	test("provider refresh and model identity/capabilities cannot reuse stale context", async () => {
		const before = await provider.provideTokenCount(model(), image(), token);
		configuration["oaicopilot.tokenEstimation"] = { image: { strategy: "fixed", fixedTokens: 222 } };
		provider.refreshLanguageModelChatInformation();
		assert.strictEqual(await provider.provideTokenCount(model(), image(), token), before + 111);
		const other = model("unconfigured");
		const native = await provider.provideTokenCount(other, image(), token);
		assert.ok(
			(await provider.provideTokenCount({ ...other, capabilities: { imageInput: false } }, image(), token)) < native
		);
	});

	test("queued panel/command work runs before a cached count burst completes", async () => {
		let completed = 0;
		let completedWhenCommandRan = -1;
		const command = new Promise<void>((resolve) =>
			setImmediate(() => {
				completedWhenCommandRan = completed;
				resolve();
			})
		);
		for (; completed < 1000; completed++) {
			await provider.provideTokenCount(model(), "private-field", token);
		}
		await command;
		assert.ok(
			completedWhenCommandRan >= 0 && completedWhenCommandRan < 128,
			`queued work only ran after ${completedWhenCommandRan} counts`
		);
	});

	test("provider transport refresh changes inherited reasoning behavior", async () => {
		configuration["oaicopilot.models"] = [{ id: "test", owned_by: "inherited" }];
		state.set(PROVIDER_CONFIG_STORAGE_KEY, [{ provider: "inherited", apiMode: "openai" }]);
		const reasoning = message([new vscode.LanguageModelThinkingPart("reason ".repeat(100))]);
		const before = await provider.provideTokenCount(model(), reasoning, token);
		state.set(PROVIDER_CONFIG_STORAGE_KEY, [{ provider: "inherited", apiMode: "ollama" }]);
		provider.refreshLanguageModelChatInformation();
		assert.ok((await provider.provideTokenCount(model(), reasoning, token)) > before + 90);
	});

	test("different model configurations keep separate image estimates", async () => {
		configuration["oaicopilot.tokenEstimation"] = {
			image: { strategy: "fixed", fixedTokens: 111 },
			perModel: { "test::second": { image: { fixedTokens: 444 } } },
		};
		const first = await provider.provideTokenCount(model("test::first"), image(), token);
		assert.strictEqual(await provider.provideTokenCount(model("test::second"), image(), token), first + 333);
		assert.strictEqual(await provider.provideTokenCount(model("test::first"), image(), token), first);
	});

	test("cancellation delivered during a burst prevents remaining count work", async () => {
		const cancellation = { isCancellationRequested: false } as vscode.CancellationToken;
		const cancel = new Promise<void>((resolve) =>
			setImmediate(() => {
				(cancellation as { isCancellationRequested: boolean }).isCancellationRequested = true;
				resolve();
			})
		);
		let skipped = 0;
		for (let i = 0; i < 500; i++) {
			if ((await provider.provideTokenCount(model(), "private-field", cancellation)) === 0) {
				skipped++;
			}
		}
		await cancel;
		assert.ok(skipped > 350);
	});

	test("configuration cache is bounded across arbitrary model IDs", async () => {
		for (let i = 0; i < 65; i++) {
			await provider.provideTokenCount(model(`model-${i}`), "private-field", token);
		}
		const before = reads;
		await provider.provideTokenCount(model("model-0"), "private-field", token);
		assert.strictEqual(reads, before + 2, "oldest configuration must be evicted");
	});
});
