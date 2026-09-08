# 云函数部署与联调指引

> 云侧唯一契约：`SPEC.md`（集合结构、状态机、action 接口）。领域语义：仓库根 `CONTEXT.md` / `docs/DESIGN.md`。

## 函数清单

| 目录 | 作用 | 触发 |
|---|---|---|
| `routeInit` | 幂等建集合 + 写入一期 7 条线路 | 手动调一次 |
| `rides` | **唯一业务函数**（原 `user` 已并入删除）：拼车局 create/list/my/detail/join/leave/cancel/checkin/respondPoll/sendMessage/… + 用户档案·信用·复核 login/me/register/adminPending/resolveReport/banUser/adminSetGender（`account.js`） + 校内身份 identitySave/adminIdentities/adminClearIdentity + 反馈 feedback/feedbackList/feedbackHandled | 小程序调用 |
| `rideSweep` | 定时触发 `rides.__sweep`（读时自愈双保险，见 SPEC §0b） | 每分钟定时器 |

## 部署步骤

1. **开通云开发**：开发者工具右上角「云开发」→ 创建环境 → 复制**环境 ID**。
2. **填环境 ID**：`sgy/app.js` 的 `globalData.env = "你的环境ID"`。
3. **上传云函数**：分别右键 `cloudfunctions/routeInit`、`rides`、`rideSweep` →「上传并部署：云端安装依赖」。`rides` 已含原 `user` 能力，请在云开发控制台**删除旧的 `user` 函数**；`routeInit` 会幂等建齐 `users/routes/rides/messages/reports/invites/blocks/feedbacks`。`rideSweep` 的定时触发器在 `config.json`，上传后可在「云开发控制台 → 云函数 → rideSweep → 触发器」确认每分钟一次。
4. **初始化一次**：调用 `routeInit`（开发者工具 → 云开发控制台 → 云函数 → routeInit → 云端测试，event 给 `{}`，或从临时页面 `wx.cloud.callFunction({ name:'routeInit' })`）。它幂等建集合并写入线路。
5. **建索引**（云开发控制台 → 数据库 → 各集合 → 索引），按 `SPEC.md §0`：
   - `rides`：① `status + boardAt` ② `directionId + boardAt + status` ③ 单字段 `memberOpenids`
   - `messages`：`rideId + createdAt`
   - `reports`：`rideId`、`status`
   - `users`：`openid`
   - `invites`：`toOpenid + status`
   - `blocks`：`byOpenid + targetOpenid`
6. **填管理员 openid**：`cloudfunctions/rides/db.js` 顶部 `ADMIN_OPENIDS`。查自己的 openid：临时在任意页面 `wx.cloud.callFunction({ name:'rides', data:{ action:'login' } })` 看返回值，或 console 打 `OPENID`。

## 冒烟测试顺序（前端接好 `callFunction` 后走，或用云端测试给模拟 openid 困难时优先走小程序）

1. `routeInit` → 返回各集合 + `routesAdded:7`。
2. `rides` action `login` → 建档，`credit:100`。
2b. `rides` action `identitySave`（学号 s+7 位）→ 登记成功；同局 `memberInfo` 返回 `schoolVerified:true`（他人不见学号明文）。
2c. `rides` action `feedback`（仅注册）→ `sent:true`；管理员 `feedbackList` 可见。
3. `rides.create`（选一条线路，时间设 40+ 分钟后）→ 得到 `rideId`。
4. 另一个微信号 `rides.join` → `rides.list` 能看到局与人数变化。
5. 时间逼近的场景（轮询/关局/结算）靠 `rideSweep`：可把 boardAt 设成很近再手动云端测试调 `rideSweep`（event `{force:true}`）看状态推进。

## 说明与已知简化（MVP）

- **并发可行性**：join/create 都校验；同人可持多局，但任意两局间隔 ≥1h、同方向 ≥2h（唯一来源 rides/rules.js，见 SPEC §2）。
- **爽约自动扣分**：rideSweep 在结算时对"到点没签到且未退出"者自动 −20；成员手动"上报"走管理员复核 −20。
- **签到后放鸽子 −40**：暂未自动判定（需人工核实的场景），管理员复核只支持 −20。留待二期。
- 集合权限建议设为"所有用户不可读写（仅云函数）"，避免前端直改库绕过规则。
