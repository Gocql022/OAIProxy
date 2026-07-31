# OAIProxy 仓库指令

本仓库的权威编码与工作流规则存放在 `.cursor/rules/` 下的 Cursor 规则文件中。它们适用于在本仓库工作的所有 agent（GitHub Copilot、Cursor、Codex 等），效力与 `AGENTS.md` 相同。

## 规则文件

在处理匹配的任务**之前**，请先用文件读取工具读取相应的规则文件：

| 规则文件 | 适用范围 |
| --- | --- |
| `.cursor/rules/oaiproxy-api-keys.mdc` | API key 存储与多供应商查找行为 |
| `.cursor/rules/oaiproxy-build.mdc` | 构建/检查/测试命令、VSIX 打包、安装/重载策略、版本号递增 |
| `.cursor/rules/oaiproxy-context.mdc` | 项目背景、架构、上游关系、VS Code 兼容性、当前功能 |
| `.cursor/rules/oaiproxy-dev.mdc` | 代码风格、新增供应商检查、运行时日志排查、调试日志推断纪律 |
| `.cursor/rules/oaiproxy-release.mdc` | 发布流程：变更日志、版本号、打标签、GitHub 发布 |

## 要求

- 将这些规则文件的内容视为具有约束力的指令，效力与 `AGENTS.md` 相同。
- 当任务涉及上述任一文件覆盖的主题时，先读取该文件并遵守其中的所有规则。
- 这些文件采用 `.mdc` 格式并带有 YAML frontmatter，无法作为普通 Markdown 导入——请直接用文件读取工具读取，而不要依赖 Markdown 的 `@` 导入。
