// sgy/utils/routes.js —— 线路目录加载
// 单一来源：云数据库 routes（rides.routes 下发，管理员可增改/停用）。
// 本地 domain.ROUTES 仅为离线快照兜底：拉取失败或尚未拉到时用快照，保证发局/筛选不空。
const api = require("./api");
const { ROUTES } = require("./domain");

const snapshot = () => ROUTES.map((r) => ({ routeId: r.id, directionId: r.directionId, from: r.from, to: r.to }));

let cache = null; // null = 尚未成功拉到 DB（用快照兜底）

/** 当前生效的线路列表（同步；进程内 DB 未加载前返回快照）。 */
function get() {
  return cache || snapshot();
}

/** 按方向取线路（返校 in / 离校 out）；发局页与找局筛选共用，避免各处重复 filter。 */
function byDirection(dir) {
  return get().filter((r) => r.directionId === dir);
}

/** 是否已从云端拉到线路目录（已拉到才需要重建下拉，避免每页每次都重建）。 */
function isLoaded() {
  return !!cache;
}

/** 拉取一次并缓存；失败或空则退回快照。返回当前生效列表。 */
function load() {
  if (cache) return Promise.resolve(cache);
  return api
    .call("routes")
    .then((res) => {
      if (res.ok && (res.data.routes || []).length) {
        cache = (res.data.routes || [])
          .filter((r) => r.enabled !== false)
          .map((r) => ({ routeId: r.routeId, directionId: r.directionId, from: r.from, to: r.to }));
      }
      return cache || snapshot();
    })
    .catch(() => snapshot());
}

module.exports = { get, byDirection, isLoaded, load };
