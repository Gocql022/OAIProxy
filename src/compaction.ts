import * as vscode from "vscode";
import type { HFModelItem } from "./types";
import { getReasoningEfforts, normalizeReasoningEffortForModel, shouldExposeReasoningEffort } from "./reasoningEffort";
import { isLanguageModelThinkingPart } from "./vscodeCompat";
import { isPromptMetadata, isImageDataPart, isToolResultContent } from "./messageContent";
import { isResponseUsagePart } from "./responseUsage";

// Copilot 1.141.0, summarizedConversationHistory.tsx (MIT).
// These are prompt signatures, not a public upstream purpose API. Fail closed on changes.
const SUMMARY_START =
	"Your task is to create a comprehensive, detailed summary of the entire conversation that captures all essential information needed to seamlessly continue the work without any loss of context.";
const USER_START =
	"Summarize the conversation history so far, paying special attention to the most recent agent commands and tool results that triggered this summarization. Structure your summary using the enhanced format provided in the system message.";
const BACKGROUND_START = "The conversation has grown too large for the context window and must be compacted now.";
const normalized = (text: string) => text.replace(/\s+/g, " ").trim();

function hasSummaryStructure(text: string): boolean {
	return (
		text.startsWith(SUMMARY_START) &&
		[
			"This summary will be used to compact the conversation while preserving critical technical details, decisions, and progress.",
			"## Recent Context Analysis",
			"## Analysis Process",
			"## Summary Structure",
			"## Quality Guidelines",
			"8. Continuation Plan:",
			"<summary>",
			"</summary>",
		].every((part) => text.includes(part))
	);
}

export function detectCompaction(
	messages: readonly vscode.LanguageModelChatRequestMessage[],
	options: vscode.ProvideLanguageModelChatResponseOptions
): "separate" | "background" | undefined {
	if (options.requestInitiator?.toLowerCase() !== "github.copilot-chat") {
		return undefined;
	}
	const last = messages.at(-1);
	if (
		!last ||
		last.role !== vscode.LanguageModelChatMessageRole.User ||
		!last.content.every((part) => part instanceof vscode.LanguageModelTextPart)
	) {
		return undefined;
	}
	const text = (message: vscode.LanguageModelChatRequestMessage) =>
		normalized(
			message.content
				.filter((part) => part instanceof vscode.LanguageModelTextPart)
				.map((part) => part.value)
				.join("\n")
		);
	const user = text(last);
	if (
		user.startsWith(BACKGROUND_START) &&
		hasSummaryStructure(user.slice(BACKGROUND_START.length).trim()) &&
		user.includes("IMPORTANT: Output your summary wrapped in <summary> and </summary> tags. Do NOT call any tools.")
	) {
		return "background";
	}
	if (
		user.startsWith(USER_START) &&
		user.endsWith(
			"Include all important tool calls and their results as part of the appropriate sections, with special emphasis on the most recent operations."
		) &&
		messages.some((message) => (message.role as number) === 0 && hasSummaryStructure(text(message)))
	) {
		return "separate";
	}
	return undefined;
}

export function compactionModelId(model: HFModelItem): string {
	return model.configId ? `${model.id}::${model.configId}` : model.id;
}

export function compactionEfforts(model: HFModelItem | undefined): string[] {
	return model && model.apiMode !== "gemini" && model.apiMode !== "ollama" && shouldExposeReasoningEffort(model)
		? getReasoningEfforts(model)
		: [];
}

export function compactionEffort(model: HFModelItem | undefined, value: unknown): string | undefined {
	if (!model || typeof value !== "string" || !compactionEfforts(model).includes(value)) {
		return undefined;
	}
	return normalizeReasoningEffortForModel(model, value);
}

/** Strip opaque model state, including state nested in historical tool results. */
export function compactionMessages(
	messages: readonly vscode.LanguageModelChatRequestMessage[]
): vscode.LanguageModelChatRequestMessage[] {
	const clean = (parts: readonly unknown[]): unknown[] =>
		parts.flatMap((part) => {
			if (isLanguageModelThinkingPart(part) || isPromptMetadata(part)) {
				return [];
			}
			// History is evidence for a summary, not a live tool exchange. Text keeps
			// full arguments/results usable across providers without signed call state.
			if (part instanceof vscode.LanguageModelToolCallPart) {
				return [
					new vscode.LanguageModelTextPart(
						`\n[Historical tool call ${JSON.stringify(part.callId)}: ${JSON.stringify(part.name)}]\n${JSON.stringify(part.input)}\n`
					),
				];
			}
			if (isToolResultContent(part)) {
				return [
					new vscode.LanguageModelTextPart(`\n[Historical tool result ${JSON.stringify(part.callId)}]\n`),
					...clean(part.content),
					new vscode.LanguageModelTextPart("\n[End historical tool result]\n"),
				];
			}
			return [part];
		});
	return messages.map((message) => ({
		...message,
		content: clean(message.content) as vscode.LanguageModelChatRequestMessage["content"],
	}));
}

/** Reject media that the existing adapter would omit rather than summarize. */
export function validateCompactionInput(
	messages: readonly vscode.LanguageModelChatRequestMessage[],
	model: HFModelItem | undefined
): void {
	const check = (parts: readonly unknown[]) => {
		for (const part of parts) {
			if (isToolResultContent(part)) {
				check(part.content);
			} else if (part instanceof vscode.LanguageModelDataPart) {
				const mime = part.mimeType.toLowerCase().split(";")[0];
				if (isImageDataPart(part) && model?.vision === true) {
					continue;
				}
				if (mime.startsWith("text/") || mime === "application/json" || mime.endsWith("+json")) {
					continue;
				}
				throw new Error("Compaction input includes media unsupported by this model.");
			}
		}
	};
	messages.forEach((message) => check(message.content));
}

/** Enforce compaction-only fields after adapter/extra merges, on a request-local body. */
export function prepareCompactionBody(body: unknown, apiMode: string, effort?: string, nested = false): void {
	if (!body || typeof body !== "object") {
		return;
	}
	const rb = body as Record<string, unknown>;
	for (const key of [
		"previous_response_id",
		"conversation",
		"tools",
		"tool_choice",
		"toolConfig",
		"parallel_tool_calls",
	]) {
		delete rb[key];
	}
	if (effort) {
		if (nested) {
			// Provider-specific extra_body fields may override the root, but do not
			// introduce effort in a location the saved provider configuration never used.
			if (rb.reasoning_effort !== undefined) {
				rb.reasoning_effort = effort;
			}
			if (object(rb.reasoning).effort !== undefined) {
				rb.reasoning = { ...object(rb.reasoning), effort };
			}
			if (object(rb.output_config).effort !== undefined) {
				rb.output_config = { ...object(rb.output_config), effort };
			}
		} else if (apiMode === "anthropic") {
			rb.output_config = { ...object(rb.output_config), effort };
		} else if (apiMode === "openai-responses") {
			rb.reasoning = { ...object(rb.reasoning), effort };
		} else if (rb.reasoning) {
			rb.reasoning = { ...object(rb.reasoning), effort };
			if (rb.reasoning_effort !== undefined) {
				rb.reasoning_effort = effort;
			}
		} else {
			rb.reasoning_effort = effort;
		}
	}
	if (rb.extra_body && typeof rb.extra_body === "object") {
		const extra = rb.extra_body as Record<string, unknown>;
		for (const key of [
			"model",
			"messages",
			"input",
			"contents",
			"instructions",
			"system",
			"systemInstruction",
			"stream",
		]) {
			delete extra[key];
		}
		prepareCompactionBody(extra, apiMode, effort, true);
	}
}

function object(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/** No partial text escapes an unsuccessful attempt. Abort promptly on excess output/tools. */
export class CompactionBuffer implements vscode.Progress<vscode.LanguageModelResponsePart2> {
	private chunks: string[] = [];
	private pending = "";
	private bytes = 0;
	private error?: Error;
	private usage?: vscode.LanguageModelResponsePart2;
	constructor(
		private readonly abort: () => void,
		private readonly limit = 8 * 1024 * 1024
	) {}

	report(part: vscode.LanguageModelResponsePart2): void {
		if (this.error) {
			return;
		}
		if (part instanceof vscode.LanguageModelToolCallPart) {
			this.fail("Compaction returned an unexpected tool call.");
		} else if (part instanceof vscode.LanguageModelTextPart) {
			this.bytes += Buffer.byteLength(part.value, "utf8");
			if (this.bytes > this.limit) {
				this.fail("Compaction summary exceeded the 8 MiB buffer limit.");
				return;
			}
			this.pending += part.value;
			if (this.pending.length >= 8192) {
				this.chunks.push(this.pending);
				this.pending = "";
			}
		} else if (isResponseUsagePart(part)) {
			this.usage = part;
		}
	}

	assertValid(): void {
		if (this.error) {
			throw this.error;
		}
		if (!this.pending.trim() && !this.chunks.some((chunk) => chunk.trim())) {
			throw new Error("Compaction returned an empty summary.");
		}
	}

	publish(progress: vscode.Progress<vscode.LanguageModelResponsePart2>): void {
		this.assertValid();
		progress.report(new vscode.LanguageModelTextPart(this.chunks.join("") + this.pending));
		if (this.usage) {
			progress.report(this.usage);
		}
	}

	private fail(message: string): void {
		this.error = new Error(message);
		this.chunks = [];
		this.pending = "";
		this.abort();
	}
}

/** Safe diagnostics: never log upstream messages, URLs, response bodies or socket details. */
export function compactionFailure(error: unknown): Record<string, unknown> {
	const value = object(error);
	const cause = object(value.cause);
	const safe = (input: unknown) =>
		typeof input === "string" && /^[A-Za-z0-9_]{1,64}$/.test(input) ? input : undefined;
	return {
		errorName: safe(value.name),
		causeCode: safe(cause.code),
		reason:
			error instanceof Error && error.message.startsWith("Compaction ")
				? error.message
				: "Model unavailable, input rejected, or response failed",
	};
}
