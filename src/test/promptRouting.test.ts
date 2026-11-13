import * as assert from "assert";
import {
	firstMatchingPromptRule,
	getRoutedModelId,
	matchesPromptPattern,
	parsePromptRoutingRules,
	resolvePromptRoutingTarget,
} from "../promptRouting";
import type { HFModelItem } from "../types";

const models: HFModelItem[] = [
	{ id: "deepseek-v4.1-flash", owned_by: "workbuddy", context_length: 1000000, max_tokens: 150000 },
	{ id: "hy3", owned_by: "workbuddy", context_length: 200000, max_tokens: 32000 },
	{ id: "glm-5.2", owned_by: "zai", configId: "thinking" },
	{ id: "glm-5.2", owned_by: "zai", configId: "fast" },
];

const judgePrompt =
	"You judge one proposed developer-tool action. ALLOW means execute now without another confirmation; DENY means escalate to the host, not prohibit forever.";

suite("prompt routing rules", () => {
	test("parses ordered rules and drops unusable values", () => {
		const rules = parsePromptRoutingRules({
			"^You judge one proposed": true,
			"^Summarize": false,
			"^Ignored": null,
			"^Bad": "yes",
			"   ": true,
		});
		assert.deepStrictEqual(rules, [
			{ pattern: "^You judge one proposed", allow: true },
			{ pattern: "^Summarize", allow: false },
			{ pattern: "^Ignored", allow: null },
		]);
	});

	test("rejects non-object settings", () => {
		assert.deepStrictEqual(parsePromptRoutingRules(undefined), []);
		assert.deepStrictEqual(parsePromptRoutingRules(["a"]), []);
		assert.deepStrictEqual(parsePromptRoutingRules("^x"), []);
	});

	test("plain patterns are case-insensitive regular expressions", () => {
		assert.strictEqual(matchesPromptPattern("^You judge one proposed", judgePrompt), true);
		assert.strictEqual(matchesPromptPattern("^you JUDGE one proposed", judgePrompt), true);
		assert.strictEqual(matchesPromptPattern("^Summarize", judgePrompt), false);
	});

	test("explicit /body/flags patterns honour flags", () => {
		assert.strictEqual(matchesPromptPattern("/^YOU JUDGE/", judgePrompt), false);
		assert.strictEqual(matchesPromptPattern("/^YOU JUDGE/i", judgePrompt), true);
	});

	test("global and sticky flags never leak search state between requests", () => {
		// `g`/`y` would otherwise make RegExp#test alternate results via lastIndex.
		for (let i = 0; i < 4; i++) {
			assert.strictEqual(matchesPromptPattern("/^You judge/gi", judgePrompt), true);
			assert.strictEqual(matchesPromptPattern("/^You judge/iy", judgePrompt), true);
		}
	});

	test("duplicate regex flags are deduplicated instead of rejected", () => {
		assert.strictEqual(matchesPromptPattern("/^You judge/iii", judgePrompt), true);
	});

	test("invalid regular expressions fall back to literal matching", () => {
		assert.strictEqual(matchesPromptPattern("(unclosed", "prefix (unclosed text"), true);
		assert.strictEqual(matchesPromptPattern("(unclosed", judgePrompt), false);
	});

	test("first matching rule wins", () => {
		const rules = parsePromptRoutingRules({
			"^Summarize": true,
			"^You judge": false,
		});
		assert.strictEqual(firstMatchingPromptRule(rules, judgePrompt)?.allow, false);
	});

	test("routes to the configured model when a true rule matches", () => {
		const target = resolvePromptRoutingTarget({
			rulesValue: { "^You judge one proposed": true, ".*": false },
			targetModelId: "hy3",
			models,
			systemText: judgePrompt,
		});
		assert.ok(target);
		assert.strictEqual(target.modelId, "hy3");
		assert.strictEqual(target.model.id, "hy3");
		assert.strictEqual(target.pattern, "^You judge one proposed");
	});

	test("stays on the selected model when routing is disabled or refused", () => {
		const base = { models, systemText: judgePrompt };
		assert.strictEqual(
			resolvePromptRoutingTarget({ ...base, rulesValue: { "^You judge": true }, targetModelId: "" }),
			undefined
		);
		assert.strictEqual(
			resolvePromptRoutingTarget({ ...base, rulesValue: { "^You judge": false }, targetModelId: "hy3" }),
			undefined
		);
		assert.strictEqual(
			resolvePromptRoutingTarget({ ...base, rulesValue: { "^Unrelated": true }, targetModelId: "hy3" }),
			undefined
		);
		assert.strictEqual(
			resolvePromptRoutingTarget({ ...base, rulesValue: { "^You judge": null }, targetModelId: "hy3" }),
			undefined
		);
	});

	test("never routes requests without a system prompt", () => {
		assert.strictEqual(
			resolvePromptRoutingTarget({
				rulesValue: { ".*": true },
				targetModelId: "hy3",
				models,
				systemText: undefined,
			}),
			undefined
		);
	});

	test("unknown target models are ignored", () => {
		assert.strictEqual(
			resolvePromptRoutingTarget({
				rulesValue: { "^You judge": true },
				targetModelId: "missing-model",
				models,
				systemText: judgePrompt,
			}),
			undefined
		);
	});

	test("config id models need the full id, and ambiguous base ids are rejected", () => {
		assert.strictEqual(getRoutedModelId(models[2]), "glm-5.2::thinking");
		const routed = resolvePromptRoutingTarget({
			rulesValue: { "^You judge": true },
			targetModelId: "glm-5.2::fast",
			models,
			systemText: judgePrompt,
		});
		assert.strictEqual(routed?.model.configId, "fast");
		assert.strictEqual(
			resolvePromptRoutingTarget({
				rulesValue: { "^You judge": true },
				targetModelId: "glm-5.2",
				models,
				systemText: judgePrompt,
			}),
			undefined
		);
	});
});
