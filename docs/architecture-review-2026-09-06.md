# 架构评审与深化记录（2026-09-06 → 09-07）

> 触发：/improve-codebase-architecture。结论与执行状态，供后续开发者/AGENT 参考，避免重复评审、重复引入同样的分叉。
> 领域词汇见 `CONTEXT.md`；云函数契约唯一来源 `cloudfunctions/SPEC.md`；决策记录 `docs/adr/`。

## 约束（决定了很多结论）

- 每个云函数文件夹 = 独立可部署单元，**跨文件夹不能 `require` 共享代码**。所以"共享逻辑"不能靠建共享模块实现，只能合并可部署单元或接受/委托。
- 产品是单人维护的 MVP，且无自动化测试、长期无 git（2026-09-07 起已有本地 git + GitHub 远程）。

## 评审发现的 5 个问题与处置

### ① 规则核心被复制三份且已分叉 —— 已修
时间线/结算/信用常量原来硬编码在 `rides`、`rideSweep`、`user` 三处，且**已漂移**：
- `T_SETTLE` 代码 60min vs SPEC 120min → 定稿 **60min**，唯一来源 `rides/rules.js`。
- `ensureUser` 默认昵称：user 随机"拼友XXXX" vs rides/rideSweep"通勤者" → 统一随机（每人不同）。
- `detail.canCheckin` 与 `checkin` action 口径不一致 → 共用 `rules.canCheckin` 谓词。
- `respondPoll → leave` 传死参数 `_noPenalty` → 删除。
**处置**：新增纯函数 `cloudfunctions/rides/rules.js`（无 wx 依赖，可本地 node 冒烟）；**rideSweep 退化为每分钟委托 `rides.__sweep` 的壳**，不再自带规则副本。部署顺序：先 rides（含 `__sweep`）后 rideSweep。

### ② rides 是"一个原因不应拆成的巨分发" —— 已修
19 个 action、6 个子领域、约 14 份重复的 `getRide→getMember` 守卫前奏、入口零入参校验。
**处置**：保持单个 rides 可部署单元，内部按子领域拆文件：
`index.js`（纯 action 路由表）+ `rules / db(共享数据守卫) / lifecycle / queries / chat / social / invites / admin / sweep`。
⚠ 不要拆成多个云函数（会重新引入跨文件夹复制）。消息查询重复收敛为 `db.recentMessages`；`rides.list` 双重遍历消除。

### ③ 客户端半途转向残留 —— 已修
"聊天搬到聊天室 Tab"后 `ride.js` 仍留整套死聊天引擎（约 90 行）与过期文案（"队友可标记爽约"已下线）；quickstart 脚手架（`pages/index`、`pages/example`、`cloudTipModal`、`quickstartFunctions`、`envList.js`）仍在磁盘。
**处置**：删死聊天与脚手架；`gender→头像框` 映射收敛为 `domain.frameCls`（chat/feed/ride 复用）；给用户看的规则文案（ride 详情/发局/我的-信用与隐私）对齐到真实机制；去旧词"检举"。

### ④ 线路目录双源 —— 已修
7 条线路同时写死在 `sgy/utils/domain.js ROUTES`（发选项）和 `routeInit`（seed DB），校验方与发选项方不同源，管理员改线路会 BAD_ROUTE。
**处置**：新增只读 `rides.routes` action；客户端 `sgy/utils/routes.js` 拉 DB 做下拉，本地 `ROUTES` 仅离线快照兜底。domain.js 头注同步说明。

### ⑤ "唯一契约"在漂移 —— 已修（随①②）
SPEC/DESIGN/CONTEXT 多处描述已下线机制（3 Tab、T+15、放鸽子 −40、no_show 举报、旧 reports kind 等）。
**处置**：SPEC §1/§2/§4/§6、CONTEXT 爽约词条、DESIGN（结算/举报/4 Tab）改到与实现一致；`rides/rules.js` 作为 §2 数值的唯一可执行来源。

## 附带修复（诊断）
- 找局首屏空白：`feed.refresh()` 把 `rides.list` 瞬时失败**伪装成空列表**（无错误态/无重试），冷启动或刚重传云函数时首屏"空白"，切 Tab 回来（onShow 再 refresh）自愈。已改为：失败显示"加载失败·自动重试中"+ 1.5s 自动重试 + 手动重试，与真空态区分。

## 仍开放（未做/待定）
- 评审 HTML 报告在仓库外（本文件即归档版）。
- 可选 ADR-0011：聊天图片 base64 存消息（每人每局 1 张，放弃云存储）——符合 ADR 门槛（不可逆/有真实取舍），未单独记录。
- 真机双账号回归尚未执行（见操作时请按"待部署顺序 + 双账号回归清单"）。
