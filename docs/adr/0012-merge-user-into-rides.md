# ADR-0012：云函数收敛 —— user 并入 rides（跨可部署单元不再双写用户策略）

- 状态：已采纳（2026-09-07）
- 关联：ADR-0007（CloudBase 技术栈）、ADR-0010（参与与举报规则）、[SPEC §0b/§6](../../cloudfunctions/SPEC.md)、架构评审 2026-09-06（① 规则唯一来源、② 别再多拆云函数）

## 背景

云函数按**文件夹 = 独立可部署单元**，跨文件夹不能 `require` 共享代码（ADR-0007）。于是两条同写 `users` 文档的"用户信任策略"被物理复制成两份：

- **性别不实分级梯**（L1 清空 / L2 反推并锁定）：`rides/social.js`（联名自动坐实）与 `user/index.js`（管理员坐实）各一份，靠 `⚠ 改动必须两处同步` 注释人肉维持；
- **扣分表**：`rides/rules.js` 的 `KIND_DELTA` 与 `user/index.js` 的 `DELTA`（含已下线 `no_show` 残留、兜底 −20 不同）；
- **建档/扣信用/默认昵称**：`rides/db.js` 与 `user/index.js` 各一份（默认昵称曾漂移成两种，见 09-06 评审①）；
- **管理员名单 `ADMIN_OPENIDS`**：`rides/admin.js` 与 `user/index.js` 各一份。

双写已导致过一次真实漂移，且下一次性别/信用规则调整会再次需要双处同步。

## 决策

**删除独立 `user` 云函数，把它的动作并入 `rides` 单可部署单元**：

- `rides/account.js` 承载 login / me / register / adminPending / resolveReport / banUser / adminSetGender，复用 `db.js`（ensureUser/applyCreditDelta）与 `rules.js`（信用参数），不再自带副本；
- 性别分级收敛为 `rides/gender.js`（`applyGenderFake`），`social.complaint` 与 `account.resolveReport` 共用；
- 管理员名单收敛为 `db.js` 的 `isAdmin`（rides/admin.js 一并改用）；
- 客户端统一 `call({ name: 'rides' })`（原 8 处 `call('user')` 改指 rides；动作名与 ride 动作无冲突）。

## 理由

- 唯一来源从"约定"变成"物理事实"：rules.js/db.js 在本文件夹内可被所有动作 require；
- 与 09-06 评审②"不要再拆更多云函数"的方向一致，并把 ① 的"规则唯一来源"贯彻到底；
- 服务端无任何函数按名调 `user`（仅 rideSweep → `rides.__sweep`），合并零外部依赖改动。

## 影响 / 取舍

- `rides` 成为单一较大部署体（动作路由约 27 项：拼车局 + 用户档案）。MVP 规模可接受；冷启动/超时影响同当前。
- 一次部署中若 `rides` 出错，ride 与 user 侧同时不可用（同一 env 现状本就接近）。
- **部署动作**：重传 `rides`；在云开发控制台删除旧 `user` 函数；重编译小程序。部署顺序与清单见 `cloudfunctions/README.md`。
- 若未来功能量增长需要拆回，须先解决"跨可部署单元共享纯规则"的机制（当前 CloudBase 不支持跨目录依赖）。
