// cloudfunctions/rides —— 拼车局主业务（入口 = 纯 action 路由表）
// 业务按子领域拆分到本文件夹内：rules(纯规则) / db(共享数据守卫) / lifecycle / queries /
// chat / social / invites / admin / sweep / gender(性别分级) / account(原独立 user 云函数并入)。
// 契约见 SPEC.md；改规则改 rules.js。
const { cloud, fail } = require("./db");
const lifecycle = require("./lifecycle");
const queries = require("./queries");
const chat = require("./chat");
const social = require("./social");
const invites = require("./invites");
const admin = require("./admin");
const sweep = require("./sweep");
const account = require("./account");
const feedback = require("./feedback");

// action → 处理函数。__sweep 由 rideSweep 云函数每分钟触发调用（见 cloudfunctions/rideSweep）。
// ⚠ 本表所有处理函数统一签名 (event, openid)：只认 openid 不认 event 的（如 account.me/adminPending）
//   也必须写成 (event, openid) 再忽略 event——否则会把 event 当 openid（曾致 users 按对象建档的 bug）。
const HANDLERS = {
  // 拼车局生命周期
  create: lifecycle.create,
  join: lifecycle.join,
  leave: lifecycle.leave,
  cancel: lifecycle.cancel,
  checkin: lifecycle.checkin,
  respondPoll: lifecycle.respondPoll,
  updateNote: lifecycle.updateNote,
  confirmPending: lifecycle.confirmPending, // 补签到确认：待确认列表
  confirmRide: lifecycle.confirmRide, // 补签到确认：上车了(+1) / 没上(−20)
  // 查询
  list: queries.list,
  my: queries.my,
  detail: queries.detail,
  messages: queries.rideMessages,
  routes: queries.routeList,
  getRules: queries.getRules, // 规则面板下发（文案/数字单一来源 rules.js，客户端快照兜底）
  // 局内聊天
  sendMessage: chat.sendMessage,
  // 局内成员间
  memberInfo: social.memberInfo,
  block: social.setBlock,
  complaint: social.complaint,
  // 邀请 / 再约
  invite: invites.inviteSend,
  inviteList: invites.inviteList,
  inviteRespond: invites.respondInvite,
  reinvite: invites.reinvite,
  // 用户档案（并入自原 user 云函数，客户端 call 本函数即可）
  login: account.login,
  me: account.me,
  register: account.register,
  // 校内身份（自报防逃跑威慑；仅绿标对外，明文仅管理员）
  identitySave: account.identitySave,
  // 管理员子域（复核/封禁/性别纠错/身份管理/联调；名单唯一来源 db.js isAdmin）
  adminPending: admin.adminPending,
  resolveReport: admin.resolveReport,
  banUser: admin.banUser,
  adminSetGender: admin.adminSetGender,
  adminIdentities: admin.adminIdentities,
  adminClearIdentity: admin.adminClearIdentity,
  adminSeedDone: admin.adminSeedDone,
  adminReset: admin.adminReset,
  secProbe: admin.secProbe, // 内容安全自检（诊断用；云控制台可无 openid 触发）
  // 用户反馈与建议（仅注册用户；管理员列表/标记）
  feedback: feedback.submit,
  feedbackList: feedback.adminList,
  feedbackHandled: feedback.markHandled,
  // 定时推进
  __sweep: sweep.run,
};

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  const handler = HANDLERS[event.action];
  if (!handler) return fail("NO_ACTION", "未知 action");
  // __sweep 为定时触发（服务端到服务端）、secProbe 为诊断触发（云控制台测试面板），都不需要用户 openid
  if (!OPENID && event.action !== "__sweep" && event.action !== "secProbe") return fail("NO_AUTH", "无法识别用户");
  try {
    return await handler(event, OPENID);
  } catch (e) {
    console.error("[rides]", event.action, e);
    return fail("EXCEPTION", "服务开小差了，请重试");
  }
};
