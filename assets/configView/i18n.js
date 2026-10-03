// OAIProxy Configuration View - i18n support.
//
// The UI locale is injected by the extension into the <html lang="..."> attribute
// (from vscode.env.language). When the VS Code display language is Chinese
// (zh / zh-cn / zh-tw / ...), the webview UI switches to Simplified Chinese.
// Any other (or unsupported) locale keeps the built-in English strings as fallback.
//
// Usage:
//   - HTML: add data-i18n="English text" or data-i18n-placeholder="English text".
//   - JS:   const label = configView_l10n_t("English text", arg0, arg1); // {0}, {1}... placeholders
(function () {
	"use strict";

	const UI_LOCALE = (document.documentElement.lang || navigator.language || "en").toLowerCase();
	const IS_ZH = UI_LOCALE.startsWith("zh");

	// English string -> Simplified Chinese translation.
	// Keep the keys byte-for-byte identical to the source English strings.
	const I18N_ZH_CN = {
		// Page
		"OAIProxy Configuration": "OAIProxy 配置",
		"Configuration": "配置",
		"Loading configuration...": "正在加载配置…",
		"Unable to load configuration. Retry to continue.": "无法加载配置。请重试以继续。",
		"Retry": "重试",

		// Global configuration
		"Global Configuration": "全局配置",
		"Export": "导出",
		"Import": "导入",
		"Refresh": "刷新",
		"Global Base URL": "全局 Base URL",
		"The base URL for the Openai Compatible Inference API.": "OpenAI 兼容 API 的 Base URL。",
		"Global API Key": "全局 API 密钥",
		"The API Key for Authentication.": "用于验证的 API 密钥。",
		"Delay (ms)": "延迟（毫秒）",
		"Fixed delay in milliseconds between consecutive requests.": "连续请求之间的固定延迟（毫秒）。",
		"Read File Lines": "文件读取行数",
		"Number of lines to read when using `read_file` tool. Large lines may cost more tokens. Default is 0, let model decide lines.":
			"使用 `read_file` 工具时读取的行数。行数过多可能会消耗更多的 token。默认 0，由模型决定读取的行数。",
		"Retry Configuration": "重试配置",
		"Enable Retry": "启用重试",
		"Enable retry mechanism for api errors.": "为 API 错误启用重试机制。",
		"Max Attempts": "最大重试次数",
		"Maximum number of retry attempts.": "重试请求的最大重试次数。",
		"Retry Interval (ms)": "重试间隔（毫秒）",
		"Interval between retry attempts in milliseconds.": "重试请求之间的间隔（毫秒）。",
		"Retry Status Codes (comma separated)": "重试状态码（以英文逗号分隔）",
		"Additional HTTP status codes that will be merged.": "需要发出重试请求的 HTTP 状态码。",
		"Git Commit Message": "Git 提交消息",
		"Git Commit Model": "Git 提交模型",
		"Select the model to be used for Git commit message generation.": "选择用于生成 Git 提交消息的模型。",
		"Commit Language": "提交信息语言",
		"Language for generated Git commit messages.": "生成的 Git 提交消息使用的语言。",
		"Vision Bridge": "视觉桥接",
		"Enable Vision Bridge": "启用视觉桥接",
		"Describe images for text-only models using a vision-capable model. Disable this to stop advertising image support for text-only models and leave images untouched.":
			"使用具备视觉能力的模型为纯文本模型描述图像，关闭后将不再为纯文本模型提供图像支持。",
		"Vision Bridge Model": "视觉桥接模型",
		"Model used to describe images for text-only models. Pick one from the configured vision-capable models. Leave empty for automatic selection.":
			"用于为纯文本模型描述图像的模型。从启用视觉能力的模型中选择。留空则自动选择。",
		"Auto (first configured vision model)": "自动（第一个已配置的视觉模型）",
		"Vision Bridge Prompt": "视觉桥接提示词",
		"Custom prompt used to describe images. Leave empty to use the default prompt.":
			"用于描述图像的自定义提示词。留空则使用默认提示词。",
		"Describe this image. Include visible text, code, UI, diagrams, and other important details.":
			"描述这张图片。包括可见的文字、代码、界面、图表以及其他重要细节。",
		"Save Global Configuration": "保存全局配置",

		// Provider management
		"Provider Management": "供应商管理",
		"Add Provider": "添加供应商",
		"Sign in": "登录",
		"Sign out": "退出",
		"OAuth · Signed in": "OAuth · 已登录",
		"OAuth · Sign in required": "OAuth · 需要登录",
		"Provider ID: {0}": "供应商 ID：{0}",
		"Provider ID": "供应商 ID",
		"Base URL": "Base URL",
		"API Key": "API 密钥",
		"Auth Method": "认证方式",
		"API Mode": "API 模式",
		"Custom Headers (JSON)": "自定义请求头 (JSON)",
		"Actions": "操作",

		// Model management
		"Model Management": "模型管理",
		"Test all": "全部测试",
		"Add Model": "添加模型",
		"Model ID": "模型 ID",
		"Display Name": "显示名称",
		"Context Length": "上下文长度",
		"Max Tokens": "最大 Token",
		"Max Completion Tokens": "最大补全 Token",
		"Supports Vision": "支持视觉",
		"Add New Model": "添加新模型",
		"Quick Setup": "快速设置",
		"Manual Setup": "手动设置",
		"Search Presets": "搜索预设",
		"Search model or provider": "搜索模型或供应商",
		"Provider": "供应商",
		"All providers": "所有供应商",
		"Category": "类别",
		"All categories": "所有类别",
		"Latest": "最新",
		"Recommended": "推荐",
		"Fast": "快速",
		"Local": "本地",
		"Provider Status": "供应商状态",
		"All statuses": "所有状态",
		"Configured": "已配置",
		"Provider Ready": "供应商就绪",
		"Key Needed": "需要 API 密钥",
		"Provider Needed": "需要供应商",
		"OAuth Sign-in Required": "需要使用 OAuth 登录",
		"Select a preset to review its ready-to-save configuration.": "选择一个预设以查看其可直接保存的配置。",
		"Add Selected": "添加所选",
		"Remove Selected": "移除所选",
		"Clear Selection": "清除选择",
		"Customize Preset": "自定义预设",
		"Provider ID *": "供应商 ID *",
		"Model provider.": "模型供应商。",
		"Select Provider": "选择供应商",
		"Provider API Key": "供应商 API 密钥",
		"Stored under the selected provider. Leave blank to keep a saved key.":
			"保存在所选供应商下。留空以保留已保存的密钥。",
		"Saved - leave blank": "已保存 - 留空",
		"Model support vision.": "模型是否支持视觉。",
		"Default (False)": "默认（否）",
		"Default (True)": "默认（是）",
		"True": "是",
		"False": "否",
		"Tool Calling": "工具调用",
		"Advertise tools to VS Code. Disable to skip Agent tool selection.": "向 VS Code 通告工具支持。禁用可跳过 Agent 工具选择。",
		"'openai' for API (/chat/completions), 'azure-foundry' for Azure Foundry (/chat/completions with api-key), 'litellm' for LiteLLM Proxy (/chat/completions), 'openai-responses' for API (/responses), 'ollama' for API (/api/chat), 'anthropic' for API (/v1/messages), 'gemini' for API (/v1beta/models/{model}:streamGenerateContent?alt=sse).":
			"'openai' 使用 API (/chat/completions)，'azure-foundry' 使用 Azure Foundry (/chat/completions with api-key)，'litellm' 使用 LiteLLM 代理 (/chat/completions)，'openai-responses' 使用 API (/responses)，'ollama' 使用 API (/api/chat)，'anthropic' 使用 API (/v1/messages)，'gemini' 使用 API (/v1beta/models/{model}:streamGenerateContent?alt=sse)。",
		"Model ID *": "模型 ID *",
		"Model ID (e.g., gpt-4, claude-3).": "模型 ID（例如 gpt-4、claude-3）。",
		"e.g., gpt-4, claude-3": "例如 gpt-4、claude-3",
		"Select Model": "选择模型",
		"Config ID": "配置 ID",
		"Configuration ID for this model. Allows defining the same model with different settings (e.g. 'glm-4.6::thinking', 'glm-4.6::no-thinking').":
			"此模型的配置 ID。允许为同一模型定义不同配置（例如 'glm-4.6::thinking'、'glm-4.6::no-thinking'）。",
		"e.g., thinking, no-thinking": "例如 thinking、no-thinking",
		"Base URL for the model provider.": "模型供应商的 Base URL。",
		"Maximum context length.": "最大上下文长度。",
		"Maximum number of tokens to generate (range: [1, context_length)).": "生成的最大 token（范围：[1, context_length)）。",
		"Maximum output tokens (OpenAI new standard - takes precedence over Max Tokens if both are set).":
			"最大输出 token （OpenAI 新标准 - 两者都设置时优先于最大 Token ）。",
		"Temperature": "Temperature",
		"Sampling temperature (range: [0, 2]). Default is 0.": "采样温度（范围：[0, 2]）。默认 0。",
		"Top P": "Top P",
		"Top-p sampling value (range: (0, 1]).": "Top-p 采样值（范围：(0, 1]）。",
		"Model-specific delay in milliseconds between consecutive requests.": "该模型在连续请求之间的延迟（毫秒）。",
		"Show Advanced Settings": "显示高级设置",
		"Hide Advanced Settings": "隐藏高级设置",
		"Display name for the model that will be shown in the Copilot interface.":
			"在 Copilot 界面中显示的模型名称。",
		"e.g., GPT-4 Turbo": "例如 GPT-4 Turbo",
		"Model Family": "模型系列",
		"Model family (e.g., 'gpt-4', 'claude-3', 'gemini'). Enables model-specific optimizations and behaviors.":
			"模型系列（例如 'gpt-4'、'claude-3'、'gemini'）。启用模型特定的优化和行为。",
		"Expose Thinking Effort": "公开思考力度",
		"Expose VS Code's per-model Thinking Effort picker.": "公开 VS Code 的模型思考力度选择器。",
		"Supported Thinking Efforts": "支持的思考力度",
		"Comma-separated values such as low, medium, high.": "逗号分隔的值，如 low、medium、high。",
		"Default Thinking Effort": "默认思考力度",
		"Default value for VS Code's Thinking Effort picker.": "VS Code 思考力度选择器的默认值。",
		"None": "None",
		"Minimal": "Minimal",
		"Low": "Low",
		"Medium": "Medium",
		"High": "High",
		"XHigh": "XHigh",
		"Max": "Max",
		"Top K": "Top K",
		"Top-k sampling value (range: [1, Infinity)).": "Top-k 采样值（范围：[1, ∞)）。",
		"Min P": "Min P",
		"Minimum probability threshold (range: [0, 1]).": "最低概率阈值（范围：[0, 1]）。",
		"Thinking Budget": "思考预算",
		"Maximum number of tokens for chain-of-thought output.": "思维链输出的最大 token 数。",
		"Frequency Penalty": "Frequency Penalty",
		"Frequency penalty (range: [-2, 2]).": "频率惩罚（范围：[-2, 2]）。",
		"Presence Penalty": "Presence Penalty",
		"Presence penalty (range: [-2, 2]).": "存在惩罚（范围：[-2, 2]）。",
		"Repetition Penalty": "Repetition Penalty",
		"Repetition penalty (range: (0, 2]).": "重复惩罚（范围：(0, 2]）。",
		"Include Reasoning": "包含推理",
		"Include reasoning_content in assistant messages sent to the API.": "在发送给 API 的助手消息中包含 reasoning_content。",
		"Thinking Type": "思考类型",
		'Include "thinking.type" in request body.': '在请求体中包含 "thinking.type"。',
		"Enabled": "启用",
		"Disabled": "禁用",
		"Enable Thinking": "启用思考",
		'Include "enable_thinking" in request body.': '在请求体中包含 "enable_thinking"。',
		"Reasoning Effort (OpenAI)": "推理力度 (OpenAI)",
		'Include "reasoning_effort" in request body.': '在请求体中包含 "reasoning_effort"。',
		"Reasoning Configuration (OpenRouter)": "推理配置 (OpenRouter)",
		"Reasoning Enabled": "启用推理",
		"Enable reasoning params in request body.": "在请求体中启用推理参数。",
		"Reasoning Effort": "推理力度",
		'Include "reasoning.effort" in request body.': '在请求体中包含 "reasoning.effort"。',
		"Reasoning Exclude": "排除推理",
		'Include "reasoning.exclude" in request body.': '在请求体中包含 "reasoning.exclude"。',
		"Reasoning Max Tokens": "推理最大 Token 数",
		'Include "reasoning.max_tokens" in request body.': '在请求体中包含 "reasoning.max_tokens"。',
		"Custom HTTP headers to be sent with every request to this model.": "每次请求此模型时发送的自定义 HTTP 请求头。",
		"Extra Parameters (JSON)": "额外参数 (JSON)",
		"Extra request body parameters to be sent with every request to this model.":
			"每次请求此模型时发送的额外请求体参数。",
		"Extra Body (JSON)": "Extra Body (JSON)",
		"LiteLLM extra_body parameters for provider/proxy-specific options.": "LiteLLM 的 extra_body 参数，用于供应商/代理特定选项。",
		"Prompt Cache (JSON)": "提示缓存 (JSON)",
		"Provider-aware prompt/KV cache configuration.": "供应商感知的提示/KV 缓存配置。",
		"Save Model": "保存模型",
		"Cancel": "取消",
		"Yes": "是",
		"No": "否",

		// Export / import
		"Include API keys in the exported configuration?": "导出配置中包含 API 密钥？",

		// Provider usage check
		"Provider Usage Check": "供应商余额检查",
		"Check All": "全部检查",
		"Usage Plan": "用量套餐",
		"Remaining / Usage": "剩余 / 已使用",
		"Usage Key": "余额检查密钥",
		"Status": "状态",
		"Action": "操作",

		// Dynamic strings (JS)
		"Checking usage...": "正在检查余额...",
		"Custom provider": "自定义供应商",
		"Testing {0} of {1} model(s)...": "正在测试 {0}/{1} 个模型...",
		"Connection test failed.": "连接测试失败。",
		"Testing": "测试中",
		"Passed": "通过",
		"Failed": "失败",
		"Connected in {0}": "连接耗时 {0}",
		"provider setup is missing for {0}": "缺少 {0} 的供应商配置",
		"API key is not saved for {0}": "未保存 {0} 的 API 密钥",
		"Cannot add selected model(s): {0}. Open OAIProxy Configuration > Provider Management and add the provider base URL/API mode/API key, or use the provider API key command, then try Add Selected again.":
			"无法添加所选模型：{0}。请打开 OAIProxy 配置 > 供应商管理，添加供应商的 Base URL/API 模式/API 密钥，或使用供应商 API 密钥命令，然后再试“添加所选”。",
		"Are you sure you want to delete model {0}?": "确定要删除模型 {0} 吗？",
		"Remove {0} selected configured model(s)?": "移除所选 {0} 个已配置的模型？",
		"Are you sure you want to delete provider {0} and all its models?": "确定要删除供应商 {0} 及其所有模型吗？",
		"provider only": "仅供应商",
		"+{0} more": "还有{0}个...",
		"Unavailable": "不可用",
		"Not checked": "未检查",
		"Checking": "检查中",
		"Error": "错误",
		"Checked": "已检查",
		"Usage check completed.": "余额检查完成。",
		"Usage check failed.": "余额检查失败。",
		"Not used": "不使用",
		"Admin usage key": "管理员余额检查密钥",
		"Provider API key": "供应商 API 密钥",
		"No configured providers have known usage-check behavior yet": "尚无具有用量检查功能的已配置供应商",
		"No API endpoint": "无 API 端点",
		"Checking...": "检查中...",
		"Check": "检查",
		"Select one or more presets to add or remove configured models.": "选择一个或多个预设以添加或移除已配置的模型。",
		"Provider: {0}": "供应商：{0}",
		"API: {0} inherited": "API：{0}（继承）",
		"Context: {0}": "上下文：{0}",
		"Key: {0}": "密钥：{0}",
		"Saved/optional": "已保存/可选",
		"Not saved": "未保存",
		"{0} preset(s) selected": "已选择 {0} 个预设",
		"Add ready: {0}": "可添加：{0}",
		"Remove ready: {0}": "可移除：{0}",
		"Providers needed: {0}": "需要供应商：{0}",
		"Keys not saved: {0}": "未保存密钥：{0}",
		"No matching model presets": "没有匹配的模型预设",
		"Remove": "移除",
		"{0} out": "{0} 最大输出",
		"{0} ctx": "{0} 上下文",
		"Close": "关闭",
		"Save": "保存",
		"Error fetching models": "获取模型失败",
		"Failed to fetch models. Check the Developer Console for details.": "获取模型失败，请查看开发者控制台了解详情。",
		"No configured models to test.": "没有可测试的已配置模型。",
		"{0} passed, {1} failed in {2}.": "{2} 内 {0} 个通过，{1} 个失败。",
		"No providers": "没有供应商",
		"model": "个模型",
		"models": "个模型",
		"Saved - leave blank to keep": "已保存 - 留空以使用当前密钥",
		"Clear Key": "清除密钥",
		"Delete": "删除",
		"Testing...": "测试中...",
		"No models": "没有模型",
		"Test": "测试",
		"Edit": "编辑",
		"Edit Model: {0}": "编辑模型：{0}",
		"Select Model ({0} available)": "选择模型（{0} 个可用）",
		"No models available": "没有可用模型",
		"Select Model ({0} matching)": "选择模型（{0} 个匹配）",
		"Model ID is required.": "必须填写模型 ID。",
		"Provider ID is required.": "必须填写供应商 ID。",
		"Provider API Key is required for models with a provider Base URL.": "带有供应商 Base URL 的模型必须填写供应商 API 密钥。",
		"A model with ID=\"{0}\"{1} already exists. Model ID and Config ID combination must be unique.":
			"已存在 ID=\"{0}\"{1} 的模型。模型 ID 和配置 ID 的组合必须唯一。",
		" and Config ID=\"{0}\"": " 且配置 ID=\"{0}\"",
		"Context Length must be a positive number.": "上下文长度必须为正数。",
		"Max Tokens must be a positive number.": "最大 Token 必须为正数。",
		"Max Completion Tokens must be a positive number.": "最大补全 Token 必须为正数。",
		"Cannot set both 'max_tokens' and 'max_completion_tokens'. Use 'max_completion_tokens' only.":
			"不能同时设置 'max_tokens' 和 'max_completion_tokens'。只能使用 'max_completion_tokens'。",
		"Temperature must be between 0 and 2.": "Temperature 必须在 0 到 2 之间。",
		"Top P must be between 0 and 1.": "Top P 必须在 0 到 1 之间。",
		"Delay must be a non-negative number.": "延迟必须为零或正数。",
		"{0} must be a valid JSON object.": "{0} 必须是有效的 JSON 对象。",
		"Enter provider API key": "输入供应商 API 密钥",
		"Optional; defaults to ollama": "可选；默认使用 ollama",
		"Provider preset": "供应商预设",
		"Credit": "余额",
		"Token": "Token",
		"Token usage": "已使用Token",
		"Cost usage": "已消耗费用",
		"Proxy key spend": "代理密钥消耗",
		"Remaining credit balance": "剩余余额",
		"Tokens left and reset time": "剩余 Token 及重置时间",
		"Month-to-date serverless tokens": "本月至今无服务器 Token 用量",
		"Month-to-date spend": "本月至今费用",
		"Virtual key spend and budget": "虚拟密钥消耗和预算",
		"Not supported": "不支持",
		"Xiaomi MiMo usage checks are unavailable because Xiaomi only exposes balance/usage through web Console endpoints; no public API-key usage endpoint is documented.":
			"小米 MiMo 用量检查不可用，因为小米仅通过网页控制台端点暴露余额/用量；没有公开的 API 密钥用量端点。",
		"Z.AI usage checks are unavailable because Z.AI currently documents API keys and console billing/usage pages, but not a public API-key usage or balance endpoint.":
			"Z.AI 用量检查不可用，因为 Z.AI 目前只提供 API 密钥和控制台账单/用量页面，没有公开的 API 密钥用量或余额端点。",
		"No selected unconfigured presets to add.": "未选中任何未配置的预设，取消添加。",
		"No selected configured presets to remove.": "未选中任何已配置的预设，取消移除。",

		// Model preset capability tags (brand names such as OpenAI / xAI / Grok
		// stay untranslated and fall back to the English source string).
		"Adaptive Thinking": "自适应思考",
		"Cache": "缓存",
		"Chat Completions": "Chat Completions",
		"Code": "代码",
		"Coding": "编程",
		"Prompt Cache": "提示词缓存",
		"Reasoning": "推理",
		"Responses": "响应",
		"Stable": "稳定",
		"Thinking": "思考",
		"Tools": "工具",
		"Vision": "视觉",

		// Model preset descriptions (keys must match src/modelPresets.ts).
		"Anthropic's high-capability Claude model for complex reasoning and agentic coding.":
			"Anthropic 的高能力 Claude 模型，适用于复杂推理与智能体编程。",
		"Balanced Claude setup for coding, agent workflows, and daily production use.":
			"均衡的 Claude 配置，适用于编程、智能体工作流与日常生产使用。",
		"Coding model with 1M context and thinking.": "具备 1M 上下文与思考能力的编程模型。",
		"Cost-conscious Kimi multimodal setup for dialogue and agent tasks.":
			"注重成本的 Kimi 多模态配置，适用于对话与智能体任务。",
		"DeepSeek V4.1 Flash through the LiteLLM proxy sample endpoint with vision, thinking, and tools.":
			"通过 LiteLLM 代理示例端点使用 DeepSeek V4.1 Flash，支持视觉、思考与工具。",
		"DeepSeek V4.1 Flash with vision, thinking, and tools through the OpenAI-compatible endpoint.":
			"通过 OpenAI 兼容端点使用 DeepSeek V4.1 Flash，支持视觉、思考与工具。",
		"DeepSeek V4 Pro 0813 through TokenRouter's OpenAI-compatible gateway.":
			"通过 TokenRouter 的 OpenAI 兼容网关使用 DeepSeek V4 Pro 0813。",
		"DeepSeek V4 Pro through Azure Foundry with max reasoning and automatic model caching.":
			"通过 Azure Foundry 使用 DeepSeek V4 Pro，启用最高推理等级与自动模型缓存。",
		"DeepSeek V4 Pro through Fireworks serverless inference.":
			"通过 Fireworks 无服务器推理使用 DeepSeek V4 Pro。",
		"DeepSeek V4 Pro with thinking mode enabled for agentic coding workflows.":
			"启用思考模式的 DeepSeek V4 Pro，适用于智能体编程工作流。",
		"Fast Gemini 3 preview setup for high-volume multimodal work.":
			"快速的 Gemini 3 预览配置，适用于高负载多模态工作。",
		"Fast multimodal model with 1M context.": "具备 1M 上下文的快速多模态模型。",
		"Fast Xiaomi MiMo V2.6 model for frequent calls and large-scale professional workflows.":
			"快速的 Xiaomi MiMo V2.6 模型，适用于高频调用与大规模专业工作流。",
		"Fast Xiaomi MiMo V2 option for lower-cost responses and everyday agent work.":
			"快速的 Xiaomi MiMo V2 选项，适用于更低成本的响应与日常智能体工作。",
		"GLM-5.2 through Fireworks serverless inference.": "通过 Fireworks 无服务器推理使用 GLM-5.2。",
		"GLM-5.3-Flash through the LiteLLM proxy sample endpoint with vision and upstream-default thinking.":
			"通过 LiteLLM 代理示例端点使用 GLM-5.3-Flash，支持视觉与上游默认思考。",
		"GLM-5.3 through the LiteLLM proxy sample endpoint with tools and upstream-default thinking.":
			"通过 LiteLLM 代理示例端点使用 GLM-5.3，支持工具与上游默认思考。",
		"GLM-5.3 through TokenRouter with forced thinking and preserved reasoning content.":
			"通过 TokenRouter 使用 GLM-5.3，强制思考并保留推理内容。",
		"Google Gemini's advanced multimodal reasoning model.": "Google Gemini 的高级多模态推理模型。",
		"GPT-5.6 Luna through the ChatGPT/Codex OAuth Responses route.":
			"通过 ChatGPT/Codex OAuth 的 Responses 路由使用 GPT-5.6 Luna。",
		"GPT-5.6 Sol through the ChatGPT/Codex OAuth Responses route.":
			"通过 ChatGPT/Codex OAuth 的 Responses 路由使用 GPT-5.6 Sol。",
		"GPT-5.6 Terra through the ChatGPT/Codex OAuth Responses route.":
			"通过 ChatGPT/Codex OAuth 的 Responses 路由使用 GPT-5.6 Terra。",
		"GPT-6.1 Sol through the ChatGPT/Codex OAuth Responses route with xhigh reasoning.":
			"通过 ChatGPT/Codex OAuth 的 Responses 路由使用 GPT-6.1 Sol，启用 xhigh 推理。",
		"GPT-6 Astra through the ChatGPT/Codex OAuth Responses route.":
			"通过 ChatGPT/Codex OAuth 的 Responses 路由使用 GPT-6 Astra。",
		"GPT-6 Luna through the ChatGPT/Codex OAuth Responses route.":
			"通过 ChatGPT/Codex OAuth 的 Responses 路由使用 GPT-6 Luna。",
		"GPT-6 Sol through the ChatGPT/Codex OAuth Responses route.":
			"通过 ChatGPT/Codex OAuth 的 Responses 路由使用 GPT-6 Sol。",
		"Grok 4.6 through the xAI subscription OAuth route.": "通过 xAI 订阅 OAuth 路由使用 Grok 4.6。",
		"Grok 4.7 through the xAI subscription OAuth route.": "通过 xAI 订阅 OAuth 路由使用 Grok 4.7。",
		"Kimi K2.6 through Azure Foundry with high reasoning and automatic model caching.":
			"通过 Azure Foundry 使用 Kimi K2.6，启用高推理等级与自动模型缓存。",
		"Kimi K2.6 through the LiteLLM proxy sample endpoint with thinking enabled.":
			"通过 LiteLLM 代理示例端点使用 Kimi K2.6，已启用思考。",
		"Kimi K2.7 Code through Fireworks serverless inference.":
			"通过 Fireworks 无服务器推理使用 Kimi K2.7 Code。",
		"Kimi K3 through the LiteLLM proxy sample endpoint for long-horizon coding and deep reasoning.":
			"通过 LiteLLM 代理示例端点使用 Kimi K3，适用于长程编程与深度推理。",
		"Kimi K3 through TokenRouter with 1M context, vision, tools, and always-on thinking.":
			"通过 TokenRouter 使用 Kimi K3，1M 上下文，支持视觉、工具与常开思考。",
		"Kimi's flagship 1M-context model for long-horizon coding, knowledge work, and deep reasoning.":
			"Kimi 的旗舰 1M 上下文模型，适用于长程编程、知识工作与深度推理。",
		"Kimi's general-purpose multimodal model with thinking enabled for agent tasks.":
			"Kimi 的通用多模态模型，已启用思考，适用于智能体任务。",
		"Kimi's latest code-focused model with multimodal input, tool calling, and always-on thinking.":
			"Kimi 最新的代码模型，支持多模态输入、工具调用与常开思考。",
		"MiniMax M3 through MiniMax's Anthropic-compatible API.":
			"通过 MiniMax 的 Anthropic 兼容 API 使用 MiniMax M3。",
		"MiniMax M3 through the OpenAI-compatible API.": "通过 OpenAI 兼容 API 使用 MiniMax M3。",
		"OpenAI-compatible Chat Completions setup for GPT-5.5.": "适用于 GPT-5.5 的 OpenAI 兼容 Chat Completions 配置。",
		"OpenAI frontier model for complex coding and professional work.":
			"OpenAI 前沿模型，适用于复杂编程与专业工作。",
		"OpenAI GPT-6.1 Sol for complex coding and professional work with xhigh reasoning.":
			"OpenAI GPT-6.1 Sol，适用于复杂编程与专业工作，启用 xhigh 推理。",
		"Qwen3.8-27B through the LiteLLM proxy sample endpoint with native 262K context and adjustable reasoning.":
			"通过 LiteLLM 代理示例端点使用 Qwen3.8-27B，原生 262K 上下文并支持可调推理等级。",
		"Qwen3.8-Max through TokenRouter with multimodal input and adjustable reasoning effort.":
			"通过 TokenRouter 使用 Qwen3.8-Max，支持多模态输入与可调推理等级。",
		"Stable Gemini price-performance model for low-latency agentic tasks.":
			"稳定版 Gemini 性价比模型，适用于低延迟智能体任务。",
		"Xiaomi MiMo V2.5 full-modal model for multimodal agent workflows.":
			"Xiaomi MiMo V2.5 全模态模型，适用于多模态智能体工作流。",
		"Xiaomi MiMo V2.5 Pro for complex agent, coding, and long-context reasoning.":
			"Xiaomi MiMo V2.5 Pro，适用于复杂智能体、编程与长上下文推理。",
		"Xiaomi MiMo V2.6 Pro for complex projects, long-horizon agent work, and high-value reasoning.":
			"Xiaomi MiMo V2.6 Pro，适用于复杂项目、长程智能体工作与高价值推理。",
	};

	/**
	 * Translate a string for the current UI locale.
	 * Falls back to the original English string when the locale is not Chinese
	 * or the string has no translation.
	 * @param text Source English string.
	 * @param args Optional values substituted into {0}, {1}, ... placeholders.
	 */
	function configView_l10n_t(text, ...args) {
		if (!IS_ZH) {
			return text;
		}
		let translated = I18N_ZH_CN[text];
		if (translated === undefined) {
			translated = text;
		}
		for (let i = 0; i < args.length; i++) {
			translated = translated.split(`{${i}}`).join(String(args[i]));
		}
		return translated;
	}

	/**
	 * Apply translations to static HTML elements annotated with
	 * data-i18n (textContent) or data-i18n-placeholder (placeholder attribute).
	 */
	function html_i18n() {
		if (!IS_ZH) {
			return;
		}
		document.querySelectorAll("[data-i18n]").forEach((el) => {
			const key = el.getAttribute("data-i18n");
			if (key && I18N_ZH_CN[key] !== undefined) {
				el.textContent = I18N_ZH_CN[key];
			}
		});
		document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
			const key = el.getAttribute("data-i18n-placeholder");
			if (key && I18N_ZH_CN[key] !== undefined) {
				el.setAttribute("placeholder", I18N_ZH_CN[key]);
			}
		});
		document.title = configView_l10n_t("OAIProxy Configuration");
	}

	// Expose helpers to the page scope (configView.js uses them).
	window.__oaiproxyI18n = { configView_l10n_t, html_i18n, isZh: IS_ZH };
})();
