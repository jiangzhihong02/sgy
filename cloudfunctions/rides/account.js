// account.js —— 用户档案 / 信用 / 管理员复核
// 原独立云函数 cloudfunctions/user 已并入本可部署单元（入口见 index.js），本文件不再自带
// ensureUser/applyCreditDelta/randNick/KIND_DELTA/ADMIN_OPENIDS 副本，全部复用 db.js/rules.js；
// 性别不实分级与 social.js 共用 gender.js（见 SPEC §0b）。契约见 SPEC.md §6。
const { db, ok, fail, ensureUser, applyCreditDelta, isAdmin } = require("./db");
const { KIND_DELTA } = require("./rules");
const { applyGenderFake } = require("./gender");

const publicUser = (u) => ({
  openid: u.openid,
  nickName: u.nickName,
  avatarUrl: u.avatarUrl,
  gender: u.gender,
  genderLocked: u.genderLocked || "", // ""=未锁；male/female=已核实锁定的性别（不可自改）
  genderFakeCount: u.genderFakeCount || 0,
  phoneVerified: u.phoneVerified,
  registered: !!u.registered,
  credit: u.credit,
  bannedUntil: u.bannedUntil || 0,
});

async function login(event, openid) {
  const u = await ensureUser(openid);
  const patch = { updatedAt: Date.now() };
  if (typeof event.nickName === "string" && event.nickName.trim()) patch.nickName = event.nickName.trim().slice(0, 20);
  if (typeof event.avatarUrl === "string") patch.avatarUrl = event.avatarUrl;
  if (["female", "male"].includes(event.gender) && !u.genderLocked) patch.gender = event.gender; // 自报；锁定性别不可改
  if (Object.keys(patch).length > 1) {
    await db.collection("users").where({ openid }).update({ data: patch });
    Object.assign(u, patch);
  }
  return ok({ user: publicUser(u), isAdmin: isAdmin(openid) });
}

async function me(openid) {
  const u = await ensureUser(openid);
  return ok({ user: publicUser(u), isAdmin: isAdmin(openid) });
}

// 注册：填昵称（+可选性别）后成为"注册用户"，才可参与拼车
async function register(event, openid) {
  const u = await ensureUser(openid);
  const nick = String(event.nickName || "").trim().slice(0, 12);
  if (!nick) return fail("BAD_NICK", "请填写昵称");
  const patch = { nickName: nick, registered: true, updatedAt: Date.now() };
  // 性别自报；已被系统锁定的性别不可改（genderLocked 见分级纠错）
  if (["female", "male"].includes(event.gender) && !u.genderLocked) patch.gender = event.gender;
  await db.collection("users").where({ openid }).update({ data: patch });
  Object.assign(u, patch);
  return ok({ user: publicUser(u), isAdmin: isAdmin(openid) });
}

// 管理员：待处理上报列表（带对象/举报人/线路/类型中文）
async function adminPending(openid) {
  if (!isAdmin(openid)) return fail("NO_ADMIN", "无管理员权限");
  const res = await db.collection("reports").where({ status: "pending" }).get();
  const KIND_LABEL = { gender_fake: "性别填写与真实不符", absence: "缺勤 / 没来", lateness: "迟到", no_show: "爽约" };
  const out = [];
  for (const r of res.data || []) {
    const t = await db.collection("users").where({ openid: r.targetOpenid }).limit(1).get();
    const b = await db.collection("users").where({ openid: r.byOpenid }).limit(1).get();
    const ride = await db.collection("rides").where({ _id: r.rideId }).limit(1).get();
    out.push({
      _id: r._id,
      kind: r.kind,
      kindLabel: KIND_LABEL[r.kind] || r.kind || "",
      targetName: (t.data[0] && t.data[0].nickName) || "?",
      byName: (b.data[0] && b.data[0].nickName) || "?",
      rideLabel: ride.data[0] ? `${ride.data[0].from} → ${ride.data[0].to}` : "",
      note: r.note || "",
      createdAt: r.createdAt,
    });
  }
  out.sort((a, b) => a.createdAt - b.createdAt);
  return ok({ reports: out });
}

// 管理员：复核单条上报
async function resolveReport(event, openid) {
  if (!isAdmin(openid)) return fail("NO_ADMIN", "无管理员权限");
  const { reportId, action } = event;
  const res = await db.collection("reports").doc(reportId).get().catch(() => null);
  const report = res && res.data;
  if (!report) return fail("NOT_FOUND", "上报不存在");
  if (report.status !== "pending") return fail("RESOLVED", "该上报已处理");

  if (action === "uphold") {
    // 按上报类型定扣分：性别不实/缺勤 −20、迟到 −10（唯一来源 rules.js KIND_DELTA；无记录的老 no_show 兜底 −20）
    const delta = Object.prototype.hasOwnProperty.call(KIND_DELTA, report.kind) ? KIND_DELTA[report.kind] : -20;
    if (report.kind === "gender_fake") {
      // 管理员单人坐实视同本局 1 名举报人：分级梯子在 gender.js（L1 清空 / L2 累计 ≥2 次反推锁定）
      await applyGenderFake(report.targetOpenid, 1);
    }
    let next = null;
    if (delta !== 0) next = await applyCreditDelta(report.targetOpenid, delta);
    await db.collection("reports").doc(reportId).update({
      data: { status: "upheld", creditDelta: delta, resolvedAt: Date.now() },
    });
    return ok({ upheld: true, targetCredit: next });
  }
  if (action === "dismiss") {
    await db.collection("reports").doc(reportId).update({
      data: { status: "dismissed", creditDelta: 0, resolvedAt: Date.now() },
    });
    return ok({ dismissed: true });
  }
  return fail("BAD_ACTION", "未知处理方式");
}

// 管理员：封禁（信用清零 + N 天禁发起）
async function banUser(event, openid) {
  if (!isAdmin(openid)) return fail("NO_ADMIN", "无管理员权限");
  const days = Math.max(1, Math.min(30, Number(event.days) || 7));
  const bannedUntil = Date.now() + days * 24 * 3600 * 1000;
  await db.collection("users").where({ openid: event.targetOpenid }).update({
    data: { credit: 0, bannedUntil, updatedAt: Date.now() },
  });
  return ok({ bannedUntil });
}

// 管理员：纠正/解锁性别（误锁时用）。gender='male|female|'，lock=false 解锁为可改。
async function adminSetGender(event, openid) {
  if (!isAdmin(openid)) return fail("NO_ADMIN", "无管理员权限");
  const targetOpenid = event.targetOpenid;
  if (!targetOpenid) return fail("BAD_TARGET", "缺少对象");
  const g = ["", "male", "female"].includes(event.gender) ? event.gender : "";
  const lock = event.lock !== false;
  const data = { gender: g, updatedAt: Date.now() };
  if (g && lock) data.genderLocked = g; // 设值并锁定
  else data.genderLocked = ""; // 纠正或解锁
  await db.collection("users").where({ openid: targetOpenid }).update({ data });
  return ok({ gender: g, genderLocked: data.genderLocked });
}

module.exports = { login, me, register, adminPending, resolveReport, banUser, adminSetGender };
