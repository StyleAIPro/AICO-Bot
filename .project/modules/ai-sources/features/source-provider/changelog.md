# 变更记录 — AI 源提供商

| 日期 | 内容 | 指令人 | 触发来源 |
|------|------|--------|---------|
| 2026-05-14 | 修复：fetchModelsFromApi 的 name fallback 从 `m.owned_by`（组织名如 "openai"）改为 `m.id`（实际模型标识符如 "gpt-4o"），避免下拉列表显示无意义的组织名 | @misakamikoto | bugfix-fetch-model-by-id-v1 |
| 2026-05-11 | 修复：智谱 AI 等 Anthropic 兼容端点获取模型列表失败——增强 fetchModelsFromApi 格式匹配（Format 1b 嵌套 + Format 4 遍历回退）+ 改进 name 提取优先级 + 补全 i18n key | @mi-saka | bugfix-fetch-models-format-v1 |
| 2026-05-11 | UX 重构：移除 "Use custom model ID" checkbox，改为下拉列表底部 "+ Add custom model" 按钮，将新增模型和改名模型操作彻底分离 | @mi-saka | bugfix-model-add-rename-ux-v1 |
| 2026-05-11 | 修复：编辑模型名称后新旧名称并存——添加模型内联编辑功能 + handleSave 按 id 去重 + syncBuiltinModels 保留用户自定义名称 | @mi-saka | bugfix-model-name-stale-v1 |
| 2026-05-11 | 修复：RemoteModelSelector 和 RemoteServersSection 直接使用 model ID 显示名称，改为通过 availableModels 查找用户友好的显示名称 | @mi-saka | bugfix-model-name-sync-v1 |
| 2026-05-10 | 修复获取模型和测试连接的成功/失败判定不可靠问题：result 消息错误判定、多格式模型列表支持、URL 规范化统一、超时和错误处理改善 | @mi-saka | bugfix-model-fetch-and-validate-v1 |
| 2026-04-16 | 初始设计 | @mi-saka1 | 新功能 |
