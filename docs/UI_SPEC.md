# CCH Web UI 设计需求

## 风格参考

参考 Claude Code / ChatGPT 的 web 端：干净、现代、温暖色调。浅色为主，支持暗色切换。

## 配色

| 元素 | Light | Dark |
|---|---|---|
| 背景 | #faf8f5（暖白） | #1a1a1a |
| 卡片 | #ffffff | #252525 |
| 边框 | #e8e6e1 | #333333 |
| 主文字 | #1a1a1a | #e8e6e3 |
| 辅助文字 | #8b8a88 | #8b8a88 |
| 强调色（按钮/logo） | #d97736（琥珀橙） | 同 |
| 成功/活跃 | #1b8a3d | #3fb950 |
| 终端背景 | #1a1a1a 黑底 | 同 |
| 终端文字 | #a5d6a5 淡绿 | 同 |

字体：SF Pro / Inter / system-ui。等宽字体：SF Mono / Fira Code。

## 页面结构

```
┌──────────────────────────────────────────────────────┐
│  Logo CCH                    [☀] [Refresh] [Logout]  │  ← 顶栏
├──────────────┬───────────────────────────────────────┤
│ Sessions (3) │  ▸ cmrxbqruh000                      │
│              │  RobyedeMacBook-Pro.local             │
│ ● Active     │  Created: 2026/7/23 17:44            │
│   fix bug    │                                       │
│   12 msgs    │  ┌─ Terminal ───────────────────────┐ │
│   3h ago     │  │                                  │ │
│              │  │  [user] fix the login bug        │ │
│ ○ Idle       │  │  [assistant] I found the issue   │ │
│   refactor   │  │  in auth middleware...            │ │
│   45 msgs    │  │                                  │ │
│   1d ago     │  │  > fix the login                │ │  ← 输入框
│              │  └──────────────────────────────────┘ │
│ Machines (1) │                                       │
│ ● Robyede... │                                       │
│   just now   │                                       │
│              │                                       │
│ ── Connect ─ │                                       │
│ [label____]  │                                       │
│ [Generate]   │                                       │
│ my-mac Copy ×│                                       │
└──────────────┴───────────────────────────────────────┘
```

## 交互

### 用户入口 `/`

1. **登录页**：居中卡片，标题+输入框+Connect 按钮。粘贴 token 或完整连接串均可。输入框自动解析 URL 中的 token。支持 `?token=xxx` 参数自动填充。
2. **Dashboard**：两栏布局。左侧固定 300px，右侧自适应。

### 左侧栏

- **Sessions**：按最近活跃排序。每条显示：状态标签（Active 绿色 / Idle 灰色）、元数据（机器名）、消息条数、相对时间。点击后高亮+右侧展开。
- **Machines**：显示机器名 + 最后心跳时间。无状态标签（无 daemon 谈不上 online/offline）。
- **Connect a Device**：输入框+Generate 按钮。生成后显示连接串+Copy 按钮。Token 列表显示 label + 创建时间 + Copy/Revoke 操作。

### 右侧详情

- 未选 session 时显示占位："Select a session to view details"
- 选中后显示 session 头信息（ID、机器名、创建时间）
- **消息区**：终端风格（黑底绿字，或白底黑字可切换）。显示用户/助手消息时间线。消息按 role 着色区分。滚动到底部。
- **输入框**：`>` 提示符 + text input + Send 按钮。Enter 发送。仅对 ccd session 显示。

### 页面 `/admin`

管理后台。保留现有功能（看板、账户管理、token 管理），加上暗色切换按钮。

### 全局

- 右上角 🌙/☀ 按钮切换主题
- 30s 自动刷新
- 手机端竖屏时堆叠布局（sidebar 在上，detail 在下）

## API 接口

所有接口需要 `Authorization: Bearer <token>`。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /v1/sessions | 所有 session（最多150条） |
| GET | /v1/machines | 机器列表 |
| GET | /v1/sessions/:id/plaintext-messages | session 的明文消息 |
| POST | /v1/sessions/:id/plaintext-messages | 发送消息 {role, content} |
| POST | /v1/bootstrap-tokens | 用户生成 token {label?} |
| GET | /v1/bootstrap-tokens | 用户查看自己的 tokens |
| POST | /v1/bootstrap-tokens/:id/revoke | 吊销 token |
| POST | /v1/auth/bootstrap | 用 bootstrap token 换取 auth token |

## 文件

| 文件 | 说明 |
|---|---|
| `server/user.html` | 用户页面 HTML+CSS |
| `server/user.js` | 用户页面逻辑 |
| `server/admin.html` | 管理页面 |
| `server/admin.js` | 管理页面逻辑 |
