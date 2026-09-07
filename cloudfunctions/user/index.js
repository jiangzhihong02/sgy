// cloudfunctions/user —— 用户档案 + 信用 + 管理员复核
// 契约见 SPEC.md §6 user。
// TODO(上线前)：把作者 openid 填进 ADMIN_OPENIDS（在开发者工具里用 getOpenId 云函数或 console 查一次即可）。
const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const CREDIT_CAP = 120;
const ADMIN_OPENIDS = ["oDhfnxajsWOYp-ak-V7Vmnm953q0"]; // 内测期作者本人；填入后才有 代发种子局/复核 权限

const ok = (data) => ({ ok: true, data });
const fail = (err, msg) => ({ ok: false, err, msg });

const isAdmin = (openid) => ADMIN_OPENIDS.includes(openid);

// 随机默认昵称：保证每个用户至少"默认名不同"（注册时可再改名）
const randNick = () => `拼友${Math.floor(1000 + Math.random() * 9000)}`;

async function ensureUser(openid) {
  const res = await db.collection("users").where({ openid }).limit(1).get();
  if (res.data[0]) return res.data[0];
  const now = Date.now();
  const data = {
    openid,
    nickName: randNick(),
    avatarUrl: "",
    gender: "",
    genderLocked: "",
    genderFakeCount: 0,
    phoneVerified: false,
    registered: false, // 游客可浏览；注册（填昵称）后才能参与拼车
    credit: 100,
    bannedUntil: 0,
    createdAt: now,
    updatedAt: now,
  };
  const add = await db.collection("users").add({ data });
  return { _id: add._id, ...data };
}

async function applyCreditDelta(openid, delta) {
  const u = await ensureUser(openid);
  const next = Math.max(0, Math.min(CREDIT_CAP, u.credit + delta));
  const patch = { credit: next, updatedAt: Date.now() };
  if (next < 60) patch.bannedUntil = Date.now() + 7 * 24 * 3600 * 1000;
  await db.collection("users").where({ openid }).update({ data: patch });
  return next;
}

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
    // 按上报类型定扣分：性别不实/缺勤 −20、迟到 −10、爽约 −20、其它 0
    const DELTA = { gender_fake: -20, absence: -20, lateness: -10, no_show: -20 };
    const delta = Object.prototype.hasOwnProperty.call(DELTA, report.kind) ? DELTA[report.kind] : -20;
    if (report.kind === "gender_fake") {
      // 与 rides 联名自动坐实同一套分级：累计坐实 ≥2 次 → 反推为另一性别并锁定；否则清空可重填。
      // ⚠ 同套分级逻辑在 cloudfunctions/rides/social.js 的 complaint（联名自动坐实），改动必须两处同步。
      const t = await ensureUser(report.targetOpenid);
      const g = t.gender || "";
      if (!t.genderLocked && g) {
        const nextCount = (t.genderFakeCount || 0) + 1;
        const upd = { genderFakeCount: nextCount, updatedAt: Date.now() };
        if (nextCount >= 2) {
          upd.gender = g === "male" ? "female" : "male";
          upd.genderLocked = upd.gender;
        } else {
          upd.gender = "";
        }
        await db.collection("users").where({ openid: report.targetOpenid }).update({ data: upd });
      }
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

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return fail("NO_AUTH", "无法识别用户");
  try {
    switch (event.action) {
      case "login":
        return await login(event, OPENID);
      case "me":
        return await me(OPENID);
      case "register":
        return await register(event, OPENID);
      case "adminPending":
        return await adminPending(OPENID);
      case "resolveReport":
        return await resolveReport(event, OPENID);
      case "banUser":
        return await banUser(event, OPENID);
      case "adminSetGender":
        return await adminSetGender(event, OPENID);
      default:
        return fail("NO_ACTION", "未知 action");
    }
  } catch (e) {
    console.error("[user]", e);
    return fail("EXCEPTION", "服务开小差了，请重试");
  }
};
