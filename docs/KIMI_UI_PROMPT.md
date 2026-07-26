# CCH Web UI 聊天渲染改进

## 背景

当前 CCH web dashboard 的消息渲染太简陋——纯文本，没有格式化。Claude Code 的消息流中包含 tool use（bash 命令执行、文件 diff、搜索结果等），这些需要像 Claude Code CLI 一样渲染。

## JSONL 消息格式

daemon 从 `~/.claude/projects/<项目>/<uuid>.jsonl` 读取的每一行 JSON 包含：

```json
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"xxx","content":[{"type":"text","text":"diff --git ..."}]}]}}
{"type":"assistant","message":{"model":"deepseek-v4-pro","content":[{"type":"text","text":"你好！"},{"type":"tool_use","id":"xxx","name":"Bash","input":{"command":"git diff"}}]}
```

**关键消息类型：**
- `type: "user"` — 用户输入
- `type: "assistant"` — AI 回复（包含 text + tool_use + tool_result）
- `type: "system"` — 系统消息（可选忽略）

**content 数组元素类型：**
- `{"type":"text","text":"..."}` — 普通文本
- `{"type":"tool_use","id":"...","name":"Bash","input":{"command":"git diff"}}` — AI 调用工具
- `{"type":"tool_result","tool_use_id":"...","content":[{"type":"text","text":"..."}]}` — 工具执行结果

## 需求

### 1. 消息气泡渲染

参考 Claude Code CLI 风格（深色终端，绿字），做聊天框的消息渲染：

- **用户消息**: 靠右对齐，浅色背景气泡，显示用户输入文本
- **AI 消息**: 靠左对齐
  - **普通文本**: 支持 markdown 渲染（代码块 ```、列表、粗体、斜体）
  - **工具调用 (tool_use)**: 折叠面板，显示 `⏺ Bash(git diff src/daemon.rs)` 格式，点击展开查看命令内容 + 输出
  - **工具结果 (tool_result)**: 折叠面板，显示 diff 或命令输出（等宽字体，深色背景）
- **消息时间戳**: 每条消息右下角显示时间

### 2. 侧边栏 Session 状态

- Session 列表显示 `活跃 · 2m` 而不是 `活跃 · 1d`（现在是固定的，需要实时更新）
- 如果有 daemon 心跳，显示 "online"
- 消息计数实时更新

### 3. 实时刷新

- 选中 session 后，每 2 秒拉取新消息（已实现，保持不变）

### 4. 样式

- 深色主题（现已实现），亮色可选
- 代码/终端区域：深色背景，等宽字体，绿/白色文字
- 气泡：圆角，柔和阴影

## 文件

- `/Users/robye/workspace/self_host_happy/server/user.html` — HTML + CSS
- `/Users/robye/workspace/self_host_happy/server/user.js` — JavaScript 逻辑
- API: `GET /v1/sessions/:id/plaintext-messages` 返回 `{messages: [{role, content, createdAt}]}`

## 注意事项

- 不要改 API 和服务端代码
- 只改 user.html 和 user.js
- message content 是纯文本，需要自己解析和渲染
- 保持现有功能：session 选择、token 管理、主题切换
