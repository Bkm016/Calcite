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
- [模组](#模组)
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
- **模组加载器**：一行参数安装 Fabric、Forge 或 NeoForge，并从本地文件、URL 或 Modrinth 加载模组（自动补全前置依赖），探针功能在模组环境中同样可用。
- **玩家操作**：转向、移动、寻路到坐标、攻击、使用物品与方块、挖掘、切换快捷栏、丢弃物品，以及打开箱子等容器并点击槽位。操作走原版客户端逻辑，与真实玩家输入等价。
- **按需渲染**：默认不渲染画面，截图时临时渲染。单次截图约 0.5 秒，进服后首次截图需等待区块编译，约 2–4 秒。
- **Java 自动管理**：按游戏版本自动选择 Java（render `off` 时原本需要 Java 8 的版本改用 Java 17，HeadlessMC 3 的 LWJGL 替身不支持 Java 8）；本机缺少时从 Eclipse Adoptium 下载 Temurin，并校验 SHA-256。HeadlessMC 3 本身运行在 Java 25 上，同样按需下载。
- **自动重连**：掉线或崩溃后按指数退避自动重连。
- **多客户端**：一个进程可同时管理多个相互隔离的客户端实例。

## 环境要求

| 项目 | 要求 |
| --- | --- |
| Node.js | 20.18.1 或更高版本 |
| Java | 无需预装；缺少时自动下载（游戏所需版本，以及 HeadlessMC 所需的 Java 25） |
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
| `:look <yaw> <pitch>` / `:lookat <x> <y> <z>` | 设置视角 / 看向坐标 |
| `:goto <x> <z>` | 直线走到指定坐标，遇到台阶自动跳跃 |
| `:move <按键,...> [tick]` | 按住按键若干 tick（默认 20），按键为 `forward`、`back`、`left`、`right`、`jump`、`sneak`、`sprint`、`attack`、`use` |
| `:stop` | 停止当前移动、挖掘等持续操作 |
| `:attack [实体ID]` | 攻击指定实体；省略时攻击准星所指 |
| `:use [实体ID \| x y z] [tick]` | 右键实体或方块；省略目标时使用手中物品，可指定按住时长 |
| `:dig <x> <y> <z>` | 挖掘方块直至破坏 |
| `:block <x> <y> <z>` / `:target` | 查看方块 / 查看准星目标 |
| `:inv` / `:slot <0-8>` | 查看背包 / 切换快捷栏 |
| `:container` / `:close` | 查看 / 关闭当前打开的容器 |
| `:click <槽位> [按键] [模式]` | 点击容器槽位，模式见下文 |
| `:drop [all]` | 丢弃手中物品（`all` 丢弃整组） |
| `:quit` | 退出并关闭客户端 |

### 命令一览

| 命令 | 说明 |
| --- | --- |
| `calcite launch [server]` | 启动客户端并在终端中交互 |
| `calcite install [version]` | 预下载指定版本（客户端、库、资源、Java），不启动游戏；`-l, --loader` 同时安装模组加载器 |
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
| `-l, --loader <loader>` | — | 模组加载器：`fabric`、`forge`、`neoforge`，可加 `@<版本>`，见[模组](#模组) |
| `--mod <spec>` | — | 加载模组，可重复；需同时指定加载器 |
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
| `launch_client` | 启动客户端，可指定服务器、版本、离线用户名或微软账号、渲染模式、模组加载器与模组 |
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
| `look` | 设置视角，或看向指定坐标 |
| `walk_to` | 直线走到指定坐标，遇障碍自动跳跃，返回是否到达 |
| `move` | 按住移动、跳跃、潜行、疾跑等按键若干 tick |
| `stop_actions` | 停止所有持续操作并松开按键 |
| `attack` | 攻击实体（按 ID 或准星目标） |
| `use` | 右键：使用手中物品、与方块交互（开箱、放置）、与实体交互 |
| `dig` | 挖掘方块直至破坏 |
| `get_block` | 查询方块 ID 与方块状态 |
| `get_target` | 查询准星所指的方块或实体 |
| `get_inventory` | 查询背包、快捷栏与手持物品 |
| `select_slot` | 切换快捷栏槽位 |
| `get_container` | 查询当前打开的容器（类型、标题、槽位物品） |
| `click_slot` | 点击容器槽位，支持拾取、快速移动、数字键交换、丢弃等模式 |
| `close_container` | 关闭当前容器 |
| `drop_item` | 丢弃手中物品 |
| `install_version` | 预下载指定版本，可同时安装模组加载器 |
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
| `loader` | 模组加载器：`fabric`、`forge`、`neoforge`，可加 `@<版本>` |
| `mods` | 模组列表：本地 jar 或目录、http(s) URL、`modrinth:<项目>[@<版本>]` |
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
| `look({ yaw, pitch } \| { x, y, z })` | 设置视角或看向坐标 |
| `walkTo(x, z, { range, sprint, timeoutMs })` | 走到坐标，返回 `{ arrived, reason?, distance, x, y, z }` |
| `move(controls, { ticks })` / `stopActions()` | 按住按键若干 tick / 停止所有持续操作 |
| `attack(entityId?)` | 攻击实体，省略时攻击准星目标 |
| `use({ entityId?, block?, holdTicks? })` | 右键实体、方块或使用手中物品 |
| `dig(block, { timeoutMs })` | 挖掘方块，返回 `{ broken, block, ticks?, reason? }` |
| `block(pos)` / `target()` | 查询方块 / 准星目标 |
| `inventory()` / `selectSlot(n)` | 查询背包 / 切换快捷栏 |
| `container({ waitMs })` / `closeContainer()` | 查询 / 关闭当前容器 |
| `click(slot, { button, mode })` | 点击容器槽位 |
| `drop({ all })` | 丢弃手中物品 |

事件：`phase`、`state`、`chat`、`log`、`exit`。

### 玩家操作示例

```js
await bot.walkTo(100.5, 200.5);                             // 走到 (100.5, 200.5)
await bot.dig({ x: 101, y: 64, z: 200 });                   // 挖掉一个方块
await bot.use({ block: { x: 100, y: 64, z: 202 } });        // 右键打开箱子
const chest = await bot.container({ waitMs: 3000 });        // 等待容器界面打开
for (const item of chest.items.filter((i) => i.slot < chest.containerSlots)) {
  await bot.click(item.slot, { mode: 'quick_move' });       // Shift+点击 取出物品
}
await bot.closeContainer();
```

容器槽位编号与原版一致：容器自身的槽位在前（`0` 到 `containerSlots - 1`），玩家背包在后；`item.inventorySlot` 给出对应的背包槽位。`click` 的 `mode` 可取 `pickup`（默认，`button` 0 为左键、1 为右键）、`quick_move`（Shift+点击）、`swap`（数字键，`button` 为快捷栏序号 0–8）、`clone`、`throw`、`quick_craft`、`pickup_all`；槽位 `-999` 表示点击界面外部。未打开容器时，`click` 作用于玩家自身的背包界面。

操作有距离限制（6 格）：目标过远时返回 `out_of_reach` 错误，需先用 `walkTo` 靠近。

此外还导出 `ClientManager`（多客户端管理）、`installVersion`、`startLogin`、`listAccounts`、`removeAccount` 等函数，类型定义随包发布。

## 平台与账号

| 平台 | 离线账号 | 微软账号 |
| --- | --- | --- |
| Linux | 全部功能（在 Xvfb 中渲染） | 全部功能 |
| Windows / macOS | 无渲染运行，不支持截图，其余功能正常 | 全部功能 |

HeadlessMC 仅在检测到 Xvfb 时允许离线账号渲染，否则强制以无渲染方式运行。这是上游策略，Calcite 遵循该策略。如需在 Windows 或 macOS 上截图，请使用正版账号。

离线账号只能进入 `online-mode=false` 的服务器。

从 0.1.x 升级：Calcite 现使用 HeadlessMC 3，其凭据格式与 HeadlessMC 2 不兼容，已保存的微软账号需要重新执行一次 `calcite login`。

## 渲染模式

| 模式 | 说明 |
| --- | --- |
| `on-demand`（默认） | 平时不渲染画面，截图时临时渲染。兼顾资源占用与截图能力 |
| `always` | 持续渲染，适合在本地桌面观察 |
| `off` | 以无渲染器方式运行（替换 LWJGL），资源占用最低，不支持截图 |

## 模组

```bash
# Fabric + Fabric API（从 Modrinth 下载，自动补全前置）
calcite launch localhost -V 1.21.11 -l fabric --mod modrinth:fabric-api --mod ./mods/my-mod.jar

# 指定加载器版本
calcite launch localhost -V 1.20.1 -l forge@47.4.26
calcite install 1.21.11 -l neoforge
```

```js
new Client({ version: '1.21.11', loader: 'fabric', mods: ['modrinth:fabric-api', './my-mod.jar'] });
```

<p align="center">
  <img src="docs/images/mods-fabric.jpg" alt="Fabric 1.21.11：Xaero's Minimap 与 Jade" width="49%">
  <img src="docs/images/mods-neoforge.jpg" alt="NeoForge 1.21.11：JEI 物品列表" width="49%">
</p>
<p align="center"><sub>左：Fabric 1.21.11，加载 Fabric API、Xaero's Minimap、Jade、Mod Menu，准星对准羊时 Jade 显示其信息。右：NeoForge 1.21.11，加载 JEI 与 Xaero's Minimap，通过 <code>use</code> 打开箱子后右侧为 JEI 物品列表。模组均以 <code>modrinth:</code> 参数自动下载。</sub></p>

- 加载器由 HeadlessMC 安装到共享的 `minecraft/versions/`，省略版本时使用最新版本（已安装过则复用本地最新版）。
- 模组来源：本地 jar、包含 jar 的目录、http(s) URL，或 `modrinth:<项目>[@<版本号>]`。Modrinth 模组按游戏版本与加载器挑选最新正式版，并自动下载必需的前置模组；下载文件按哈希校验并缓存在 `mods/`。
- 模组复制到实例的 `mods/` 目录。Calcite 只管理自己放入的文件（记录在 `mods/.calcite-mods.json`），手动放入的模组不受影响。
- 模组加载失败时，客户端会停在错误界面；Calcite 检测到后立即结束进程并返回 `mod_loading_failed`，错误信息附带相关日志。

| 加载器 | 支持的版本 | 探针 |
| --- | --- | --- |
| Fabric | Fabric 支持的所有版本 | 全部功能（自动将 Mojang 映射转换为 intermediary 名称） |
| NeoForge | 1.20.2 及以上 | 全部功能 |
| Forge | 1.17 及以上 | 全部功能（1.20.4 及以前自动转换为 SRG 名称） |
| Forge | 1.16.5 及以前 | 可以启动，探针功能不可用 |

Forge 与 NeoForge 的安装器要求与游戏版本完全一致的 Java 主版本（例如 1.20.1 需要 Java 17），缺少时自动下载。Forge 与 NeoForge 不支持在 render `off` 下运行原本需要 Java 8 的版本。

已验证：Fabric 1.21.11 / 26.3（含 Fabric API）、NeoForge 1.20.4 / 1.21.11、Forge 1.20.1 / 1.21.1。

## 版本兼容性

| 版本范围 | 支持情况 |
| --- | --- |
| 1.14.4 及以上 | 全部功能（状态、实体、聊天、指令、截图、玩家操作） |
| 1.14.4 以前 | 可以启动并进入服务器；Mojang 未发布这些版本的映射表，探针功能不可用 |

已验证的版本：1.16.5、1.20.4、1.21.11、26.3。

## 数据目录与环境变量

所有数据保存在 `~/.calcite`，可通过 `CALCITE_HOME` 修改。

| 目录 | 内容 |
| --- | --- |
| `minecraft/` | 各版本共享的游戏文件、库与资源 |
| `instances/<name>/` | 各实例独立的游戏目录（`options.txt`、日志、截图） |
| `hmc-home/.auth/default/` | 已保存的微软登录凭据（权限 600，请妥善保管） |
| `instances/<name>/.headlessmc/` | 该实例的 HeadlessMC 配置、账号副本与缓存 |
| `java/` | 自动下载的 Java 运行时 |
| `mods/` | 从 URL 与 Modrinth 下载的模组缓存 |
| `mappings/` | 映射表及为模组加载器转换后的名称表 |

| 环境变量 | 说明 |
| --- | --- |
| `CALCITE_HOME` | 数据目录 |
| `CALCITE_LOG_LEVEL` | 日志级别：`debug`、`info`、`warn`、`error`、`silent` |
| `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` | HTTP 代理。Calcite 自身的下载使用该代理，并将其转换为 Java 系统属性传给 HeadlessMC 与游戏进程（Java 不支持代理认证；游戏与服务器之间的连接不经过代理） |
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
| `bad_loader` / `unsupported_loader` | 加载器名称或版本格式错误 / 该版本组合无法运行 |
| `install_failed` | HeadlessMC 未能安装加载器（该游戏版本可能没有对应构建） |
| `bad_mod` / `mod_not_found` | 模组参数错误 / 找不到模组文件或 Modrinth 上没有适配的版本 |
| `mod_loading_failed` | 模组加载失败（缺少前置、版本不兼容等），错误信息附带日志 |

排查环境问题时，建议先运行 `calcite doctor`。

## 工作原理

1. Calcite 解析 Mojang 版本清单，下载客户端、库与资源文件，并逐一校验哈希。
2. 使用 [HeadlessMC](https://github.com/headlesshq/headlessmc) 3 启动游戏。每个实例拥有独立的游戏目录、HeadlessMC 配置和启动参数，并发启动互不干扰。
3. 向游戏注入一个轻量 Java Agent（探针）。探针借助 Mojang 官方映射表（模组环境下转换为 intermediary 或 SRG 名称）定位游戏内部类，并通过本地 TCP 连接与 Calcite 交换 JSON 消息。
4. 在 Linux 无显示环境中，Calcite 启动共享的 Xvfb，并配置 Mesa 软件渲染。Minecraft 26.x 的渲染器改用 EGL。

## 许可

本项目以 [MIT](LICENSE) 许可证发布。第三方组件的许可信息见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

使用 Minecraft 须遵守 [Minecraft EULA](https://www.minecraft.net/eula)。连接正版服务器时，请使用您本人的正版账号。本项目与 Mojang Studios、Microsoft 无关。
