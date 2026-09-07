// sweep.js —— __sweep：扫一批到期局，交给 db.advanceStatus 推进。
// 与"读时自愈"（getRide/advanceMany）共用同一套推进逻辑，定时器与读取不会再打架。
const { T_POLL_ASK } = require("./rules");
const { db, _, advanceStatus } = require("./db");

async function sweepOne(ride) {
  const { changed } = await advanceStatus(ride);
  return changed ? 1 : 0;
}

/** 扫一批到期推进（rideSweep 每分钟触发 __sweep 调用本函数；定时器不可用时读取也会自愈）。 */
async function run(event) {
  const now = Date.now();
  const res = await db
    .collection("rides")
    .where({ status: _.in(["recruiting", "locked", "ongoing"]), boardAt: _.lte(now + T_POLL_ASK) })
    .limit(100)
    .get();
  let changed = 0;
  for (const ride of res.data) {
    changed += await sweepOne(ride);
  }
  return { scanned: res.data.length, changed };
}

module.exports = { run };
