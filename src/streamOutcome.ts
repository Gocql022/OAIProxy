/** Strict terminal outcome for buffered compaction; ordinary streaming is unchanged. */
export class StreamOutcome {
	private terminal = false;
	private failure: string | undefined;
	private anthropicStop: string | undefined;

	malformed(): void {
		this.failure = "malformed stream event";
	}

	observe(payload: unknown): void {
		const p = record(payload);
		const response = record(p.response);
		const itemType = record(p.item).type ?? record(p.content_block).type;
		if (itemType === "function_call" || itemType === "tool_use") {
			this.failure = "unexpected tool call";
		}
		for (const item of array(response.output)) {
			const output = record(item);
			if (output.type === "function_call") {
				this.failure = "unexpected tool call";
			}
			if (array(output.content).some((part) => record(part).type === "refusal")) {
				this.failure = "provider refused the summary";
			}
		}
		if (p.error || ["error", "response.failed", "response.cancelled", "response.incomplete"].includes(String(p.type))) {
			this.failure = "provider reported an unsuccessful response";
		}
		if (String(p.type).startsWith("response.refusal.")) {
			this.failure = "provider refused the summary";
		}
		if (p.type === "response.completed") {
			this.terminal = true;
			if (response.status && response.status !== "completed") {
				this.failure = "incomplete response";
			}
		}
		if (p.type === "message_delta") {
			this.anthropicStop = record(p.delta).stop_reason as string | undefined;
		}
		if (p.type === "message_stop") {
			this.finish(this.anthropicStop, ["end_turn", "stop_sequence"]);
		}
		if (p.done === true) {
			this.finish(p.done_reason ?? "stop", ["stop"]);
		}
		for (const choice of array(p.choices)) {
			const c = record(choice);
			if (record(c.delta).refusal) {
				this.failure = "provider refused the summary";
			}
			if (c.finish_reason) {
				this.finish(c.finish_reason, ["stop"]);
			}
		}
		if (record(p.promptFeedback).blockReason) {
			this.failure = "provider blocked the summary";
		}
		for (const candidate of array(p.candidates)) {
			const c = record(candidate);
			if (c.finishReason) {
				this.finish(c.finishReason, ["STOP"]);
			}
		}
	}

	assertSuccessful(): void {
		if (this.failure || !this.terminal) {
			throw new Error(`Compaction failed: ${this.failure ?? "stream ended without a successful terminal event"}.`);
		}
	}

	private finish(reason: unknown, successful: string[]): void {
		this.terminal = true;
		if (!successful.includes(String(reason))) {
			this.failure = "response did not finish normally";
		}
	}
}

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function array(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}
