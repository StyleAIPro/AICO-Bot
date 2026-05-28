# 变更记录 -- 用户输入区域

| 日期 | 内容 | 指令人 | 触发来源 |
|------|------|--------|---------|
| 2026-04-16 | 初始设计 | @moonseeker1 | 新功能 |
| 2026-04-16 | BUG-001 修复：MAX_IMAGES 未定义导致崩溃，添加 export 和 import | @moonseeker1 | BUG修复 |
| 2026-04-16 | 重构：提取 useMentionSystem hook（@mention 自动补全、键盘导航、targetAgentIds 同步）；提取 useImageAttachments hook（粘贴/拖拽/选择、压缩、验证） | @moonseeker1 | 代码审计 |
| 2026-04-18 | 新增斜杠命令框架集成：useSlashCommand hook、SlashCommandMenu 组件、命令注册表、执行器；支持 /skill 系列 5 个子命令（list/install/uninstall/info/search） | @MoonSeeker | feature/slash-command-framework-v1 |
| 2026-04-20 | /skill 斜杠命令增强：新增 enable/disable/refresh/create 4 个子命令，新增 api.skillGenerateFromPrompt 封装 | @moonseeker1 | feature/skill-slash-command-v1 |
| 2026-04-21 | 新增输入历史翻阅：useInputHistory hook，上/下键浏览当前对话用户消息，支持草稿暂存、边界处理、与 mention/slash 系统兼容 | @moonseeker1 | feature/chat/input-history-v1 |
| 2026-05-14 | 斜杠菜单新增已安装技能列表：输入 / 弹出菜单同时显示命令和技能分组，支持模糊搜索，选中技能后走普通消息发送路径 | @misakamikoto | feature-chat-slash-command-v1 |
| 2026-05-14 | 新增上下文用量实时显示：InputToolbar 压缩按钮右侧显示 `125K / 200K (62.5%)`，含颜色预警（60% 橙色、80% 红色），新增 `agent:context-usage` IPC 事件 | @misakamikoto | feature-context-usage-display-v1 |
