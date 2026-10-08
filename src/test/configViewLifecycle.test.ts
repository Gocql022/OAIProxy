import * as assert from "assert";
import * as vscode from "vscode";
import { ConfigViewPanel } from "../views/configView";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

suite("configuration panel lifecycle", () => {
	const originalCreate = vscode.window.createWebviewPanel;
	const originalConfig = vscode.workspace.getConfiguration;
	const originalRead = vscode.workspace.fs?.readFile;
	let configuration: Record<string, unknown>;
	let reads: string[];
	let stored: Map<string, string>;
	let migrations: string[];
	let active: number;
	let peak: number;
	let readGate: Promise<void> | undefined;
	let htmlGate: Promise<Uint8Array> | undefined;
	let failReads: boolean;
	let panels: ReturnType<typeof makePanel>[];

	function makePanel() {
		let disposed = false;
		let disposeHandler: (() => void) | undefined;
		let receive: ((message: unknown) => void) | undefined;
		const messages: Array<{ type: string; payload?: Record<string, unknown> }> = [];
		const webview = {
			html: "",
			cspSource: "test",
			asWebviewUri: (uri: vscode.Uri) => uri,
			postMessage: async (message: (typeof messages)[number]) => {
				assert.ok(!disposed);
				messages.push(message);
				return true;
			},
			onDidReceiveMessage: (handler: typeof receive) => {
				receive = handler;
				return { dispose() {} };
			},
		};
		const panel = {
			get webview() {
				if (disposed) {
					throw new Error("Webview is disposed");
				}
				return webview;
			},
			onDidDispose: (handler: () => void) => {
				disposeHandler = handler;
				return { dispose() {} };
			},
			dispose: () => {
				if (!disposed) {
					disposed = true;
					disposeHandler?.();
				}
			},
			reveal() {},
		};
		return { panel, webview, messages, receive: (message: unknown) => receive?.(message) };
	}

	function open() {
		ConfigViewPanel.openPanel(
			vscode.Uri.file("/test"),
			{
				get: async (key: string) => {
					reads.push(key);
					peak = Math.max(peak, ++active);
					try {
						if (readGate) {
							await readGate;
						}
						await new Promise((resolve) => setTimeout(resolve, 2));
						if (failReads) {
							throw new Error("secret read failed");
						}
						return stored.get(key);
					} finally {
						active--;
					}
				},
				store: async (key: string, value: string) => {
					stored.set(key, value);
					migrations.push(`store:${key}`);
				},
				delete: async (key: string) => {
					stored.delete(key);
					migrations.push(`delete:${key}`);
				},
			} as unknown as vscode.SecretStorage,
			{
				get: (_key: string, fallback: unknown) => fallback,
				update: async () => undefined,
			} as unknown as vscode.Memento,
			async () => ({ durationMs: 1 })
		);
		return ConfigViewPanel.currentPanel!;
	}

	setup(() => {
		configuration = {};
		reads = [];
		stored = new Map();
		migrations = [];
		active = 0;
		peak = 0;
		readGate = undefined;
		htmlGate = undefined;
		failReads = false;
		panels = [];
		vscode.workspace.getConfiguration = (() => ({
			get: (key: string, fallback: unknown) => configuration[key] ?? fallback,
			update: async (key: string, value: unknown) => { configuration[key] = value; },
		})) as unknown as typeof originalConfig;
		vscode.workspace.fs.readFile = async () => htmlGate ?? new TextEncoder().encode("test html");
		vscode.window.createWebviewPanel = (() => {
			const fake = makePanel();
			panels.push(fake);
			return fake.panel;
		}) as unknown as typeof originalCreate;
	});
	teardown(() => {
		ConfigViewPanel.currentPanel?.dispose();
		vscode.window.createWebviewPanel = originalCreate;
		vscode.workspace.getConfiguration = originalConfig;
		vscode.workspace.fs.readFile = originalRead;
	});

	test("waits for readiness, coalesces duplicate init and bounds parallel credential reads", async () => {
		const view = open();
		await tick();
		assert.strictEqual(reads.length, 0);
		const gate = deferred<void>();
		readGate = gate.promise;
		const first = view.handleMessage({ type: "requestInit" });
		const second = view.handleMessage({ type: "requestInit" });
		assert.strictEqual(active, 8);
		gate.resolve();
		await Promise.all([first, second]);
		assert.strictEqual(peak, 8);
		assert.strictEqual(panels[0].messages.length, 1);
		assert.strictEqual(reads.filter((key) => key === "oaicopilot.apiKey").length, 1);
		assert.ok(reads.length >= 35, "fixture must exercise all preset credential reads");
	});

	test("closing during HTML load cannot overwrite a newly opened panel", async () => {
		const gate = deferred<Uint8Array>();
		htmlGate = gate.promise;
		const old = open();
		old.dispose();
		htmlGate = undefined;
		const current = open();
		gate.resolve(new TextEncoder().encode("old html"));
		await tick();
		old.dispose();
		assert.strictEqual(ConfigViewPanel.currentPanel, current);
		assert.strictEqual(panels[0].webview.html, "");
		assert.strictEqual(panels[1].webview.html, "test html");
	});

	test("closing during credential reads stops scheduling and never posts to the disposed panel", async () => {
		const gate = deferred<void>();
		readGate = gate.promise;
		const view = open();
		const pending = view.handleMessage({ type: "requestInit" });
		view.dispose();
		gate.resolve();
		await pending;
		assert.strictEqual(panels[0].messages.length, 0);
		assert.strictEqual(reads.length, 8);
	});

	test("configuration mutation during init discards the stale snapshot", async () => {
		configuration["oaicopilot.baseUrl"] = "https://old.example";
		const gate = deferred<void>();
		readGate = gate.promise;
		const view = open();
		const pending = view.handleMessage({ type: "requestInit" });
		configuration["oaicopilot.baseUrl"] = "https://new.example";
		const refreshed = (view as unknown as { sendInit(): Promise<void> }).sendInit();
		gate.resolve();
		await Promise.all([pending, refreshed]);
		assert.strictEqual(panels[0].messages.length, 1);
		assert.strictEqual(panels[0].messages[0].payload?.baseUrl, "https://new.example");
	});

	test("legacy mixed-case credentials migrate in order and reach every provider alias", async () => {
		configuration["oaicopilot.models"] = [{ id: "model", owned_by: "OpenAI", baseUrl: "https://example.com" }];
		stored.set("oaicopilot.apiKey.OpenAI", "private-test-key");
		const view = open();
		await view.handleMessage({ type: "requestInit" });
		assert.deepStrictEqual(migrations, ["store:oaicopilot.apiKey.openai", "delete:oaicopilot.apiKey.OpenAI"]);
		const keys = panels[0].messages[0].payload?.providerKeys as Record<string, string>;
		assert.strictEqual(keys.OpenAI, "private-test-key");
		assert.strictEqual(keys.openai, "private-test-key");
	});

	test("read failure reports recoverable init error through the real message handler", async () => {
		failReads = true;
		const view = open();
		panels[0].receive({ type: "requestInit" });
		for (let i = 0; i < 100 && !panels[0].messages.length; i++) {
			await new Promise((resolve) => setTimeout(resolve, 2));
		}
		assert.deepStrictEqual(panels[0].messages, [{ type: "initError" }]);
		failReads = false;
		await view.handleMessage({ type: "requestInit" });
		assert.strictEqual(panels[0].messages.at(-1)?.type, "init");
	});
	test("compaction init includes every added model and save preserves full identity", async () => {
		configuration["oaicopilot.models"] = [
			{ id: "same", configId: "one", owned_by: "first", supported_reasoning_efforts: ["low", "high"] },
			{ id: "same", configId: "two", owned_by: "second" },
			{ id: "gemini", owned_by: "google", apiMode: "gemini" },
		];
		const view = open();
		await view.handleMessage({ type: "requestInit" });
		const choices = panels[0].messages.at(-1)!.payload!.compactionModels as Array<{ id: string; efforts: string[] }>;
		assert.deepStrictEqual(choices.map((model) => model.id), ["same::one", "same::two", "gemini"]);
		assert.deepStrictEqual(choices[0].efforts, ["low", "high"]);
		assert.deepStrictEqual(choices[2].efforts, []);
		configuration["oaicopilot.baseUrl"] = "https://saved.example/v1";
		stored.set("oaicopilot.apiKey", "saved-test-key");
		await view.handleMessage({ type: "saveCompactionConfig", compactionModel: "same::one", compactionReasoningEffort: "low" });
		assert.strictEqual(configuration["oaicopilot.baseUrl"], "https://saved.example/v1");
		assert.strictEqual(stored.get("oaicopilot.apiKey"), "saved-test-key");
		await view.handleMessage({ type: "saveGlobalConfig", baseUrl: "", apiKey: "", delay: 0, readFileLines: 0, retry: {}, commitModel: "", commitLanguage: "English" });
		assert.strictEqual(configuration["oaicopilot.compactionModel"], "same::one");
		assert.strictEqual(configuration["oaicopilot.compactionReasoningEffort"], "low");
		view.dispose();
		const reopened = open();
		await reopened.handleMessage({ type: "requestInit" });
		assert.strictEqual(panels.at(-1)!.messages.at(-1)!.payload!.compactionModel, "same::one");
		assert.strictEqual(panels.at(-1)!.messages.at(-1)!.payload!.compactionReasoningEffort, "low");
	});

	test("compaction exports/imports and legacy imports disable routing", async () => {
		const originalSave = vscode.window.showSaveDialog;
		const originalOpen = vscode.window.showOpenDialog;
		const originalWrite = vscode.workspace.fs.writeFile;
		const originalReadFile = vscode.workspace.fs.readFile;
		let exported = new Uint8Array();
		try {
			configuration["oaicopilot.models"] = [{ id: "fast", owned_by: "test", supported_reasoning_efforts: ["low"] }];
			configuration["oaicopilot.compactionModel"] = "fast";
			configuration["oaicopilot.compactionReasoningEffort"] = "low";
			const view = open();
			await tick();
			vscode.window.showSaveDialog = async () => vscode.Uri.file("/test/export.json");
			vscode.window.showOpenDialog = async () => [vscode.Uri.file("/test/export.json")];
			vscode.workspace.fs.writeFile = async (_uri, bytes) => { exported = Uint8Array.from(bytes); };
			await view.handleMessage({ type: "exportConfig" });
			const data = JSON.parse(new TextDecoder().decode(exported));
			assert.strictEqual(data.compactionModel, "fast");
			assert.strictEqual(data.compactionReasoningEffort, "low");
			configuration["oaicopilot.compactionModel"] = "";
			vscode.workspace.fs.readFile = async () => exported;
			await view.handleMessage({ type: "importConfig" });
			assert.strictEqual(configuration["oaicopilot.compactionModel"], "fast");
			assert.strictEqual(configuration["oaicopilot.compactionReasoningEffort"], "low");
			delete data.compactionModel; delete data.compactionReasoningEffort;
			exported = new TextEncoder().encode(JSON.stringify(data));
			await view.handleMessage({ type: "importConfig" });
			assert.strictEqual(configuration["oaicopilot.compactionModel"], "");
			assert.strictEqual(configuration["oaicopilot.compactionReasoningEffort"], "default");
		} finally {
			vscode.window.showSaveDialog = originalSave; vscode.window.showOpenDialog = originalOpen;
			vscode.workspace.fs.writeFile = originalWrite; vscode.workspace.fs.readFile = originalReadFile;
		}
	});

});
