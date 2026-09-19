# 使用 ngrok 在云服务器部署

[English](README.ngrok.md) | **简体中文**

此方案让 Linux x86_64 云服务器运行 VisionEcho，再通过 ngrok 账号分配的固定 HTTPS 域名访问。无需自有域名，电脑可关机。ngrok 的流量、请求及账号限额仍适用；阿里云主机、流量和 Azure 用量分别计费。

`compose.ngrok.yml` 是 [Caddy 方案](README.zh-CN.md)的独立替代配置，仅运行 `app` 与 `ngrok`。不要将两个 Compose 文件叠加启动。默认 Compose 项目名仍为 `visionecho`，会复用同名 `app-data` 卷；全新服务器创建的是空工作区，不会自动导入电脑素材。

## 准备

- Linux x86_64、Docker Engine、Docker Compose 插件，建议 2 核 4 GB。
- ngrok 账号已分配的固定域名，以及属于该账号的 authtoken。这里只使用 authtoken，不需要 ngrok API key。
- 可用 Azure 配置，服务器可出站连接 ngrok、Azure 和镜像源。
- 从干净代码检出部署，不复制电脑的私人数据、`.env.local` 或账号数据库。

没有公网入站 80 / 443 要求。应用仅绑定服务器 `127.0.0.1:8000`，ngrok 不发布本地检查端口；安全组不要开放 8000、4040、5174，SSH 仅允许维护者来源。

## 配置

在仓库根目录，首次部署时创建私有环境文件；已有文件则保留并编辑：

```bash
cp deploy/server.env.example deploy/server.env
chmod 600 deploy/server.env
```

在服务器编辑器中填写 Azure 配置，并向同一个 `deploy/server.env` 添加以下字段。示例均为占位值：

```dotenv
NGROK_DOMAIN=your-assigned-domain.ngrok-free.app
NGROK_AUTHTOKEN=REPLACE_WITH_YOUR_AGENT_AUTHTOKEN
NGROK_IMAGE=ngrok/ngrok:latest
NGROK_SUBNET=172.30.89.0/24
NGROK_PRIVATE_IP=172.30.89.2
APP_PRIVATE_IP=172.30.89.3
```

`NGROK_DOMAIN` 只填账号中已分配的主机名，不含 `https://`、路径或端口。原 `DOMAIN` 字段仅供 Caddy 配置使用，此方案忽略它。Compose 自动生成精确的 `PUBLIC_ORIGIN=https://…`，不要改写请求 Host 为 `localhost`。

ngrok 使用官方 `ngrok/ngrok` 镜像。默认标签为 `latest`，部署验证后可将 `NGROK_IMAGE` 固定到当次下载镜像的 digest，避免以后更新时意外更换版本。两个容器使用不同的固定地址：ngrok 为 `172.30.89.2`，应用为 `172.30.89.3`。固定应用地址可防止应用先启动时，被 Docker 动态分配到 ngrok 预留的地址。

应用仅信任 `NGROK_PRIVATE_IP` 提供的转发头。网段冲突时同时修改 `NGROK_SUBNET`、`NGROK_PRIVATE_IP` 和 `APP_PRIVATE_IP`。两个 IP 必须是该子网内不同且未占用的主机地址，均不能使用网关地址。不要使用 `FORWARDED_ALLOW_IPS=*`。

[ngrok.yml.example](ngrok.yml.example) 是无凭据 v3 配置，由 Compose 只读挂载。`agent.web_addr: false` 关闭本地 Web / API，`--inspect=false` 关闭代理端 HTTP 流量检查。ngrok 云端处理及其保留规则仍由账号和平台决定，不能将本地检查关闭理解为流量从不经过 ngrok。

真实配置只保存于已忽略的 `deploy/server.env`，不放进 YAML、镜像或 Git。ngrok token 仅传入 ngrok 容器，Azure 密钥仅传入 app。不要公开 `docker inspect` 或未加 `--quiet` 的 Compose 配置展开结果，它们可能显示环境变量。

## 构建与校验

以下命令不会启动公开端点。先构建最新版应用，再获取官方 agent 镜像：

```bash
docker compose --env-file deploy/server.env -f deploy/compose.ngrok.yml config --quiet
docker compose --env-file deploy/server.env -f deploy/compose.ngrok.yml build app
docker compose --env-file deploy/server.env -f deploy/compose.ngrok.yml pull ngrok
docker compose --env-file deploy/server.env -f deploy/compose.ngrok.yml run --rm --no-deps ngrok config check --config /etc/ngrok.yml
```

如果从经过验证的镜像包加载应用，先核对 `build-info.txt` 中的提交号；旧包不含最新代码。然后以 `docker load` 导入、跳过 `build app`。本机校验已确认 ngrok Agent 3.39.11 接受此 v3 配置及 CLI 参数；实际 Linux 容器仍须执行上述校验。

## 将原固定域名迁移到服务器

1. 先启动云端应用，等待 `app` 状态为 `healthy`。
2. 原电脑端确认没有进行中的生成或上传，再停止使用同一域名的旧 ngrok agent。不要同时启动两个相同域名端点，也不要启用 pooling。
3. 启动云端 ngrok。固定域名不变，短暂切换期间可能显示端点离线。

```bash
docker compose --env-file deploy/server.env -f deploy/compose.ngrok.yml up -d --no-build app
docker compose --env-file deploy/server.env -f deploy/compose.ngrok.yml ps
# 确认应用健康且旧端点已停止后，再启动公开端点。
docker compose --env-file deploy/server.env -f deploy/compose.ngrok.yml up -d --no-build ngrok
```

更换域名后重建 app 与 ngrok 容器，使 Host 和 Origin 校验使用同一新域名。不要把电脑上的私人工作区复制为公开示例；如要迁移托管用户数据，应另做已授权的备份迁移，不能与原本地素材混合。

## 验证与运维

- 打开账号固定 HTTPS 域名，确认英文介绍页加载；ngrok 套餐可能显示平台提示页。
- 分别使用两个独立浏览器会话创建访客，确认工作区为空且相互隔离。
- 用合成或已授权短片验证上传、生成、播放与导出。审校为可选，不影响已有文件下载。
- 检查 `docker compose … ps` 和受限日志，避免公开完整日志。此方案故意没有 4040 检查界面。

```bash
docker compose --env-file deploy/server.env -f deploy/compose.ngrok.yml logs --tail=80 app ngrok
```

容器使用 `restart: unless-stopped`；还需保证 Docker 服务开机启动。暂停服务时使用同一 Compose 文件的 `stop`；备份与更新先等待处理结束，再停止容器并备份 `app-data`。不要执行 `down -v`，它会删除数据卷。当前仅支持一个 app worker。

有关访客额度、账号隔离和素材保留，见[登录、试用与数据隔离](../DEPLOYMENT-PRIVACY.zh-CN.md)。

## 官方依据

- [ngrok Docker 镜像及使用方式](https://ngrok.com/docs/using-ngrok-with/docker)
- [Agent v3 配置：web_addr](https://ngrok.com/docs/gateway/agent/config/v3)
- [ngrok CLI：http、--url、--inspect](https://ngrok.com/docs/gateway/agent/cli)
