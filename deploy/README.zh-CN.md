# 在 Linux 服务器部署 VisionEcho

此配置运行一个 HTTPS 网站：Caddy 接收公网请求，VisionEcho 在独立容器内处理登录、视频与 API。账号及访客素材写入持久化卷，不读取维护者电脑中的案例目录。

## 准备

- Linux x86_64 服务器，已安装 Docker Engine 和 Docker Compose 插件。
- 建议至少 2 核、4 GB 内存；视频临时文件和导出需要额外磁盘空间。一次仅运行一个生成任务。
- 一个实际持有的域名。为该域名设置指向服务器公网 IPv4 的 A 记录；没有可用 IPv6 时不要保留错误的 AAAA 记录。
- 放行入站 TCP 80、443；SSH 仅允许维护者来源。不要开放 8000、5174 或数据库端口。
- 中国内地服务器使用自有域名提供网站服务时，先完成适用的备案要求。没有域名时，本方案不会生成可用的公开 HTTPS 地址。

从干净代码检出部署，不上传本机的 `.local-data`、`.hosted-data`、`.env.local` 或案例文件。Docker 构建使用仓库的源码允许列表；账户、视频和密钥都不进入镜像。

## 配置域名与服务密钥

以下命令在仓库根目录执行。首次部署时创建配置；后续更新保留现有配置文件。

```bash
cp deploy/server.env.example deploy/server.env
chmod 600 deploy/server.env
cp deploy/Caddyfile.example deploy/Caddyfile
```

用服务器编辑器填写 `deploy/server.env`：`DOMAIN` 只填实际域名，不带协议或路径；Azure 凭据仅填到该文件。Compose 自动将 `PUBLIC_ORIGIN` 设置为此域名的 HTTPS 来源。不要把环境文件粘贴到聊天、提交仓库或发送配置展开结果。

无需修改 Compose 中的上传上限：`MAX_UPLOAD_MB=1024`。前端把文件分成不超过 8 MiB 的请求，Caddy 保留 1 GB 请求上限与 150 秒读写超时；生成和导出任务异步执行，不要求一个 HTTP 请求等待整个视频完成。

## 构建并启动

Compose 为 Caddy 分配固定的 Docker 私网地址，后端只信任该地址提供的转发来源，以便登录和体验限流按实际访客 IP 计算。若服务器已有网络与默认私网段冲突，在环境文件中一起修改 VISIONECHO_SUBNET 和 CADDY_PRIVATE_IP；不要将可信代理设置为任意来源。

```bash
docker compose --env-file deploy/server.env -f deploy/compose.yml build app
docker compose --env-file deploy/server.env -f deploy/compose.yml up -d --no-build
docker compose --env-file deploy/server.env -f deploy/compose.yml ps
```

也可把经过验证的 Linux amd64 镜像载入服务器，或在 `VISIONECHO_IMAGE` 指定有权限拉取的镜像标签，再启动。不要假定私有仓库存在公开镜像；只有实际提供镜像地址后才执行拉取。

应用以 UID/GID `10001` 运行。首次创建的 `visionecho_app-data` 命名卷继承镜像中 `/data` 的属主和 0700 权限。若改用宿主机目录挂载，先将新建的专用目录属主设为 `10001:10001`；不要把现有私人素材目录作为挂载源。

## 验证

- Compose 中应用应显示 `healthy`；镜像健康检查携带正确的 Host 访问 `/healthz`。
- 打开实际域名的 HTTPS 地址，证书应有效，首页显示登录或体验入口。
- 使用两个独立浏览器会话：分别创建账号或体验，只能看到各自上传的素材。复制一个会话的成片链接到另一个会话应返回 404，退出后应返回 401。
- 上传一个授权的短视频，确认分块上传、生成进度、播放及导出正常。

查看运行错误时可使用以下命令，不要公开完整日志：

```bash
docker compose --env-file deploy/server.env -f deploy/compose.yml logs --tail=100 app caddy
```

若 Caddy 无法获取证书，检查域名解析、80/443 防火墙规则、服务器时钟及备案状态。不要通过关闭 HTTPS 或浏览器证书检查掩盖配置错误。

## 更新、备份与停止

更新前先等待当前生成任务结束，再停止容器、备份持久化卷，避免 SQLite 和工作区 JSON 在写入时被复制。备份包含用户素材及账号数据库，应存放在受限位置。

```bash
docker compose --env-file deploy/server.env -f deploy/compose.yml stop
# 此时使用服务器或云平台的卷备份能力保存 app-data。
docker compose --env-file deploy/server.env -f deploy/compose.yml build app
docker compose --env-file deploy/server.env -f deploy/compose.yml up -d --no-build
```

`docker compose down` 默认保留命名卷；不要使用 `down -v`，这会删除线上数据。不要扩容多个应用副本或 workers：当前工作区索引与生成锁按单进程设计。

访客和账号的数据隔离、会话期限及当前限制见 [登录、试用与数据隔离](../DEPLOYMENT-PRIVACY.zh-CN.md)。此目录只是部署配置，不代表已经购买服务器、配置域名或完成上线。
