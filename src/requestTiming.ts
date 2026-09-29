import { logger } from "./logger";

/** Content-free timing for one provider invocation, including retries. */
export class RequestTiming {
	private readonly startedAt = performance.now();
	private attempt = 0;
	private readonly seen = new Set<string>();

	constructor(
		private readonly requestId: string,
		private readonly modelId: string
	) {}

	mark(phase: string, fields: Record<string, unknown> = {}): void {
		logger.debug("request.timing", {
			requestId: this.requestId,
			modelId: this.modelId,
			phase,
			elapsedMs: performance.now() - this.startedAt,
			...fields,
		});
	}

	once(phase: string): void {
		if (!this.seen.has(phase)) {
			this.seen.add(phase);
			this.mark(phase);
		}
	}

	async measure<T>(phase: string, operation: () => Promise<T>): Promise<T> {
		const startedAt = performance.now();
		let succeeded = false;
		this.mark(`${phase}.start`);
		try {
			const result = await operation();
			succeeded = true;
			return result;
		} finally {
			this.mark(`${phase}.end`, { durationMs: performance.now() - startedAt, succeeded });
		}
	}

	async fetch(url: string, options: RequestInit): Promise<Response> {
		const attempt = ++this.attempt;
		const startedAt = performance.now();
		this.mark("dispatch", { attempt });
		try {
			const response = await fetch(url, options);
			this.mark("headers", { attempt, status: response.status, durationMs: performance.now() - startedAt });
			return response;
		} catch (error) {
			this.mark("transportError", {
				attempt,
				durationMs: performance.now() - startedAt,
				errorName: error instanceof Error ? error.name : "Error",
			});
			throw error;
		}
	}
}
