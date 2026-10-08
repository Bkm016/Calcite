# Calcite 方解石

用代码或 AI Agent 驱动**真实的 Minecraft Java 版客户端**：自动下载、启动、进服、读取客户端实际看到的实体、发聊天/指令、截图。
提供 **CLI**、**MCP Server** 和 **Node.js API**。

- 任意版本：1.14.4 及以上全部功能；更早的版本可以启动进服，但读取状态/实体/截图等探针功能不可用（Mojang 未发布映射表）。
- Linux / Windows / macOS。
- 离线账号，或微软正版账号（设备码登录，登录状态持久保存并自动刷新）。
- 无显卡的云服务器也能截图（Linux：Xvfb + Mesa 软件渲染）。
- 按需渲染：平时不渲染画面（约 50% 单核 CPU），截图时才渲染几帧（约 0.5 秒）。
- Java 自动选择，缺少时自动从 Adoptium 下载对应版本。
- 掉线/崩溃自动重连（指数退避）。

底层使用 [HeadlessMC](https://github.com/headlesshq/headlessmc) 启动游戏，并注入一个很小的 Java Agent（探针）读取游戏状态。

## 安装

```bash
npm i -g @bkm016/calcite
calcite doctor
```

需要 Node.js 20.18+。Java 不需要预装。

Linux 服务器上要截图需安装 Xvfb 与 Mesa（EGL 是 26.x 新渲染器在 Xvfb 下所需）：

```bash
# Debian / Ubuntu
sudo apt install xvfb libgl1-mesa-dri libegl1 libegl-mesa0
```

## CLI

```bash
# 离线账号进服，终端里直接聊天，/开头是指令
calcite launch play.example.com -V 1.21.11 -n Bot1

# 交互命令：:state  :ents [半径]  :shot [文件]  :render on|off  :respawn  :quit

# 预下载某个版本（首次约 0.5~1 GB）
calcite install 1.20.4

# 版本列表
calcite versions -t release

# 微软正版登录（只需一次，之后自动刷新）
calcite login
calcite accounts
calcite launch mc.hypixel.net -V 1.21.11 --microsoft
calcite logout <名字>
```

## MCP

在 Claude Code / Claude Desktop / Cursor 等客户端中添加：

```json
{
  "mcpServers": {
    "calcite": { "command": "npx", "args": ["-y", "@bkm016/calcite", "mcp"] }
  }
}
```

Claude Code：`claude mcp add calcite -- npx -y @bkm016/calcite mcp`

| 工具 | 作用 |
| --- | --- |
| `launch_client` | 启动客户端（可选进服、版本、离线名/微软账号、渲染模式） |
| `stop_client` / `list_clients` | 停止 / 列出客户端 |
| `get_state` | 生命周期 + 游戏状态（界面、坐标、血量、维度、FPS、断开原因） |
| `get_entities` | 客户端实际收到的实体（类型、坐标、名字、乘骑关系），可按半径/类型/名字/UUID 过滤 |
| `send_chat` / `run_command` | 发聊天 / 执行指令（返回期间收到的聊天） |
| `screenshot` | 渲染并返回 PNG 图片 |
| `wait_for` | 等待聊天匹配正则、实体出现/消失、或进入某状态 |
| `get_chat` / `get_logs` | 聊天记录 / 游戏与 Calcite 日志（排查崩溃） |
| `set_render` / `respawn` | 开关持续渲染 / 重生 |
| `install_version` / `list_versions` | 预下载版本 / 版本列表 |
| `account_login_start` / `account_login_status` / `account_list` / `account_remove` | 微软账号登录与管理 |

一个 MCP 进程可同时管理多个客户端；只运行一个时 `client` 参数可省略。

## Node.js API

```js
import { Client } from '@bkm016/calcite';

const bot = new Client({ name: 'Bot1', version: '1.21.11', server: 'localhost:25565' });
bot.on('chat', (c) => console.log(c.message));
await bot.start();                                   // 进服后返回
console.log(await bot.state());
console.log(await bot.entities({ radius: 32, type: 'minecraft:player' }));
await bot.command('say hi');
await bot.waitFor({ chat: 'hi' }, 10_000);
const { png } = await bot.screenshot();
await bot.stop();
```

## 平台与账号

| | 离线账号 | 微软账号 |
| --- | --- | --- |
| Linux | 全部功能（截图走 Xvfb） | 全部功能 |
| Windows / macOS | 无渲染运行（不能截图，其余功能正常） | 全部功能 |

HeadlessMC 只允许离线账号在 Linux 虚拟显示器上渲染，这是上游策略，Calcite 遵守。需要在 Windows/macOS 截图请使用正版账号。

渲染模式：

- `on-demand`（默认）：不渲染画面，截图时临时渲染。
- `always`：持续渲染（用于本地观看）。
- `off`：完全无渲染器（LWJGL 替换），最省资源，不能截图。

## 数据与环境变量

所有数据在 `~/.calcite`（`CALCITE_HOME` 可改）：

| 目录 | 内容 |
| --- | --- |
| `minecraft/` | 共享的版本、库、资源文件 |
| `instances/<name>/` | 每个客户端独立的游戏目录（options.txt、日志、截图） |
| `hmc-home/HeadlessMC/auth/` | 保存的微软登录（权限 600，请勿泄露） |
| `java/` | 自动下载的 Java |

| 变量 | 作用 |
| --- | --- |
| `CALCITE_HOME` | 数据目录 |
| `CALCITE_LOG_LEVEL` | `debug` / `info` / `warn` / `error` / `silent` |
| `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` | 下载代理 |
| `CALCITE_JAVA_<主版本>` | 指定某个 Java 主版本的路径，如 `CALCITE_JAVA_8` |
| `CALCITE_HMC_JAR` / `CALCITE_HMC_URL` | 使用自定义 HeadlessMC |
| `CALCITE_PROBE_DIR` | 探针目录（必须不含空格） |

## 许可

MIT。第三方组件见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。使用 Minecraft 需遵守 [Minecraft EULA](https://www.minecraft.net/eula)；连接正版服务器请使用你自己的正版账号。
