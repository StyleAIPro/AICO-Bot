# Bug 记录 — hyper-space

## 统计
| 严重程度 | 数量 |
|---------|------|
| Critical | 0 |
| Major | 1 |
| Minor | 0 |

## BUG-001: Worker 任务无法中断 & 团队删除无法断连

- **日期**：2026-06-02
- **严重程度**：Major
- **PRD**：`.project/prd/bugfix/agent/bugfix-hyperspace-worker-interrupt-v1.md`
- **现象**：Leader 分发任务给 Worker 后，点击停止只能中断 Leader，Worker 继续运行；删除 HyperSpace 空间或对话时，团队资源未清理
- **根因**：`stopGeneration` 只能找到父 conversationId 的 session，Worker 的 SDK session / 远程 WebSocket 以 childConversationId 注册无法被触达；`deleteSpace`/`deleteConversation` 未调用 `destroyTeam`
- **修复**：新增 `interruptWorkersForConversation` 方法，在 `stopGeneration`、`deleteSpace`、`deleteConversation` 路径中调用，统一中断所有 Worker 并销毁 team
