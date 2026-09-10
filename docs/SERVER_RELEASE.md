# Server 离线构建与 Jetson 一键部署

发布流程分成两步：开发机生成离线发布包，手动上传到 Jetson 后运行包内的 `deploy.sh`。发布包包含 Linux ARM64 Docker 镜像、Compose、环境模板、manifest 和部署脚本，不包含数据库密码。

## 1. 开发机构建

在仓库根目录运行：

```bash
pnpm release:server
```

默认行为：

- 版本号使用当前 Git 短 SHA。
- 目标平台为 Jetson 使用的 `linux/arm64`。
- 构建前执行全仓检查、Server 构建和测试。
- 工作区存在未提交修改时拒绝发布，避免镜像内容与版本号不一致。
- 输出到 `dist/releases/`。

指定正式版本：

```bash
pnpm release:server -- --version 0.1.0
```

可用参数：

```text
--version VERSION
--platform linux/arm64
--output-dir PATH
--skip-check
--allow-dirty
```

生成文件示例：

```text
dist/releases/
├── termrelay-server-0.1.0-linux-arm64.tar.gz
└── termrelay-server-0.1.0-linux-arm64.tar.gz.sha256
```

Docker Desktop 必须正在运行，并支持 Buildx。首次跨架构构建可能需要下载 ARM64 基础镜像；网络不稳定时可以为 Docker daemon 配置代理。

## 2. 上传并校验

手动上传 `.tar.gz` 和 `.sha256` 到 Jetson，在文件所在目录执行：

```bash
sha256sum -c termrelay-server-0.1.0-linux-arm64.tar.gz.sha256
tar -xzf termrelay-server-0.1.0-linux-arm64.tar.gz
cd termrelay-server-0.1.0
```

发布包内容：

```text
termrelay-server-0.1.0/
├── image.tar.gz
├── compose.yaml
├── deploy.sh
├── manifest.env
└── .env.production.example
```

## 3. 首次配置

```bash
cp .env.production.example .env.production
chmod 600 .env.production
```

编辑 `.env.production`，填写生产数据库的应用账户和 migration 账户密码。不要修改 `manifest.env` 中的镜像标识，也不要把 `.env.production` 上传到 Git。

生产端口默认只绑定 Jetson 的 `127.0.0.1:3000`。在设备认证和 Cloudflare Access 完成前，不建议设置为 `0.0.0.0`。

## 4. 一键部署

```bash
./deploy.sh
```

脚本依次执行：

1. 校验 Docker、Compose、发布包和环境文件。
2. 从 `image.tar.gz` 加载指定版本镜像。
3. 使用 migration 账户执行 TypeORM migration。
4. 使用低权限应用账户启动长期运行容器。
5. 最多等待 60 秒并检查 `/health`。
6. 成功后输出容器状态；失败时输出最近 Server 日志。

数据库已经单独完成迁移时，可以执行：

```bash
./deploy.sh --skip-migration
```

使用其他环境文件：

```bash
./deploy.sh --env-file /secure/path/termrelay.env
```

部署是幂等的：再次上传新版本、解压并执行新包内的 `deploy.sh`，Compose 会使用新镜像替换 Server 容器，数据库 migration 只执行尚未应用的版本。

## 5. 验证和访问

在 Jetson 上：

```bash
curl -fsS http://127.0.0.1:3000/health
docker compose --env-file .env.production -f compose.yaml -p termrelay ps
```

从 Mac 安全访问当前仅监听本机的服务：

```bash
ssh -N -L 13000:127.0.0.1:3000 jetson
```

浏览器访问 `http://127.0.0.1:13000`，Mac App 使用 `ws://127.0.0.1:13000/ws/client`。
