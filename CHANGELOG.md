# 更新日志

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
