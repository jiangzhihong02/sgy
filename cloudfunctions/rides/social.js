// social.js —— 局内成员间动作：查看资料 / 标记不与其乘车 / 举报（性别不实·迟到·缺勤）
const { KIND_DELTA } = require("./rules");
const { db, ok, fail, findUser, applyCreditDelta, getMember, getRide } = require("./db");
const { applyGenderFake } = require("./gender");

const COMPLAINT_KINDS = ["gender_fake", "lateness", "absence"];

async function memberInfo(event, openid) {
  const ride = await getRide(event.rideId);
  if (!ride) return fail("NOT_FOUND", "这一局不存在或已被删除");
  if (!getMember(ride, openid)) return fail("NOT_IN", "只有同局成员能查看");
  const target = ride.members.find((m) => m.openid === event.targetOpenid);
  if (!target) return fail("BAD_TARGET", "对象不在这一局");
  const u = await findUser(event.targetOpenid);
  const blk = await db.collection("blocks").where({ byOpenid: openid, targetOpenid: event.targetOpenid }).count();
  return ok({
    member: {
      openid: target.openid,
      name: target.name,
      gender: target.gender || "",
      credit: u ? u.credit : 100,
      blocked: blk.total > 0,
      schoolVerified: !!(u && u.schoolId), // 仅"已登记"绿标，不下发明文（见 CONTEXT 校内身份）
    },
  });
}

async function setBlock(event, openid) {
  const ride = await getRide(event.rideId);
  if (!ride) return fail("NOT_FOUND", "这一局不存在或已被删除");
  if (!getMember(ride, openid)) return fail("NOT_IN", "只有同局成员能标记");
  if (event.targetOpenid === openid) return fail("BAD_TARGET", "不能标记自己");
  if (!ride.memberOpenids.includes(event.targetOpenid)) return fail("BAD_TARGET", "对象不在这一局");
  const now = Date.now();
  const want = !!event.block;
  const existing = await db.collection("blocks").where({ byOpenid: openid, targetOpenid: event.targetOpenid }).get();
  if (want && existing.data.length === 0) {
    await db.collection("blocks").add({ data: { byOpenid: openid, targetOpenid: event.targetOpenid, createdAt: now } });
  } else if (!want && existing.data.length > 0) {
    await db.collection("blocks").doc(existing.data[0]._id).remove();
  }
  return ok({ blocked: want });
}

async function complaint(event, openid) {
  const ride = await getRide(event.rideId);
  if (!ride) return fail("NOT_FOUND", "这一局不存在或已被删除");
  if (!getMember(ride, openid)) return fail("NOT_IN", "只有同局成员能举报");
  if (event.targetOpenid === openid) return fail("BAD_TARGET", "不能举报自己");
  if (!ride.memberOpenids.includes(event.targetOpenid)) return fail("BAD_TARGET", "对象不在这一局");
  if (!COMPLAINT_KINDS.includes(event.kind)) return fail("BAD_KIND", "举报类型无效");
  // 迟到/缺勤只在拼车结束后可举报；性别不实随时可报
  if (event.kind !== "gender_fake" && ride.status !== "done") return fail("NOT_DONE", "拼车结束（已完成）后才能举报迟到/缺勤");

  const now = Date.now();
  const exRes = await db.collection("reports").where({ rideId: ride._id, targetOpenid: event.targetOpenid, status: "pending" }).get();
  const existing = exRes.data || [];

  // 同一人同一对象同一类只能一次；同对象可被不同成员"联名"
  if (existing.some((x) => x.byOpenid === openid && x.kind === event.kind)) return fail("DUP", "你已对该成员提交过同类举报");

  await db.collection("reports").add({
    data: {
      rideId: ride._id,
      byOpenid: openid,
      targetOpenid: event.targetOpenid,
      kind: event.kind,
      note: event.note || "",
      status: "pending",
      creditDelta: 0,
      createdAt: now,
      resolvedAt: 0,
    },
  });

  // 联名坐实：同一局内 ≥2 名不同成员举报同一人 → 自动坐实并扣分一次。
  // 性别不实的分级（L1 清空 / L2 反推锁定）收敛在 gender.js，管理员坐实路径（account.resolveReport）共用。
  const after = await db.collection("reports").where({ rideId: ride._id, targetOpenid: event.targetOpenid, status: "pending" }).get();
  const list = after.data || [];
  const reporters = new Set(list.map((x) => x.byOpenid));
  if (reporters.size >= 2) {
    const worst = Math.min(...list.map((x) => KIND_DELTA[x.kind] || 0));
    const gf = list.filter((x) => x.kind === "gender_fake");
    let genderAction = "none";
    if (gf.length) {
      const gfReporters = new Set(gf.map((x) => x.byOpenid));
      genderAction = await applyGenderFake(event.targetOpenid, gfReporters.size);
    }
    const credit = await applyCreditDelta(event.targetOpenid, worst);
    for (const rep of list) {
      await db.collection("reports").doc(rep._id).update({ data: { status: "upheld", creditDelta: worst, resolvedAt: Date.now() } });
    }
    return ok({ reported: true, auto: true, targetCredit: credit, genderAction });
  }
  return ok({ reported: true, auto: false });
}

module.exports = { memberInfo, setBlock, complaint };
