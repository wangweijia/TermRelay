# TermRelay CardputerZero

基于用户提供的 CardputerZero Application Template 初始化的原生客户端项目。
技术方案见 [CardputerZero App 设计](../../docs/CARDPUTERZERO_APP_DESIGN.md)。

## 当前状态

已导入 LVGL 模板及其演示界面、桌面模拟器、Linux 显示/输入适配和构建预设。
已实现授权连接首个闭环：原生域名输入、后台配对、Web 设置页选择执行设备后批准、永久凭据保存与恢复、共享公网 WSS 连接及在线撤销。
本轮按用户授权同步修改 Server、Contracts 和 Web；Mac / Linux Agent 实现未改，不连接真实 AI Provider。
当前只确认控制端身份与授权范围，不包含会话浏览、对话、审批、问答或终端业务。

2026-11-05 验证记录：macOS Apple Silicon Debug 构建通过，产物为 Mach-O arm64；
安装暂存到本项目 `build/` 后，启动器、唯一命名图标、配置文件及默认不安装服务的检查通过。
LVGL v9.5.0 已下载到忽略的 `.cache/vendor/`，本地配置使用该源码完成，无需重复下载。
未启动模拟器，未做截图或交互验收，未验证 Linux ARM64、实机及 `.deb` 包。
本轮新增验证：原生 Debug 构建和 1 个 CTest（HTTPS 地址、输入映射及私有存储）通过；C++ 探针与临时 Nest HTTP/WSS 服务完成配对、授权、重启恢复与在线撤销。集成测试使用内存仓库，不代表真实 MySQL 迁移或公网 TLS 已验收。

## 模板依据

- 上游：[CardputerZero/Template](https://github.com/CardputerZero/Template)。
- 本次来源：用户提供的本地 `Template-main` 解压目录，模板版本 0.2.1。
- 上游配套工具：[CardputerZero/AppBuilder](https://github.com/CardputerZero/AppBuilder)。
- 本地源码确认：C++17、CMake 3.31+、LVGL v9.5.0、SDL2、FreeType、libpng、JPEG、fmt 和 zlib。README 徽标中的 SDL3 不是该源码的实际依赖。
- 模板有 MIT 许可证，保留原始声明及字体许可清单；这不表示 TermRelay 整个仓库已指定 MIT 许可证。
- 解压目录没有 Git 元数据，不能据此确定上游 commit；不虚构 commit 或下载日期。

LVGL 由 CMake FetchContent 按 v9.5.0 获取，首次配置需要网络。
可使用标准 CMake 参数 `-DFETCHCONTENT_SOURCE_DIR_LVGL=/absolute/path/to/lvgl` 指定已下载的同版本源码。
未导入上游代理指令、截图、部署脚本或 AppStore 占位发布信息。

## 目录

```text
src/             授权启动页、connection 网络状态机、模板 UI 和平台适配
tests/           无 GUI 的授权存储/输入测试和原生连接探针
assets/          模拟器外壳、字体、图标和音效，保留模板资源
config/          应用默认配置
cmake/           设备工具链和构建辅助
packaging/       安装、desktop 入口和可选 systemd 模板
CMakeLists.txt   应用目标和依赖
CMakePresets.json 桌面及设备构建预设
app-builder.json 私有构建元数据，不配置 AppStore 发布
```

## 换电脑快速开始

优先使用仓库中已经初始化好的本目录，不必重新下载模板，也不必安装 AppBuilder CLI。
先把包含本目录的仓库版本同步到新电脑；仅克隆远端不会带上尚未提交或推送的本地文件。
这个原生应用单独编译不依赖 `pnpm install`，不需要提供 AI 凭据；真实授权需要先部署支持控制端角色的 Server / Web 并应用迁移。

### 1. 检查构建环境

需要 CMake 3.31+、Ninja、C++17 编译器、SDL2、FreeType、libpng、JPEG、fmt、zlib、libcurl 8.4+（必须编译启用 ws/wss）及 nlohmann-json 3.11+。
macOS 先检查 Apple 工具链与已有依赖：

```sh
xcode-select -p
cmake --version
ninja --version
clang++ --version
pkg-config --modversion sdl2 freetype2 libpng libjpeg fmt zlib
```

缺少 Apple 命令行工具时由用户运行 `xcode-select --install`。此应用的桌面构建不要求完整 Xcode；
仓库 Mac App 的完整 Xcode / Metal 要求是另一件事。
已有 Homebrew 时，从下面列表中只安装本机缺少的项目：

```sh
HTTP_PROXY=http://127.0.0.1:7890 HTTPS_PROXY=http://127.0.0.1:7890 \
ALL_PROXY=http://127.0.0.1:7890 \
brew install cmake ninja pkgconf sdl2 freetype libpng jpeg fmt zlib curl nlohmann-json
```

代理命令仅用于本机已启动 `7890` HTTP 代理时；不会修改 shell 全局代理配置。macOS 系统 curl 的版本号不足以证明支持 WebSocket，检查 Homebrew 版本：

```sh
"$(brew --prefix curl)/bin/curl" --version
```

`Protocols` 必须包含 `ws wss`。本次使用 curl 8.23.0、nlohmann-json 3.12.0；其余电脑和目标设备需自行确认。

不需要为桌面预览预装 ARM 交叉工具链、BSP、`dpkg` 或发布工具。
Apple Silicon 使用 arm64 Homebrew 与依赖；不要混用 Rosetta 的 x86_64 库。
若 CMake 找不到已安装的 Homebrew 依赖，可在配置命令后追加 `-DCMAKE_PREFIX_PATH="$(brew --prefix)"`。

### 2. 配置和编译

以下命令从 TermRelay 仓库根目录开始执行：

```sh
cd apps/cardputerzero
cmake --list-presets
cmake --preset darwin-arm64 -DCURL_ROOT="$(brew --prefix curl)"
cmake --build --preset darwin-arm64-dbg --parallel 4
```

首次配置会通过 Git 获取 LVGL v9.5.0，需要网络；失败时改用下一节的源码包方式。
Debug 程序位于 `build/darwin-arm64/Debug/termrelay-cardputerzero`。
需要打开授权界面时，可手动运行：

```sh
./build/darwin-arm64/Debug/termrelay-cardputerzero
```

这会打开授权窗口，本轮未自动运行 GUI 或做视觉验收。首次授权步骤见下文；不要用模板演示截图作为新界面的验收证据。

其他宿主机预设：

| 环境 | 配置 | Debug 构建 | 验证状态 |
| --- | --- | --- | --- |
| Apple Silicon Mac | `darwin-arm64` | `darwin-arm64-dbg` | 本次已编译通过 |
| Intel Mac | `darwin-x86-64` | `darwin-x86-64-dbg` | 模板保留，未验证 |
| Linux x86_64 | `linux-x86-64` | `linux-x86-64-dbg` | 模板保留，未验证 |

Linux 桌面还需要启用 WebSocket 的 libcurl 开发包及 `nlohmann-json3-dev`，不能只检查系统 `curl` 命令版本。
其余包包括编译器、CMake、Ninja、pkg-config、SDL2、FreeType、PNG、JPEG、fmt 和 zlib 的开发包。
Debian/Ubuntu 可对应 `build-essential`、`cmake`、`ninja-build`、`pkg-config`、`libsdl2-dev`、
`libfreetype-dev`、`libpng-dev`、`libjpeg-dev`、`libfmt-dev`、`zlib1g-dev`，但先确认发行版 CMake 达到 3.31。
不能假设系统默认 CMake 足够新；本文不声称 Linux 或 Windows 已完成验证。

### 3. Git 下载失败时使用固定版本源码包

本次遇到 GitHub API 限流、页面抓取失败和 Git `Broken pipe`；Git 失败不代表模板不存在。
下载依赖不需要 GitHub API、PAT 或 GitHub 登录。以下命令在本应用目录执行：

```sh
mkdir -p .cache/vendor
curl --fail --location --connect-timeout 10 --max-time 180 \
	--output .cache/vendor/lvgl-v9.5.0.tar.gz \
	https://codeload.github.com/lvgl/lvgl/tar.gz/refs/tags/v9.5.0
tar -xzf .cache/vendor/lvgl-v9.5.0.tar.gz -C .cache/vendor
cmake --preset darwin-arm64 \
	-DCURL_ROOT="$(brew --prefix curl)" \
	-DFETCHCONTENT_SOURCE_DIR_LVGL="$PWD/.cache/vendor/lvgl-9.5.0" \
	-DFETCHCONTENT_FULLY_DISCONNECTED=ON
cmake --build --preset darwin-arm64-dbg --parallel 4
```

本次实际使用这条路径构建成功。压缩包约 97 MiB，解压与编译还需额外空间；
出现下载 100% 并不代表解压、配置和构建全部结束，需看最终命令退出码和构建结果。
其他架构把配置/构建预设替换为对应名称，LVGL 源码路径不变。

完全离线时，可以从另一台机器传输同版本源码包或已解压的源码，再传入该参数。
不要在 LVGL 源码尚未存在时启用 `FETCHCONTENT_FULLY_DISCONNECTED=ON`，否则 CMake 会直接报错。
该参数只禁止 FetchContent 联网，不代表设备工具链也不会下载 BSP。

### 4. 配置 VS Code 头文件解析

仓库级设置使用 `C_Cpp.default.compileCommands` 指向编译数据库。
从仓库根目录打开 VS Code、并完成配置后，Apple Silicon 路径为：

```json
{
	"C_Cpp.default.compileCommands": "${workspaceFolder}/apps/cardputerzero/build/darwin-arm64/compile_commands.json"
}
```

这是 VS Code C/C++ 扩展的设置。构建预设会生成数据库，其中包含真实头文件路径和 `USE_DESKTOP=1`。
若换电脑后仓库级本地设置未同步，请在 VS Code 设置中配置相同字段；不要假定被忽略的本地配置会随 Git 迁移。
Intel Mac / Linux 替换路径中的预设名；若仅打开本应用目录，则去掉 `apps/cardputerzero/` 前缀。
使用 clangd 等其他扩展时，应配置其自己的编译数据库路径，不能指望 `C_Cpp` 设置生效。

本次遇到：编译成功，但编辑器提示找不到 `xf86drmMode.h`。原因是编辑器缺失桌面宏，
把 `src/config/lv_conf.h` 解析进 Linux 分支；使用正确数据库后诊断消失。
不要为修复这个桌面误报安装 Linux DRM 依赖，也不要删除平台条件编译代码。

### 5. 检查安装布局，不安装到系统

需要复现初始化时的安装检查，可在本应用目录运行：

```sh
DESTDIR="$PWD/build/darwin-arm64/stage" \
	cmake --install build/darwin-arm64 --config Debug --prefix /usr
```

只写入项目 `build/darwin-arm64/stage/`，不需要 sudo。
应能看到 `usr/bin/termrelay-cardputerzero`、`etc/termrelay-cardputerzero.conf`、
`usr/share/APPLaunch/applications/termrelay-cardputerzero.desktop` 和唯一命名的图标。
默认不安装 systemd 服务。不要漏掉 `DESTDIR` 后把调试程序直接安装进系统目录。

### 6. 迁移和重新配置

- 同步源代码、资源、配置、构建文件、打包文件和许可证；不依赖原电脑桌面的 Template-main 目录。
- `build/` 和 `.cache/` 被忽略，不随 Git 同步；离线使用时单独传输 LVGL 源码包即可。
- 不复制旧电脑的 CMakeCache 或整个 build 目录：其中含绝对路径、编译器、架构及依赖位置。
- 本次传入的 `FETCHCONTENT_SOURCE_DIR_LVGL` 会保存在当前构建缓存中，不是跨电脑可用的路径。
- 路径或架构改变后，在本应用目录重新配置；需要重置缓存时使用 `cmake --fresh --preset darwin-arm64`，并按需重新传入本地 LVGL 路径及离线选项。
- 清理缓存或更换预设不会改变源代码；不要通过重置 Git 工作区来解决 CMake 缓存问题。
- 新电脑成功配置与链接，只说明宿主机目标可编译，不表示设备可运行或业务功能完成。

## 本次如何从模板初始化

这部分是初始化复盘，不是每台电脑都要重复的操作。
日常开发直接使用本目录；若将来重新基于上游初始化，应另建目录对照，不能覆盖当前项目代码。

1. 核对本地模板 README、CMake、主入口、预设、包元数据、资源与许可证。确认版本 0.2.1、LVGL v9.5.0、SDL2 和 CMake 3.31+；解压包没有 Git commit，不能伪造版本溯源。
2. 复制源码、资源、配置、CMake 工具链/辅助文件、预设、包元数据与许可证。排除嵌套 Git、缓存、构建产物、上游代理指令、截图和一键部署脚本，不引入其发布流程。
3. 把 CMake 工程名及包名改为 `termrelay-cardputerzero`、版本改为 0.1.0，窗口与页面标题改为 TermRelay；保留原始代码的版权声明。
4. 配置文件统一为 `termrelay-cardputerzero.conf`，同时修改桌面/设备默认路径、XDG 用户配置路径、安装规则及 conffiles，避免只改文件名却漏改运行时读取路径。
5. 将 `template*.png` 改为 `termrelay-cardputerzero*.png`，同步 desktop 图标路径和安装匹配规则。APPLaunch 图标是共享目录，保留模板通用名称会与其他应用冲突；图片内容仍是模板素材，不代表正式品牌图标。
6. 将模板包辅助逻辑和 desktop/systemd/conffiles 模板放到 `packaging/`，修改 CMake include；工具链保留在 `cmake/`。包产物指向根 `dist/termrelay-cardputerzero/`，不是应用局部 dist。
7. 关闭默认 systemd 安装：上游服务没有指定 User，会以 root 运行。本次保留可选模板但默认 OFF；不能直接开启当作正式非 root 服务。
8. 清除 `app-builder.json` 的 AppStore 占位发布信息，保留私有构建元数据；不虚构作者、许可证、产品截图或发布授权。
9. 先验证 `cmake --list-presets`，再配置、编译和项目内暂存安装；检查唯一命名资源、配置路径及未默认安装服务，最后同步实际验证结果。

### 其他已遇到或确认的注意事项

- 上游 README 顶部出现 SDL3 徽标，但源码通过 `find_package(SDL2)` 构建；依赖以源码为准。
- 本次 shell 没有 `rg`。搜索可以回退到编辑器搜索或系统工具，不需要为构建本项目额外安装 ripgrep。
- `git diff --no-index` 用于比较不同文件时可能返回 1；不要把它与独立检查用 `&&` 连接后，误以为后续检查也执行了。应分别读取退出码与验证输出。
- 不要把编辑器“无诊断”、编译通过、安装暂存通过、GUI 验收通过和实机通过混为一谈；这些是不同检查。
- 模板初始化阶段没有单测；授权阶段已新增 CTest，不依赖外部 C++ 测试框架。不要将两阶段验证混淆。
- AppBuilder 是配套构建/发布工具，不是需要嵌入 App 的运行时；初次本地开发不要求登录 GitHub 或公开发布仓库。

## 授权连接

1. Server 按 [环境约定](../../docs/ENVIRONMENTS.md) 选择正确数据库，构建后应用 `1793836800000-controller-auth` 显式迁移，再部署 Server / Web。本轮没有实际执行迁移，也没有使用生产数据库。
2. 沿用 Mac 的同一公网域名和三个精确 Bypass 路径：`/api/client-pairings`、`/api/client-pairings/token`、`/ws/client-public`。不要 Bypass Web 管理接口。
3. 原生界面填写服务域名（自动补 `https://`），选择 `Connect`。不显示短码、二维码或倒计时。
4. 自行登录现有 Web 的“配置”，在“掌机授权”的待授权列表核对安装 ID、版本和申请时间，选择允许访问的执行设备后批准。
5. 掌机显示 `Online` 与授权设备数量。普通断网自动重连；退出后保留凭据，重启无需再次批准。
6. Web 的“删除授权”先持久化撤销，再通知并关闭在线掌机（4003）。掌机清除本机密钥并停止重连；重新连接需要再次批准。

`Cancel` 在待授权时尝试取消申请，在线时仅断开本次连接；长按 Esc 退出。关闭进程或网络中断时未确认取消的申请会自动过期，不会生成永久凭据。
`Clear local key` 需要再次确认，只移除本机副本，不撤销 Web 上的授权；旧授权需在 Web 手动删除。已有凭据时服务地址锁定，清除后才能更换地址，绝不向新地址发送旧凭据。

凭据和随机 installation ID 保存在 `$XDG_STATE_HOME/termrelay-cardputerzero/authorization.json`，未设置时为 `$HOME/.local/state/termrelay-cardputerzero/authorization.json`。目录 0700、文件 0600、原子替换；拒绝不安全权限或符号链接。该文件含长期密钥，不要复制到日志、截图、Git 或排障材料中。服务端仅保存摘要。

键盘目前按 Linux 标准 US evdev 字母、数字、标点、Shift、编辑和 Tab / Shift+Tab 焦点导航映射；尚未在实机核对 Fn 层、布局或输入设备权限。中文 UI、中文输入和全部业务界面不属于此次授权连接验收。

授权接口依赖现有 Access / Tunnel 保护管理面，未新增应用级 Access JWT 校验；不得把源站管理接口直接暴露到公网。当前只支持单 Server 实例的即时撤销。待授权最多返回最近 100 条，凭据列表最多 500 条；游标分页、权限缩减和多副本撤销仍待后续完善。

### 无 GUI 验证

在仓库根目录，完成原生 Debug 构建后：

```sh
ctest --test-dir apps/cardputerzero/build/darwin-arm64 -C Debug --output-on-failure
pnpm --filter @termrelay/server build
TERMRELAY_NATIVE_PROBE="$PWD/apps/cardputerzero/build/darwin-arm64/Debug/authorization_probe" \
	node --test apps/server/dist/client-auth/controller-auth.service.spec.js
pnpm --filter @termrelay/web build
pnpm check
```

探针仅在测试构建中生成，显式允许数字回环地址的 HTTP / WS；正式 App 默认只接受 HTTPS / WSS。测试启动临时回环服务，不访问真实数据库、Cloudflare 或 AI Provider。不设置 `TERMRELAY_NATIVE_PROBE` 时，Server 普通测试会跳过 C++ 集成检查。

发布前仍需真实 MySQL 迁移、公网 TLS / Access、320×170 视觉与键盘交互、实机 ABI、Linux 交叉编译和设备依赖打包验收。模板 Debian 依赖清单尚未适配并验证设备上的 WebSocket libcurl，不可直接发布 `.deb`。

## CardputerZero 构建与打包

保留 `cp0-cross` 和 `cp0-native` 预设，但须先核对实机系统 ABI、BSP 和工具链。
不能把宿主机编译通过等同于设备可用。完整发布脚本和根 release 命令尚未提供。
设备包产物目录已调整为根 `dist/termrelay-cardputerzero/`。

默认不安装模板 systemd 服务，因为模板没有配置非 root 用户。
未来需要后台服务时须显式配置非 root 用户、设备权限及启动器生命周期。
Debian Maintainer 尚为上游占位值，字体许可清单含待补全文本；正式发布前必须核实。
不使用现有模板截图冒充 TermRelay 产品截图，不自动发布到 AppStore。

## 已确定约束

- 目标 320×170，实体键盘导航；现阶段保留上游演示，不宣称界面完成。
- 公网只复用 `/api/client-pairings`、`/api/client-pairings/token` 和 `/ws/client-public`。
- 用户自行登录现有 Web 批准掌机，不使用短码、二维码或倒计时。
- 正式凭据永久有效，仅由用户通过 Web 主动删除授权；配对申请有效期单独处理。
- 共用公网入口但严格区分控制端和执行端；所需服务端扩展尚未实现。
- 后续按设计接入网络、协议和存储，不重复创建另一套平台或 UI 框架。