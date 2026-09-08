# 云函数与数据契约（唯一来源）

> 实现云函数时以本文档为准。领域语义见仓库根 `CONTEXT.md` / `docs/DESIGN.md` / `docs/adr/`。本文档只定义云侧接口与数据，不含 UI。

## 0. 通用约定

- 运行环境：微信云开发，`wx-server-sdk`，`cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })`。
- **openid**：一律取 `cloud.getWXContext().OPENID`，不信任前端传入。
- **时间**：所有时间字段用 **毫秒时间戳 number**（避免时区/反序列化坑）。前端展示自行换算。
- **响应信封**（云函数统一返回，前端据此判断）：
  - 成功 `{ ok: true, data }`
  - 失败 `{ ok: false, err: 'ERR_CODE', msg: '给用户看的中文提示' }`
- **权限**：所有写操作在云函数内完成；集合权限设为"仅创建者可读写"或"所有用户不可读写(仅云函数)"均可，云函数以管理员身份访问不受限。
- 每个集合建议加的索引（在控制台手动建，见 README）：
  - `rides`：(status + boardAt)、(directionId + boardAt + status)、`memberOpenids`（数组等值匹配 "我的局/一人一局"）
  - `messages`：(rideId + createdAt)
  - `reports`：(rideId)、(status)
  - `users`：(openid)
  - `feedbacks`：(status)

## 0b. 近期修订（2026-09，详见 docs/adr/0010）

- 参与动作（create/join/sendMessage/inviteSend）要求 `users.registered=true`，否则 `NEED_REGISTER`。
- 并发规则：同人多个未出发局——**任何方向**出发时间差 <1h（`T_MIN_GAP`）即冲突；**同方向**（返校×返校 / 离校×离校）再额外要求 ≥2h（`T_SAME_DIR`：同向需先完成一趟往返）。冲突失败带 `data.conflict`。
- 举报（complaint）：kind 限 `gender_fake|lateness|absence`；同一(局,人)同类一人一次；同局 ≥2 名不同成员联名自动坐实并只扣一次。
- rides 新增 action：`messages`（轻量拉消息）、`updateNote`（发起人改备注）、`reinvite`（下周同刻再约）、`adminSeedDone`（管理员造已完成局）。消息带 `type: text|image`（image=base64 data URI，单条 ≤200k 字符，每人每局 1 张）。
- user 新增：`register`、`adminPending` 返回带对象/举报人/线路中文。
- **rides 入口为纯 action 路由表**：业务按子领域分文件（`lifecycle/queries/chat/social/invites/admin/sweep`），规则常量唯一来源 `cloudfunctions/rides/rules.js`；`rideSweep` 云函数退化为每分钟调 `rides.__sweep` 的委托（先部署 rides 再部署 rideSweep）。
- **状态推进为"读时自愈"（不依赖定时器）**：`db.getRide`/`db.advanceMany` 在读取时即就地推进到期状态（关局/上路/结算，结算防重 `settled`）；`__sweep` 仅作批量双保险，与读取共用 `advanceStatus`。
- **聊天室生命周期（2026-09-08）**：局完成后保留 48h（`chatKeepMs = T_SETTLE + CONFIRM_WINDOW_MS`），期间仍可发言（补 AA 账）；过后 `sendMessage` 返回 `CHAT_CLOSED`；历史消息随时可在「行程」查看。
- **加急局（2026-09-08）**：`create` 接受 `urgent`——出发前 15–30 分钟（`URGENT_MIN_LEAD`/`URGENT_WINDOW`）内可发起，绕开 `TOO_SOON`；`rides.urgent` 标记；关局/`canJoin`/加入窗口统一用 `joinCloseMs`（加急 T−5、正常 T−10）；凑不齐 2 人自动 `failed`（与正常未成局一致，不计爽约、不扣发起人分）。
- **云函数收敛（2026-09-07）**：独立 `user` 云函数删除、并入 `rides`（用户动作见 `rides/account.js`，客户端统一 `call('rides', …)`）；管理员名单收敛到 `rides/db.js`；性别不实分级收敛到 `rides/gender.js`（`social.complaint` 与 `account.resolveReport` 共用）。

## 1. 集合与文档结构

**blocks（不与其乘车标记）**：`{ byOpenid, targetOpenid, createdAt }`（by+target 幂等）。
**invites（组队邀请）**：`{ rideId, fromOpenid, fromName, toOpenid, status: 'pending'|'accepted'|'declined', createdAt }`。
**feedbacks（用户反馈）**：`{ openid, nickName, kind: 'suggestion'|'bug'|'other', text(≤500), contact(选填≤60), status: 'pending'|'handled', createdAt }`（仅注册用户提交）。

### users（用户档案，惰性创建）
| 字段 | 说明 |
|---|---|
| `openid` | string，唯一 |
| `nickName` / `avatarUrl` | string，展示用（头像昵称填写能力所得） |
| `gender` | string `''` \| `'female'` \| `'male'`（**自报**，不可信来源） |
| `genderLocked` | string `''`(未锁) \| `'male'`\|`'female'`（性别不实分级纠错 L2 反推真值后锁定的值；锁定后不可自改，仅管理员 `adminSetGender`） |
| `genderFakeCount` | number，性别不实坐实累计次数（L2 触发②：≥2） |
| `schoolId` | object \| null，自报校内身份 `{ school(一期固定教大), studentId(小写 s+7 位), name, major(选填), declaredAt }`；明文仅本人(me)/管理员可见，他人只见 `memberInfo.schoolVerified` 绿标 |
| `phoneVerified` | bool |
| `credit` | number，初始 100，封顶 120 |
| `createdAt` / `updatedAt` | number ms |
| `bannedUntil` | number ms \| 0（封禁到期时间，见 REPORT_RULES） |

### routes（线路目录，seed 一次）
| 字段 | 说明 |
|---|---|
| `routeId` | string，`in-futian` 等，唯一 |
| `directionId` | `'in'`(返校 SZ→HK) \| `'out'`(离校 HK→SZ) |
| `from` / `to` | string，展示名（上车点 / 下车点） |
| `enabled` | bool |

一期 7 条见 `docs/DESIGN.md`「线路目录」。

### rides（拼车局，核心）
| 字段 | 说明 |
|---|---|
| `routeId` / `directionId` | string，引用 routes |
| `from` / `to` | string，冗余快照（路由改名不影响历史局） |
| `date` | string `YYYY-MM-DD` |
| `boardAt` | number ms = T |
| `capacity` | number 默认 4，发起人可设 2–6（create 服务端钳制 2–6） |
| `status` | `recruiting` \| `locked` \| `ongoing` \| `done` \| `cancelled` \| `failed` |
| `womenOnly` | bool（**废弃**：UI 已移除"仅限女生"，仅历史数据保留，不再参与任何校验） |
| `note` | string，发起人备注/暗号（≤50 字） |
| `hostOpenid` | string |
| `memberCount` | number（冗余，含发起人） |
| `members` | array of `{ openid, name, gender, role: 'host'\|'member', checkedInAt: number\|0, joinedAt: number }`（gender 为加入时快照，用于头像框着色） |
| `memberOpenids` | array of string，派生（保持与 members 同步），供"一人一未出发局/我的局"查询用 |
| `poll` | object \| null，见 §2 轮询 |
| `noShowConfirmed` | array of openid（结算期自动确认的爽约，便于展示） |
| `createdAt` / `updatedAt` | number ms |
| `settled` | bool，done 结算是否已执行 |
| `pendingConfirm` | object \| null，结算时对未签到成员挂起 `{ dueAt, openids[], resolved[], settled }`，供补签到确认（confirmPending/confirmRide） |

### messages（局内聊天）
`{ rideId, openid, name, text, createdAt }`

### reports（爽约 / 举报 / 申诉）
| 字段 | 说明 |
|---|---|
| `rideId` | string |
| `byOpenid` | 上报人 |
| `targetOpenid` | 被上报人 |
| `kind` | `'gender_fake'` \| `'lateness'` \| `'absence'`（complaint 产生；联名 ≥2 自动坐实否则待复核）。`no_show/false_report/appeal` 为早期已下线流程的存量字段，仅供历史记录 |
| `note` | string |
| `status` | `'pending'` \| `'upheld'` \| `'dismissed'` |
| `creditDelta` | 确认后应扣分值（结算用，见 §4） |
| `createdAt` / `resolvedAt` | number ms |

## 2. 规则常量（毫秒）

```
T_JOIN_CLOSE = 10 * 60_000     // T−10 停止加入
T_JOIN_CLOSE_URGENT = 5 * 60_000 // 加急局关局点：T−5 停止加入（正常 T−10；唯一来源 rides/rules.js joinCloseMs）
T_FREE_EXIT  = 30 * 60_000     // T−30 自由退出/解散截止
T_MIN_GAP    = 60 * 60_000     // 任意方向两局须相隔 ≥1h
T_SAME_DIR   = 120 * 60_000    // 同方向两局须相隔 ≥2h（往返的士约 1h + 缓冲；唯一来源 rides/rules.js）
T_POLL_ASK   = 60 * 60_000     // T−60 人数轮询
T_POLL_DUE   = 45 * 60_000     // T−45 轮询截止（未回默认接受）
T_CHECKIN_GRACE = 10 * 60_000  // T+10 停止"我到了"签到
T_SETTLE     = 45 * 60_000     // 上车后 45min 自动结算 done（深港单程最慢约 45 分钟，行程结束即结算、尽早进补签确认窗口；此前 2h→1h，2026-09-08 定稿；唯一来源 rides/rules.js）
CONFIRM_WINDOW_MS = 48 * 60 * 60_000  // 结算后"补签到确认"窗口：未签到成员 48h 内弹窗确认是否上车，逾期默认爽约（唯一来源 rides/rules.js）
URGENT_MIN_LEAD = 15 * 60_000  // 加急局最早提前 15 分钟发起（留出加入窗口）
URGENT_WINDOW   = 30 * 60_000  // 加急局窗口：出发前 30 分钟内
```

## 3. 拼车局状态机（rideSweep 定时推进 + 用户动作触发）

```
recruiting
  ├─ 发起人 cancel（now < T−T_FREE_EXIT）──▶ cancelled
  ├─ sweep at now ≥ T−T_JOIN_CLOSE：memberCount ≥2 ──▶ locked
  │                                  memberCount <2 ──▶ failed（自动，不计爽约）
locked
  ├─ sweep at now ≥ T ──▶ ongoing
ongoing
  └─ sweep at now ≥ T+T_SETTLE ──▶ done（结算，见 §4）
```

**约束（写入时校验，违反返回 `{ ok:false }`）：**
1. **并发可行性（create/join 都查）**：同人可并存多个未出发局，但任意两局出发时间差 < `T_MIN_GAP`(1h) 即冲突；同方向（directionId 相同）且差 < `T_SAME_DIR`(2h) 也冲突（同向需先完成一趟往返）。
2. **join**：`status==='recruiting' && now ≤ T−T_JOIN_CLOSE && memberCount<capacity`；性别不影响加入（仅用于头像框着色与不实检举）。
3. **create（发起）**：用户 `credit ≥ 60` 才可发起；同一并发可行性校验（见上约束 1）；`boardAt` 需 > now + T_FREE_EXIT（给他人留组队窗口）。
4. **leave**：仅 `status ∈ {recruiting, locked}` 且 `now < T`。`now < T−T_FREE_EXIT` → 免费；否则计爽约（credit −20，见 §4）。发起人离开时若仍有成员，把 `role:'host'` 转给 `joinedAt` 最早者；若空则 `cancelled`。
5. **cancel（发起人解散）**：仅 `now < T−T_FREE_EXIT`。
6. **checkin（我到了）**：成员本人，`now ≤ T+T_CHECKIN_GRACE`，`status ∈ {recruiting, locked, ongoing}`；幂等（已签不重复）。

## 4. 结算与信用分（rideSweep 在 done 时执行，`settled` 防重入）

- 规则：初始 100，`<60` 暂停发起 7 天（封禁到期 `bannedUntil = now + 7d`），封顶 120。
- done 结算（读时自愈 + rideSweep，`settled` 防重入）：
  - 每位 **checkedInAt>0** 的成员 `credit +1`（封顶 120）。
  - 到点仍未 checkin 且未 leave 且未被手动移除的成员 → **不立即扣分**，挂入 `ride.pendingConfirm`（`dueAt = boardAt + T_SETTLE + CONFIRM_WINDOW_MS`，48h）。
  - **补签到确认**：`confirmPending` 列出窗口内我待确认的局；`confirmRide { rideId, rode }`——`rode=true` → 补记为已签到（`checkedInAt` 补写）并 `credit +1`；`rode=false` → `credit −20` 并记入 `ride.noShowConfirmed`。**窗口到期仍未确认**（读时/`__sweep` 推进）→ 按爽约 `credit −20` 并记入 `noShowConfirmed`。
  - 谎报"上车了"由队友在局 done 后举报「缺勤没来」兜底（见 §0b complaint）。
- **leave 在 T−T_FREE_EXIT 之后**触发时同步扣 `−20`。
- **迟到/缺勤/性别不实**在局 `done` 后由同局成员 `complaint` 举报（性别不实随时可报）：≥2 人联名自动坐实取最重扣分一次，否则转管理员 `resolveReport` 复核（坐实按 §0b kind 定分；`gender_fake` 顺带清空性别）。
- **签到后放鸽子 / 乱标申诉**等早期 `no_show/false_report/appeal` 流程已下线，存量字段不再新产生。
- 信用更新统一收敛到 `applyCreditDelta(openid, delta)`（幂等安全，users 文档 update）。

## 5. 轮询（T−60 人数确认，MVP 确定性实现）

`rides.poll = { active, askedAt, dueAt(=T−T_POLL_DUE), responses:[{openid, accept:bool, at}] }`

- **触发**：rideSweep 检测 `now ≥ T−T_POLL_ASK && now < T−T_POLL_DUE && recruiting && memberCount<capacity && !poll.active` → 建 poll，前端据此在局详情展示"是否接受当前 N 人出发？"。
- **成员回应**：rides 函数 `action:'respondPoll'`，`accept` true/false。仅当 `now < dueAt` 且仍为成员。
  - `accept=false`：等价免费退出（不扣分），从 members 移除，并**取消本轮 poll**（人数变了重问）。
- **dueAt 结算（sweep）**：`poll.active` 中未回复成员默认 `accept=true`；全员接受 → `poll.status='accepted'`、`active=false`（局可按当前人数出发，但仍在 recruiting 继续招满或到 T−10 锁定）。任一显式 false 的成员已在上面退出。
- 若随后 memberCount 变化（有人加入/退出）且仍 <capacity 且距 T−T_FREE_EXIT 仍足够 → 允许再开新一轮 poll（同一 dueAt 逻辑）。

## 6. 云函数清单与 action 契约

### `rides`（主业务）
`exports.main = async (event)`，按 `event.action` 分发：
- `create`：入 `{ routeId, date, time, capacity, note, urgent? }`（`time` 形如 `"07:40"`，与 `date` 拼为 boardAt）；`routeId` 缺省且 `directionId='out'` 时可传 `to` 作自定义下车点（ADR-0009），`directionId='in'` 时可传 `from` 作自定义上车点（ADR-0014，均 ≤14 字）。`urgent=true` 时允许出发前 15–30 分钟（绕开 TOO_SOON），存 `rides.urgent`。出 `{ rideId }`。
- `list`：入 `{ directionId?, pickup?, date? }` 可选。出未出发局数组（供"找局"，含 members 精简视图与 poll 状态）。默认只返回 `status∈{recruiting,locked}` 且 `boardAt > now − 某窗口`。
- `my`：出我参与/发起的局（ongoing 进行中 / done 历史），不带消息。
- `detail`：入 `{ rideId }`。出 rides doc + 我是否成员 + 是否可加入/可签到，+ 最新 N 条 messages。
- `join`：入 `{ rideId }`。规则见 §3.2。
- `leave`：入 `{ rideId }`。规则见 §3.4，含发起人移交/空局取消。
- `cancel`：入 `{ rideId }`。发起人解散，规则见 §3.5。
- `checkin`：入 `{ rideId }`。规则见 §3.6。
- `confirmPending` / `confirmRide`：补签到确认。`confirmPending` 出我待确认的已完成局（窗口内、未处理）；`confirmRide` 入 `{ rideId, rode: true|false }`，见 §4 补签到确认。
- `respondPoll`：入 `{ rideId, accept }`。见 §5。
- `complaint`：入 `{ rideId, targetOpenid, kind: gender_fake|lateness|absence, note? }`。同局成员提交；同类同一人一局一次；同局 ≥2 名不同成员联名自动坐实（取最重扣分一次），否则 `pending` 待管理员复核。迟到/缺勤仅 `done` 后可报，性别不实随时可报。**性别不实分级**：L1 联名/复核坐实=清空性别；L2（单局 ≥3 名不同成员同报，或该用户坐实累计 ≥2 次）=反推为相反性别并锁 `genderLocked`（仅 `adminSetGender` 可解）。
- `memberInfo` / `block`：成员资料（含信用/是否已标记/`schoolVerified` 仅绿标）与"不与其乘车"标记。
- `invite` / `inviteList` / `inviteRespond` / `reinvite`：组队邀请与"下周同一时刻再约"（复用/新建进行中局并发邀请）。
- `sendMessage` / `messages`：发消息（text；image=base64 见 §0b）与拉最近 20 条。已完成局保留窗 `boardAt + T_SETTLE + CONFIRM_WINDOW_MS`（48h）内仍可发（补账用），过后返回 `CHAT_CLOSED`。
- `routes`：只读下发线路目录（enabled 全集），供发局/筛选下拉；本地快照仅兜底（见 sgy/utils/routes.js）。
- `getRules`：下发面向用户规则面板 `{ timeline, creditTable, creditFooter, privacySections, limits:{imgMax, chatKeepMs, urgentMinLead, urgentWindow, …} }`——文案与数值唯一来源 `rides/rules.js rulePayload()`（同文件同常量，改数值自动带出文案）；`creditTable`/`privacySections` 为可视化面板的结构化数据（信用分表格 / 隐私分节），是规则的**唯一表述格式**（整段散文 CREDIT_TEXT/PRIVACY_TEXT/PREVIEW_TEXT 均已删除，避免双轨漂移）；`timeline` 供详情与发局页的规则表；`chatKeepMs` 供客户端判断聊天室保留窗；客户端 `sgy/utils/rulesText.js` 快照兜底。
- `updateNote` / `adminSeedDone`：发起人改备注（≤50 字）／管理员造已完成局（联调用）。
- `adminReset`（管理员）：清空局数据域 `rides / messages / invites / reports`，**保留 users 与 routes**（内测重测前用）。
- `feedback`（仅注册用户）/ `feedbackList`（管理员）/ `feedbackHandled`（管理员）：提交/查看/标记已处理用户反馈（集合 `feedbacks`，见 §1）。
- `__sweep`：由 rideSweep 定时触发调用的结算/状态推进（rides 文件夹内 `sweep.js`，数值以 §2 为准）。

### 用户档案动作（并入 `rides` 云函数；原独立 `user` 云函数已删除，客户端统一 `call({ name:'rides' })`）

> 2026-09-07：`user` 目录删除，以下动作改由 `rides` 入口分发（`rides/account.js`）。信用/建档复用 `db.js`，性别分级复用 `gender.js`，管理员名单唯一来源 `db.js`——不再有跨可部署单元的策略副本。

- `login`：入 `{ nickName, avatarUrl?, gender? }`。按 openid 惰性建档/更新，出 `{ user, isAdmin }`。
- `adminList`：出待处理 reports + 用户信用列表（需管理员）。
- `resolveReport`：入 `{ reportId, action: 'uphold'|'dismiss' }`（需管理员）。按 §4 应用扣分并置状态；`gender_fake` 坐实另需清空目标性别。
- `banUser`：入 `{ openid, days }`（需管理员，信用清零用）。
- `adminSetGender`：入 `{ targetOpenid, gender: male|female|'', lock?: bool }`（需管理员）。`gender` 非空且 `lock!==false` → 设值并锁定；否则纠正/解锁（`genderLocked=''`）。用于性别误锁纠正。
- `identitySave`：入 `{ studentId, name, major? }`（仅注册用户）。校内身份自报；学号须 `^s\d{7}$`（存小写），学校一期固定教大；覆盖更新 `users.schoolId`（ADR-0013）。
- `adminIdentities`（管理员）：列出已登记校内身份（含学号/姓名明文，复核乱填用）。
- `adminClearIdentity`：入 `{ targetOpenid }`（管理员）。移除 `users.schoolId`（撤销登记）。
- **管理员判定**：唯一来源 `cloudfunctions/rides/db.js` 的 `ADMIN_OPENIDS`（内测期作者）。改名单改那一处即可。

### `routeInit`（一次性初始化，手动调用一次）
- 幂等创建集合（users/routes/rides/messages/reports；已存在则跳过）。
- 写入一期 7 条 routes（已存在按 routeId 跳过）。
- 出每个集合的结果。

### `rideSweep`（定时器，config.json 配每分钟触发器）
每轮扫描 `rides where status in {recruiting,locked,ongoing} and boardAt < now+...`：
1. 到期关局：`recruiting && now ≥ T−T_JOIN_CLOSE` → locked / failed。
2. 到点上路：`locked && now ≥ T` → ongoing。
3. 结算：`ongoing && now ≥ T+T_SETTLE` → done + §4 结算。
4. 轮询触发/到期结算（§5）。
手动调用 `event.force=true` 也执行（便于没有配触发器时手动跑）。

## 7. 索引与部署步骤（写进 README）
1. 开发者工具开通云开发 → 建环境 → 拿环境 ID 填 `sgy/app.js` 的 `env`。
2. 右键 `cloudfunctions/routeInit` → 「上传并部署：云端安装依赖」，在云开发控制台或临时页调用一次初始化。
3. 上传 `rides` / `user` / `rideSweep`（rideSweep 带 config.json 触发器）。
4. 云开发控制台给 rides/messages/reports/users 按 §0 建索引。
5. 作者 openid 填进 `rides/db.js` 顶部的 `ADMIN_OPENIDS`。
