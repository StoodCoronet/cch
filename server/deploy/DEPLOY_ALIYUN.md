# 阿里云 ECS 部署 CCH（生产）

适配代码已备好：`docker-compose.yml`（cch-server + caddy）和 `server/deploy/Caddyfile`。
架构：公网只暴露 Caddy（80/443，自动 HTTPS），server 容器不直接暴露端口。

## 前置条件

- ECS 一台（安全组放行 **22、80、443**；22 建议限办公 IP 或改端口 + 密钥登录）
- 域名一个，A 记录指向 ECS 公网 IP（大陆 ECS 需备案）
- ECS 上装好 Docker + docker compose 插件

## 步骤

```bash
# 1. 上传代码（或 git clone）
scp -r .env docker-compose.yml server/deploy/Caddyfile root@<ECS_IP>:/opt/cch/

# 2. 在 ECS 上准备 .env（照 .env.example 填）
mkdir -p /opt/cch && cd /opt/cch
openssl rand -hex 32   # 生成 HANDY_MASTER_SECRET
# .env 内容示例：
#   HANDY_MASTER_SECRET=<上面生成的>
#   ADMIN_PASSWORD=<强密码>
#   DOMAIN=cch.example.com
#   PUBLIC_URL=https://cch.example.com
#   ALLOWED_ORIGINS=https://cch.example.com
chmod 600 .env

# 3. 启动
cd /opt/cch && docker compose pull && docker compose up -d

# 4. 验证
curl https://cch.example.com/health     # 应返回 {"status":"ok",...}
docker compose logs caddy | tail        # 确认证书签发成功
```

## 部署后必做

1. 打开 `https://<域名>/admin`，用 ADMIN_PASSWORD 登录，**生成邀请链接**（带过期时间和次数限制）发给用户；用户打开链接注册（邮箱+密码）
2. CLI 连接：`ccd connect 'https://<域名>/connect?token=...'`
3. Android：app 菜单里把服务器地址改成 `https://<域名>`

## 运维

- **备份**：`docker run --rm -v cch_cch-data:/data -v $(pwd):/backup alpine tar czf /backup/cch-data-$(date +%F).tar.gz /data`，建议 crontab 每日 + 传 OSS
- **升级**：`docker compose pull && docker compose up -d`
- **日志**：`docker compose logs -f cch-server`
- **吊销邀请/管理账号**：`/admin` 面板

## 安全要点（已内置/需你确认）

- TLS 由 Caddy 自动签发续期；server 不对公网暴露端口
- 登录/邀请接口有限流（20/min），全局 300/min
- CORS 默认同源，ALLOWED_ORIGINS 白名单收紧
- admin 密码比较为恒定时间
- 数据库是容器内嵌 PGlite，无端口暴露
- SSH 建议：改密钥登录 + 禁密码；可装 fail2ban
