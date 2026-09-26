# Vision Bridge

OAIProxy can automatically describe images for text-only models. When a model has `"vision": false` set explicitly, any images in chat messages are automatically sent to a separately configured vision-capable model first, and the resulting text description is forwarded in place of the image.

> **Note**: You must explicitly set `"vision": false` to enable the bridge. Omitting the `vision` field will not trigger the bridge.

This means you can use images with models that don't natively support vision — useful when your preferred coding model lacks vision capabilities but you still want to share screenshots or diagrams.

## Enabling / Disabling

The bridge is enabled by default (`"oaicopilot.visionBridgeEnabled": true`). You can turn it off from the Configuration UI (Global Configuration → Vision Bridge → **Enable Vision Bridge**) or directly in settings:

```json
"oaicopilot.visionBridgeEnabled": false
```

When disabled, OAIProxy no longer advertises image support for `"vision": false` models and leaves images untouched — the provider will receive the image parts as-is (and may reject them).

## How it works

1. When a chat message contains an image and the target model has `"vision": false`, OAIProxy finds a configured model with `"vision": true` (or the model set via `oaicopilot.visionBridgeModel`).
2. The image is sent to the vision model with a prompt asking for a detailed description (customizable via `oaicopilot.visionBridgePrompt`).
3. The description is injected as text into the message sent to the text-only model.
4. Results are cached (SHA-256 keyed LRU, 50 entries / ~500KB) for the session lifetime.

## Configuration Example

Configure at least one vision-capable model alongside your text-only models:

```json
"oaicopilot.models": [
    {
        "id": "Qwen/Qwen3-Coder-480B-A35B-Instruct",
        "owned_by": "modelscope",
        "vision": false
    },
    {
        "id": "Qwen/Qwen2.5-VL-72B-Instruct",
        "owned_by": "modelscope",
        "vision": true
    }
]
```

With this setup, images sent to the text-only `Qwen3-Coder` model are automatically described by the vision-capable `Qwen2.5-VL` model.

## Selecting the Vision Bridge Model

By default OAIProxy picks the first available model with `"vision": true`. To pin a specific model, set `oaicopilot.visionBridgeModel` to any registered language model id — it does not have to come from the OAIProxy provider:

```json
"oaicopilot.visionBridgeModel": "Qwen/Qwen2.5-VL-72B-Instruct"
```

For models with multiple configurations, use the full id `baseId::configId` (for example `Qwen/Qwen2.5-VL-72B-Instruct::myconfig`). Leave the value empty to fall back to automatic selection.

In the Configuration UI (Global Configuration → Vision Bridge) the dropdown lists only the models you configured with `"vision": true`, plus **Auto (first configured vision model)**. To use a model id that is not in that list — for example one provided by another extension — set `oaicopilot.visionBridgeModel` directly in `settings.json`.

## Customizing the Vision Bridge Prompt

The default prompt is:

```
Describe this image. Include visible text, code, UI, diagrams, and other important details.
```

Override it with `oaicopilot.visionBridgePrompt` (also editable in the Configuration UI). An empty value restores the default prompt.

```json
"oaicopilot.visionBridgePrompt": "Transcribe all text verbatim and describe the layout of this screenshot."
```

## Requirements

- At least one model with `"vision": true` must be configured and available, or `oaicopilot.visionBridgeModel` must point to an available model.
- The vision model must be registered under the OAIProxy provider (unless overridden with `oaicopilot.visionBridgeModel`).
