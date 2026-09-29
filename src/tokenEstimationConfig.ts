import type { ContentOptions } from "./messageContent";

export interface ImageTokenConfig {
	strategy: "auto" | "fixed" | "area";
	profile: "auto" | "openai-patches" | "openai-tiles" | "claude-standard" | "claude-high" | "unknown";
	fixedTokens: number;
	fallbackTokens: number;
	areaDivisor: number;
	maxLongEdge: number;
	maxTokensPerImage: number;
}

export interface TokenEstimationConfig {
	charsPerToken: number;
	nonAsciiTokensPerChar: number;
	maxSerializedPartChars: number;
	bridgeTokens: number;
	calibration: "observe" | "adaptive";
	image: ImageTokenConfig;
}

export interface EstimationContext extends ContentOptions {
	includeReasoningInRequest: boolean;
	modelId?: string;
	settings?: TokenEstimationConfig;
	textMultiplier?: number;
	cachedDescription?: (part: import("vscode").LanguageModelDataPart) => string | undefined;
}

export const ESTIMATOR_REVISION = "2";
export const DEFAULT_TOKEN_ESTIMATION: TokenEstimationConfig = {
	charsPerToken: 4,
	nonAsciiTokensPerChar: 1,
	maxSerializedPartChars: 200000,
	bridgeTokens: 8192,
	calibration: "observe",
	image: {
		strategy: "auto",
		profile: "auto",
		fixedTokens: 8192,
		fallbackTokens: 8192,
		areaDivisor: 750,
		maxLongEdge: 2576,
		maxTokensPerImage: 8192,
	},
};

function record(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function resolveTokenEstimationConfig(value: unknown, modelId = ""): TokenEstimationConfig {
	const root = record(value);
	const perModel = record(root.perModel);
	const base = record(perModel[modelId.split("::")[0]]);
	const exact = record(perModel[modelId]);
	const merged = { ...root, ...base, ...exact };
	const image = { ...record(root.image), ...record(base.image), ...record(exact.image) };
	const positive = (v: unknown, fallback: number, min = 0.01, max = 1000000) =>
		typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : fallback;
	const defaults = DEFAULT_TOKEN_ESTIMATION;
	return {
		charsPerToken: positive(merged.charsPerToken, defaults.charsPerToken, 0.1, 100),
		nonAsciiTokensPerChar: positive(merged.nonAsciiTokensPerChar, defaults.nonAsciiTokensPerChar, 0.1, 100),
		maxSerializedPartChars: Math.floor(positive(merged.maxSerializedPartChars, defaults.maxSerializedPartChars, 64)),
		bridgeTokens: Math.ceil(positive(merged.bridgeTokens, defaults.bridgeTokens, 1)),
		calibration: merged.calibration === "adaptive" ? "adaptive" : "observe",
		image: {
			strategy: image.strategy === "fixed" || image.strategy === "area" ? image.strategy : "auto",
			profile: ["openai-patches", "openai-tiles", "claude-standard", "claude-high", "unknown"].includes(
				String(image.profile)
			)
				? (image.profile as ImageTokenConfig["profile"])
				: "auto",
			fixedTokens: Math.ceil(positive(image.fixedTokens, defaults.image.fixedTokens, 1)),
			fallbackTokens: Math.ceil(positive(image.fallbackTokens, defaults.image.fallbackTokens, 1)),
			areaDivisor: positive(image.areaDivisor, defaults.image.areaDivisor),
			maxLongEdge: positive(image.maxLongEdge, defaults.image.maxLongEdge, 1),
			maxTokensPerImage: Math.ceil(positive(image.maxTokensPerImage, defaults.image.maxTokensPerImage, 1)),
		},
	};
}
