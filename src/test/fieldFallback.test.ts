import * as assert from "assert";
import {
    bodyHasField,
    deleteBodyField,
    fetchWithFieldFallback,
    parseUnsupportedFieldError,
} from "../fieldFallback";

interface MockResponseInit {
    status: number;
    statusText?: string;
    bodyText?: string;
}

function mockResponse(init: MockResponseInit): Response {
    return {
        ok: init.status >= 200 && init.status < 300,
        status: init.status,
        statusText: init.statusText ?? "",
        body: null,
        async text(): Promise<string> {
            return init.bodyText ?? "";
        },
    } as unknown as Response;
}

suite("fieldFallback", () => {
    const noRetry = { enabled: false };

    test("parses unsupported field names from common gateway error messages", () => {
        assert.strictEqual(
            parseUnsupportedFieldError('{"error":{"message":"prompt_cache_retention is not supported on this model"}}'),
            "prompt_cache_retention"
        );
        assert.strictEqual(
            parseUnsupportedFieldError('"prompt_cache_retention" is not supported'),
            "prompt_cache_retention"
        );
        assert.strictEqual(
            parseUnsupportedFieldError("Unknown parameter: 'prompt_cache_retention'"),
            "prompt_cache_retention"
        );
        assert.strictEqual(
            parseUnsupportedFieldError("Unrecognized request argument supplied: prompt_cache_retention"),
            "prompt_cache_retention"
        );
        assert.strictEqual(
            parseUnsupportedFieldError("Unsupported parameter: temperature"),
            "temperature"
        );
    });

    test("returns null for unrelated error messages", () => {
        assert.strictEqual(parseUnsupportedFieldError("Invalid API key"), null);
        assert.strictEqual(parseUnsupportedFieldError("Rate limit exceeded"), null);
        assert.strictEqual(parseUnsupportedFieldError(""), null);
    });

    test("detects and deletes body fields case-insensitively", () => {
        const body: Record<string, unknown> = { prompt_cache_retention: "24h", model: "gpt" };
        assert.strictEqual(bodyHasField(body, "prompt_cache_retention"), true);
        assert.strictEqual(bodyHasField(body, "PROMPT_CACHE_RETENTION"), true);
        assert.strictEqual(bodyHasField(body, "missing"), false);
        assert.strictEqual(deleteBodyField(body, "PROMPT_CACHE_RETENTION"), true);
        assert.strictEqual(body.prompt_cache_retention, undefined);
        assert.strictEqual(deleteBodyField(body, "missing"), false);
    });

    test("removes unsupported field and retries successfully", async () => {
        const calls: string[] = [];
        let firstCall = true;
        const originalFetch = globalThis.fetch;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (globalThis as any).fetch = async (_url: unknown, init: RequestInit | undefined) => {
            calls.push(String(init?.body));
            if (firstCall) {
                firstCall = false;
                return mockResponse({
                    status: 400,
                    bodyText: '{"error":{"message":"prompt_cache_retention is not supported on this model"}}',
                });
            }
            return mockResponse({ status: 200, bodyText: "ok" });
        };

        const body: Record<string, unknown> = { prompt_cache_retention: "24h", model: "gpt" };
        const removed: string[] = [];
        const result = await fetchWithFieldFallback({
            url: "https://example.test/v1/chat/completions",
            headers: { Authorization: "Bearer x" },
            body,
            retryConfig: noRetry,
            apiLabel: "OAIProxy API",
            onFieldRemoved: (field) => removed.push(field),
        });

        assert.strictEqual(result.response.status, 200);
        assert.deepStrictEqual(result.removedFields, ["prompt_cache_retention"]);
        assert.deepStrictEqual(removed, ["prompt_cache_retention"]);
        assert.strictEqual(body.prompt_cache_retention, undefined);
        assert.strictEqual(calls.length, 2);
        assert.ok(!calls[1].includes("prompt_cache_retention"));
        globalThis.fetch = originalFetch;
    });

    test("throws when error is not about an unsupported field", async () => {
        const originalFetch = globalThis.fetch;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (globalThis as any).fetch = async () =>
            mockResponse({ status: 400, bodyText: '{"error":{"message":"Invalid API key"}}' });

        await assert.rejects(
            fetchWithFieldFallback({
                url: "https://example.test/v1/chat/completions",
                headers: {},
                body: { model: "gpt" },
                retryConfig: noRetry,
                apiLabel: "OAIProxy API",
            }),
            /\[400\]/
        );
        globalThis.fetch = originalFetch;
    });

    test("throws when reported field is not present in the body (no infinite loop)", async () => {
        const originalFetch = globalThis.fetch;
        let calls = 0;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (globalThis as any).fetch = async () => {
            calls += 1;
            return mockResponse({
                status: 400,
                bodyText: '{"error":{"message":"prompt_cache_retention is not supported on this model"}}',
            });
        };

        await assert.rejects(
            fetchWithFieldFallback({
                url: "https://example.test/v1/chat/completions",
                headers: {},
                body: { model: "gpt" },
                retryConfig: noRetry,
                apiLabel: "OAIProxy API",
            }),
            /\[400\]/
        );
        assert.strictEqual(calls, 1);
        globalThis.fetch = originalFetch;
    });

    test("retries each unsupported field at most once", async () => {
        const originalFetch = globalThis.fetch;
        let calls = 0;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (globalThis as any).fetch = async () => {
            calls += 1;
            return mockResponse({
                status: 400,
                bodyText: '{"error":{"message":"prompt_cache_retention is not supported on this model"}}',
            });
        };

        await assert.rejects(
            fetchWithFieldFallback({
                url: "https://example.test/v1/chat/completions",
                headers: {},
                body: { prompt_cache_retention: "24h", model: "gpt" },
                retryConfig: noRetry,
                apiLabel: "OAIProxy API",
            }),
            /\[400\]/
        );
        assert.strictEqual(calls, 2);
        globalThis.fetch = originalFetch;
    });
});
