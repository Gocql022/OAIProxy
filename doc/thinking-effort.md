# Thinking Effort Control

VS Code 1.120+ exposes a **Thinking Effort** dropdown in the model picker, allowing you to adjust how much reasoning the model performs — without editing your settings JSON.

OAIProxy surfaces this control automatically for any model that has a `reasoning_effort`, `reasoning.effort`, `default_reasoning_effort`, or `supported_reasoning_efforts` configured. The direct DeepSeek Flash Quick Setup card offers `low`, `high`, and `max`, with `max` selected by default.

## How to enable Thinking Effort in the picker

Add `supports_reasoning_effort: true` to your model config, or set `supported_reasoning_efforts`:

```json
"oaicopilot.models": [
    {
        "id": "gpt-5-codex",
        "owned_by": "openai",
        "baseUrl": "https://api.openai.com/v1",
        "apiMode": "openai-responses",
        "supports_reasoning_effort": true,
        "supported_reasoning_efforts": ["minimal", "low", "medium", "high", "xhigh", "max"],
        "default_reasoning_effort": "high",
        "reasoning_effort": "high",
        "extra": {
            "reasoning": {
                "summary": "detailed"
            }
        }
    },
    {
        "id": "deepseek-v3.2",
        "owned_by": "deepseek",
        "reasoning_effort": "high",
        "supports_reasoning_effort": true
    }
]
```

## New model fields

| Field | Type | Description |
|---|---|---|
| `supports_reasoning_effort` | `boolean` | Expose VS Code's per-model Thinking Effort control |
| `supported_reasoning_efforts` | `string[]` | Custom list of effort values shown in the dropdown |
| `default_reasoning_effort` | `string` | Pre-selected effort value when the model is first picked |

Models with `reasoning_effort`, `reasoning.effort`, or `default_reasoning_effort` also expose the control automatically.
If `default_reasoning_effort` is omitted, OAIProxy still sends VS Code a safe picker default (`medium` when available, Claude `high`, otherwise the first supported value) so newer VS Code builds can open the dropdown correctly.

## DeepSeek models

The direct `deepseek-flash` model with provider `deepseek` preserves `low`, `high`, and `max`. Its Quick Setup card enables thinking and selects `max` by default. Compatibility aliases follow the official [Thinking Mode guide](https://api-docs.deepseek.com/guides/thinking_mode):

- `minimal` → `low`
- `medium`/`xhigh` → `high`
- `ultra` → `max`

Other DeepSeek models retain the legacy effort mapping (TokenRouter uses its configured tiers):

- `low`/`medium`/`high` → maps to `high`
- `xhigh`/`max` → maps to `max`

When no custom `supported_reasoning_efforts` list is configured, the DeepSeek picker falls back to `high` and `max`.

## Anthropic Claude models

Claude Sonnet 4.6, Claude Opus 4.6, Claude Opus 4.7, Claude Opus 4.5, and Claude Mythos Preview expose the picker automatically. OAIProxy maps the selected value to Anthropic's `output_config.effort`; for Claude Sonnet 4.6 and other adaptive-thinking models, OAIProxy also sends `thinking: { "type": "adaptive" }` unless you explicitly disable thinking.

Claude Sonnet 4.6 shows `low`, `medium`, `high`, and `max`. `xhigh` is only exposed for Claude Opus 4.7.
