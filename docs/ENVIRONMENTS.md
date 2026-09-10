# 数据库环境

TermRelay 使用两个完全隔离的数据库环境。任何密码文件均由 `.gitignore` 排除；仓库只提交占位模板。

## 本地开发

本地数据库为 Docker MySQL 8.4：

| 配置 | 值 |
| --- | --- |
| 数据库 | `termrelay_dev` |
| 用户 | `termrelay_dev` |
| 应用内地址 | `mysql:3306` |
| 宿主机地址 | `127.0.0.1:3307` |

启动完整开发栈：

```bash
docker compose -f deploy/server/compose.dev.yaml up --build
```

只启动数据库、在宿主机运行 NestJS：

```bash
docker compose -f deploy/server/compose.dev.yaml up -d mysql
cp apps/server/.env.example apps/server/.env.development
# 将 DB_HOST 改为 127.0.0.1，DB_PORT 改为 3307
set -a; source apps/server/.env.development; set +a
pnpm dev:server
```

开发环境的默认密码只用于绑定在 `127.0.0.1` 的本机数据库，可以在 `deploy/server/.env.development` 中覆盖。

Mac App 可以在设置中填写开发 Server 地址。同机运行时使用 `ws://127.0.0.1:3000/ws/client`；从另一台 Mac 连接时将主机替换为 Server 的局域网地址，并确保 Server 监听 LAN 地址。当前尚无设备认证，只能用于受控局域网。

## 最终部署

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
