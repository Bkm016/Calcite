# Calcite 方解石

[![CI](https://github.com/bkm016/Calcite/actions/workflows/ci.yml/badge.svg)](https://github.com/bkm016/Calcite/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@bkm016/calcite.svg)](https://www.npmjs.com/package/@bkm016/calcite)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Calcite 用于以编程方式驱动**真实的 Minecraft Java 版客户端**。它负责下载与启动游戏、加入服务器，并提供读取客户端状态与实体、发送聊天和指令、截图等能力。Calcite 以三种形式提供：

- **命令行工具**（`calcite`）
- **MCP 服务器**：供 Claude、Cursor 等 AI Agent 直接调用
- **Node.js 库**

适用场景包括服务端插件与模组的端到端测试、AI Agent 在游戏内的感知与操作，以及服务器的自动化巡检。

<p align="center">
  <img src="docs/images/landscape.jpg" alt="Minecraft 26.3 风景截图" width="49%">
  <img src="docs/images/gameplay.jpg" alt="Agent 在游戏中发送聊天与指令" width="49%">
</p>
<p align="center"><sub>两张图均由 Calcite 在无显卡的 Linux 云服务器上截取（Minecraft 26.3，Xvfb + Mesa 软件渲染）。右图为 Agent 发送聊天与指令后的画面。</sub></p>

## 目录

- [特性](#特性)
- [环境要求](#环境要求)
- [安装](#安装)
- [命令行](#命令行)
- [MCP 服务器](#mcp-服务器)
- [Node.js API](#nodejs-api)
- [平台与账号](#平台与账号)
- [渲染模式](#渲染模式)
- [版本兼容性](#版本兼容性)
- [数据目录与环境变量](#数据目录与环境变量)
- [故障排查](#故障排查)
- [工作原理](#工作原理)
- [许可](#许可)

## 特性

- **支持所有版本**：可启动 Mojang 发布的任意版本，包括正式版与快照；1.14.4 及以上版本支持全部探针功能。
- **跨平台**：Linux、Windows、macOS。
- **账号**：支持离线账号，也支持微软正版账号。正版账号使用设备码登录，凭据持久保存并自动刷新。
- **无显卡环境截图**：在 Linux 服务器上通过 Xvfb 与 Mesa 软件渲染完成截图。
- **按需渲染**：默认不渲染画面，截图时临时渲染。单次截图约 0.5 秒，进服后首次截图需等待区块编译，约 2–4 秒。
- **Java 自动管理**：按游戏版本自动选择 Java；本机缺少时从 Eclipse Adoptium 下载 Temurin，并校验 SHA-256。
- **自动重连**：掉线或崩溃后按指数退避自动重连。
- **多客户端**：一个进程可同时管理多个相互隔离的客户端实例。

## 环境要求

| 项目 | 要求 |
| --- | --- |
| Node.js | 20.18.1 或更高版本 |
| Java | 无需预装；缺少时自动下载 |
| 磁盘 | 每个游戏版本约 0.5–1 GB，资源文件在各版本间共享 |
| Linux 截图 | `xvfb`、`libgl1-mesa-dri`；Minecraft 26.x 另需 `libegl1`、`libegl-mesa0` |

Debian / Ubuntu 安装截图依赖：

```bash
sudo apt install xvfb libgl1-mesa-dri libegl1 libegl-mesa0
```

## 安装

```bash
npm install -g @bkm016/calcite
calcite doctor
```

`calcite doctor` 用于检查 Node.js、Java、显示环境、EGL、已保存账号以及 Mojang 服务的连通性。

## 命令行

### 快速开始

```bash
# 以离线账号 Bot1 进入服务器
calcite launch play.example.com -V 1.21.11 -n Bot1
```

客户端进服后，终端进入交互模式：

- 直接输入文本：发送聊天
- 以 `/` 开头：执行指令
- 以 `:` 开头：控制命令，见下表

| 交互命令 | 说明 |
| --- | --- |
| `:state` | 输出当前游戏状态 |
| `:ents [半径]` | 列出附近实体，默认半径 32 |
| `:shot [文件]` | 截图并保存为 PNG |
| `:render on\|off` | 开启或关闭持续渲染 |
| `:respawn` | 死亡后重生 |
| `:quit` | 退出并关闭客户端 |

### 命令一览

| 命令 | 说明 |
| --- | --- |
| `calcite launch [server]` | 启动客户端并在终端中交互 |
| `calcite install [version]` | 预下载指定版本（客户端、库、资源、Java），不启动游戏 |
| `calcite versions` | 列出可用版本（`-t release\|snapshot\|old_beta\|old_alpha\|all`，`-l <数量>`） |
| `calcite login` | 微软账号登录（设备码） |
| `calcite accounts` | 列出已保存的微软账号 |
| `calcite logout <name>` | 删除已保存的微软账号 |
| `calcite doctor` | 检查运行环境 |
| `calcite mcp` | 以 stdio 方式运行 MCP 服务器 |

### `launch` 参数

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `-n, --name <name>` | `calcite` | 实例名，同时作为游戏目录名 |
| `-V, --mc-version <version>` | `release` | 版本号，也可使用 `release` 或 `snapshot` |
| `-u, --username <name>` | 实例名 | 离线用户名 |
| `-m, --microsoft [account]` | — | 使用已保存的微软账号（省略名称时使用主账号） |
| `-r, --render <mode>` | `on-demand` | 渲染模式：`on-demand`、`always`、`off` |
| `--java <path>` | 自动选择 | 指定游戏使用的 Java |
| `--no-java-download` | — | 禁止自动下载 Java |
| `--memory <size>` | `2G` | 最大堆内存 |
| `--no-reconnect` | — | 掉线或崩溃后不自动重连 |

全局参数 `-v, --verbose` 用于输出调试日志。

### 微软正版账号

```bash
calcite login                                        # 只需执行一次，按提示在浏览器中完成登录
calcite accounts
calcite launch mc.example.com -V 1.21.11 --microsoft
```

## MCP 服务器

在支持 MCP 的客户端（Claude Code、Claude Desktop、Cursor 等）中添加如下配置：

```json
{
  "mcpServers": {
    "calcite": { "command": "npx", "args": ["-y", "@bkm016/calcite", "mcp"] }
  }
}
```

Claude Code 也可以通过命令添加：

```bash
claude mcp add calcite -- npx -y @bkm016/calcite mcp
```

`calcite mcp` 支持 `-r, --render <mode>` 和 `--memory <size>`，用于设置新客户端的默认值。

### 工具列表

| 工具 | 说明 |
| --- | --- |
| `launch_client` | 启动客户端，可指定服务器、版本、离线用户名或微软账号、渲染模式 |
| `stop_client` | 停止客户端 |
| `list_clients` | 列出当前管理的客户端 |
| `get_state` | 获取生命周期阶段与游戏状态（界面、坐标、生命值、维度、帧率、断开原因） |
| `get_entities` | 获取客户端已接收的实体，可按半径、类型、名称、UUID 过滤 |
| `send_chat` | 发送聊天消息 |
| `run_command` | 执行指令，并返回执行期间收到的聊天 |
| `screenshot` | 渲染并返回 PNG 截图 |
| `wait_for` | 等待条件成立：聊天匹配正则、实体出现或消失、进入指定阶段 |
| `get_chat` | 获取聊天记录 |
| `get_logs` | 获取游戏日志与 Calcite 日志，用于排查崩溃 |
| `set_render` | 开启或关闭持续渲染 |
| `respawn` | 死亡后重生 |
| `install_version` | 预下载指定版本 |
| `list_versions` | 列出可用版本 |
| `account_login_start` | 开始微软账号登录，返回验证链接 |
| `account_login_status` | 查询登录进度 |
| `account_list` | 列出已保存的微软账号 |
| `account_remove` | 删除已保存的微软账号 |

仅运行一个客户端时，各工具的 `client` 参数可以省略。工具调用失败时返回 `isError` 结果，错误信息格式为 `[错误码] 描述`。

## Node.js API

```js
import { Client } from '@bkm016/calcite';

const bot = new Client({
  name: 'Bot1',
  version: '1.21.11',
  server: 'localhost:25565',
  account: { type: 'offline', username: 'Bot1' },
});

bot.on('chat', (line) => console.log(line.message));

await bot.start();                                          // 进入服务器后返回
console.log(await bot.state());
console.log(await bot.entities({ radius: 32, type: 'minecraft:player' }));

await bot.command('say hello');
await bot.waitFor({ chat: 'hello' }, 10_000);

const { png } = await bot.screenshot();
await bot.stop();
```

### `Client` 主要选项

| 选项 | 说明 |
| --- | --- |
| `name` | 实例名，只允许字母、数字、`-`、`_`、`.` |
| `version` | 版本号、`release` 或 `snapshot` |
| `server` | `host[:port]`；省略时停留在标题界面 |
| `account` | `{ type: 'offline', username }` 或 `{ type: 'microsoft', name? }` |
| `render` | `on-demand`（默认）、`always`、`off` |
| `memory` | 最大堆内存，默认 `2G` |
| `javaPath` / `allowJavaDownload` | 指定 Java 路径 / 是否允许自动下载 |
| `jvmArgs` / `gameArgs` | 额外的 JVM 参数 / 游戏参数 |
| `renderDistance` / `maxFps` | 渲染距离 / 帧率上限 |
| `reconnect` | `false` 表示关闭自动重连，或传入 `{ maxAttempts }`（默认 10） |
| `startTimeoutMs` | 启动总超时，含下载时间，默认 15 分钟 |

### 方法

| 方法 | 说明 |
| --- | --- |
| `start()` / `stop()` | 启动（进入服务器后返回）/ 停止 |
| `prepare()` | 仅下载与校验依赖 |
| `status()` | 生命周期阶段、最近错误、玩家信息 |
| `state()` | 游戏状态 |
| `entities(query)` | 实体列表，`query` 支持 `radius`、`type`、`name`、`uuid`、`limit` |
| `chat(text)` / `command(cmd)` | 发送聊天 / 执行指令 |
| `screenshot({ keep })` | 返回 `{ png, path? }` |
| `waitFor(cond, timeoutMs)` | 等待聊天、实体或阶段条件 |
| `setRender(enabled)` / `respawn()` | 切换持续渲染 / 重生 |
| `chatSince(seq)` / `logsSince(opts)` | 读取聊天与日志缓冲 |

事件：`phase`、`state`、`chat`、`log`、`exit`。

此外还导出 `ClientManager`（多客户端管理）、`installVersion`、`startLogin`、`listAccounts`、`removeAccount` 等函数，类型定义随包发布。

## 平台与账号

| 平台 | 离线账号 | 微软账号 |
| --- | --- | --- |
| Linux | 全部功能（在 Xvfb 中渲染） | 全部功能 |
| Windows / macOS | 无渲染运行，不支持截图，其余功能正常 | 全部功能 |

HeadlessMC 仅允许离线账号在 Linux 虚拟显示器中渲染。这是上游策略，Calcite 遵循该策略。如需在 Windows 或 macOS 上截图，请使用正版账号。

离线账号只能进入 `online-mode=false` 的服务器。

## 渲染模式

| 模式 | 说明 |
| --- | --- |
| `on-demand`（默认） | 平时不渲染画面，截图时临时渲染。兼顾资源占用与截图能力 |
| `always` | 持续渲染，适合在本地桌面观察 |
| `off` | 以无渲染器方式运行（替换 LWJGL），资源占用最低，不支持截图 |

## 版本兼容性

| 版本范围 | 支持情况 |
| --- | --- |
| 1.14.4 及以上 | 全部功能（状态、实体、聊天、指令、截图） |
| 1.14.4 以前 | 可以启动并进入服务器；Mojang 未发布这些版本的映射表，探针功能不可用 |

已验证的版本：1.16.5、1.20.4、1.21.11、26.3。

## 数据目录与环境变量

所有数据保存在 `~/.calcite`，可通过 `CALCITE_HOME` 修改。

| 目录 | 内容 |
| --- | --- |
| `minecraft/` | 各版本共享的游戏文件、库与资源 |
| `instances/<name>/` | 各实例独立的游戏目录（`options.txt`、日志、截图） |
| `hmc-home/HeadlessMC/auth/` | 已保存的微软登录凭据（权限 600，请妥善保管） |
| `java/` | 自动下载的 Java 运行时 |

| 环境变量 | 说明 |
| --- | --- |
| `CALCITE_HOME` | 数据目录 |
| `CALCITE_LOG_LEVEL` | 日志级别：`debug`、`info`、`warn`、`error`、`silent` |
| `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` | 下载代理 |
| `CALCITE_JAVA_<主版本>` | 指定某个 Java 主版本的路径，例如 `CALCITE_JAVA_8` |
| `CALCITE_HMC_JAR` / `CALCITE_HMC_URL` | 使用自定义的 HeadlessMC |
| `CALCITE_PROBE_DIR` | 探针目录，路径中不能包含空格 |

## 故障排查

错误均带有错误码。CLI 输出格式为 `error [code]: ...`，MCP 返回格式为 `[code] ...`。

| 错误码 | 原因与处理 |
| --- | --- |
| `server_unreachable` | 服务器端口不可达。请检查地址、端口与防火墙 |
| `start_timeout` | 未在规定时间内进入游戏。可用 `get_logs` 或 `logsSince()` 查看游戏日志 |
| `crashed` | 游戏进程退出。错误信息中附有日志末尾内容 |
| `renderer_unavailable` | 无法创建任何图形后端。Linux 无显卡环境请安装 `libegl1 libegl-mesa0`（或 `mesa-vulkan-drivers`），也可改用 `render: 'off'` |
| `headless` | 当前客户端以无渲染方式运行，无法截图。参见[平台与账号](#平台与账号) |
| `not_logged_in` / `unknown_account` | 未登录微软账号或账号名不存在。请先执行 `calcite login` |
| `instance_busy` | 同名实例已在其他进程中运行 |
| `unsupported_version` | 版本不存在或不受支持 |

排查环境问题时，建议先运行 `calcite doctor`。

## 工作原理

1. Calcite 解析 Mojang 版本清单，下载客户端、库与资源文件，并逐一校验哈希。
2. 使用 [HeadlessMC](https://github.com/headlesshq/headlessmc) 启动游戏。每个实例拥有独立的游戏目录和启动参数。
3. 向游戏注入一个轻量 Java Agent（探针）。探针借助 Mojang 官方映射表定位游戏内部类，并通过本地 TCP 连接与 Calcite 交换 JSON 消息。
4. 在 Linux 无显示环境中，Calcite 启动共享的 Xvfb，并配置 Mesa 软件渲染。Minecraft 26.x 的渲染器改用 EGL。

## 许可

本项目以 [MIT](LICENSE) 许可证发布。第三方组件的许可信息见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

使用 Minecraft 须遵守 [Minecraft EULA](https://www.minecraft.net/eula)。连接正版服务器时，请使用您本人的正版账号。本项目与 Mojang Studios、Microsoft 无关。
