# 更新日志

## 0.5.5

### 新增

- 持续攻击：`attack(entityId, { seconds })`（MCP `attack` 的 `seconds`、交互模式 `:attack <实体ID> <秒数>`）按攻击冷却连续出手，视线平滑跟随移动目标，目标死亡时结果带 `killed: true` 与 `attacks`，离开 6 格时以 `reason: "out_of_reach"` 结束；可传 `stopOnDamage`，也可作为后台任务运行。此前只能反复调用 `attack`，每次都要重新转身，移动目标很容易脱靶。
- `state()` 的玩家带 `vx`/`vy`/`vz`（每 tick 位移）、`onGround` 与 `inWater`；客户端状态流刷新间隔由 1 秒缩短到 250 毫秒，闭环控制不再基于一秒前的坐标。
- `item(slot?, { inventory })`（MCP `get_item`、交互模式 `:item [槽位]`）：读取单个物品并附上客户端悬停时显示的提示行（名称、附魔、词缀、属性、药水效果等）；省略槽位时为手持物品，`inventory: false` 时按容器窗口槽位读取。此前只能看到物品 ID、数量、名称与耐久，无法判断附魔或药水效果。

### 变更

- `walk_to` 不再瞬间转身：每 tick 最多转向 20°，背对目标时先原地转身再前进，接近路点时松开前进键以免冲过头，疾跑只在朝向基本一致且距目标足够远时启用。

## 0.5.4

### 新增

- `attack` 默认先等攻击冷却充满再出手（`charged: false` 恢复立即出手），并在结果里给出出手时的 `strength`。此前连点攻击每下只有 20%–40% 的伤害，循环 40 次也打不死 6 血的僵尸。
- `inventory()` 的每个物品带 `menuSlot`，即 `click` 要用的窗口槽位；`click(slot, { inventory: true })` 直接按背包编号点击。此前 `inventory()` 的副手是 40，而窗口里 40 是快捷栏 4，`click(40)` 会点错。
- `language` 选项（如 `zh_cn`）：固定游戏语言，提示、物品名与聊天文本不再随默认的 en_us 变化。

## 0.5.3

### 修复

- 写错的实体类型（`entities({ type })`）、方块 id 或通配符（`findBlocks`）、物品 id（`craft`）现在返回 `bad_request` 并指出哪个 id 不存在，不再静默返回空列表；`craft` 对确实存在但没有可用配方的物品，仍提示配方尚未解锁。

## 0.5.2

### 新增

- `waitFor({ block: { x, y, z, id?, air? } })`（MCP `wait_for` 的 `block`）：等到客户端看到的方块变成指定状态。服务端 `setblock` 之后客户端要稍后才同步，此前只能自己轮询。

### 修复

- `use` 指定的方块在客户端是空气或区块未加载时，返回 `no_block` 错误并说明原因，不再静默点空。
- `block` 查询未加载的区块时返回 `loaded: false`；此前客户端对任何未加载位置都答 `void_air`，被当成空气。`dig` 与 `use` 的报错同步区分“区块未加载”。
- 整数参数传了小数（如 `selectSlot(1.5)`）时返回 `bad_request`，不再悄悄截断；`look` 传 NaN 或无穷同样报错，不再被忽略。
- 玩家死亡后，`use`、`attack`、`dig`、`walkTo` 返回 `dead` 错误并提示先 `respawn`，不再返回含糊的 `no_path` 或空操作。

## 0.5.1

### 修复

- `startPaperServer` 不保留世界（`keepWorld` 为 false）时，同时清空 `plugins/` 下各插件的数据目录（配置、存档、数据库），不再把上一轮测试的残留带进新世界；插件 jar 与缓存保留。
- 宿主进程退出（包括崩溃）时一并结束 Paper 服务器，不再留下孤儿进程。

## 0.5.0

### 新增

- **单人世界**：`world` 选项（命令行 `-w, --world`、`--game-mode`、`--seed`，MCP `launch_client` 的 `world` 参数），从标题界面打开存档，不存在时按指定模式与种子创建；`stop` 时先保存世界再退出。
- **插件测试服**：`startPaperServer` 拉起一次性的 Paper 服务器，自动下载对应版本、挑选 Java、写入离线超平坦测试配置并安装插件（Java 17+ 时附带 ViaVersion/ViaBackwards）；`keepWorld` 用于验证重启后的持久化，换版本时自动重置配置与世界。另导出 `offlineUuid`。

### 修复

- 游戏、启动器与 Paper 的控制台统一以 UTF-8 输出。此前 Java 17 及更早版本在 POSIX/C 区域设置下会把中文等非 ASCII 聊天内容变成 `?`。

### 其他

- 端到端测试改用托管的 Paper 服务器与单人世界；MCP 服务器通过内存传输测试；TypeScript 引入 ESLint 与 Prettier，探针测试迁移到 JUnit 5 并开启全部编译警告。

## 0.4.0

### 新增

- **寻路**：`walk_to` / `walkTo` 改为 A* 寻路，可绕墙、跳上一格台阶、安全下落，路线受阻时重新规划；`direct: true` 保留原来的直线行走。
- **方块搜索**：`find_blocks` / `findBlocks`，按 ID 或通配符（如 `*_ore`）在已加载区块中搜索并按距离排序。
- **周边感知**：`surroundings`，返回以玩家为中心的俯视字符地图、脚下与所处方块、附近方块统计、实体、群系、时间与天气。
- **合成**：`craft`，按配方书合成指定数量的物品；3×3 配方自动打开附近的工作台并在结束后关闭。
- **物品搬运**：`transfer`，在当前容器与背包之间按物品移动，可指定数量与目标槽位；`get_container` 对熔炉额外返回燃烧状态与进度。
- **内置游戏事件**：`world.join/leave`、`player.hurt/death/respawn/food/dimension`、`inventory.change`、`container.open/close`、`screen.change`，与扩展事件共用同一事件流。
- **长时操作**：寻路、挖掘、合成统一由探针调度，同一时间只运行一个；`task` / `get_task` 查询进度，`stop_actions` 取消（等待中的调用以 `cancelled` 结束）；`stopOnDamage` 在受伤时以 `damaged` 中止。MCP 工具支持 `background: true` 后台运行。
- 交互模式新增 `:around`、`:find`、`:task`、`:craft`、`:transfer`、`:events`。

### 变更

- `Client` 的 `extension` 事件更名为 `event`，同时携带内置游戏事件；`ExtensionEvent` 类型更名为 `GameEvent`（旧名保留为已弃用别名）。
- 资源文件在首次成功启动时完整校验，之后的启动跳过逐文件哈希，启动约快 2–3 秒。
- MCP 服务器与交互模式拆分为独立模块，工具说明面向 Agent 重写。
