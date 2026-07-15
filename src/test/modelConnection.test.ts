import * as assert from "assert";
import * as vscode from "vscode";
import type {
	CancellationToken,
	LanguageModelChatInformation,
	LanguageModelChatRequestMessage,
	LanguageModelResponsePart2,
	Progress,
	ProvideLanguageModelChatResponseOptions,
} from "vscode";

import { HuggingFaceChatModelProvider } from "../provider";

interface TestableProvider {
	executeLanguageModelChatResponse(
		model: LanguageModelChatInformation,
		messages: readonly LanguageModelChatRequestMessage[],
		options: ProvideLanguageModelChatResponseOptions,
		progress: Progress<LanguageModelResponsePart2>,
		token: CancellationToken,
		executionOptions: { diagnostic?: boolean }
	): Promise<void>;
}

suite("model connection test", () => {
	test("uses diagnostic execution and accepts non-empty model output", async () => {
		const provider = createProvider();
		const model = modelInfo("model::config");
		provider.provideLanguageModelChatInformation = async () => [model];
		let observedDiagnostic = false;
		let observedInitiator = "";
		(provider as unknown as TestableProvider).executeLanguageModelChatResponse = async (
			_model,
			_messages,
			options,
			progress,
			_token,
			executionOptions
		) => {
			observedDiagnostic = executionOptions.diagnostic === true;
			observedInitiator = options.requestInitiator;
			progress.report(new vscode.LanguageModelTextPart("OK"));
		};

		const cancellationSource = new vscode.CancellationTokenSource();
		try {
			const result = await provider.testModelConnection(model.id, cancellationSource.token, 1000);
			assert.ok(result.durationMs >= 0);
			assert.strictEqual(observedDiagnostic, true);
			assert.strictEqual(observedInitiator, "oaiproxy.modelTest");
		} finally {
			cancellationSource.dispose();
			provider.dispose();
		}
	});

	test("rejects a successful transport that emits no usable output", async () => {
		const provider = createProvider();
		const model = modelInfo("empty-model");
		provider.provideLanguageModelChatInformation = async () => [model];
		(provider as unknown as TestableProvider).executeLanguageModelChatResponse = async () => undefined;

		const cancellationSource = new vscode.CancellationTokenSource();
		try {
			await assert.rejects(
				provider.testModelConnection(model.id, cancellationSource.token, 1000),
				/no text or thinking output/
			);
		} finally {
			cancellationSource.dispose();
			provider.dispose();
		}
	});

	test("times out and cancels a stalled diagnostic request", async () => {
		const provider = createProvider();
		const model = modelInfo("slow-model");
		provider.provideLanguageModelChatInformation = async () => [model];
		let cancelled = false;
		(provider as unknown as TestableProvider).executeLanguageModelChatResponse = async (
			_model,
			_messages,
			_options,
			_progress,
			token
		) => {
			await new Promise<void>((resolve) => {
				token.onCancellationRequested(() => {
					cancelled = true;
					resolve();
				});
			});
		};

		const cancellationSource = new vscode.CancellationTokenSource();
		try {
			await assert.rejects(provider.testModelConnection(model.id, cancellationSource.token, 10), /timed out/);
			assert.strictEqual(cancelled, true);
		} finally {
			cancellationSource.dispose();
			provider.dispose();
		}
	});
});

function createProvider(): HuggingFaceChatModelProvider {
	const secrets = {
		get: async () => undefined,
		store: async () => undefined,
		delete: async () => undefined,
		onDidChange: () => ({ dispose: () => undefined }),
	};
	const globalState = {
		keys: () => [],
		get: () => undefined,
		update: async () => undefined,
		setKeysForSync: () => undefined,
	};
	const statusBarItem = {
		show: () => undefined,
		hide: () => undefined,
		dispose: () => undefined,
	};

	return new HuggingFaceChatModelProvider(
		secrets as unknown as vscode.SecretStorage,
		globalState as unknown as vscode.Memento,
		statusBarItem as unknown as vscode.StatusBarItem
	);
}

function modelInfo(id: string): LanguageModelChatInformation {
	return {
		id,
		name: id,
		detail: "OAIProxy",
		tooltip: "OAIProxy",
		family: "OAIProxy",
		version: "1.0.0",
		maxInputTokens: 1000,
		maxOutputTokens: 100,
		capabilities: {
			toolCalling: true,
			imageInput: false,
		},
	};
}
