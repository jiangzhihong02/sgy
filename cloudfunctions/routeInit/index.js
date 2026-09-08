// cloudfunctions/routeInit —— 一次性初始化：建集合 + 写入一期线路目录
// 契约见 SPEC.md §1 routes / §6 routeInit。幂等，可重复调用。
const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const COLLECTIONS = ["users", "routes", "rides", "messages", "reports", "invites", "blocks", "feedbacks"];

// 一期 7 条线路（见 docs/DESIGN.md「线路目录」，均为香港侧上车/下车）
// 命名约定：口岸保留"的士站"；大埔墟本身就是"站"，不加"的士站"。
const ROUTES = [
  { routeId: "in-liantang", directionId: "in", from: "莲塘口岸（香园围）的士站", to: "香港教育大学" },
  { routeId: "in-futian", directionId: "in", from: "福田口岸（落马洲）的士站", to: "香港教育大学" },
  { routeId: "in-szbay", directionId: "in", from: "深圳湾口岸的士站", to: "香港教育大学" },
  { routeId: "in-taimarket", directionId: "in", from: "大埔墟站（东铁线）", to: "香港教育大学" },
  { routeId: "out-liantang", directionId: "out", from: "香港教育大学", to: "莲塘口岸（香园围）香港侧" },
  { routeId: "out-futian", directionId: "out", from: "香港教育大学", to: "福田口岸（落马洲）香港侧" },
  { routeId: "out-szbay", directionId: "out", from: "香港教育大学", to: "深圳湾口岸香港侧" },
];

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
