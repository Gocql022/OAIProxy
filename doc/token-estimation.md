# Token estimation and tool-result images

OAIProxy decodes UTF-8 text DataParts and sends supported tool-result images as images. It never serializes image byte arrays as numeric JSON tool text. Unsupported binary parts become short MIME/size placeholders. Unknown objects use bounded serialization with binary placeholders, cycle detection, and a visible truncation marker. Ordinary text outputs are preserved in full.

Anthropic receives image blocks inside `tool_result`. Chat Completions, Responses (including Codex OAuth), Gemini, and Ollama receive textual tool responses followed by a user message containing the associated images. All results in a consecutive parallel tool-call batch precede that companion message. IDs and image order are preserved. Text-only models use the existing Vision Bridge when configured; otherwise images become placeholders. A configured but unavailable or failing bridge still reports an error.

## Counting and budgets

Text uses the existing bundled `o200k_base` tokenizer. It is an estimate for models with different tokenizers. If initialization/tokenization fails, the fallback counts ASCII characters at 1/4 token and non-ASCII Unicode code points at one token. Tool names, arguments, results, definitions, and emitted reasoning are included. Usage, cache-control, and Responses state metadata are excluded from prompt text.

The final guard reads the prepared request after conversion and Vision Bridge processing, counting semantic content and framing allowances rather than JSON envelopes or base64 characters. Status bar and diagnostics use that report. For Responses continuation, the guard counts the full logical history even when only the delta is transmitted; cached tokens still occupy context. Explicit externally managed `previous_response_id` histories that are absent from the supplied messages cannot be reconstructed locally.

VS Code's `provideTokenCount` uses the same content normalization, tokenizer, and image profiles. It does not initiate network requests. An uncached bridge image receives a provisional allowance; once a description is cached, it can count that description. Actual bridge text is counted again before the target request. Adapter framing/grouping and unavailable server history mean per-message totals need not exactly equal the prepared-request total or server usage. Correct accounting does not guarantee Copilot compaction behavior.

The hard guard and existing advertised budget remain enabled. In particular, a configured 1,050,000-token context is currently normalized to 1,000,000 for the model picker, leaving 872,000 input tokens after a 128,000 output reserve. This change does not modify context limits or verify private OAuth endpoint limits.

## Image estimates

PNG, JPEG, GIF, and WebP dimensions are read from bytes without decoding pixels. Bounds checks respect typed-array offsets. Invalid/unsupported headers use the fallback. Unknown model aliases use the fallback instead of inheriting a rule solely from the API mode. Supported profiles are:

| Profile | Rule |
| --- | --- |
| `auto` | Recognized OpenAI or Claude model ID selects a documented profile; other IDs use `unknown`. |
| `openai-patches` | 32-pixel patches, model/detail-specific resizing and multiplier. Astra auto/original does not use the high-detail 2,500-patch cap. |
| `openai-tiles` | Model-specific base and 512-pixel tile cost after documented resizing. |
| `claude-standard` | 28-pixel patches, 1,568-pixel long edge and 1,568-patch budget. |
| `claude-high` | 28-pixel patches, 2,576-pixel long edge and 4,784-patch budget. |
| `unknown` | Configurable fixed fallback, initially 8,192 tokens per image. |

OpenAI profiles follow the [official vision guide](https://developers.openai.com/api/docs/guides/images-vision); Claude profiles follow the [official vision guide](https://platform.claude.com/docs/en/build-with-claude/vision), reviewed September 29, 2026. Counts remain estimates, particularly on gateway and OAuth routes. Gemini and local/other gateway aliases use the explicit fallback until a documented matching profile or user override is available. Native video input retains its existing transport and receives the image fallback allowance as a labeled heuristic; no video tokenizer is claimed.

For a 744×1053 image, Astra's profile estimates 951 image tokens; Claude estimates 1,026. Compression/file size does not change those counts. The estimator does not resize or recompress the image and does not guarantee upstream image-size acceptance. An unknown/header fallback of 8,192 is an uncalibrated allowance, not an upper bound for every model or image.

## Settings

Settings use the existing `oaicopilot` namespace. Defaults:

```jsonc
"oaicopilot.tokenEstimation": {
  "charsPerToken": 4,
  "nonAsciiTokensPerChar": 1,
  "maxSerializedPartChars": 200000,
  "bridgeTokens": 8192,
  "calibration": "observe",
  "image": {
    "strategy": "auto",
    "profile": "auto",
    "fixedTokens": 8192,
    "fallbackTokens": 8192,
    "areaDivisor": 750,
    "maxLongEdge": 2576,
    "maxTokensPerImage": 8192
  },
  "perModel": {}
},
"oaicopilot.debug.tokenBreakdown": false
```

`strategy: "fixed"` uses `fixedTokens`. `strategy: "area"` is an explicit custom heuristic: scale down to `maxLongEdge`, then divide pixel area by `areaDivisor` and cap at `maxTokensPerImage`. These area defaults are not the automatic rule for any provider. `fallbackTokens` handles unreadable headers and unknown models. A profile override is useful for gateway aliases; choose the profile matching the actual underlying model. OpenAI profile overrides for unrecognized names use the generic 1.2× patch/high-detail limits or 85+170 tile formula, respectively.

Overrides merge in order: defaults, global fields, base model ID, full `modelId::configId`. Image subfields merge at each step. For example:

```jsonc
"oaicopilot.tokenEstimation": {
  "perModel": {
    "local-vision::ollama": {
      "image": { "strategy": "fixed", "fixedTokens": 4096 }
    }
  }
}
```

Invalid values fall back to defaults. No legacy switch restores binary serialization. Changing estimation settings affects subsequent requests without installing another extension build.

## Diagnostics and calibration

Enable both `oaicopilot.logLevel: "debug"` and `oaicopilot.debug.tokenBreakdown: true`. The OAIProxy output/file log includes:

- `request.tokenBreakdown`: correlated request ID, logical/transmitted estimates, categories, part-type totals, largest five parts, and image profile/confidence.
- `request.tokenComparison`: estimate, reported input usage, actual/estimate ratio, usage availability, and calibration eligibility.
- `request.contextTooLarge`: budget and largest parts. The user-facing error also names those parts.

These events contain types, IDs and sizes only, never message text or base64. Image contributors retain source message/part/call information; other prepared contributors identify their converted message/part position. Missing streaming usage is unreported, never zero. Existing adapter usage normalization covers cached input, including Anthropic cache creation/read tokens.

`calibration: "observe"` records numeric EWMA state without changing estimates. `"adaptive"` applies a multiplier after 20 eligible completed stateless text-only requests. EWMA α=0.1, bounded [1,2], never reduces estimates. Image/video, Vision Bridge, diagnostic, cancelled, unreported-usage and stateful requests are excluded. Actual usage is compared to the uncalibrated estimate to avoid feedback amplification. Cached input is not subtracted. Records are isolated by endpoint, API mode, full model/config ID and estimation settings/revision; only digests and numeric state are persisted, up to 100 profiles.

## Validation limits

Headless tests cover valid PNGs with different byte sizes, all five adapters, parallel tool ordering, decoding/unknown binaries, image headers, tokenizer failure, configuration, Vision Bridge, calibration and a localhost HTTP replay. A live Copilot/OAuth replay requires the user to install the test extension. Verify actual image understanding and streaming usage there; do not treat local conversion tests as evidence that an upstream model saw an image. Collect at least 20 real eligible requests before assessing calibration accuracy. No new dependencies are required.
