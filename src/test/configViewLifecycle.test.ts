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
			} as vscode.Memento,
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
		})) as typeof originalConfig;
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
});
