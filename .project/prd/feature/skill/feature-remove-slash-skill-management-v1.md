# PRD [功能级] -- 移除斜杠菜单中的 /skill 管理命令

> 版本：feature-remove-slash-skill-management-v1
> 日期：2026-05-14
> 指令人：@misakamikoto
> 归属模块：renderer/hooks/slash-command
> 状态：done
> 优先级：P1
> 影响范围：前端（slash-command 框架）

## 需求分析

### 问题

`useSlashCommand` hook 在 `index.ts` 中注册了 `/skill` 管理命令（含 list/install/uninstall/info/search/enable/disable/refresh/create 共 9 个子命令）。这些管理类命令不应出现在聊天输入的 `/` 菜单中：

1. 用户只需快速调用技能，不需要在聊天框管理技能
2. 技能管理已通过专门的技能页面完成，聊天菜单重复且干扰
3. `/skill` 命令注册后，输入 `/skill` 会被拦截为本地命令而非发送给 AI

### 预期效果

- 输入 `/` 菜单只显示已安装技能列表，不显示管理命令
- 输入 `/skill xxx` 不再被拦截，作为普通消息发送给 AI

## 技术方案

### 修改文件

`src/renderer/hooks/slash-command/index.ts`

### 实现方式

移除 `index.ts` 中 `skillCommand` 的导入和 `slashCommandRegistry.register(skillCommand)` 调用。`slashCommandRegistry` 仍保留导出，以备未来扩展。

## 涉及文件（实际）

| # | 文件 | 改动类型 | 说明 |
|---|------|---------|------|
| 1 | `src/renderer/hooks/slash-command/index.ts` | 修改 | 移除 skillCommand 导入和注册 |

## 验收标准

- [ ] 输入 `/` 菜单不显示 `/skill` 管理命令
- [ ] 输入 `/` 菜单正确显示已安装技能列表
- [ ] 输入 `/skill xxx` 作为普通消息发送给 AI，不被拦截

## 变更

| 日期 | 内容 | 指令人 |
|------|------|--------|
| 2026-05-14 | 初始 PRD（补充已完成的变更） | @misakamikoto |
