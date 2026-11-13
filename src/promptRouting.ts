import type { HFModelItem } from "./types";

/** Setting that maps a prompt pattern to whether that prompt may be routed. */
export const PROMPT_ROUTING_RULES_SETTING = "oaicopilot.promptRouting";
/** Setting that names the single model every routed request is sent to. */
export const PROMPT_ROUTING_MODEL_SETTING = "oaicopilot.promptRoutingModel";

export interface PromptRoutingRule {
	/** Pattern exactly as configured, kept for logging. */
	pattern: string;
	/** `true` routes, `false` refuses, `null` ignores the pattern. */
	allow: boolean | null;
}

export interface PromptRoutingTarget {
	/** Model id as registered with VS Code, including any `::configId` suffix. */
	modelId: string;
	model: HFModelItem;
	/** The pattern that matched. */
	pattern: string;
}

/**
 * Normalize the `oaicopilot.promptRouting` setting into ordered rules.
 *
 * The shape mirrors `chat.tools.terminal.autoApprove`: an object whose keys are
 * patterns and whose values are `true` (route), `false` (never route) or `null`
 * (ignore the pattern). Insertion order is preserved, and the first matching
 * rule decides the outcome.
 */
export function parsePromptRoutingRules(value: unknown): PromptRoutingRule[] {
	if (!isPlainObject(value)) {
		return [];
	}

	const rules: PromptRoutingRule[] = [];
	for (const [key, raw] of Object.entries(value)) {
		const pattern = key.trim();
		if (!pattern) {
			continue;
		}
		if (raw === true) {
			rules.push({ pattern, allow: true });
		} else if (raw === false) {
			rules.push({ pattern, allow: false });
		} else if (raw === null) {
			rules.push({ pattern, allow: null });
		}
	}
	return rules;
}

/** The first rule that matches `text`, or `undefined` when nothing matches. */
export function firstMatchingPromptRule(
	rules: readonly PromptRoutingRule[],
	text: string
): PromptRoutingRule | undefined {
	for (const rule of rules) {
		if (matchesPromptPattern(rule.pattern, text)) {
			return rule;
		}
	}
	return undefined;
}

/**
 * Test one configured pattern against the prompt text.
 *
 * A pattern written as `/body/flags` is a regular expression with explicit
 * flags, matching the convention `chat.tools.terminal.autoApprove` uses.
 * Any other pattern is a case-insensitive regular expression, so a plain
 * prefix such as `^You judge one proposed` works as written. An invalid
 * expression falls back to a case-insensitive literal substring check so a
 * typo disables matching instead of breaking every request.
 */
export function matchesPromptPattern(pattern: string, text: string): boolean {
	const matcher = compilePromptPattern(pattern);
	return matcher(text);
}

/**
 * Resolve which model a request should be sent to.
 *
 * Returns `undefined` when routing is disabled (no target model), when no rule
 * matches, when the matching rule is `false`, or when the target model is not
 * configured.
 */
export function resolvePromptRoutingTarget(options: {
	rulesValue: unknown;
	targetModelId: string | undefined;
	models: readonly HFModelItem[];
	systemText: string | undefined;
}): PromptRoutingTarget | undefined {
	const targetId = options.targetModelId?.trim();
	if (!targetId || !options.systemText) {
		return undefined;
	}

	const rules = parsePromptRoutingRules(options.rulesValue);
	if (rules.length === 0) {
		return undefined;
	}

	const matched = firstMatchingPromptRule(rules, options.systemText);
	if (!matched || matched.allow !== true) {
		return undefined;
	}

	const model = findTargetModel(options.models, targetId);
	if (!model) {
		return undefined;
	}

	return { modelId: getRoutedModelId(model), model, pattern: matched.pattern };
}

/** Model id as registered with VS Code, mirroring `provideModel.ts`. */
export function getRoutedModelId(model: HFModelItem): string {
	return model.configId ? `${model.id}::${model.configId}` : model.id;
}

function findTargetModel(models: readonly HFModelItem[], targetId: string): HFModelItem | undefined {
	const exact = models.find((model) => getRoutedModelId(model) === targetId);
	if (exact) {
		return exact;
	}

	// Accept a bare base id when it identifies exactly one configured model.
	const matches = models.filter((model) => model.id === targetId);
	return matches.length === 1 ? matches[0] : undefined;
}

function compilePromptPattern(pattern: string): (text: string) => boolean {
	const explicit = parseExplicitRegex(pattern);
	try {
		const regex = explicit
			? new RegExp(explicit.body, explicit.flags)
			: new RegExp(pattern, "i");
		return (text) => regex.test(text);
	} catch {
		const literal = pattern.toLowerCase();
		return (text) => text.toLowerCase().includes(literal);
	}
}

function parseExplicitRegex(pattern: string): { body: string; flags: string } | undefined {
	if (!pattern.startsWith("/")) {
		return undefined;
	}
	const closing = pattern.lastIndexOf("/");
	if (closing <= 0) {
		return undefined;
	}
	const body = pattern.slice(1, closing);
	const rawFlags = pattern.slice(closing + 1);
	if (!body || !/^[dgimsuvy]*$/.test(rawFlags)) {
		return undefined;
	}
	// `g` and `y` make RegExp#test keep a stateful lastIndex, so the same pattern
	// would alternate between matching and not matching across requests. They carry
	// no meaning for a boolean match test, so drop them. Duplicate flags are a common
	// typo and are deduplicated rather than treated as an invalid pattern.
	const flags = [...new Set(rawFlags.replace(/[gy]/gu, ""))].join("");
	return { body, flags };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}
