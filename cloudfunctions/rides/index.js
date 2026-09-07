// cloudfunctions/rides —— 拼车局主业务（入口 = 纯 action 路由表）
// 业务按子领域拆分到本文件夹内：rules(纯规则) / db(共享数据守卫) / lifecycle / queries /
// chat / social / invites / admin / sweep。契约见 SPEC.md；改规则改 rules.js。
const { cloud, fail } = require("./db");
const lifecycle = require("./lifecycle");
const queries = require("./queries");
const chat = require("./chat");
const social = require("./social");
const invites = require("./invites");
const admin = require("./admin");
const sweep = require("./sweep");

// action → 处理函数。__sweep 由 rideSweep 云函数每分钟触发调用（见 cloudfunctions/rideSweep）。
const HANDLERS = {
  // 生命周期
  create: lifecycle.create,
  join: lifecycle.join,
  leave: lifecycle.leave,
  cancel: lifecycle.cancel,
  checkin: lifecycle.checkin,
  respondPoll: lifecycle.respondPoll,
  updateNote: lifecycle.updateNote,
  // 查询
  list: queries.list,
  my: queries.my,
  detail: queries.detail,
  messages: queries.rideMessages,
  routes: queries.routeList,
  // 聊天
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
  // 管理员联调
  adminSeedDone: admin.adminSeedDone,
  adminReset: admin.adminReset,
  // 定时推进
  __sweep: sweep.run,
};

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  const handler = HANDLERS[event.action];
  if (!handler) return fail("NO_ACTION", "未知 action");
  // __sweep 为定时触发（服务端到服务端），不需要用户 openid
  if (!OPENID && event.action !== "__sweep") return fail("NO_AUTH", "无法识别用户");
  try {
    return await handler(event, OPENID);
  } catch (e) {
    console.error("[rides]", event.action, e);
    return fail("EXCEPTION", "服务开小差了，请重试");
  }
};
