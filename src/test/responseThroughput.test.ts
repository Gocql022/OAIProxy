import * as assert from "assert";
import * as path from "path";
import { ResponseThroughput, type ThroughputSnapshot } from "../responseThroughput";
import { tokenizerManager, TokenizerManager } from "../tokenizer/tokenizerManager";

suite("response throughput", () => {
	let now: number;
	let trackers: ResponseThroughput[];
	const create = (countTokens = async (text: string) => text.length, onUpdate?: (snapshot: ThroughputSnapshot) => void) => {
		const tracker = new ResponseThroughput({ countTokens, now: () => now, onUpdate });
		trackers.push(tracker);
		return tracker;
	};
	setup(() => { now = 0; trackers = []; });
	teardown(() => { trackers.forEach((tracker) => tracker.dispose()); });
	suiteSetup(async () => {
		TokenizerManager.setExtensionPath(path.resolve(__dirname, "../.."));
		await tokenizerManager.getTokenizer();
	});

	test("measures combined output from first content, including streaming pauses", async () => {
		const tracker = create();
		now = 10000;
		tracker.observe("text", " ");
		tracker.observe("thinking", "");
		assert.strictEqual(tracker.snapshot().status, "waiting");
		tracker.observe("thinking", "think");
		now += 250;
		await tracker.refresh();
		assert.strictEqual(tracker.snapshot().tokensPerSecond, undefined);
		tracker.observe("text", "answer");
		now += 250;
		await tracker.refresh();
		assert.deepStrictEqual(tracker.snapshot(), { status: "streaming", estimatedTokens: 11, elapsedMs: 500, tokensPerSecond: 22 });
		now += 500;
		await tracker.refresh();
		assert.strictEqual(tracker.snapshot().tokensPerSecond, 11);
		await tracker.finish("completed");
		const final = tracker.snapshot();
		now += 60000;
		tracker.observe("text", "ignored");
		await tracker.refresh();
		assert.deepStrictEqual(tracker.snapshot(), final);
	});

	test("empty and short responses have no numeric rate", async () => {
		for (const text of ["", " ", "OK"]) {
			const tracker = create();
			tracker.observe("text", text);
			now += 499;
			await tracker.finish("completed");
			assert.strictEqual(tracker.snapshot().tokensPerSecond, undefined);
			assert.strictEqual(tracker.snapshot().estimatedTokens, text.trim().length);
		}
	});

	test("cancelled and failed streams freeze partial counts and stop scheduled updates", async () => {
		for (const status of ["cancelled", "failed"] as const) {
			let updates = 0;
			const tracker = create(undefined, () => { updates++; });
			tracker.observe("thinking", "partial");
			now += 1000;
			await tracker.finish(status);
			assert.strictEqual(tracker.snapshot().status, status);
			assert.strictEqual(tracker.snapshot().estimatedTokens, 7);
			const before = updates;
			await new Promise((resolve) => setTimeout(resolve, 550));
			assert.strictEqual(updates, before);
		}
	});

	test("automatically refreshes while streaming", async () => {
		let resolveUpdate!: () => void;
		const updated = new Promise<void>((resolve) => { resolveUpdate = resolve; });
		const tracker = create(undefined, (snapshot) => {
			if (snapshot.estimatedTokens === 4) { resolveUpdate(); }
		});
		tracker.observe("text", "live");
		now += 500;
		await updated;
		assert.strictEqual(tracker.snapshot().tokensPerSecond, 8);
	});

	test("real tokenizer handles fragmented English, CJK and surrogate pairs", async () => {
		const tokenizer = await tokenizerManager.getTokenizer();
		const answer = "Hello world! 你好世界 😀 more text";
		const thinking = "Thinking carefully. 思考 🧠";
		const tracker = create(async (text) => tokenizer.encode(text).length);
		for (const [kind, text] of [["text", answer], ["thinking", thinking]] as const) {
			for (const char of text.split("")) {
				tracker.observe(kind, char);
				await tracker.refresh();
			}
		}
		now += 1000;
		await tracker.finish("completed");
		assert.strictEqual(tracker.snapshot().estimatedTokens, tokenizer.encode(answer).length + tokenizer.encode(thinking).length);
	});

	test("fixed blocks give the same final count regardless of stream fragmentation", async () => {
		const tokenizer = await tokenizerManager.getTokenizer();
		const text = "a".repeat(4095) + "😀" + " mixed 中文 ".repeat(1200);
		let processedChars = 0;
		let largestBlock = 0;
		const counter = async (part: string) => {
			processedChars += part.length;
			largestBlock = Math.max(largestBlock, part.length);
			assert.ok(part.isWellFormed());
			return tokenizer.encode(part).length;
		};
		const whole = create(counter);
		whole.observe("text", text);
		await whole.finish("completed");
		assert.strictEqual(processedChars, text.length);
		assert.ok(largestBlock <= 4096);
		const fragmented = create(counter);
		for (let offset = 0; offset < text.length; offset += 73) {
			fragmented.observe("text", text.slice(offset, offset + 73));
			await fragmented.refresh();
		}
		await fragmented.finish("completed");
		assert.strictEqual(fragmented.snapshot().estimatedTokens, whole.snapshot().estimatedTokens);
	});

	test("tokenizer failures use the shared Unicode fallback and configured ratios", async () => {
		const tracker = new ResponseThroughput({
			countTokens: async () => { throw new Error("tokenizer unavailable"); },
			fallbackSettings: () => ({ charsPerToken: 2, nonAsciiTokensPerChar: 2 }),
		});
		trackers.push(tracker);
		tracker.observe("text", "abcd你好😀");
		await tracker.finish("completed");
		assert.strictEqual(tracker.snapshot().estimatedTokens, 8);
	});

	test("finishing includes deltas received during asynchronous counting", async () => {
		let resolveCount!: (tokens: number) => void;
		let first = true;
		const tracker = create(async (text) => {
			if (first) {
				first = false;
				return new Promise<number>((resolve) => { resolveCount = resolve; });
			}
			return text.length;
		});
		tracker.observe("text", "before");
		const refresh = tracker.refresh();
		tracker.observe("text", "after");
		now += 1000;
		const finished = tracker.finish("completed");
		resolveCount(6);
		await Promise.all([refresh, finished]);
		assert.strictEqual(tracker.snapshot().estimatedTokens, 11);
	});

	test("replacement discards deferred counts and observer errors cannot escape", async () => {
		let resolveCount!: (tokens: number) => void;
		let updates = 0;
		const tracker = create(() => new Promise((resolve) => { resolveCount = resolve; }), () => { updates++; });
		tracker.observe("text", "private output");
		const refresh = tracker.refresh();
		tracker.dispose();
		const before = updates;
		resolveCount(100);
		await refresh;
		assert.strictEqual(updates, before);
		const throwingObserver = create(undefined, () => { throw new Error("UI unavailable"); });
		throwingObserver.observe("text", "OK");
		await throwingObserver.finish("completed");
	});

	test("long output yields between bounded tokenizer operations", async () => {
		let calls = 0;
		const tracker = create(async (text) => { calls++; return text.length; });
		tracker.observe("text", "x".repeat(4096 * 100));
		let callsAtYield = -1;
		const queued = new Promise<void>((resolve) => setImmediate(() => { callsAtYield = calls; resolve(); }));
		await Promise.all([tracker.finish("completed"), queued]);
		assert.ok(callsAtYield >= 0 && callsAtYield < 100);
		assert.strictEqual(calls, 100);
	});
});
