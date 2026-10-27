import type { EstimationContext } from "./tokenEstimationConfig";
import * as vscode from "vscode";
import { LanguageModelChatInformation, LanguageModelChatRequestMessage, LanguageModelChatTool } from "vscode";
import { onDidChangeCacheUsage } from "./cacheUsage";
import type { ThroughputSnapshot } from "./responseThroughput";
import {
	appendThroughputTooltip,
	createProgressBar,
	createTokenUsageReport,
	formatTokenUsageTooltip,
	type TokenUsageReport,
} from "./tokenUsage";

export { createProgressBar, formatTokenCount } from "./tokenUsage";

let latestTokenUsageReport: TokenUsageReport | undefined;

interface StatusState {
	requestId?: string;
	report?: TokenUsageReport;
	throughput?: ThroughputSnapshot;
}
const states = new WeakMap<vscode.StatusBarItem, StatusState>();

function stateFor(item: vscode.StatusBarItem): StatusState {
	let state = states.get(item);
	if (!state) {
		state = {};
		states.set(item, state);
	}
	return state;
}

export function initStatusBar(context: vscode.ExtensionContext): vscode.StatusBarItem {
	// Create status bar item for token count display
	const tokenCountStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	tokenCountStatusBarItem.name = "OAIProxy Usage";
	tokenCountStatusBarItem.text = "$(server-process) " + vscode.l10n.t("OAIProxy Ready");
	tokenCountStatusBarItem.tooltip = vscode.l10n.t("Current model token usage - Click to Open Configuration UI");
	tokenCountStatusBarItem.command = "oaiproxy.openConfig";
	context.subscriptions.push(tokenCountStatusBarItem);
	context.subscriptions.push(
		onDidChangeCacheUsage(() => {
			renderStatusBar(tokenCountStatusBarItem);
		})
	);
	// Show the status bar item initially
	tokenCountStatusBarItem.show();
	return tokenCountStatusBarItem;
}

export function getLatestTokenUsageReport(): TokenUsageReport | undefined {
	return latestTokenUsageReport;
}

export function beginStatusBarRequest(item: vscode.StatusBarItem, requestId: string): void {
	states.set(item, { requestId, throughput: { status: "waiting", estimatedTokens: 0, elapsedMs: 0 } });
	latestTokenUsageReport = undefined;
	renderStatusBar(item);
}

export function updateStatusBarThroughput(item: vscode.StatusBarItem, requestId: string, throughput: ThroughputSnapshot): void {
	const state = stateFor(item);
	if (state.requestId !== requestId) { return; }
	state.throughput = throughput;
	renderStatusBar(item);
}

export function endStatusBarRequests(item: vscode.StatusBarItem): void {
	// Invalidate deferred preflight/count results when the provider is disposed.
	stateFor(item).requestId = undefined;
}

/**
 * Update the status bar with token usage information
 * @param messages The chat messages to count tokens for
 * @param tools Optional tool definitions to count tokens for
 * @param model The language model information
 * @param statusBarItem The status bar item to update
 * @param modelConfig Configuration including reasoning settings
 */
export async function updateContextStatusBar(
	messages: readonly LanguageModelChatRequestMessage[],
	tools: readonly LanguageModelChatTool[] | undefined,
	model: LanguageModelChatInformation,
	statusBarItem: vscode.StatusBarItem,
	modelConfig: EstimationContext,
	preparedBody?: unknown,
	requestId?: string
): Promise<TokenUsageReport> {
	const report = await createTokenUsageReport({
		messages,
		tools,
		model,
		modelConfig,
		preparedBody,
	});
	const state = stateFor(statusBarItem);
	if (requestId === undefined || state.requestId === requestId) {
		state.report = report;
		latestTokenUsageReport = report;
		renderStatusBar(statusBarItem);
	}
	return report;
}

function renderStatusBar(statusBarItem: vscode.StatusBarItem): void {
	const { report, throughput } = stateFor(statusBarItem);
	const context = report ? createProgressBar(report.inputTokens, report.maxContextTokens) : "OAIProxy";
	const speed = throughput?.status === "waiting" ? vscode.l10n.t("Waiting…")
		: throughput?.tokensPerSecond !== undefined ? vscode.l10n.t("~{0} tok/s", throughput.tokensPerSecond.toFixed(1))
			: vscode.l10n.t("— tok/s");
	statusBarItem.text = `$(server-process) ${context}${throughput ? ` · ${speed}` : report ? "" : ` ${vscode.l10n.t("Ready")}`}`;
	if (report) {
		statusBarItem.tooltip = formatTokenUsageTooltip(report, throughput);
	} else if (throughput) {
		const markdown = new vscode.MarkdownString(undefined, true);
		appendThroughputTooltip(markdown, throughput);
		markdown.appendMarkdown(vscode.l10n.t("$(gear) Click to open OAIProxy Configuration"));
		statusBarItem.tooltip = markdown;
	} else {
		statusBarItem.tooltip = vscode.l10n.t("Current model token usage - Click to Open Configuration UI");
	}

	// Add color coding based on advertised input budget usage
	const usagePercentage = report?.inputUsagePercent ?? 0;
	if (usagePercentage >= 90) {
		statusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
	} else if (usagePercentage >= 70) {
		statusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
	} else {
		statusBarItem.backgroundColor = undefined;
	}

	statusBarItem.show();
}
