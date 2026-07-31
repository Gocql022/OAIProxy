import * as vscode from "vscode";
import { LanguageModelChatInformation, LanguageModelChatRequestMessage, LanguageModelChatTool } from "vscode";
import { type CacheUsageRecord, getLatestCacheUsage } from "./cacheUsage";
import { countMessageTokenDetails, countToolTokens, type MessageTokenDetails } from "./provideToken";
import { isToolResultPart, mapRole } from "./utils";

export type TokenUsageCategoryId =
	| "systemContext"
	| "currentPrompt"
	| "conversationHistory"
	| "toolDefinitions"
	| "toolTraffic"
	| "media"
	| "reasoning";

export type TokenUsageStatus = "ok" | "warning" | "error";

export interface TokenUsageCategory {
	id: TokenUsageCategoryId;
	label: string;
	tokens: number;
}

export interface TokenUsageReport {
	modelId: string;
	modelName: string;
	messageCount: number;
	toolCount: number;
	messageTokens: number;
	toolDefinitionTokens: number;
	inputTokens: number;
	maxInputTokens: number;
	maxOutputTokens: number;
	maxContextTokens: number;
	inputUsagePercent: number;
	contextUsagePercent: number;
	currentUserMessageIndex: number;
	categories: TokenUsageCategory[];
	status: TokenUsageStatus;
	generatedAt: string;
	note: string;
}

export interface TokenUsageReportRequest {
	messages: readonly LanguageModelChatRequestMessage[];
	tools: readonly LanguageModelChatTool[] | undefined;
	model: LanguageModelChatInformation;
	modelConfig: { includeReasoningInRequest: boolean };
}

export interface TokenUsageEstimator {
	countMessageDetails(
		message: LanguageModelChatRequestMessage,
		modelConfig: { includeReasoningInRequest: boolean }
	): Promise<MessageTokenDetails>;
	countToolDefinitions(tools: readonly LanguageModelChatTool[]): Promise<number>;
}

const DEFAULT_NOTE = vscode.l10n.t(
	"Best-effort estimate. VS Code exposes the assembled request, so project context is grouped with system/context messages when it is not separately labeled."
);

const CORE_CATEGORY_IDS = new Set<TokenUsageCategoryId>([
	"systemContext",
	"currentPrompt",
	"conversationHistory",
	"toolDefinitions",
	"toolTraffic",
]);

const defaultEstimator: TokenUsageEstimator = {
	countMessageDetails: countMessageTokenDetails,
	countToolDefinitions: countToolTokens,
};

export async function createTokenUsageReport(
	request: TokenUsageReportRequest,
	estimator: TokenUsageEstimator = defaultEstimator
): Promise<TokenUsageReport> {
	const categories = createTokenUsageCategories();
	const currentUserMessageIndex = findCurrentUserPromptIndex(request.messages);
	let messageTokens = 0;

	for (let index = 0; index < request.messages.length; index++) {
		const message = request.messages[index];
		const details = await estimator.countMessageDetails(message, request.modelConfig);
		messageTokens += details.totalTokens;
		addMessageDetailsToCategories(categories, message, index, currentUserMessageIndex, details);
	}

	const toolCount = request.tools?.length ?? 0;
	const toolDefinitionTokens = toolCount > 0 ? await estimator.countToolDefinitions(request.tools ?? []) : 0;
	addCategoryTokens(categories, "toolDefinitions", toolDefinitionTokens);

	const inputTokens = messageTokens + toolDefinitionTokens;
	const maxInputTokens = Math.max(0, request.model.maxInputTokens);
	const maxOutputTokens = Math.max(0, request.model.maxOutputTokens);
	const maxContextTokens = maxInputTokens + maxOutputTokens;
	const inputUsagePercent = calculatePercentage(inputTokens, maxInputTokens);
	const contextUsagePercent = calculatePercentage(inputTokens, maxContextTokens);

	return {
		modelId: request.model.id,
		modelName: request.model.name,
		messageCount: request.messages.length,
		toolCount,
		messageTokens,
		toolDefinitionTokens,
		inputTokens,
		maxInputTokens,
		maxOutputTokens,
		maxContextTokens,
		inputUsagePercent,
		contextUsagePercent,
		currentUserMessageIndex,
		categories,
		status: getTokenUsageStatus(inputUsagePercent),
		generatedAt: new Date().toISOString(),
		note: DEFAULT_NOTE,
	};
}

/**
 * Format number to thousands (K, M, B) format.
 * @param value The number to format.
 * @returns Formatted string (e.g., "2.3K", "168.0K").
 */
export function formatTokenCount(value: number): string {
	if (value >= 1_000_000_000) {
		return (value / 1_000_000_000).toFixed(1) + "B";
	} else if (value >= 1_000_000) {
		return (value / 1_000_000).toFixed(1) + "M";
	} else if (value >= 1_000) {
		return (value / 1_000).toFixed(1) + "K";
	}
	return value.toLocaleString();
}

/**
 * Format token usage as a compact percentage for status bar display.
 * @param usedTokens Tokens used.
 * @param maxTokens Maximum tokens available.
 * @returns Percentage string (e.g., "75.2%").
 */
export function createProgressBar(usedTokens: number, maxTokens: number): string {
	if (maxTokens <= 0) {
		return "0.0%";
	}

	const usagePercentage = Math.max(0, (usedTokens / maxTokens) * 100);
	return `${usagePercentage.toFixed(1)}%`;
}

export function formatTokenPercentage(value: number, maxTokens: number): string {
	if (maxTokens <= 0) {
		return "0.0%";
	}
	return `${calculatePercentage(value, maxTokens).toFixed(1)}%`;
}

export function formatTokenUsageTooltip(report: TokenUsageReport): vscode.MarkdownString {
	const cacheUsage = getLatestCacheUsage(report.modelId) ?? getLatestCacheUsage();
	const warning = getWarningText(report);
	const markdown = new vscode.MarkdownString(undefined, true);
	markdown.supportThemeIcons = true;
	markdown.appendMarkdown(`$(server-process) **OAIProxy**\n\n`);
	markdown.appendMarkdown(
		vscode.l10n.t(
			"**{0}** of context used",
			formatTokenPercentage(report.inputTokens, report.maxContextTokens)
		) + "\n\n"
	);
	markdown.appendMarkdown(
		vscode.l10n.t(
			"{0} / {1} context · {2} output reserve",
			formatTokenCount(report.inputTokens),
			formatTokenCount(report.maxContextTokens),
			formatTokenCount(report.maxOutputTokens)
		) + "\n\n"
	);
	markdown.appendMarkdown("---\n\n");
	markdown.appendMarkdown(
		vscode.l10n.t(
			"$(graph-line) **Input budget** {0} · {1} / {2}",
			formatTokenPercentage(report.inputTokens, report.maxInputTokens),
			formatTokenCount(report.inputTokens),
			formatTokenCount(report.maxInputTokens)
		) + "\n\n"
	);
	markdown.appendMarkdown(`${formatCacheUsageSummary(cacheUsage, report)}\n\n`);
	markdown.appendMarkdown("---\n\n");
	markdown.appendMarkdown(vscode.l10n.t("$(list-tree) **Breakdown**") + "\n\n");
	for (const line of formatTooltipBreakdownLines(report)) {
		markdown.appendMarkdown(`${line}\n\n`);
	}

	if (warning) {
		markdown.appendMarkdown(`\n$(warning) ${warning}\n`);
	}

	markdown.appendMarkdown(vscode.l10n.t("$(gear) Click to open OAIProxy Configuration"));
	return markdown;
}

export function formatTokenUsageDetails(report: TokenUsageReport): string {
	const lines = [
		vscode.l10n.t("OAIProxy Token Usage"),
		vscode.l10n.t("Model: {0} ({1})", report.modelName, report.modelId),
		vscode.l10n.t("Generated: {0}", report.generatedAt),
		"",
		vscode.l10n.t(
			"Input Tokens: {0} / {1} ({2})",
			formatTokenCount(report.inputTokens),
			formatTokenCount(report.maxInputTokens),
			formatTokenPercentage(report.inputTokens, report.maxInputTokens)
		),
		vscode.l10n.t(
			"Context Window: {0} / {1} ({2})",
			formatTokenCount(report.inputTokens),
			formatTokenCount(report.maxContextTokens),
			formatTokenPercentage(report.inputTokens, report.maxContextTokens)
		),
		vscode.l10n.t("Output Reserve: {0}", formatTokenCount(report.maxOutputTokens)),
		vscode.l10n.t("Messages: {0}", report.messageCount),
		vscode.l10n.t("Tools: {0}", report.toolCount),
		"",
		...formatCacheUsageLines(report),
		"",
		vscode.l10n.t("Breakdown:"),
		...getVisibleCategories(report).map((category) => formatCategoryLine(category, report.maxInputTokens)),
	];

	const warning = getWarningText(report);
	if (warning) {
		lines.push("", warning);
	}

	lines.push("", vscode.l10n.t("Notes:"), `- ${report.note}`);
	return lines.join("\n");
}

export function formatTokenUsageSummary(report: TokenUsageReport): string {
	return vscode.l10n.t(
		"OAIProxy token usage: {0} input ({1}% input budget, {2}% context).",
		formatTokenCount(report.inputTokens),
		report.inputUsagePercent.toFixed(1),
		report.contextUsagePercent.toFixed(1)
	);
}

export function getTokenBudgetErrorMessage(report: TokenUsageReport): string | undefined {
	if (report.maxInputTokens <= 0 || report.inputTokens <= report.maxInputTokens) {
		return undefined;
	}

	const overBy = report.inputTokens - report.maxInputTokens;
	const largestCategories = getVisibleCategories(report)
		.filter((category) => category.tokens > 0)
		.sort((a, b) => b.tokens - a.tokens)
		.slice(0, 4)
		.map((category) => `${category.label}: ${formatTokenCount(category.tokens)}`)
		.join("; ");
	const categorySuffix = largestCategories ? ` Largest categories: ${largestCategories}.` : "";

	return [
		vscode.l10n.t(
			"OAIProxy blocked this request before contacting the provider because Copilot assembled {0} input tokens for {1}, which is {2} over the advertised input budget of {3}.",
			formatTokenCount(report.inputTokens),
			report.modelName,
			formatTokenCount(overBy),
			formatTokenCount(report.maxInputTokens)
		),
		vscode.l10n.t("Output reserve is {0} tokens.", formatTokenCount(report.maxOutputTokens)),
		vscode.l10n.t(
			"Run /compact in this Copilot chat, start a new chat, or remove large attached files/tool output/terminal output before retrying."
		),
		categorySuffix,
	].join(" ");
}

function createTokenUsageCategories(): TokenUsageCategory[] {
	return [
		{ id: "systemContext", label: vscode.l10n.t("System / Project Context"), tokens: 0 },
		{ id: "currentPrompt", label: vscode.l10n.t("Current User Prompt"), tokens: 0 },
		{ id: "conversationHistory", label: vscode.l10n.t("Conversation History"), tokens: 0 },
		{ id: "toolDefinitions", label: vscode.l10n.t("Tool Definitions"), tokens: 0 },
		{ id: "toolTraffic", label: vscode.l10n.t("Tool Calls / Results"), tokens: 0 },
		{ id: "media", label: vscode.l10n.t("Images / Binary"), tokens: 0 },
		{ id: "reasoning", label: vscode.l10n.t("Reasoning History"), tokens: 0 },
	];
}

function addMessageDetailsToCategories(
	categories: TokenUsageCategory[],
	message: LanguageModelChatRequestMessage,
	messageIndex: number,
	currentUserMessageIndex: number,
	details: MessageTokenDetails
): void {
	const role = mapRole(message);
	const toolTrafficTokens = details.toolCallTokens + details.toolResultTokens;
	const mediaTokens = details.imageTokens + details.binaryTokens;
	const envelopeTokens = details.overheadTokens + details.textTokens;

	addCategoryTokens(categories, "toolTraffic", toolTrafficTokens);
	addCategoryTokens(categories, "media", mediaTokens);
	addCategoryTokens(categories, "reasoning", details.reasoningTokens);

	if (envelopeTokens <= 0) {
		return;
	}

	if (role === "system") {
		addCategoryTokens(categories, "systemContext", envelopeTokens);
	} else if (role === "user" && messageIndex === currentUserMessageIndex) {
		addCategoryTokens(categories, "currentPrompt", envelopeTokens);
	} else if (toolTrafficTokens > 0 && details.textTokens === 0) {
		addCategoryTokens(categories, "toolTraffic", envelopeTokens);
	} else {
		addCategoryTokens(categories, "conversationHistory", envelopeTokens);
	}
}

function addCategoryTokens(categories: TokenUsageCategory[], id: TokenUsageCategoryId, tokens: number): void {
	const category = categories.find((entry) => entry.id === id);
	if (!category) {
		return;
	}
	category.tokens += tokens;
}

function findCurrentUserPromptIndex(messages: readonly LanguageModelChatRequestMessage[]): number {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (mapRole(message) === "user" && hasDirectPromptContent(message)) {
			return index;
		}
	}

	for (let index = messages.length - 1; index >= 0; index--) {
		if (mapRole(messages[index]) === "user") {
			return index;
		}
	}

	return -1;
}

function hasDirectPromptContent(message: LanguageModelChatRequestMessage): boolean {
	for (const part of message.content ?? []) {
		if (part instanceof vscode.LanguageModelTextPart && part.value.trim()) {
			return true;
		}
		if (part instanceof vscode.LanguageModelDataPart && part.mimeType !== "cache_control") {
			return true;
		}
		if (isToolResultPart(part)) {
			continue;
		}
	}
	return false;
}

function getVisibleCategories(report: TokenUsageReport): TokenUsageCategory[] {
	return report.categories.filter((category) => CORE_CATEGORY_IDS.has(category.id) || category.tokens > 0);
}

function formatCategoryLine(category: TokenUsageCategory, maxInputTokens: number): string {
	return `  - ${category.label}: ${formatTokenCount(category.tokens)} (${formatTokenPercentage(category.tokens, maxInputTokens)})`;
}

function formatTooltipCategoryLabel(category: TokenUsageCategory): string {
	switch (category.id) {
		case "systemContext":
			return vscode.l10n.t("$(project) System / Project Context");
		case "currentPrompt":
			return vscode.l10n.t("$(account) User Prompt");
		case "conversationHistory":
			return vscode.l10n.t("$(comment-discussion) Conversation");
		case "toolDefinitions":
			return vscode.l10n.t("$(code) Tool Definitions");
		case "toolTraffic":
			return vscode.l10n.t("$(tools) Tool Calls / Results");
		case "media":
			return vscode.l10n.t("$(file-media) Images / Binary");
		case "reasoning":
			return vscode.l10n.t("$(sparkle) Reasoning");
	}
}

function formatTooltipBreakdownLines(report: TokenUsageReport): string[] {
	const visibleCategories = getVisibleCategories(report);
	if (visibleCategories.length === 0) {
		return [vscode.l10n.t("$(circle-slash) No request tokens counted yet")];
	}

	const lines: string[] = [];

	for (let index = 0; index < visibleCategories.length; index += 2) {
		const first = visibleCategories[index];
		const second = visibleCategories[index + 1];
		const formatted = [first, second]
			.filter((category): category is TokenUsageCategory => Boolean(category))
			.map((category) => `${formatTooltipCategoryLabel(category)} **${formatTokenCount(category.tokens)}**`)
			.join(" · ");
		lines.push(formatted);
	}

	return lines;
}

function formatCacheUsageLines(report: TokenUsageReport): string[] {
	const cacheUsage = getLatestCacheUsage(report.modelId) ?? getLatestCacheUsage();
	if (!cacheUsage) {
		return [vscode.l10n.t("Cache:"), vscode.l10n.t("  - Status: no provider cache telemetry yet")];
	}

	const source =
		cacheUsage.modelId === report.modelId
			? cacheUsage.apiMode
			: `${cacheUsage.apiMode} / ${cacheUsage.modelId}`;
	const lines = [
		vscode.l10n.t("Cache:"),
		vscode.l10n.t("  - Status: {0}", formatCacheStatus(cacheUsage)),
		vscode.l10n.t("  - Source: {0}", source),
	];

	if (cacheUsage.cacheHitRate !== undefined) {
		lines.push(
			vscode.l10n.t(
				"  - Hit Rate: {0}% ({1} / {2} input tokens)",
				(cacheUsage.cacheHitRate * 100).toFixed(1),
				formatTokenCount(cacheUsage.cacheHitTokens ?? 0),
				formatTokenCount(cacheUsage.cacheEligibleTokens ?? 0)
			)
		);
	} else if (cacheUsage.cacheHitTokens !== undefined) {
		lines.push(vscode.l10n.t("  - Cached Input: {0}", formatTokenCount(cacheUsage.cacheHitTokens)));
	}

	return lines;
}

function formatCacheUsageSummary(cacheUsage: CacheUsageRecord | undefined, report: TokenUsageReport): string {
	if (!cacheUsage) {
		return vscode.l10n.t("$(database) **Cache** No provider telemetry yet");
	}

	const status = formatCacheStatus(cacheUsage);
	const source =
		cacheUsage.modelId === report.modelId
			? cacheUsage.apiMode
			: `${cacheUsage.apiMode} / ${cacheUsage.modelId}`;
	if (cacheUsage.cacheHitRate !== undefined) {
		return vscode.l10n.t(
			"$(database) **Cache** **{0}% hit** · {1} · {2} / {3} · {4}",
			(cacheUsage.cacheHitRate * 100).toFixed(1),
			status,
			formatTokenCount(cacheUsage.cacheHitTokens ?? 0),
			formatTokenCount(cacheUsage.cacheEligibleTokens ?? 0),
			source
		);
	}
	if (cacheUsage.cacheHitTokens !== undefined) {
		return vscode.l10n.t(
			"$(database) **Cache** {0} cached input · {1} · {2}",
			formatTokenCount(cacheUsage.cacheHitTokens),
			status,
			source
		);
	}
	return vscode.l10n.t("$(database) **Cache** {0} · {1}", status, source);
}

function formatCacheStatus(cacheUsage: CacheUsageRecord): string {
	if (cacheUsage.status === "hit") {
		return vscode.l10n.t("working");
	}
	if (cacheUsage.status === "miss") {
		return vscode.l10n.t("no hit yet");
	}
	return vscode.l10n.t("provider reported");
}

function getWarningText(report: TokenUsageReport): string | undefined {
	if (report.status === "error") {
		return vscode.l10n.t(
			"Warning: input estimate is high ({0}% of the advertised input budget).",
			report.inputUsagePercent.toFixed(1)
		);
	}
	if (report.status === "warning") {
		return vscode.l10n.t(
			"Warning: input estimate is elevated ({0}% of the advertised input budget).",
			report.inputUsagePercent.toFixed(1)
		);
	}
	return undefined;
}

function getTokenUsageStatus(inputUsagePercent: number): TokenUsageStatus {
	if (inputUsagePercent >= 90) {
		return "error";
	}
	if (inputUsagePercent >= 70) {
		return "warning";
	}
	return "ok";
}

function calculatePercentage(value: number, maxTokens: number): number {
	if (maxTokens <= 0) {
		return 0;
	}
	return (value / maxTokens) * 100;
}
