import { logger } from "./logger";

interface CountSummary {
	calls: number;
	stringCalls: number;
	textChars: number;
	messageParts: number;
	tokens: number;
	durationMs: number;
	maxDurationMs: number;
	cancelled: number;
	failed: number;
}

/** Copilot can count tens of thousands of small strings in a single prompt build. */
export class TokenCountWork {
	private sliceStartedAt = performance.now();
	private sliceCalls = 0;
	private yielding?: Promise<void>;
	private summaries = new Map<string, CountSummary>();
	private summaryTimer?: NodeJS.Timeout;
	private disposed = false;

	yieldIfNeeded(): Promise<void> | undefined {
		if (this.yielding) {
			return this.yielding;
		}
		if (++this.sliceCalls < 128 && performance.now() - this.sliceStartedAt < 8) {
			return;
		}
		// A resolved Promise only yields to microtasks; commands and webviews need an event-loop turn.
		this.yielding = new Promise<void>((resolve) => setImmediate(resolve)).then(() => {
			this.sliceStartedAt = performance.now();
			this.sliceCalls = 0;
			this.yielding = undefined;
		});
		return this.yielding;
	}

	record(
		modelId: string,
		textChars: number | undefined,
		messageParts: number,
		tokens: number | undefined,
		durationMs: number,
		cancelled: boolean
	): void {
		if (this.disposed) {
			return;
		}
		const summary = this.summaries.get(modelId) ?? {
			calls: 0,
			stringCalls: 0,
			textChars: 0,
			messageParts: 0,
			tokens: 0,
			durationMs: 0,
			maxDurationMs: 0,
			cancelled: 0,
			failed: 0,
		};
		summary.calls++;
		summary.stringCalls += Number(textChars !== undefined);
		summary.textChars += textChars ?? 0;
		summary.messageParts += messageParts;
		summary.tokens += tokens ?? 0;
		summary.durationMs += durationMs;
		summary.maxDurationMs = Math.max(summary.maxDurationMs, durationMs);
		summary.cancelled += Number(cancelled);
		summary.failed += Number(tokens === undefined && !cancelled);
		this.summaries.set(modelId, summary);
		this.summaryTimer ??= setTimeout(() => this.flush(), 1000).unref();
	}

	private flush(): void {
		if (this.summaryTimer) {
			clearTimeout(this.summaryTimer);
		}
		this.summaryTimer = undefined;
		for (const [modelId, summary] of this.summaries) {
			logger.debug("tokenCount.summary", { modelId, ...summary });
		}
		this.summaries.clear();
	}

	dispose(): void {
		this.disposed = true;
		this.flush();
	}
}
