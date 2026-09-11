# 数据库环境

TermRelay 使用两个完全隔离的数据库环境。任何密码文件均由 `.gitignore` 排除；仓库只提交占位模板。

## 端口分配

| 场景 | 地址/端口 | 说明 |
| --- | --- | --- |
| Jetson 生产 Server | `0.0.0.0:3006` | 监听所有网卡，局域网通过 Jetson IP 访问；避开 Forgejo 使用的 3000 |
| 本地开发 Server | `127.0.0.1:3007` | Compose、Mac 默认地址和探针统一使用 |
| 独立 Vite 开发页 | `127.0.0.1:5177` | API/WS 代理到 3007 |
| 本地开发 MySQL | `127.0.0.1:13307` | 映射到容器 MySQL 3306 |
| Docker 内部 Server | `3000` | 仅容器网络内使用，不占用宿主机 3000 |
| Docker/生产 MySQL | `3306` | 容器内部及既有 Jetson 数据库端口 |
| 本地网络代理 | `127.0.0.1:7890` | 仅依赖下载遇到网络问题时使用 |

2026-09-11 在 Jetson 实测：3000 由 Forgejo 监听，8000 由另一个 Docker 项目使用，3306 由共享 MySQL 使用；3006 未被占用。生产发布包默认将 3006 暴露到 Jetson 的所有网卡，宿主机端口可以通过 `.env.production` 的 `SERVER_PORT` 修改，无需重新构建镜像。

## 本地开发

本地数据库为 Docker MySQL 8.4：

| 配置 | 值 |
| --- | --- |
| 数据库 | `termrelay_dev` |
| 用户 | `termrelay_dev` |
| 应用内地址 | `mysql:3306` |
| 宿主机地址 | `127.0.0.1:13307` |

启动完整开发栈：

```bash
docker compose -f deploy/server/compose.dev.yaml up --build
```

只启动数据库、在宿主机运行 NestJS：

```bash
docker compose -f deploy/server/compose.dev.yaml up -d mysql
cp apps/server/.env.example apps/server/.env.development
# 将 DB_HOST 改为 127.0.0.1，DB_PORT 改为 13307
set -a; source apps/server/.env.development; set +a
pnpm dev:server
```

开发环境的默认密码只用于绑定在 `127.0.0.1` 的本机数据库，可以在 `deploy/server/.env.development` 中覆盖。

完整开发栈的 Server 地址是 `http://127.0.0.1:3007`。Mac App 同机运行时使用 `ws://127.0.0.1:3007/ws/client`；独立 Vite 开发页使用 `http://127.0.0.1:5177` 并代理到 3007。从另一台 Mac 连接时将主机替换为 Server 的局域网地址，并确保 Server 监听 LAN 地址。当前尚无设备认证，只能用于受控局域网。

## 最终部署

需要在开发机生成离线 Docker 发布包、再手动上传 Jetson 时，使用 `pnpm release:server`；完整步骤见 `docs/SERVER_RELEASE.md`。

生产数据库使用 Jetson 上的 MySQL 8.4：

| 配置 | 值 |
| --- | --- |
| 地址 | `192.168.8.134:3306` |
| 数据库 | `termrelay_prod` |
| 运行用户 | `appuser` |
| 迁移用户 | `root`，只用于一次性命令 |

准备部署变量：

```bash
cp deploy/server/.env.production.example deploy/server/.env.production
# 编辑实际密码和 Cloudflare Access 参数
```

首次部署或升级数据库：

```bash
docker compose --env-file deploy/server/.env.production \
  -f deploy/server/compose.prod.yaml \
  --profile migration run --rm migrate
```

迁移成功后启动长期运行的低权限应用容器：

```bash
docker compose --env-file deploy/server/.env.production \
  -f deploy/server/compose.prod.yaml up -d server
```

生产容器只接收 `appuser` 密码。不要把 root 密码留在容器环境、镜像层、Git 或普通日志中；迁移完成后应从 shell 环境清除。

## 迁移规则

- `synchronize` 永远为 `false`，所有结构变化必须提交 migration。
- 本地开发自动先执行 migration，再启动 Server。
- 生产 migration 是显式的一次性操作，失败时不启动新版本 Server。
- 运行用户只有 CRUD 权限，不拥有 `CREATE`、`ALTER`、`DROP` 或 `GRANT`。
- 不复用现有 `shared` 数据库，避免 TermRelay 迁移影响其他应用。

截至 2026-09-11，本地开发库和 Jetson 生产库均已应用：

- `InitialSchema1788966000000`
- `SessionRuntimeMode1789056300000`

第二个 migration 只为 `sessions` 新增默认值为 `terminal` 的 `runtime_mode` 列；生产应用账户已验证可以读取新结构，但仍不具备 DDL 权限。生产 Server 镜像尚未随 S3 代码部署。
