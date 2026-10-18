import * as assert from "assert";
import * as net from "node:net";
import { configureConnectionAttemptTimeout, summarizeNetworkError } from "../network";

suite("connection attempt timeout", () => {
	let originalTimeout: number;
	setup(() => {
		originalTimeout = net.getDefaultAutoSelectFamilyAttemptTimeout();
	});
	teardown(() => {
		net.setDefaultAutoSelectFamilyAttemptTimeout(originalTimeout);
	});

	test("raises the short Node timeout without changing address-family selection", () => {
		net.setDefaultAutoSelectFamilyAttemptTimeout(250);
		const autoSelectFamily = net.getDefaultAutoSelectFamily();
		const configuration = configureConnectionAttemptTimeout();
		assert.strictEqual(net.getDefaultAutoSelectFamilyAttemptTimeout(), 5000);
		assert.strictEqual(net.getDefaultAutoSelectFamily(), autoSelectFamily);
		assert.strictEqual(configuration.previousTimeoutMs, 250);
		configuration.dispose();
		assert.strictEqual(net.getDefaultAutoSelectFamilyAttemptTimeout(), 250);
	});

	test("preserves a longer timeout configured by the host", () => {
		net.setDefaultAutoSelectFamilyAttemptTimeout(8000);
		const configuration = configureConnectionAttemptTimeout();
		assert.strictEqual(net.getDefaultAutoSelectFamilyAttemptTimeout(), 8000);
		configuration.dispose();
		assert.strictEqual(net.getDefaultAutoSelectFamilyAttemptTimeout(), 8000);
	});

	test("does not undo another extension's later timeout change", () => {
		net.setDefaultAutoSelectFamilyAttemptTimeout(250);
		const configuration = configureConnectionAttemptTimeout();
		net.setDefaultAutoSelectFamilyAttemptTimeout(7000);
		configuration.dispose();
		assert.strictEqual(net.getDefaultAutoSelectFamilyAttemptTimeout(), 7000);
	});

	test("does not restore a timeout on repeated disposal", () => {
		net.setDefaultAutoSelectFamilyAttemptTimeout(250);
		const configuration = configureConnectionAttemptTimeout();
		configuration.dispose();
		net.setDefaultAutoSelectFamilyAttemptTimeout(5000);
		configuration.dispose();
		assert.strictEqual(net.getDefaultAutoSelectFamilyAttemptTimeout(), 5000);
	});
});

suite("network error diagnostics", () => {
	test("extracts the real nested IPv4/IPv6 failure codes from a fetch error", () => {
		const ipv4 = Object.assign(new Error("connect timed out"), { code: "ETIMEDOUT", syscall: "connect" });
		const ipv6 = Object.assign(new Error("route unavailable"), { code: "ENETUNREACH", syscall: "connect" });
		const cause = Object.assign(new AggregateError([ipv4, ipv6]), { code: "ETIMEDOUT" });
		const error = new TypeError("fetch failed", { cause });
		assert.deepStrictEqual(summarizeNetworkError(error), {
			name: "TypeError",
			cause: {
				name: "AggregateError",
				code: "ETIMEDOUT",
				errors: [
					{ name: "Error", code: "ETIMEDOUT", syscall: "connect" },
					{ name: "Error", code: "ENETUNREACH", syscall: "connect" },
				],
			},
		});
	});

	test("omits error messages and arbitrary properties that could contain credentials", () => {
		const secret = "Bearer private-test-credential";
		const error = Object.assign(new Error(secret), {
			name: secret,
			code: secret,
			syscall: secret,
			headers: { Authorization: secret },
			url: `https://example.com/?key=${secret}`,
			cause: { name: "Error", code: "UND_ERR_CONNECT_TIMEOUT", message: secret },
		});
		assert.deepStrictEqual(summarizeNetworkError(error), {
			name: "Error", cause: { name: "Error", code: "UND_ERR_CONNECT_TIMEOUT" },
		});
	});

	test("handles cyclic causes and limits oversized aggregate errors", () => {
		const error: { name: string; cause?: unknown; errors: Error[] } = {
			name: "AggregateError", errors: Array.from({ length: 100 }, () => new Error("omitted")),
		};
		error.cause = error;
		const summary = summarizeNetworkError(error);
		assert.strictEqual(summary?.cause, undefined);
		assert.strictEqual(summary?.errors?.length, 8);
	});

	test("bounds deeply nested error causes and ignores primitive rejection values", () => {
		let error: Error = new Error("last");
		for (let index = 0; index < 100; index++) {
			error = new Error("wrapper", { cause: error });
		}
		const summary = summarizeNetworkError(error);
		assert.ok(summary?.cause?.cause?.cause?.cause);
		assert.strictEqual(summary.cause.cause.cause.cause.cause, undefined);
		assert.strictEqual(summarizeNetworkError("private error message"), undefined);
	});
});
