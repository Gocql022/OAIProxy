import * as assert from "assert";
import { logger } from "../logger";
import { RequestTiming } from "../requestTiming";

suite("request timing transport", () => {
	let originalFetch: typeof globalThis.fetch;
	let originalDebug: typeof logger.debug;
	let logs: Array<Record<string, unknown>>;
	setup(() => {
		originalFetch = globalThis.fetch;
		originalDebug = logger.debug;
		logs = [];
		logger.debug = (_tag, data) => { logs.push(data); };
	});
	teardown(() => {
		globalThis.fetch = originalFetch;
		logger.debug = originalDebug;
	});

	test("keeps the host fetch, request options and streaming response intact", async () => {
		const options: RequestInit = {
			method: "POST", body: "request body", signal: new AbortController().signal,
			headers: { Authorization: "Bearer test-only" },
		};
		const response = new Response("data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
		let calls = 0;
		globalThis.fetch = async (url, init) => {
			calls++;
			assert.strictEqual(url, "https://example.com/chat/completions");
			assert.strictEqual(init, options);
			return response;
		};
		const timing = new RequestTiming("test-request", "test-model");
		assert.strictEqual(await timing.fetch("https://example.com/chat/completions", options), response);
		assert.strictEqual(calls, 1);
		assert.strictEqual(await response.text(), "data: [DONE]\n\n");
		assert.deepStrictEqual(logs.map((item) => item.phase), ["dispatch", "headers"]);
		assert.ok(!JSON.stringify(logs).includes("test-only"));
	});

	test("logs nested connection codes and rethrows the original error for retries", async () => {
		const cause = new AggregateError([
			Object.assign(new Error("private URL and credentials"), { code: "ETIMEDOUT", syscall: "connect" }),
			Object.assign(new Error("private URL and credentials"), { code: "ENETUNREACH", syscall: "connect" }),
		]);
		const error = new TypeError("fetch failed", { cause });
		globalThis.fetch = async () => { throw error; };
		const timing = new RequestTiming("test-request", "test-model");
		for (let attempt = 1; attempt <= 2; attempt++) {
			await assert.rejects(timing.fetch("https://example.com", {}), (actual) => actual === error);
			const entry = logs.at(-1);
			assert.strictEqual(entry?.phase, "transportError");
			assert.strictEqual(entry.attempt, attempt);
			assert.deepStrictEqual(entry.error, {
				name: "TypeError", cause: {
					name: "AggregateError", errors: [
						{ name: "Error", code: "ETIMEDOUT", syscall: "connect" },
						{ name: "Error", code: "ENETUNREACH", syscall: "connect" },
					],
				},
			});
		}
		assert.ok(!JSON.stringify(logs).includes("private"));
	});

	test("preserves cancellation errors and the caller's abort signal", async () => {
		const controller = new AbortController();
		controller.abort();
		globalThis.fetch = async (_url, init) => {
			assert.strictEqual(init?.signal, controller.signal);
			init.signal.throwIfAborted();
			throw new Error("Expected an aborted signal");
		};
		await assert.rejects(
			new RequestTiming("test-request", "test-model").fetch("https://example.com", { signal: controller.signal }),
			(error) => error === controller.signal.reason
		);
	});
});
