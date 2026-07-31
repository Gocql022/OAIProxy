import * as vscode from "vscode";
import * as crypto from "crypto";
import type { HFModelItem } from "./types";
import { isImageMimeType, normalizeUserModels } from "./utils";
import { isBridgeableImageData } from "./tokenizer/imageUtils";
import { logger } from "./logger";

const CACHE_MAX_ENTRIES = 50;
const CACHE_MAX_SIZE_BYTES = 512_000; // ~500KB of description text

export const DEFAULT_VISION_PROMPT =
	"Describe this image. Include visible text, code, UI, diagrams, and other important details.";
export const VISION_BRIDGE_REQUEST_OPTION = "oaiproxyVisionBridge";

const LANGUAGE_MODEL_VENDOR = "oaiproxy";

/**
 * Resolve the vision bridge prompt. Uses the user-configured
 * `oaicopilot.visionBridgePrompt` when set, otherwise the default prompt.
 */
export function getVisionPrompt(): string {
	const config = vscode.workspace.getConfiguration();
	const custom = (config.get<string>("oaicopilot.visionBridgePrompt", "") ?? "").trim();
	return custom || DEFAULT_VISION_PROMPT;
}

/**
 * Resolve the explicitly configured vision bridge model id
 * (`oaicopilot.visionBridgeModel`), trimmed. Empty means automatic selection.
 */
export function getConfiguredVisionBridgeModel(): string {
	const config = vscode.workspace.getConfiguration();
	return (config.get<string>("oaicopilot.visionBridgeModel", "") ?? "").trim();
}

// ---------------------------------------------------------------------------
// In-memory LRU cache for image descriptions
// ---------------------------------------------------------------------------

class ImageDescriptionCache {
	private cache = new Map<string, string>();
	private currentSizeBytes = 0;

	get(key: string): string | undefined {
		const value = this.cache.get(key);
		if (value !== undefined) {
			this.cache.delete(key);
			this.cache.set(key, value);
		}
		return value;
	}

	set(key: string, value: string): void {
		const entrySize = (key.length + value.length) * 2;

		const existing = this.cache.get(key);
		if (existing !== undefined) {
			this.currentSizeBytes -= (key.length + existing.length) * 2;
			this.cache.delete(key);
		}

		while (
			(this.cache.size >= CACHE_MAX_ENTRIES || this.currentSizeBytes + entrySize > CACHE_MAX_SIZE_BYTES) &&
			this.cache.size > 0
		) {
			const firstKey = this.cache.keys().next().value;
			if (firstKey === undefined) {
				break;
			}
			const firstValue = this.cache.get(firstKey)!;
			this.currentSizeBytes -= (firstKey.length + firstValue.length) * 2;
			this.cache.delete(firstKey);
		}

		this.cache.set(key, value);
		this.currentSizeBytes += entrySize;
	}
}

const descriptionCache = new ImageDescriptionCache();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hashImageData(data: Uint8Array): string {
	return crypto.createHash("sha256").update(data).digest("hex");
}

function createVisionBridgeMessages(
	imagePart: vscode.LanguageModelDataPart,
	prompt: string
): vscode.LanguageModelChatMessage[] {
	// Keep the bridge request intentionally minimal: fixed instruction plus image only.
	const ChatMessageCtor: typeof vscode.LanguageModelChatMessage =
		(vscode as Record<string, unknown>).LanguageModelChatMessage2 as typeof vscode.LanguageModelChatMessage ??
		vscode.LanguageModelChatMessage;

	return [
		ChatMessageCtor.User([new vscode.LanguageModelTextPart(prompt), imagePart] as never),
	] as vscode.LanguageModelChatMessage[];
}

/**
 * Minimum image dimension (px) for the vision bridge. Host-injected
 * placeholder images are typically tiny (e.g. 7x27), and some providers
 * reject images smaller than 14px, so anything below this is treated as
 * an invalid image and dropped instead of being described.
 */
const MIN_IMAGE_DIMENSION = 14;

/**
 * Check whether a data part is a usable image for the vision bridge.
 * Tiny or unparseable images (e.g. placeholders injected by the host) are
 * ignored so text-only requests are not routed through the vision model
 * for them.
 */
function isBridgeImage(part: vscode.LanguageModelDataPart): boolean {
	return (
		part instanceof vscode.LanguageModelDataPart &&
		isBridgeableImageData(part.data, part.mimeType, MIN_IMAGE_DIMENSION)
	);
}

/**
 * Check whether any message in the array contains an image data part.
 * This includes invalid (tiny/unparseable) images because they still need
 * to be stripped before the request reaches a text-only model.
 */
export function messagesContainImages(messages: readonly vscode.LanguageModelChatRequestMessage[]): boolean {
	for (const m of messages) {
		for (const part of m.content ?? []) {
			if (part instanceof vscode.LanguageModelDataPart && isImageMimeType(part.mimeType)) {
				return true;
			}
		}
	}
	return false;
}

// ---------------------------------------------------------------------------
// Vision model discovery
// ---------------------------------------------------------------------------

function fullModelId(m: HFModelItem): string {
	return m.configId ? `${m.id}::${m.configId}` : m.id;
}

/**
 * Check whether a vision bridge is available: either a bridge model was
 * explicitly configured, or any user-configured model has `vision: true`
 * (excluding a given model by its full ID — `baseId` or `baseId::configId`).
 * Used by provideModel to decide whether to advertise imageInput for
 * bridge-eligible models.
 */
export function hasVisionModelAvailable(userModels: HFModelItem[], excludeFullId: string): boolean {
	const configuredKey = getConfiguredVisionBridgeModel();
	if (configuredKey && configuredKey !== excludeFullId) {
		return true;
	}
	return userModels.some((m) => m.vision === true && fullModelId(m) !== excludeFullId);
}

async function findVisionModel(excludeFullId: string): Promise<vscode.LanguageModelChat> {
	const config = vscode.workspace.getConfiguration();
	const userModels = normalizeUserModels(config.get<unknown>("oaicopilot.models", []));

	const configuredKey = getConfiguredVisionBridgeModel();

	// Explicitly configured bridge model takes priority. It may be any model
	// registered in VS Code (not necessarily from the oaiproxy vendor), so
	// users can also type a model id provided by another extension.
	if (configuredKey) {
		const allModels = await vscode.lm.selectChatModels();
		const configuredBase = configuredKey.split("::")[0];
		const hasConfigId = configuredKey.includes("::");
		let chatModel = allModels.find((m) => m.id === configuredKey);
		if (!chatModel && !hasConfigId) {
			chatModel = allModels.find((m) => m.id === configuredBase);
		}
		if (!chatModel) {
			throw new Error(
				`Vision bridge model "${configuredKey}" configured but not available. ` +
					"Check oaicopilot.visionBridgeModel or pick a model registered in VS Code."
			);
		}
		if (chatModel.id === excludeFullId) {
			throw new Error(
				`Vision bridge model "${configuredKey}" is the same as the target model. ` +
					"Choose a different model in oaicopilot.visionBridgeModel."
			);
		}
		return chatModel;
	}

	// Exclude by full ID so multi-config setups (foo::text, foo::vision) work.
	const visionModelConfigs = userModels.filter(
		(m) => m.vision === true && fullModelId(m) !== excludeFullId
	);

	if (visionModelConfigs.length === 0) {
		throw new Error(
			"No vision-capable model configured. " +
				'Add a model with "vision": true to oaicopilot.models to use images with text-only models.'
		);
	}

	const availableModels = await vscode.lm.selectChatModels({ vendor: LANGUAGE_MODEL_VENDOR });

	for (const vmc of visionModelConfigs) {
		const vmcFullId = fullModelId(vmc);
		// Prefer exact full-ID match; only fall back to base-ID when the
		// candidate has no configId (avoids picking the wrong config variant).
		const chatModel = availableModels.find(
			(m) => m.id === vmcFullId || (!vmc.configId && m.id === vmc.id)
		);
		if (chatModel) {
			return chatModel;
		}
	}

	throw new Error(
		"Vision model configured but not available. " +
			'Ensure a model with "vision": true is properly registered.'
	);
}

// ---------------------------------------------------------------------------
// Single-image description (with cache)
// ---------------------------------------------------------------------------

async function describeImage(
	imagePart: vscode.LanguageModelDataPart,
	visionModel: vscode.LanguageModelChat,
	token: vscode.CancellationToken
): Promise<string> {
	const cacheKey = hashImageData(imagePart.data);

	const cached = descriptionCache.get(cacheKey);
	if (cached !== undefined) {
		logger.debug("visionBridge.cache.hit", {
			cacheKey: cacheKey.substring(0, 16),
			mimeType: imagePart.mimeType,
			dataSize: imagePart.data.byteLength,
			descriptionLength: cached.length,
			visionModel: visionModel.id,
		});
		return cached;
	}

	logger.info("visionBridge.describe", {
		mimeType: imagePart.mimeType,
		dataSize: imagePart.data.byteLength,
		visionModel: visionModel.id,
		promptLength: getVisionPrompt().length,
	});
	logger.debug("visionBridge.cache.miss", {
		cacheKey: cacheKey.substring(0, 16),
		mimeType: imagePart.mimeType,
		dataSize: imagePart.data.byteLength,
		visionModel: visionModel.id,
		promptLength: getVisionPrompt().length,
	});

	const prompt = getVisionPrompt();
	const messages = createVisionBridgeMessages(imagePart, prompt);
	logger.debug("visionBridge.request", {
		visionModel: visionModel.id,
		messageCount: messages.length,
		contentParts: 2,
		promptLength: prompt.length,
		mimeType: imagePart.mimeType,
		dataSize: imagePart.data.byteLength,
	});

	const response = await visionModel.sendRequest(
		messages,
		{ modelOptions: { [VISION_BRIDGE_REQUEST_OPTION]: true } },
		token
	);
	let description = "";
	for await (const chunk of response.text) {
		if (token.isCancellationRequested) {
			throw new Error("Vision bridge request cancelled");
		}
		description += chunk;
	}

	description = description.trim();
	if (!description) {
		throw new Error("Vision model returned empty description");
	}

	descriptionCache.set(cacheKey, description);
	logger.debug("visionBridge.cache.store", {
		cacheKey: cacheKey.substring(0, 16),
		descriptionLength: description.length,
	});

	return description;
}

// ---------------------------------------------------------------------------
// Public API — rewrite messages that contain images
// ---------------------------------------------------------------------------

/**
 * Scan messages for image parts and replace them with text descriptions
 * obtained from a vision-capable model. Non-image parts are kept as-is.
 * Invalid (tiny/unparseable) image parts are dropped so a text-only request
 * never fails because of a host-injected placeholder image.
 */
export async function processMessagesForVision(
	messages: readonly vscode.LanguageModelChatRequestMessage[],
	targetModelId: string,
	token: vscode.CancellationToken
): Promise<vscode.LanguageModelChatRequestMessage[]> {
	let hasValidImage = false;
	let invalidImageCount = 0;
	for (const message of messages) {
		for (const part of message.content ?? []) {
			if (part instanceof vscode.LanguageModelDataPart && isImageMimeType(part.mimeType)) {
				if (isBridgeImage(part)) {
					hasValidImage = true;
				} else {
					invalidImageCount++;
				}
			}
		}
	}

	// Only invalid (tiny or unparseable) images, e.g. placeholders injected
	// by the host. Drop them so the text-only request stays clean, without
	// needing a vision model at all.
	if (!hasValidImage && invalidImageCount > 0) {
		logger.info("visionBridge.dropInvalidImages", { droppedImages: invalidImageCount });
		return removeImageParts(messages);
	}

	const visionModel = await findVisionModel(targetModelId);

	logger.info("visionBridge.processing", {
		targetModel: targetModelId,
		visionModel: visionModel.id,
		messageCount: messages.length,
	});

	let convertedCount = 0;
	const result: vscode.LanguageModelChatRequestMessage[] = [];

	for (const message of messages) {
		const content = message.content ?? [];
		let hasValidImages = false;

		for (const part of content) {
			if (part instanceof vscode.LanguageModelDataPart && isBridgeImage(part)) {
				hasValidImages = true;
				break;
			}
		}

		if (!hasValidImages) {
			// No bridgeable images in this message. If it still carries
			// invalid image parts, strip them; otherwise keep it as-is.
			result.push(hasImageParts(content) ? removeImageParts([message])[0] : message);
			continue;
		}

		const newContent: unknown[] = [];

		for (const part of content) {
			if (part instanceof vscode.LanguageModelDataPart && isBridgeImage(part)) {
				const description = await describeImage(part, visionModel, token);
				newContent.push(new vscode.LanguageModelTextPart(`\n[Image description: ${description}]\n`));
				convertedCount++;
			} else if (part instanceof vscode.LanguageModelDataPart && isImageMimeType(part.mimeType)) {
				// Invalid/too-small image — drop it for text-only targets.
				logger.debug("visionBridge.dropInvalidImage", {
					mimeType: part.mimeType,
					dataSize: part.data.byteLength,
				});
			} else {
				newContent.push(part);
			}
		}

		// Build a replacement message preserving role and name.
		const replaced = {
			role: message.role,
			content: newContent,
			name: (message as { name?: string }).name,
		} as vscode.LanguageModelChatRequestMessage;
		result.push(replaced);
	}

	logger.info("visionBridge.complete", { convertedImages: convertedCount });
	return result;
}

function hasImageParts(content: readonly unknown[]): boolean {
	return content.some((p) => p instanceof vscode.LanguageModelDataPart && isImageMimeType(p.mimeType));
}

function removeImageParts(
	messages: readonly vscode.LanguageModelChatRequestMessage[]
): vscode.LanguageModelChatRequestMessage[] {
	const result: vscode.LanguageModelChatRequestMessage[] = [];
	for (const message of messages) {
		const content = message.content ?? [];
		if (!hasImageParts(content)) {
			result.push(message);
			continue;
		}
		const newContent = content.filter(
			(p) => !(p instanceof vscode.LanguageModelDataPart && isImageMimeType(p.mimeType))
		);
		result.push({
			role: message.role,
			content: newContent,
			name: (message as { name?: string }).name,
		} as vscode.LanguageModelChatRequestMessage);
	}
	return result;
}
