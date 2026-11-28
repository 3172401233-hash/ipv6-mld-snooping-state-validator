# ipv6-mld-snooping-state-validator

验证 MLD snooping 状态、监听者和转发端口：一个**持久化 MLD snooping 状态机** +
一个**独立审计器**，用于复现并检测"路由器端口迁移 / 监听者快速 Leave/Report
时交换机提前剪枝"这类转发面错误。

> **重要声明：本项目是纯控制面仿真，不发送、不接收任何真实 MLD 报文。**
> 不使用 raw socket，不加入真实组播组；所有 MLD Report / Done / Query 均为
> JSON 事件输入，所有"查询"仅为日志中的仿真动作记录。

要求 Node.js >= 24（在 24.16.0 上验证）。无第三方依赖。

## 架构

- `src/state-machine.js` — MLD snooping 状态机。维护 (group, source, port)
  成员关系、路由器端口和各类定时器；每个时间片输出一次转发端口集合；
  每个 tick 后原子化落盘（tmp + rename），支持进程重启后从状态文件恢复。
- `src/runner.js` — 事件驱动器。按 tick 推进定时器、应用事件、处理
  `restart` 事件（落盘并重新加载全新实例），把每个时间片的转发决策追加到
  决策日志（JSONL），把已应用事件追加到事件日志。
- `src/auditor.js` — 独立审计器。不复用状态机代码，而是从事件日志重建
  "成员关系有效区间"参考模型，逐时间片比对决策日志，找出：
  - `erroneous-flooding`（错误泛洪）：端口无有效成员关系/路由器身份却被转发；
  - `erroneous-pruning`（误剪枝）：成员关系或路由器身份仍有效却被移出转发集合；
  - `duplicate-member`（重复成员）：决策或状态文件中同一 (group, source, port) 出现多次。

  每条发现都包含 `group`、`source`、`port`、`tick` 和 `evidence`（相关事件 id/tick/type）。
- `src/cli.js` — 命令行入口（见下）。

## 语义要点

- **源特定组播（SSM）**：`include` 模式 Report 按源建立 (group, source) 成员；
  `exclude` 模式（空源列表）建立通配成员 `group|*`，接收该组所有源的流量。
- **Last-listener 窗口**：收到 Done 后不立即剪枝，而是进入 `pending-leave`
  （窗口 = `lastListenerInterval × lastListenerCount`），并记录一条仿真的
  组/源特定查询；窗口内收到新 Report 即取消 Leave、恢复 active。
- **路由器端口**：`router-port-add/del`、`query`（刷新定时器）维护；迁移用
  同 tick 的 del + add 表示；所有已注册流始终转发到路由器端口。
- **重启**：`restart` 事件触发落盘 + 重新加载；成员、定时器（绝对 tick）
  和已处理事件 id 全部持久化，重启前后转发决策完全一致。
- **事件去重**：带 `id` 的事件幂等，重复 id（包括重启后重放）不会重复应用。

## 事件格式

事件脚本为 JSON 数组，按 `(tick, 输入顺序)` 应用：

| type | 字段 | 说明 |
| --- | --- | --- |
| `report` | `port`, `group`, `mode`(`include`/`exclude`), `sources[]` | MLD Report；`include`+空源列表等价于 Leave |
| `done` | `port`, `group`, `sources[]`（空=全部源） | MLD Done（Leave） |
| `router-port-add` / `router-port-del` | `port` | 路由器端口学习/删除（迁移=同 tick 一删一增） |
| `query` | `port` | 收到查询，刷新该端口的路由器定时器 |
| `port-up` / `port-down` | `port` | 拓扑事件；down 立即清除该端口成员与路由器身份 |
| `restart` | — | 进程重启点：落盘并从状态文件恢复 |

所有事件可带 `id` 用于幂等去重。配置（`--config`）字段：`groupTimer`、
`lastListenerInterval`、`lastListenerCount`、`routerPortTimer`（单位均为时间片）。

## 使用

```bash
# 运行状态机（示例脚本含快速 Leave/Report、路由器端口迁移、重启）
node src/cli.js run --events examples/events.json --horizon 12 \
  --state artifacts/state.json --decisions artifacts/decisions.jsonl \
  --events-log artifacts/events.jsonl

# 独立审计：读取状态文件 + 决策日志 + 事件日志
node src/cli.js audit --state artifacts/state.json \
  --decisions artifacts/decisions.jsonl --events-log artifacts/events.jsonl
# 无发现时退出码 0；发现错误泛洪/误剪枝/重复成员时退出码 1 并输出 JSON 详情

# 测试（node:test：快速加入离开、端口迁移、状态恢复、重复事件、SSM、审计器负例）
node --test
```

决策日志每行一个时间片：`{"tick":N,"flows":{"group|source":["port",...]},"routerPorts":[...],"queries":[...]}`。

## 已知限制

- `exclude` 模式仅支持空源列表（经典 ASM）；非空源列表会报错。
- `include` 模式 Report 为增量加入（按源），离开通过 `done` 表达。
- 未注册组播流默认丢弃，不做未注册泛洪。
