import * as assert from "assert";
import * as path from "path";
import * as vscode from "vscode";
import { beginStatusBarRequest, endStatusBarRequests, getLatestTokenUsageReport, initStatusBar, updateContextStatusBar, updateStatusBarThroughput } from "../statusBar";
import { recordCacheUsage, resetCacheUsageForTests } from "../cacheUsage";
import { tokenizerManager, TokenizerManager } from "../tokenizer/tokenizerManager";

suite("throughput status bar", () => {
	let item: vscode.StatusBarItem;
	let subscriptions: vscode.Disposable[];
	const originalCreate = vscode.window.createStatusBarItem;
	const model = (name: string) => ({ id: name, name, maxInputTokens: 100, maxOutputTokens: 50 }) as vscode.LanguageModelChatInformation;
	const context = (id: string, text = "hello") => updateContextStatusBar(
		[vscode.LanguageModelChatMessage.User(text)], [], model(id), item, { includeReasoningInRequest: false }, undefined, id
	);
	const tooltip = () => (item.tooltip as vscode.MarkdownString).value;
	suiteSetup(async () => {
		TokenizerManager.setExtensionPath(path.resolve(__dirname, "../.."));
		await tokenizerManager.getTokenizer();
	});
	setup(() => {
		item = { show() {}, dispose() {} } as unknown as vscode.StatusBarItem;
		subscriptions = [];
		vscode.window.createStatusBarItem = (() => item) as typeof originalCreate;
		initStatusBar({ subscriptions } as vscode.ExtensionContext);
	});
	teardown(() => {
		subscriptions.forEach((subscription) => subscription.dispose());
		vscode.window.createStatusBarItem = originalCreate;
		resetCacheUsageForTests();
	});

	test("context, cache and TPS share the tooltip and keep the configuration action", async () => {
		beginStatusBarRequest(item, "model", "Model");
		assert.ok(item.text.includes("Waiting…"));
		const report = await context("model", "hello world ".repeat(50));
		updateStatusBarThroughput(item, "model", { status: "streaming", estimatedTokens: 42, elapsedMs: 1000, tokensPerSecond: 42 });
		const color = item.backgroundColor;
		assert.ok(color, "high input usage should retain its warning color");
		assert.ok(item.text.includes("% · ~42.0 tok/s"));
		assert.ok(tooltip().includes("Streaming"));
		recordCacheUsage("openai", "model", { inputTokens: 100, cachedTokens: 50 });
		assert.ok(tooltip().includes("50.0% hit"));
		assert.ok(tooltip().includes("~42.0 tok/s"));
		assert.ok(tooltip().includes("hidden reasoning and tool payloads"));
		assert.strictEqual(item.command, "oaiproxy.openConfig");
		assert.strictEqual(item.backgroundColor?.id, color?.id);
		assert.strictEqual(getLatestTokenUsageReport(), report);
	});

	test("a stale asynchronous preflight cannot overwrite the latest request", async () => {
		const originalCount = tokenizerManager.countTokens;
		let release!: () => void;
		let reached!: () => void;
		const paused = new Promise<void>((resolve) => { reached = resolve; });
		const blocked = new Promise<void>((resolve) => { release = resolve; });
		tokenizerManager.countTokens = async (text) => {
			if (text === "old prompt") { reached(); await blocked; }
			return originalCount.call(tokenizerManager, text);
		};
		try {
			beginStatusBarRequest(item, "old", "Old");
			const oldReport = context("old", "old prompt");
			await paused;
			beginStatusBarRequest(item, "new", "New");
			const current = await context("new");
			updateStatusBarThroughput(item, "new", { status: "completed", estimatedTokens: 21, elapsedMs: 1000, tokensPerSecond: 21 });
			const before = tooltip();
			release();
			assert.strictEqual((await oldReport).modelId, "old", "older requests still receive their own budget report");
			updateStatusBarThroughput(item, "old", { status: "failed", estimatedTokens: 99, elapsedMs: 1000, tokensPerSecond: 99 });
			assert.strictEqual(tooltip(), before);
			assert.strictEqual(getLatestTokenUsageReport(), current);
		} finally {
			release();
			tokenizerManager.countTokens = originalCount;
		}
	});

	test("disposed request ownership rejects late UI updates", async () => {
		beginStatusBarRequest(item, "old", "Old");
		endStatusBarRequests(item);
		const before = item.text;
		await context("old");
		updateStatusBarThroughput(item, "old", { status: "completed", estimatedTokens: 100, elapsedMs: 1000, tokensPerSecond: 100 });
		assert.strictEqual(item.text, before);
	});
});
