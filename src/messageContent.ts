import * as vscode from "vscode";
import { isLanguageModelThinkingPart } from "./vscodeCompat";
import { logger } from "./logger";

export interface ContentOptions {
	apiMode?: string;
	imageMode?: "native" | "bridge" | "omit";
	maxSerializedPartChars?: number;
	imageSources?: Map<string, vscode.LanguageModelDataPart[]>;
}

export interface PartOrigin {
	messageIndex: number;
	partIndex: number;
	callId?: string;
}

const origins = new WeakMap<object, PartOrigin>();
const METADATA_MIMES = new Set(["usage", "cache_control", "application/vnd.oaiproxy.stateful-marker"]);
const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const TRUNCATED = "[serialized part truncated]";

export function setPartOrigin(part: object, origin: PartOrigin | undefined): void {
	if (origin) {
		origins.set(part, origin);
	}
}

export function getPartOrigin(part: unknown): PartOrigin | undefined {
	return part !== null && typeof part === "object" ? origins.get(part) : undefined;
}

export function isToolResultContent(value: unknown): value is { callId: string; content: readonly unknown[] } {
	return (
		!!value &&
		typeof value === "object" &&
		typeof (value as { callId?: unknown }).callId === "string" &&
		Array.isArray((value as { content?: unknown }).content)
	);
}

export function isImageDataPart(value: unknown): value is vscode.LanguageModelDataPart {
	return value instanceof vscode.LanguageModelDataPart && IMAGE_MIMES.has(value.mimeType.toLowerCase().split(";")[0]);
}

export function isPromptMetadata(part: unknown): boolean {
	return part instanceof vscode.LanguageModelDataPart && METADATA_MIMES.has(part.mimeType);
}

export function encodeImageData(part: vscode.LanguageModelDataPart, options: ContentOptions = {}): string {
	const encoded = Buffer.from(part.data).toString("base64");
	if (options.imageSources) {
		const sources = options.imageSources.get(encoded) ?? [];
		sources.push(part);
		options.imageSources.set(encoded, sources);
	}
	return encoded;
}

export function binaryPlaceholder(part: vscode.LanguageModelDataPart): string {
	const mime = part.mimeType.replace(/[^a-zA-Z0-9/+.-]/g, "").slice(0, 80);
	return `[${mime.startsWith("image/") ? "image" : "binary"} omitted: ${mime}, ${part.data.byteLength} bytes]`;
}

/** Serialize data without invoking toJSON/getters or enumerating binary bytes. */
export function serializeUnknownContent(value: unknown, limit = 200000): string {
	const max = Number.isFinite(limit) ? Math.max(64, Math.floor(limit)) : 200000;
	const chunks: string[] = [];
	const ancestors = new Set<object>();
	let remaining = max - TRUNCATED.length;
	let nodes = 0;
	let truncated = false;
	const append = (text: string) => {
		if (text.length > remaining) {
			chunks.push(text.slice(0, remaining));
			remaining = 0;
			truncated = true;
		} else {
			chunks.push(text);
			remaining -= text.length;
		}
	};
	const write = (item: unknown, depth: number): void => {
		if (remaining <= 0 || ++nodes > 10000 || depth > 32) {
			truncated = true;
			return;
		}
		if (item instanceof ArrayBuffer || ArrayBuffer.isView(item)) {
			append(JSON.stringify(`[binary ${item.byteLength} bytes]`));
		} else if (item === null || typeof item === "boolean" || typeof item === "number") {
			append(JSON.stringify(item));
		} else if (typeof item === "string") {
			// Bound the temporary escaped string as well as the output.
			const inputLimit = remaining;
			append(JSON.stringify(item.slice(0, inputLimit)));
			if (item.length > inputLimit) {
				truncated = true;
			}
		} else if (typeof item !== "object") {
			append(JSON.stringify(`[${typeof item}]`));
		} else if (ancestors.has(item)) {
			append('"[circular]"');
		} else {
			const type = Object.getOwnPropertyDescriptor(item, "type")?.value;
			const data = Object.getOwnPropertyDescriptor(item, "data")?.value;
			if (type === "Buffer" && Array.isArray(data)) {
				append(JSON.stringify(`[binary ${data.length} bytes]`));
				return;
			}
			ancestors.add(item);
			const array = Array.isArray(item);
			append(array ? "[" : "{");
			let first = true;
			for (const key in item) {
				if (!Object.prototype.hasOwnProperty.call(item, key)) {
					continue;
				}
				if (remaining <= 0 || nodes >= 10000) {
					truncated = true;
					break;
				}
				if (!first) {
					append(",");
				}
				first = false;
				if (!array) {
					append(JSON.stringify(key.slice(0, remaining)) + ":");
				}
				const descriptor = Object.getOwnPropertyDescriptor(item, key);
				write(descriptor && "value" in descriptor ? descriptor.value : "[accessor omitted]", depth + 1);
			}
			append(array ? "]" : "}");
			ancestors.delete(item);
		}
	};
	try {
		write(value, 0);
	} catch {
		append('"[unserializable object]"');
	}
	if (truncated) {
		logger.warn("content.truncated", { maxSerializedPartChars: max });
	}
	return chunks.join("") + (truncated ? TRUNCATED : "");
}

/** Normalize content once, preserving binary images instead of turning bytes into text. */
export function normalizeContent(content: readonly unknown[], options: ContentOptions = {}, nested = false): unknown[] {
	const out: unknown[] = [];
	for (const part of content) {
		if (
			part instanceof vscode.LanguageModelTextPart ||
			part instanceof vscode.LanguageModelToolCallPart ||
			isLanguageModelThinkingPart(part)
		) {
			out.push(part);
		} else if (typeof part === "string") {
			out.push(new vscode.LanguageModelTextPart(part));
		} else if (!nested && isToolResultContent(part)) {
			out.push({ ...part, content: normalizeContent(part.content, options, true) });
		} else if (part instanceof vscode.LanguageModelDataPart) {
			const mime = part.mimeType.toLowerCase().split(";")[0].trim();
			if (isPromptMetadata(part)) {
				if (!nested) {
					out.push(part);
				}
			} else if (mime.startsWith("text/") || mime === "application/json" || mime.endsWith("+json")) {
				out.push(new vscode.LanguageModelTextPart(new TextDecoder().decode(part.data)));
			} else if (isImageDataPart(part) && options.imageMode !== "omit") {
				out.push(new vscode.LanguageModelDataPart(part.data, mime));
			} else if (
				!nested &&
				mime.startsWith("video/") &&
				["openai", "anthropic", "litellm", "azure-foundry"].includes(options.apiMode ?? "openai")
			) {
				out.push(part);
			} else {
				out.push(new vscode.LanguageModelTextPart(binaryPlaceholder(part)));
			}
		} else {
			out.push(new vscode.LanguageModelTextPart(serializeUnknownContent(part, options.maxSerializedPartChars)));
		}
	}
	return out;
}

export function toolResultText(content: readonly unknown[], options: ContentOptions = {}): string {
	return normalizeContent(content, { ...options, imageMode: "omit" }, true)
		.filter((part): part is vscode.LanguageModelTextPart => part instanceof vscode.LanguageModelTextPart)
		.map((part) => part.value)
		.join("");
}

/** Put companion images after the entire consecutive tool-result batch. */
export function prepareMessagesForApi(
	messages: readonly vscode.LanguageModelChatRequestMessage[],
	options: ContentOptions = {}
): vscode.LanguageModelChatRequestMessage[] {
	const out: vscode.LanguageModelChatRequestMessage[] = [];
	let pending: unknown[] = [];
	const flush = () => {
		if (pending.length) {
			out.push({
				role: vscode.LanguageModelChatMessageRole.User,
				name: undefined,
				content: pending,
			} as vscode.LanguageModelChatRequestMessage);
			pending = [];
		}
	};
	for (const [messageIndex, message] of messages.entries()) {
		const content: unknown[] = [];
		for (const [partIndex, part] of (message.content ?? []).entries()) {
			const origin = getPartOrigin(part) ?? {
				messageIndex,
				partIndex,
				...(isToolResultContent(part) ? { callId: part.callId } : {}),
			};
			for (const normalized of normalizeContent([part], options)) {
				if (normalized && typeof normalized === "object") {
					origins.set(normalized, origin);
				}
				content.push(normalized);
			}
		}
		const results = content.filter(isToolResultContent);
		if (results.length === 0) {
			flush();
			out.push({ ...message, content } as vscode.LanguageModelChatRequestMessage);
			continue;
		}
		for (const result of results) {
			for (const [partIndex, part] of result.content.entries()) {
				if (part && typeof part === "object") {
					origins.set(part, { ...getPartOrigin(result)!, partIndex });
				}
			}
		}
		if (options.apiMode === "anthropic") {
			out.push({
				...message,
				content: [...results, ...content.filter((part) => !isToolResultContent(part))],
			} as vscode.LanguageModelChatRequestMessage);
			continue;
		}
		for (const result of results) {
			const retained: unknown[] = [];
			for (const part of result.content) {
				if (isImageDataPart(part)) {
					const label = new vscode.LanguageModelTextPart(`[Image from tool ${result.callId.slice(0, 128)}]\n`);
					const origin = getPartOrigin(result)!;
					origins.set(label, origin);
					origins.set(part, origin);
					pending.push(label, part);
				} else {
					retained.push(part);
				}
			}
			result.content = retained;
		}
		out.push({ ...message, content: results } as vscode.LanguageModelChatRequestMessage);
		pending.push(...content.filter((part) => !isToolResultContent(part)));
	}
	flush();
	return out;
}
