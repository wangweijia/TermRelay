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
- 构建前执行协议检查、Server 构建和测试、Web 单元测试；不运行与服务端发布无关的 Mac 测试。Docker 内仍执行 Server 和 Web 类型检查。
- 工作区存在未提交修改时拒绝发布，避免镜像内容与版本号不一致。
- 输出到 `dist/termrelay-server/`。

指定正式版本：

```bash
pnpm release:server --version 0.1.0
```

可用参数：

```text
--version VERSION
--platform linux/arm64
--output-dir PATH
--full-check
--skip-check
--allow-dirty
```

生成文件示例：

```text
dist/termrelay-server/
├── termrelay-server-0.1.0-linux-arm64.tar.gz
└── termrelay-server-0.1.0-linux-arm64.tar.gz.sha256
```

每次成功生成新发布包和校验文件后，脚本会自动删除 `dist/termrelay-server` 中的旧 Server 发布包，只保留最新版本。构建或导出失败时不会清理旧包。

Docker Desktop 必须正在运行，并支持 Buildx。首次跨架构构建可能需要下载 ARM64 基础镜像；网络不稳定时可以为 Docker daemon 配置代理。

### 构建提速与发布内容

- Docker 上下文仅包含 Node/Web 构建需要的清单、配置、源码和协议文件，不传输 Mac、文档、图片预览、探针、测试源码及历史发布包。
- 构建阶段的依赖安装显式限定为 Server、Web 及其工作区依赖，不安装 Linux Agent 的 `node-pty`，也不需要为 Server 镜像添加 PTY 原生编译工具。依赖生命周期脚本仍正常执行。
- 协议只生成一次，Server 与 Web 使用独立构建阶段；仅修改其中一端时复用另一端的缓存。编译使用构建机架构，运行镜像及生产依赖仍使用目标架构。
- pnpm 下载缓存跨构建保留；生产依赖打包独立于 Server/Web 源码，业务改动不重新安装生产依赖。
- 镜像保留运行代码、Web 静态资源、协议运行文件、生产依赖和全部数据库迁移；不包含测试、探针、应用源码、Server 类型声明和 source map。日常 Server 构建／测试不受精简影响。
- 镜像在包内以 `image.tar` 保存，整个发布包只做一次快速 gzip 压缩；已安装 `pigz` 时自动使用多核压缩。相比最高压缩率，优先降低 CPU 耗时，包大小可能增加。临时目录需要容纳未压缩的 Docker 镜像。

需要发布前执行完整仓库检查（含 Mac）时使用 `pnpm release:server --full-check`。已经在当前代码版本完成检查时可使用 `--skip-check`，但这不会跳过 Docker 内的生产构建及类型检查。首次安装依赖和构建基础镜像仍然需要时间；不要禁用缓存或在每次发布前清理 Docker builder 缓存。

发布／部署脚本的回归检查使用 `pnpm test:release`，不要求 Docker daemon，不访问生产数据库；它验证发布包结构、校验和、失败时旧包保留、镜像 ID 检查和旧包兼容。真实镜像构建仍须在有 Docker 的环境执行。

## 2. 上传并校验

手动上传 `.tar.gz` 和 `.sha256` 到 Jetson，在文件所在目录执行：

```bash
sha256sum -c termrelay-server-0.1.0-linux-arm64.tar.gz.sha256
tar -xzf termrelay-server-0.1.0-linux-arm64.tar.gz
cd termrelay-server-0.1.0
```

发布包内容：

```text
termrelay-server/
└── termrelay-server-0.1.0/
    ├── image.tar
    ├── compose.yaml
    ├── deploy.sh
    ├── manifest.env
    └── .env.production.example
```

## 3. 首次配置

在 Jetson 上创建一次稳定的生产配置：

```bash
mkdir -p /home/weijia/deploy/termrelay/shared
cp .env.production.example /home/weijia/deploy/termrelay/shared/.env.production
chmod 600 /home/weijia/deploy/termrelay/shared/.env.production
```

填写实际数据库凭据。后续每个发布包都复用该文件，构建产物不包含任何生产密钥；Release Runner 会在部署时通过 `--env-file` 传入稳定路径。

如果这个稳定配置由旧版本创建，请在升级前同步新增的必填项。当前至少需要配置浏览器实际访问的 origin：

```dotenv
PUBLIC_ORIGIN=https://termrelay.example.com
```

部署脚本会在加载镜像前检查该值，避免 Compose 在迁移阶段才因缺少变量退出。

生产发布包默认绑定 Jetson 的所有网络接口，即 `0.0.0.0:3006`。局域网设备可以通过 Jetson 的局域网 IP 直接访问。当前没有应用层认证，只能在可信局域网使用，不能通过路由器端口转发直接暴露到公网。

## 4. 一键部署

```bash
./deploy.sh --env-file /home/weijia/deploy/termrelay/shared/.env.production
```

脚本依次执行：

1. 校验 Docker、Compose、发布包和环境文件。
2. 从 `image.tar` 加载指定版本镜像；本地已有与 manifest 镜像 ID 完全一致的镜像时跳过导入，同名但内容不同的镜像仍重新加载。部署脚本也兼容旧包的 `image.tar.gz`。
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
curl --noproxy 127.0.0.1 -fsS http://127.0.0.1:3006/health
docker compose --env-file /home/weijia/deploy/termrelay/shared/.env.production -f compose.yaml -p termrelay ps
```

从 Mac 或其他局域网设备直接访问（将示例 IP 替换为 Jetson 的实际局域网 IP）：

```bash
curl --noproxy '*' -fsS http://192.168.8.134:3006/health
```

浏览器访问 `http://192.168.8.134:3006`，Mac App 使用 `ws://192.168.8.134:3006/ws/client`。如果 Jetson 的地址由 DHCP 分配，请在路由器中为它保留固定地址。
