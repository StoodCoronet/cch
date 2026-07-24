# CCH Web UI 重设计 — Spec

> 状态: Interview 完成
> 日期: 2026-07-24

## 已确认决策

### UI 基调

| 议题 | 决策 |
|---|---|
| 主题 | 默认 Day（浅色），有 Dark 切换按钮，localStorage 记住选择 |
| 桌面布局 | 两栏：左侧 session/machine 列表，右侧详情面板 |
| 移动端 | 单列堆叠：列表→点进去全屏详情 |
| 输入框风格 | 轻量 CLI 模拟：黑底绿字 + `>` 提示符 |
| 管理页 | /admin 保留现有风格，只加 day/night 切换 |

### Session 交互

| 议题 | 决策 |
|---|---|
| ccd session | 可交互。展开后显示对话 + 底部输入框。消息通过 Socket.IO 实时收发。 |
| cch session | 只读。展开后显示消息时间线（数量+时间戳+角色）。内容 E2E 加密不可读正文。 |
| 消息存储 | ccd 发起的消息走 Socket.IO，server 存明文（新模型 `SessionMessage`）。cch 沿用 happy E2E。 |

### Session 详情

| 议题 | 决策 |
|---|---|
| 历史展示 | 每个 session 显示消息条数（如 "12 msgs"）。展开后显示消息时间线。ccd session 显示明文对话内容。 |
| 消息模型 | 新增 `PlaintextMessage` 模型（sessionId, role, content, createdAt）。与 happy 的 `SessionMessage`（加密）并存。 |

## 布局

```
┌──────────────────────────────────────────────────────────┐
│  CCH                              [☀/🌙] [admin] [logout]│
├──────────────────┬───────────────────────────────────────┤
│  Sessions (3)    │  ▸ cmrxbqruh000                      │
│  ┌────────────┐  │  Machine: RobyedeMacBook-Pro         │
│  │ ● Active   │  │  Created: 2026/7/23 17:44             │
│  │  12 msgs   │  │                                       │
│  │  3h ago    │  │  ┌─ Terminal ──────────────────────┐  │
│  └────────────┘  │  │ > fix the login bug             │  │
│  ┌────────────┐  │  │                                  │  │
│  │ ○ Idle     │  │  │ [assistant] Sure! Let me check  │  │
│  │  45 msgs   │  │  │ the auth middleware...           │  │
│  │  1d ago    │  │  │                                  │  │
│  └────────────┘  │  │ >                             █  │  │
│                  │  └──────────────────────────────────┘  │
│  Machines (1)    │                                       │
│  ● RobyedeM...   │                                       │
│    just now      │                                       │
├──────────────────┴───────────────────────────────────────┤
│  Connect a Device:  [label] [Generate]   [token list]    │
└──────────────────────────────────────────────────────────┘
```

## 技术实现

### Server 端

| 文件 | 改动 |
|---|---|
| `prisma/schema.prisma` | 新增 `PlaintextMessage` 模型 |
| `server/sources/app/api/routes/sessionRoutes.ts` | `GET /v1/sessions/:id/messages` 返回明文消息列表 |
| `server/sources/app/api/socket.ts` | 新增 `ccd-message` 事件 handler，写入 PlaintextMessage |

### ccd 端

- ccd 连接 Socket.IO 后，每收到 claude 输出，emit `ccd-message` 到 server
- 格式：`{ sessionId, role: "user"|"assistant", content: "..." }`

### Web UI 端

| 文件 | 改动 |
|---|---|
| `server/user.html` | 重写为两栏布局 + day/night + 终端区域 |
| `server/user.js` | 重写：消息拉取/发送，day/night 切换，session 展开 |
| `server/admin.html` | 加 day/night 切换 |
| `server/admin.js` | 加 theme toggle |

### 消息模型

```prisma
model PlaintextMessage {
    id        String   @id @default(cuid())
    sessionId String
    role      String   // "user" | "assistant"
    content   String
    createdAt DateTime @default(now())

    @@index([sessionId, createdAt])
}
```

### 验证方案

1. `ccd start` → Socket.IO 连接 → dashboard 显示 machine online
2. `ccd run --profile default "test"` → session 出现在列表
3. 点击 session → 展开对话 → 看到 user/assistant 消息
4. 在输入框输入 → 回车发送 → 通过 ccd RPC 到达本地 claude
5. 切换 day/night → 页面刷新主题
6. 手机打开 → 单列布局正常
