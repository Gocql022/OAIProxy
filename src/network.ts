import * as net from "node:net";

const CONNECTION_ATTEMPT_TIMEOUT_MS = 5_000;

/**
 * VS Code can replace per-request dispatchers when adding proxy/certificate
 * support, so configure Node's connection default without replacing its fetch.
 * This default is shared with other extensions in the same extension host.
 */
export function configureConnectionAttemptTimeout(): {
	previousTimeoutMs: number;
	timeoutMs: number;
	dispose(): void;
} {
	const previousTimeoutMs = net.getDefaultAutoSelectFamilyAttemptTimeout();
	const timeoutMs = Math.max(previousTimeoutMs, CONNECTION_ATTEMPT_TIMEOUT_MS);
	if (timeoutMs !== previousTimeoutMs) {
		net.setDefaultAutoSelectFamilyAttemptTimeout(timeoutMs);
	}
	let disposed = false;
	return {
		previousTimeoutMs,
		timeoutMs,
		dispose() {
			if (disposed) {
				return;
			}
			disposed = true;
			if (timeoutMs !== previousTimeoutMs && net.getDefaultAutoSelectFamilyAttemptTimeout() === timeoutMs) {
				net.setDefaultAutoSelectFamilyAttemptTimeout(previousTimeoutMs);
			}
		},
	};
}

interface NetworkErrorSummary {
	name: string;
	code?: string;
	syscall?: string;
	cause?: NetworkErrorSummary;
	errors?: NetworkErrorSummary[];
}

/** Report nested transport failures without copying messages, URLs or headers. */
export function summarizeNetworkError(error: unknown): NetworkErrorSummary | undefined {
	const seen = new Set<object>();
	function visit(value: unknown, depth: number): NetworkErrorSummary | undefined {
		if (!value || typeof value !== "object" || depth > 4 || seen.has(value) || seen.size >= 16) {
			return undefined;
		}
		seen.add(value);
		const candidate = value as Record<string, unknown>;
		const name = typeof candidate.name === "string" &&
			["Error", "TypeError", "AggregateError", "AbortError", "TimeoutError"].includes(candidate.name)
			? candidate.name : "Error";
		const result: NetworkErrorSummary = { name };
		if (typeof candidate.code === "string" && /^(?:E[A-Z0-9_]+|UND_ERR_[A-Z0-9_]+|ERR_[A-Z0-9_]+)$/.test(candidate.code) && candidate.code.length <= 64) {
			result.code = candidate.code;
		}
		if (typeof candidate.syscall === "string" && ["connect", "getaddrinfo", "read", "write"].includes(candidate.syscall)) {
			result.syscall = candidate.syscall;
		}
		const cause = visit(candidate.cause, depth + 1);
		if (cause) {
			result.cause = cause;
		}
		if (Array.isArray(candidate.errors)) {
			const errors = candidate.errors.slice(0, 8).map((item) => visit(item, depth + 1))
				.filter((item): item is NetworkErrorSummary => item !== undefined);
			if (errors.length > 0) {
				result.errors = errors;
			}
		}
		return result;
	}
	return visit(error, 0);
}
