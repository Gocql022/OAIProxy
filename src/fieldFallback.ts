import { executeWithRetry } from "./utils";
import type { RetryConfig } from "./types";
import { logger } from "./logger";

/**
 * 从不支持的字段错误文本中提取字段名。
 *
 * 支持常见网关的几种错误措辞：
 *   - "prompt_cache_retention" is not supported on this model
 *   - prompt_cache_retention is not supported
 *   - Unknown parameter: 'prompt_cache_retention'
 *   - Unrecognized request argument supplied: prompt_cache_retention
 *   - Unsupported parameter: prompt_cache_retention
 *
 * 返回 snake_case 字段名（不含引号），无法识别时返回 null。
 */
const UNSUPPORTED_FIELD_PATTERNS: RegExp[] = [
    // "field_name" is not supported [on this model] / field_name is not supported
    /["']?([A-Za-z_][A-Za-z0-9_.-]*)["']?\s+is not supported\b/i,
    // Unknown/Unrecognized/Unsupported/Invalid parameter|argument|field|option|property: 'field_name'
    /(?:unknown|unrecognized|unsupported|invalid)\s+(?:request\s+)?(?:parameter|argument|field|option|property)\s*(?:\bsupplied\b)?\s*[:\s]+["']?([A-Za-z_][A-Za-z0-9_.-]*)["']?/i,
];
/**
 * 声明"不支持"后禁止自动移除的字段（大小写不敏感比较）。
 *
 * 移除这些字段会导致请求语义变化：缓存字段被删会让网关缓存失效
 * （命中率下降、输入 token 重新计费），thinking 被删会改变模型行为，
 * previous_response_id 被删会丢失对话状态。因此这些字段一旦被网关
 * 拒绝，应直接按正常流程抛出错误，不做降级重试。
 *
 * 该集合可被 FetchWithFieldFallbackOptions.protectedFields 覆盖。
 */
export const PROTECTED_UNSUPPORTED_FIELDS: ReadonlySet<string> = new Set([
    "PROMPT_CACHE_KEY",
    "PROMPT_CACHE_RETENTION",
    "THINKING",
    "ENABLE_THINKING",
    "PREVIOUS_RESPONSE_ID",
]);

function toLowerCaseFieldSet(fields: ReadonlySet<string>): Set<string> {
    const normalized = new Set<string>();
    for (const field of fields) {
        normalized.add(field.toLowerCase());
    }
    return normalized;
}
export function parseUnsupportedFieldError(errorText: string): string | null {
    if (!errorText) {
        return null;
    }
    for (const pattern of UNSUPPORTED_FIELD_PATTERNS) {
        const match = pattern.exec(errorText);
        if (match) {
            return match[1];
        }
    }
    return null;
}

/** 大小写不敏感地检查请求体中是否存在指定字段。 */
export function bodyHasField(body: Record<string, unknown>, field: string): boolean {
    if (body[field] !== undefined) {
        return true;
    }
    const lowerField = field.toLowerCase();
    return Object.keys(body).some((key) => key.toLowerCase() === lowerField);
}

/** 大小写不敏感地从请求体中删除指定字段，返回是否删除成功。 */
export function deleteBodyField(body: Record<string, unknown>, field: string): boolean {
    if (body[field] !== undefined) {
        delete body[field];
        return true;
    }
    const lowerField = field.toLowerCase();
    const key = Object.keys(body).find((candidate) => candidate.toLowerCase() === lowerField);
    if (key !== undefined) {
        delete body[key];
        return true;
    }
    return false;
}

export interface FetchWithFieldFallbackOptions {
    readonly url: string;
    readonly headers: Record<string, string>;
    readonly body: object;
    readonly retryConfig: RetryConfig;
    readonly signal?: AbortSignal;
    /** 错误消息前缀，例如 "OAIProxy API"。 */
    readonly apiLabel: string;
    /** 字段被移除并重试时回调（可用来弹出提示）。 */
    readonly onFieldRemoved?: (field: string) => void;
    /**
     * 声明"不支持"后禁止自动移除的字段（大小写不敏感）。
     * 缺省使用 {@link PROTECTED_UNSUPPORTED_FIELDS}。
     */
    readonly protectedFields?: ReadonlySet<string>;
}

export interface FieldFallbackResult {
    readonly response: Response;
    /** 本次请求中因"不支持"而被移除并重试的字段。 */
    readonly removedFields: string[];
}

/**
 * 发送请求；当网关以 400/422 拒绝请求并声明某个字段不受支持时，
 * 自动移除该字段并以新的请求体重试（每个字段最多降级一次）。
 *
 * 抛出的错误结构与 executeWithRetry 一致（含 status / errorText 属性），
 * 因此调用方已有的基于 status 的降级逻辑（如 previous_response_id）不受影响。
 */
export async function fetchWithFieldFallback(options: FetchWithFieldFallbackOptions): Promise<FieldFallbackResult> {
    const { url, headers, body, retryConfig, signal, apiLabel, onFieldRemoved } = options;
    const mutableBody = body as Record<string, unknown>;
    const removedFields: string[] = [];
    const triedFields = new Set<string>();
    const protectedFields = toLowerCaseFieldSet(options.protectedFields ?? PROTECTED_UNSUPPORTED_FIELDS);

    while (true) {
        let unsupportedField: string | null = null;
        try {
            const response = await executeWithRetry(async () => {
                const res = await fetch(url, {
                    method: "POST",
                    headers,
                    body: JSON.stringify(body),
                    signal,
                });

                if (!res.ok) {
                    const errorText = await res.text();
                    if (res.status === 400 || res.status === 422) {
                        const field = parseUnsupportedFieldError(errorText);
                        if (field && bodyHasField(mutableBody, field) && !protectedFields.has(field.toLowerCase())) {
                            unsupportedField = field;
                        }
                    }
                    const error = new Error(
                        `${apiLabel} error: [${res.status}] ${res.statusText}${errorText ? `\n${errorText}` : ""}\nURL: ${url}`
                    );
                    (error as { status?: number; errorText?: string }).status = res.status;
                    (error as { status?: number; errorText?: string }).errorText = errorText;
                    throw error;
                }

                return res;
            }, retryConfig);

            return { response, removedFields };
        } catch (err) {
            if (unsupportedField) {
                triedFields.add(unsupportedField);
                if (deleteBodyField(mutableBody, unsupportedField)) {
                    removedFields.push(unsupportedField);
                    logger.warn("field.fallback", { url, field: unsupportedField });
                    onFieldRemoved?.(unsupportedField);
                }
                continue;
            }
            throw err;
        }
    }
}
