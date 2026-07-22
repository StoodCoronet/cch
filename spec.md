# Self-host Happy + cct 集成 Spec(Interview 进行中)

> 状态:interview 进行中,本文档随每轮问答持续更新。

## 目标

- 在阿里云等平台上 self-host 一个 happy server,聚合跑在各台电脑上的所有 cc(Claude Code)项目 session。
- 手机(Android 优先)上查看每个项目进展,必要时远程给 cc 下达指令。
- 本地开发 pipeline(用 cct 切 key / 启动)不被打扰。
- 认证方式:server 生成 token,本地 cct 与手机各配置一次;连接信息可一次性复制粘贴(单条字符串包含 server + token 等必要信息)。

## 已确认决策(Round 1)

| 议题 | 决策 |
|---|---|
| 总体路线 | **Fork happy,只改认证层**;保留 happy 全部功能(E2E 加密、socket 转发、Android app)。cct 侧加配置胶水。 |
| 认证模型 | **Token 作为一次性 bootstrap**:server 生成 token → 各端用 token 换取/领取账户凭证(keypair secret 打包进连接串),之后仍走 happy 原生 E2E 协议。一次粘贴完成配对,无需扫 QR。 |
| E2E 加密 | **保留**。server 只存密文 blob;加密与认证正交,不动 crypto 代码。 |
| 监控范围 | **只覆盖通过 happy 启动的 session**。约定开发链路经过 happy,不经过 happy 的 plain cc session 不出现在手机上。 |

## 技术事实(代码勘察结论)

### happy(reference/happy,pnpm monorepo)

- `packages/happy-server`:Fastify + Socket.IO(`/v1/updates`)+ Prisma。盲转发,内容全 E2E 加密。
- 自托管已是一等公民:`happy server` 命令(内嵌 PGlite,自动生成 master secret,端口 3005),或 `Dockerfile.server`(Postgres/Redis/S3)。
- server URL 配置点:
  - CLI:`HAPPY_SERVER_URL` env > `~/.happy/settings.json` 的 `serverUrl` > 默认(`packages/happy-cli/src/configuration.ts:56-63`)。
  - App:MMKV `custom-server-url`(app 内有 server 选择页)> 注入的 `__HAPPY_CONFIG__` > 默认(`packages/happy-app/sources/sync/serverConfig.ts`)。
- 认证现状:账户 = NaCl keypair;`POST /v1/auth` 用签名换 Bearer token(privacy-kit 持久 token,源自 `HANDY_MASTER_SECRET`)。CLI↔App 配对走 `TerminalAuthRequest` QR 挑战响应。
- 认证改动面:`sources/app/api/routes/authRoutes.ts`、`sources/app/auth/auth.ts`、`enableAuthentication.ts`、`socket.ts` 中间件——全部汇聚到 `auth.verifyToken`。
- App:Expo RN(Android 用 `pnpm android` / `expo run:android` 构建),libsodium E2E。

### happy CLI 对 claude 的包装(与 cct 集成的关键)

- happy CLI 把**未知参数透传给 claude**(`packages/happy-cli/src/index.ts:623-698`,`unknownArgs → claudeArgs`),包括 `--model`、`--dangerously-skip-permissions` 等。
- 环境变量沿进程链继承:cct 注入的 profile env(`ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`)→ happy → claude,无需额外 plumbing。happy daemon 还有 `expandEnvVars` 机制(`src/utils/expandEnvVars.ts`)。

### cct(reference/cct,Rust)

- 配置:`~/.config/cc-tui/profiles.toml`(`CCT_CONFIG` 可覆盖),`Profile` 定义在 `src/config.rs:105-127`,API key 只存于 `[profiles.env]`。
- 启动:`src/launch.rs` `exec_claude` 注入 env 后 `exec()` claude 二进制,带 `--model` / `--dangerously-skip-permissions` / `extra_args`。
- 已有"改写外部工具配置"的先例:`generate_kimi_config`(`launch.rs:488-589`)写 `~/.kimi-code/config.toml`。
- 扩展点:`Profile`/`NewProfile` 加可选字段 + `append_profile`/`update_profile` 透传;或加独立子命令(只需动 `main.rs` 的 `Commands` enum)。已有 doc 记载 `cct env <profile> -- happy daemon start` 的用法。

## 已确认决策(Round 2)

| 议题 | 决策 |
|---|---|
| cct 接 happy 的方式 | **Profile 加字段开关**:在每个 `[profiles.xxx]` 下增加可选的 happy server 连接字段;happy exec 替换 claude exec,profile env 仍沿进程链注入。不设独立 `cct connect` 子命令,保持 cct 的 profile 切换体验。 |
| 手机端能力边界 | **要 daemon,可远程开 session**:每台机器上 happy daemon 常驻,手机可通过 server 转发指令在该机器上新开 session 或执行 bash。 |

## 已确认决策(Round 3)

| 议题 | 决策 |
|---|---|
| 部署形态 | **Server 用 Docker Compose**(happy 已有 `Dockerfile.server`)。CLI/cct 侧保持轻量，只加 profile 字段和 exec 目标切换。 |
| 连接串格式 | **URL 参数式**:`https://happy.example.com/connect?token=xxx` — 浏览器可开、CLI 和 App 都能解析。 |
| Token 生命周期 | **长期有效 + 可吊销**:不设自动过期，server dashboard 可手动吊销。降低反复配置的摩擦。 |
| 多机器命名 | **自动取 hostname**:连接时自动获取机器 hostname 作为标识，可在 App 中后续重命名。 |

## 已确认决策(Round 4)

| 议题 | 决策 |
|---|---|
| Android 构建 | **本地 `expo run:android`**:直接构建 debug APK 装手机，不走 CI/CD，最快验证。 |
| 功能裁剪 | **全部保留，暂不裁剪**:先不动功能代码，核心流程跑通后再按需删减。 |
| Profile 切换 | **无需特殊处理**:切 profile = 新开 session，旧 session 独立存在。happy server 上聚合展示所有 session，按机器 hostname 分组。 |
| Dashboard | **内置 Web UI**:happy server 内嵌 `/admin` 单页应用，功能：机器列表、session 列表、token 管理(生成/吊销)。 |

## 已确认决策(Round 5 - 最终轮)

| 议题 | 决策 |
|---|---|
| 通知机制 | **纯 Socket.IO**:happy 已有 `/v1/updates` 长连接，App 前台实时更新，后台重回时拉最新状态。不引入 FCM，零额外开发。 |
| Dashboard 认证 | **独立管理密码**:`/admin` 页面要求输入 `ADMIN_PASSWORD` 环境变量预设的密码。最简单，不需要额外依赖。 |
| 同步粒度 | **状态 + 标题摘要**:server 存 session 状态(active/idle/done)、当前任务标题/摘要、开始时间、最后活动时间。对话内容仍走 E2E 加密通道。 |
| cct 改动范围 | **最小改动**:只改两处——`config.rs` 给 Profile 加 `happy_server`/`happy_token` 可选字段；`launch.rs` 当字段存在时 exec `happy` 而非 `claude`。不加子命令、不改 UI。 |
| 显示范围 | **只显示 active session**:server 侧存储所有 session 历史，但 App/Web UI 默认只展示 active 状态的 session。历史记录保留但不出现在列表中。 |

## CLI 启动流程(最终确认)

```
cct run --profile work-key1 "改个 bug"
  │
  ├─ cct 读取 ~/.config/cc-tui/profiles.toml
  │  发现 [profiles.work-key1] 下有 happy_server + happy_token
  │
  ├─ cct exec happy (替换原有的 exec claude)
  │  传入: profile env (ANTHROPIC_API_KEY 等) + claude args (--model, extra_args)
  │
  ├─ happy 用 token 连接 server(首次做 bootstrap 配对)
  │  happy daemon 常驻，维护与 server 的 Socket.IO 长连接
  │
  ├─ happy 包装启动 claude，参数和 env 全部透传
  │
  └─ happy daemon 自动上报 session 状态到 server
      → 手机 App 实时看到新 session 出现(pure Socket.IO)
```

cct 的 profile 切换、env 注入、extra_args 透传全部原样工作。happy 作为中间层对用户完全透明。

## Profile 示例

```toml
[profiles.work-key1]
model = "claude-sonnet-4-6"
happy_server = "https://happy.example.com"
happy_token = "hbt_xxxxxxxxxxxxxxxxxxxx"

[profiles.work-key1.env]
ANTHROPIC_BASE_URL = "https://api.anthropic.com"
ANTHROPIC_API_KEY = "sk-ant-xxx"
ANTHROPIC_AUTH_TOKEN = "sk-ant-xxx"
```

happy_server + happy_token 两个字段即可触发 exec happy 路径；不配这两个字段的 profile 行为完全不变（直接 exec claude），保证向后兼容。
