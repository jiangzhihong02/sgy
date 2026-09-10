// cloudfunctions/routeInit —— 一次性初始化：建集合 + 写入一期线路目录
// 契约见 SPEC.md §1 routes / §6 routeInit。幂等，可重复调用。
const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const { ROUTES } = require("./catalog"); // 一期 7 条线路（纯数据；与客户端快照的一致性由 tests/contract.spec.js 守）

// 一期 7 个集合（messages 于 2026-09-10 随站内聊天下线，见 ADR-0017，不再新建）
const COLLECTIONS = ["users", "routes", "rides", "reports", "invites", "blocks", "feedbacks"];

async function ensureCollection(name) {
  try {
    await db.createCollection(name);
    return "created";
  } catch (e) {
    return "exists"; // 已存在：幂等成功
  }
}

exports.main = async () => {
  const collections = {};
  for (const c of COLLECTIONS) {
    collections[c] = await ensureCollection(c);
  }

  let routesAdded = 0;
  let routesUpdated = 0;
  for (const r of ROUTES) {
    const hit = await db.collection("routes").where({ routeId: r.routeId }).count();
    if (hit.total === 0) {
      await db.collection("routes").add({
        data: { ...r, enabled: true, createdAt: Date.now() },
      });
      routesAdded += 1;
    } else {
      // upsert：线路改名后重跑可覆盖旧显示名，保证与前端一致
      await db.collection("routes").where({ routeId: r.routeId }).update({
        data: { from: r.from, to: r.to, directionId: r.directionId, enabled: true, updatedAt: Date.now() },
      });
      routesUpdated += 1;
    }
  }

  return { ok: true, data: { collections, routesAdded, routesUpdated } };
};
