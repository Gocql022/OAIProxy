import { fallbackTextTokenLength, type TokenEstimationConfig } from "./tokenEstimationConfig";

export type ThroughputStatus = "waiting" | "streaming" | "completed" | "cancelled" | "failed";
export interface ThroughputSnapshot {
	status: ThroughputStatus;
	estimatedTokens: number;
	elapsedMs: number;
	tokensPerSecond?: number;
}

interface ThroughputOptions {
	countTokens: (text: string) => Promise<number>;
	now?: () => number;
	onUpdate?: (snapshot: ThroughputSnapshot) => void;
	fallbackSettings?: () => Pick<TokenEstimationConfig, "charsPerToken" | "nonAsciiTokensPerChar"> | undefined;
}

interface OutputChannel {
	pending: string;
	committedTokens: number;
	tail: string;
	tailTokens: number;
	started: boolean;
}

const BLOCK_CHARS = 4096;
const REFRESH_MS = 500;

/** Reference estimate of received output, independent of provider billing usage. */
export class ResponseThroughput {
	private readonly channels: Record<"text" | "thinking", OutputChannel> = {
		text: { pending: "", committedTokens: 0, tail: "", tailTokens: 0, started: false },
		thinking: { pending: "", committedTokens: 0, tail: "", tailTokens: 0, started: false },
	};
	private readonly now: () => number;
	private firstOutputAt?: number;
	private endedAt?: number;
	private status: ThroughputStatus = "waiting";
	private timer?: NodeJS.Timeout;
	private scheduled?: NodeJS.Immediate;
	private work?: Promise<void>;
	private finishing?: Promise<void>;
	private settled = false;
	private disposed = false;

	constructor(private readonly options: ThroughputOptions) {
		this.now = options.now ?? (() => performance.now());
	}

	observe(kind: "text" | "thinking", text: string): void {
		if (this.disposed || this.endedAt !== undefined || !text) { return; }
		const channel = this.channels[kind];
		// Adapters can emit a synthetic space for tool-only responses.
		if (!channel.started && !text.trim()) { return; }
		channel.started = true;
		channel.pending += text;
		if (this.firstOutputAt === undefined) {
			this.firstOutputAt = this.now();
			this.status = "streaming";
			this.publish();
			this.timer = setInterval(() => { void this.refresh(); }, REFRESH_MS);
			this.timer.unref();
		}
		// Drain full blocks promptly, outside the provider's progress callback.
		if (channel.pending.length >= BLOCK_CHARS && !this.scheduled) {
			this.scheduled = setImmediate(() => {
				this.scheduled = undefined;
				void this.countBuffered();
			});
		}
	}

	snapshot(): ThroughputSnapshot {
		const elapsedMs = this.firstOutputAt === undefined ? 0 : Math.max(0, (this.endedAt ?? this.now()) - this.firstOutputAt);
		const estimatedTokens = Object.values(this.channels).reduce((sum, channel) => sum + channel.committedTokens + channel.tailTokens, 0);
		return {
			status: this.status,
			estimatedTokens,
			elapsedMs,
			tokensPerSecond: this.firstOutputAt !== undefined && elapsedMs >= REFRESH_MS
				? estimatedTokens / (elapsedMs / 1000) : undefined,
		};
	}

	async refresh(): Promise<void> {
		if (this.disposed || this.settled) { return; }
		await this.countBuffered();
		this.publish();
	}

	private countBuffered(): Promise<void> {
		if (this.disposed || this.settled) { return Promise.resolve(); }
		return this.work ??= this.countPending().finally(() => { this.work = undefined; });
	}

	finish(status: "completed" | "cancelled" | "failed"): Promise<void> {
		if (this.disposed) { return Promise.resolve(); }
		if (this.finishing) { return this.finishing; }
		this.endedAt = this.now();
		this.status = status;
		this.clearTimers();
		this.finishing = (async () => {
			await this.work;
			// Include output that arrived while a previous refresh was counting.
			await this.refresh();
			this.settled = true;
			this.clearText();
		})();
		return this.finishing;
	}

	dispose(): void {
		this.disposed = true;
		this.clearTimers();
		this.clearText();
	}

	private async countPending(): Promise<void> {
		for (const channel of Object.values(this.channels)) {
			while (!this.disposed) {
				const pending = channel.pending;
				let length = Math.min(BLOCK_CHARS, channel.pending.length);
				// Leave a high surrogate for the next chunk, even at a block boundary.
				const last = channel.pending.charCodeAt(length - 1);
				if (last >= 0xD800 && last <= 0xDBFF && (this.endedAt === undefined || length < channel.pending.length)) { length--; }
				const fullBlock = channel.pending.length >= BLOCK_CHARS;
				const text = channel.pending.slice(0, length);
				if (!fullBlock && text === channel.tail) { break; }
				const tokens = await this.count(text);
				if (this.disposed) { return; }
				if (fullBlock) {
					channel.committedTokens += tokens;
					channel.pending = channel.pending.slice(length);
					channel.tail = "";
					channel.tailTokens = 0;
					await new Promise<void>((resolve) => setImmediate(resolve));
				} else {
					channel.tail = text;
					channel.tailTokens = tokens;
					// Recheck in case more output arrived while awaiting the tokenizer.
					if (channel.pending === pending) { break; }
				}
			}
		}
	}

	private async count(text: string): Promise<number> {
		if (!text) { return 0; }
		try {
			const tokens = await this.options.countTokens(text);
			if (Number.isFinite(tokens) && tokens >= 0) { return tokens; }
		} catch { /* A speed estimate must never interrupt the response. */ }
		return fallbackTextTokenLength(text, this.options.fallbackSettings?.());
	}

	private publish(): void {
		if (!this.disposed) {
			try { this.options.onUpdate?.(this.snapshot()); } catch { /* UI updates are best effort. */ }
		}
	}

	private clearTimers(): void {
		clearInterval(this.timer);
		clearImmediate(this.scheduled);
		this.timer = undefined;
		this.scheduled = undefined;
	}

	private clearText(): void {
		for (const channel of Object.values(this.channels)) {
			channel.pending = "";
			channel.tail = "";
		}
	}
}
