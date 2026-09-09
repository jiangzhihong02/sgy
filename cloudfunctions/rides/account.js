// account.js —— 用户档案（login / me / register / 校内身份自报）
// 原独立云函数 cloudfunctions/user 已并入本可部署单元（入口见 index.js）。
// 管理员动作（复核/封禁/性别纠错/校内身份管理）已迁往 admin.js——"管理员"子域一个模块一个家。
// ensureUser/applyCreditDelta/randNick/KIND_DELTA/ADMIN_OPENIDS 全部复用 db.js/rules.js，不再自带副本。
// 契约见 SPEC.md §6。
const { db, ok, fail, ensureUser, ensureRegistered, isAdmin } = require("./db");
const { checkText } = require("./safe"); // 内容安全：昵称/姓名入库前拦截违规

const SCHOOL_FIXED = "香港教育大学"; // 一期仅教大
const RE_STUDENT_ID = /^s\d{7}$/i; // 学号固定格式：小写 s + 7 位纯数字
const ID_NAME_MAX = 30;
const ID_MAJOR_MAX = 40;

const publicUser = (u) => ({
  openid: u.openid,
  nickName: u.nickName,
  avatarUrl: u.avatarUrl,
  gender: u.gender,
  genderLocked: u.genderLocked || "", // ""=未锁；male/female=已核实锁定的性别（不可自改）
  genderFakeCount: u.genderFakeCount || 0,
  schoolId: u.schoolId || null, // 校内身份（仅自己可见明文；他人只见 memberInfo.schoolVerified 绿标）
  phoneVerified: u.phoneVerified,
  registered: !!u.registered,
  credit: u.credit,
  bannedUntil: u.bannedUntil || 0,
});

async function login(event, openid) {
  const u = await ensureUser(openid);
  const patch = { updatedAt: Date.now() };
  if (typeof event.nickName === "string" && event.nickName.trim()) {
    const nickSafe = await checkText(event.nickName.trim());
    if (!nickSafe.safe) return fail("UNSAFE_CONTENT", "昵称含违规或不当内容，请换一个");
    patch.nickName = event.nickName.trim().slice(0, 20);
  }
  if (typeof event.avatarUrl === "string") patch.avatarUrl = event.avatarUrl;
  if (["female", "male"].includes(event.gender) && !u.genderLocked) patch.gender = event.gender; // 自报；锁定性别不可改
  if (Object.keys(patch).length > 1) {
    await db.collection("users").where({ openid }).update({ data: patch });
    Object.assign(u, patch);
  }
  return ok({ user: publicUser(u), isAdmin: isAdmin(openid) });
}

async function me(event, openid) {
  // 签名与 index.js 的 handler(event, OPENID) 统一：只认 openid，忽略 event。
  const u = await ensureUser(openid);
  return ok({ user: publicUser(u), isAdmin: isAdmin(openid) });
}

// 注册：填昵称（+可选性别）后成为"注册用户"，才可参与拼车
async function register(event, openid) {
  const u = await ensureUser(openid);
  const nick = String(event.nickName || "").trim().slice(0, 12);
  if (!nick) return fail("BAD_NICK", "请填写昵称");
  const nickSafe = await checkText(nick);
  if (!nickSafe.safe) return fail("UNSAFE_CONTENT", "昵称含违规或不当内容，请换一个");
  const patch = { nickName: nick, registered: true, updatedAt: Date.now() };
  // 性别自报；已被系统锁定的性别不可改（genderLocked 见分级纠错）
  if (["female", "male"].includes(event.gender) && !u.genderLocked) patch.gender = event.gender;
  await db.collection("users").where({ openid }).update({ data: patch });
  Object.assign(u, patch);
  return ok({ user: publicUser(u), isAdmin: isAdmin(openid) });
}

// —— 校内身份（自报，防逃跑威慑；对外只给绿标，明文仅管理员可见）——

// 注册用户自报/修改校内身份。学校一期固定教大；学号格式 s+7 位。
async function identitySave(event, openid) {
  const needReg = await ensureRegistered(openid);
  if (needReg) return needReg;
  const studentId = String(event.studentId || "").trim().toLowerCase();
  if (!RE_STUDENT_ID.test(studentId)) return fail("BAD_STUDENT_ID", "学号应为小写 s + 7 位数字（如 s1234567）");
  const name = String(event.name || "").trim().slice(0, ID_NAME_MAX);
  if (!name) return fail("BAD_NAME", "请填写真实姓名");
  const nameSafe = await checkText(name);
  if (!nameSafe.safe) return fail("UNSAFE_CONTENT", "姓名含违规或不当内容，请核对");
  const major = String(event.major || "").trim().slice(0, ID_MAJOR_MAX);
  const schoolId = { school: SCHOOL_FIXED, studentId, name, major, declaredAt: Date.now() };
  await db.collection("users").where({ openid }).update({ data: { schoolId, updatedAt: Date.now() } });
  return ok({ declared: true });
}

module.exports = { login, me, register, identitySave };
