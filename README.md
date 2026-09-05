# CCH — Self-hosted Claude Code with Happy

在阿里云等平台自建 server，聚合所有电脑上的 Claude Code session。手机/浏览器实时查看进度。

## 架构

```
cch (Rust CLI) ──HTTP──→ cch-server (阿里云) ←── 浏览器/手机
    exec claude               ^
                              |
                     GitHub Actions build → ghcr.io
```

## 项目结构

```
cli/node-ccd/  Node 版 daemon（推荐），启动/接管 Claude Code 并同步到 server
cli/           Rust 版 cch/ccd（历史代码，当前默认不使用）
server/        cch-server (Node.js + PGlite)，内嵌 admin + user dashboard
app/           手机 App (Expo RN / PWA)
packages/wire  共享消息协议
```

## 快速开始

### 1. 启动 Server

```bash
cd server
pnpm install
pnpm standalone:dev
```

浏览器打开 `http://localhost:3005/admin`（密码：admin123）

### 2. 安装 ccd

```bash
npm install -g cch-ccd
```

如果 npm 提示 `allow-scripts` 警告，需要先批准 install 脚本（否则 `node-pty` 原生模块无法编译）：

```bash
npm approve-scripts @anthropic-ai/claude-code node-pty
npm install -g cch-ccd
```

### 3. 连接

从 dashboard 的 "Connect a Device" 生成 token，然后：

```bash
ccd connect 'http://localhost:3005/connect?token=xxx'
ccd
```

### 4. 查看

`http://localhost:3005/` — 用户 dashboard，看 session 和机器

## iPhone / 移动端使用

### iPhone（PWA）

不需要 Apple Developer 账号，直接通过 Safari "Add to Home Screen" 安装：

1. iPhone Safari 打开 server 地址，例如 `http://<你的服务器>:3005/`。
2. 登录账号。
3. 点击底部分享按钮 → **Add to Home Screen**（添加到主屏幕）。
4. 主屏幕会出现 ccc 图标，点击即可全屏运行，体验和原生 App 接近。

> 首次添加前建议先登录，这样 PWA 打开后会保持登录状态。

### Android

去 GitHub Releases 下载最新的 `app-debug.apk` 安装即可：

<https://github.com/StoodCoronet/cch/releases>

## 安装 ccd（Node daemon）

ccd 是本地守护进程，负责启动/接管 Claude Code session 并同步到 cch-server。需要 Node.js 20+。

### 通过 npm 全局安装

```bash
npm install -g cch-ccd
```

如果 npm 提示 `allow-scripts` 警告，需要先批准 install 脚本（否则 `node-pty` 原生模块无法编译）：

```bash
npm approve-scripts @anthropic-ai/claude-code node-pty
npm install -g cch-ccd
```

### 从源码运行

```bash
cd cli/node-ccd
npm install
npm link        # 或者直接用 ./bin/ccd.js
ccd connect 'http://<你的服务器>:3005/connect?token=xxx'
```

## 使用教程

### 1. 连接 server

在 web dashboard（`/admin` 或用户首页）点击 **Connect a Device**，输入标签后生成 token，复制连接命令：

```bash
ccd connect 'http://<你的服务器>:3005/connect?token=xxx'
```

连接成功后会保存到 `~/.cch/token`，后续命令自动使用该配置。

### 2. 启动 session

直接运行 `ccd`，会弹出 profile 选择界面，选择后进入 Claude Code 交互界面：

```bash
ccd
```

### 3. 断开与重连

- 在 session 里按 `Ctrl+B` 再按 `D` 可以 detach，session 仍在后台运行。
- 列出所有 session：
  ```bash
  ccd ls
  ```
- 重新 attach 某个 session：
  ```bash
  ccd attach <session-id>
  ```
- 交互式选择并 attach：
  ```bash
  ccd -a
  ```

### 4. 停止 daemon

```bash
ccd stop
```

### 5. 常用命令速查

```bash
ccd --version              # 查看版本
ccd connect <url>          # 连接 server
ccd start                  # 启动 daemon（通常自动完成）
ccd stop                   # 停止 daemon
ccd status                 # 查看 daemon 和 session 状态
ccd ls                     # 列出历史 session
ccd attach <id>            # attach 到指定 session
ccd -a                     # 交互式选择 session 并 attach
ccd spawn <profile> [cwd]  # 非交互式启动 session
ccd conversations <cwd>    # 列出该目录下的 Claude Code conversations
```

## 部署

Docker 部署到阿里云：

```bash
docker compose up -d
```

或从 ghcr.io 拉镜像：

```bash
docker compose pull && docker compose up -d
```
