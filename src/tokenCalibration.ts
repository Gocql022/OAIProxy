import { createHash } from "crypto";
import type { Memento } from "vscode";
import { ESTIMATOR_REVISION, type TokenEstimationConfig } from "./tokenEstimationConfig";

interface CalibrationRecord {
	samples: number;
	ewma: number;
	updatedAt: number;
}
const STORAGE_KEY = "tokenEstimation.calibration.v2";

export function calibrationKey(
	endpoint: string,
	apiMode: string,
	modelId: string,
	settings: TokenEstimationConfig
): string {
	// Persist a digest, never endpoint query parameters, credentials, or message content.
	return createHash("sha256")
		.update(
			JSON.stringify([
				endpoint.replace(/\/+$/, ""),
				apiMode,
				modelId,
				ESTIMATOR_REVISION,
				{ ...settings, calibration: undefined },
			])
		)
		.digest("hex");
}

export class TokenCalibration {
	private records: Record<string, CalibrationRecord>;
	private writes: Promise<void> = Promise.resolve();

	constructor(private readonly state: Memento) {
		this.records = {};
		const stored = state.get<Record<string, CalibrationRecord>>(STORAGE_KEY, {});
		for (const [key, value] of Object.entries(stored ?? {})) {
			if (
				/^[a-f0-9]{64}$/.test(key) &&
				value &&
				Number.isFinite(value.ewma) &&
				value.ewma >= 1 &&
				value.ewma <= 2 &&
				Number.isSafeInteger(value.samples) &&
				value.samples >= 0 &&
				Number.isFinite(value.updatedAt)
			) {
				this.records[key] = value;
			}
		}
	}

	multiplier(key: string, mode: TokenEstimationConfig["calibration"]): number {
		const record = this.records[key];
		return mode === "adaptive" && record && record.samples >= 20 ? record.ewma : 1;
	}

	async observe(key: string, rawEstimate: number, actual: number, eligible: boolean): Promise<void> {
		if (!eligible || !Number.isFinite(rawEstimate) || !Number.isFinite(actual) || rawEstimate <= 0 || actual <= 0) {
			return;
		}
		const ratio = Math.max(1, Math.min(2, actual / rawEstimate));
		const previous = this.records[key];
		this.records[key] = {
			samples: (previous?.samples ?? 0) + 1,
			ewma: previous ? previous.ewma * 0.9 + ratio * 0.1 : ratio,
			updatedAt: Date.now(),
		};
		const entries = Object.entries(this.records)
			.sort((a, b) => b[1].updatedAt - a[1].updatedAt)
			.slice(0, 100);
		this.records = Object.fromEntries(entries);
		const snapshot = { ...this.records };
		this.writes = this.writes
			.catch(() => undefined)
			.then(async () => {
				await this.state.update(STORAGE_KEY, snapshot);
			});
		await this.writes;
	}
}
