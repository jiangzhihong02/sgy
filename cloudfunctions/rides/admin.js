// admin.js —— 管理员联调辅助（造已完成局）。正式后台复核在 user 云函数 adminPending/resolveReport。
// ADMIN_OPENIDS 与 cloudfunctions/user/index.js 保持一致。
const { db, _, ok, fail, ensureUser } = require("./db");

const ADMIN_OPENIDS = ["oDhfnxajsWOYp-ak-V7Vmnm953q0"];

// 联调辅助：管理员为给定 openid 们创建一条"已完成"的共享拼车局（含示例消息），用于测试历史/举报/再约
async function adminSeedDone(event, openid) {
  if (!ADMIN_OPENIDS.includes(openid)) return fail("NO_ADMIN", "无管理员权限");
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
  if (!ADMIN_OPENIDS.includes(openid)) return fail("NO_ADMIN", "无管理员权限");
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

module.exports = { adminSeedDone, adminReset };
