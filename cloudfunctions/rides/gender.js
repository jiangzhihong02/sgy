// gender.js —— 性别不实分级纠错的唯一实现
// social.js（联名自动坐实）与 account.js（管理员坐实）共用，杜绝两份梯子再次分叉。
// 规则（见 CONTEXT「性别」/ ADR-0010 #11）：
//   L1 = 清空 gender（可重填）
//   L2 = 单局 ≥3 名不同成员同报，或该用户累计坐实 ≥2 次 → 反推为另一性别并锁 genderLocked（仅 adminSetGender 可解）
const { db, findUser } = require("./db");

/**
 * 对 targetOpenid 应用一次"性别不实坐实"的分级纠错。调用方须已确认坐实。
 * @param {string} targetOpenid 被坐实的成员
 * @param {number} sameRideReporters 本局同报性别不实的不同成员数（管理员单人复核坐实时传 1）
 * @returns {Promise<string>} genderAction: 'switched'(L2 反推并锁定) | 'cleared'(L1 清空) | 'locked'(已锁定不再动) | 'noop'(本就没填性别，只走扣信用)
 */
async function applyGenderFake(targetOpenid, sameRideReporters) {
  const u = await findUser(targetOpenid);
  if (!u) return "noop";
  const g = u.gender || "";
  if (u.genderLocked) return "locked"; // 已锁定：不再改（信用照扣由调用方处理）
  if (!g) return "noop"; // 本就没填：不动 gender
  const nextCount = (u.genderFakeCount || 0) + 1;
  const escalate = sameRideReporters >= 3 || nextCount >= 2;
  const data = { genderFakeCount: nextCount, updatedAt: Date.now() };
  if (escalate) {
    data.gender = g === "male" ? "female" : "male"; // 反推为正确性别
    data.genderLocked = data.gender; // 锁死，仅管理员可解
  } else {
    data.gender = ""; // L1：清空、可重填
  }
  await db.collection("users").where({ openid: targetOpenid }).update({ data });
  return escalate ? "switched" : "cleared";
}

module.exports = { applyGenderFake };
