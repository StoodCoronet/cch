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
cli/          cch 命令行 (Rust)，代替 cct，直连 server
server/       cch-server (Node.js + PGlite)，内嵌 admin + user dashboard
app/          手机 App (Expo RN)，待开发
packages/wire 共享消息协议
```

## 快速开始

### 1. 启动 Server

```bash
cd server
pnpm install
pnpm standalone:dev
```

浏览器打开 `http://localhost:3005/admin`（密码：admin123）

### 2. Build CLI

```bash
cd cli
cargo build --release
```

### 3. 连接

从 dashboard 的 "Connect a Device" 生成 token，然后：

```bash
./target/release/cch connect "http://localhost:3005/connect?token=xxx"
./target/release/cch run --profile default "hello"
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

## 常用命令

```bash
cch connect <url>     # 连接 server
cch disconnect        # 断开
cch status            # 查看状态
cch run <profile>     # 启动 session
cch                   # TUI 模式
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
