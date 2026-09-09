// admin.js —— 管理员子域（复核 / 封禁 / 性别纠错 / 校内身份管理 / 种子局联调 / 内容安全自检）
// 管理员名单唯一来源 db.js（isAdmin）；扣分定级唯一来源 rules.js KIND_DELTA；性别分级复用 gender.js。
// 复核/身份管理动作自 account.js 迁入（2026-09-08）："管理员"一个模块一个家。
const { db, _, ok, fail, ensureUser, applyCreditDelta, isAdmin, cloud } = require("./db");
const { KIND_DELTA } = require("./rules");
const { applyGenderFake } = require("./gender");

// —— 复核 / 举报坐实 ——

// 管理员：待处理上报列表（带对象/举报人/线路/类型中文）
async function adminPending(event, openid) {
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

// —— 校内身份管理（复核乱填 / 撤销）——

// 管理员：查看已登记校内身份（复核乱填/重复用）
async function adminIdentities(event, openid) {
  if (!isAdmin(openid)) return fail("NO_ADMIN", "无管理员权限");
  const res = await db.collection("users").where({ schoolId: _.exists(true) }).limit(200).get();
  const list = (res.data || [])
    .map((u) => ({
      openid: u.openid,
      nickName: u.nickName || "?",
      studentId: (u.schoolId && u.schoolId.studentId) || "",
      name: (u.schoolId && u.schoolId.name) || "",
      major: (u.schoolId && u.schoolId.major) || "",
      declaredAt: (u.schoolId && u.schoolId.declaredAt) || 0,
    }))
    .sort((a, b) => b.declaredAt - a.declaredAt);
  return ok({ list });
}

// 管理员：撤销登记（乱填/纠正），schoolId 字段移除
async function adminClearIdentity(event, openid) {
  if (!isAdmin(openid)) return fail("NO_ADMIN", "无管理员权限");
  const targetOpenid = String(event.targetOpenid || "");
  if (!targetOpenid) return fail("BAD_TARGET", "缺少对象");
  await db.collection("users").where({ openid: targetOpenid }).update({ data: { schoolId: _.remove(), updatedAt: Date.now() } });
  return ok({ cleared: true });
}

// —— 联调辅助 ——

// 管理员：为给定 openid 们创建一条"已完成"的共享拼车局（含示例消息），用于测试历史/举报/再约
async function adminSeedDone(event, openid) {
  if (!isAdmin(openid)) return fail("NO_ADMIN", "无管理员权限");
  const list = (event.members || []).filter((x) => x && typeof x === "string");
  if (list.length < 2) return fail("BAD_MEMBERS", "至少传两个成员 openid");
  const now = Date.now();
  const members = [];
  for (const o of list) {
    const u = await ensureUser(o);
    members.push({
      openid: o,
      name: u.nickName || "拼友",
      gender: u.gender || "",
      role: members.length ? "member" : "host",
      checkedInAt: now - 60 * 60000,
      joinedAt: now - 90 * 60000,
    });
  }
  const add = await db.collection("rides").add({
    data: {
      routeId: "in-futian",
      directionId: "in",
      from: "福田口岸（落马洲）的士站",
      to: "香港教育大学",
      date: "",
      boardAt: now - 90 * 60000,
      capacity: 4,
      womenOnly: false,
      note: "联调用·已完成局（adminSeedDone）",
      status: "done",
      hostOpenid: list[0],
      memberCount: list.length,
      members,
      memberOpenids: list,
      poll: null,
      noShowConfirmed: [],
      settled: true,
      createdAt: now - 90 * 60000,
      updatedAt: now,
    },
  });
  const lines = ["到齐了，出发 🚕", "到学校了，下次再拼！"];
  for (let i = 0; i < lines.length; i++) {
    const who = members[i % members.length];
    await db.collection("messages").add({
      data: { rideId: add._id, openid: who.openid, name: who.name, text: lines[i], createdAt: now - 80 * 60000 + i * 1000 },
    });
  }
  return ok({ rideId: add._id, members: list });
}

// 联调清理：清空 局数据域（rides / messages / invites / reports），保留 users 与 routes。
// 管理员专用；内测重测前使用。
async function adminReset(event, openid) {
  if (!isAdmin(openid)) return fail("NO_ADMIN", "无管理员权限");
  const removed = {};
  for (const c of ["reports", "invites", "messages", "rides"]) {
    let n = 0;
    // 先试批量 where 删除，不支持则退化为分页逐删
    try {
      const r = await db.collection(c).where({ _id: _.exists(true) }).remove();
      n = (r && r.stats && r.stats.removed) || 0;
    } catch (e) {
      let total = 0;
      for (;;) {
        const page = await db.collection(c).where({ _id: _.exists(true) }).limit(100).get();
        const ids = (page.data || []).map((d) => d._id);
        if (!ids.length) break;
        for (const id of ids) {
          await db.collection(c).doc(id).remove();
          total += 1;
        }
        if ((page.data || []).length < 100) break;
      }
      n = total;
    }
    removed[c] = n;
  }
  return ok({ removed });
}

// 内容安全自检：直调 msgSecCheck 返回原始结果，验证个人主体/权限是否放行。
// 用途：上线对外宣称"已接入内容安全"前先跑一次——返回 errCode 0 / suggest=pass 才说明真可用；
// config.json 加权限后需重传云函数，权限缓存约 10 分钟（此间报 -604101 属正常，稍后再试）。
async function secProbe(event, openid) {
  if (openid && !isAdmin(openid)) return fail("NO_ADMIN", "无管理员权限");
  const out = { errCode: null, errMsg: "", suggest: null, hit87014: null };
  try {
    const res = await cloud.openapi.security.msgSecCheck({ content: "深港通勤，拼车组队，明天一起出发" });
    out.errCode = res && res.errCode;
    out.errMsg = (res && res.errMsg) || "";
    out.suggest = res && res.result && res.result.suggest;
  } catch (e) {
    out.errCode = e && (e.errCode != null ? e.errCode : e.errcode);
    out.errMsg = (e && (e.errMsg || e.message)) || "";
  }
  return ok(out);
}

module.exports = {
  adminPending,
  resolveReport,
  banUser,
  adminSetGender,
  adminIdentities,
  adminClearIdentity,
  adminSeedDone,
  adminReset,
  secProbe,
};
