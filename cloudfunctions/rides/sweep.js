// sweep.js —— 状态机定时推进（每分发到 __sweep）。规则数值全部来自 rules.js。
const { T_JOIN_CLOSE, T_POLL_ASK, T_POLL_DUE, T_CHECKIN_GRACE, T_SETTLE, CREDIT_LEAVE_NO_SHOW, CREDIT_RIDE_OK } = require("./rules");
const { db, _, applyCreditDelta } = require("./db");

async function sweepOne(ride) {
  const now = Date.now();
  let patch = null;

  if (ride.status === "recruiting") {
    if (now >= ride.boardAt - T_JOIN_CLOSE) {
      // T−10 关局
      const toStatus = ride.memberCount >= 2 ? "locked" : "failed";
      patch = { status: toStatus, updatedAt: now, poll: null };
    } else if (ride.memberCount < ride.capacity) {
      if (!ride.poll || !ride.poll.active) {
        if (now >= ride.boardAt - T_POLL_ASK && now < ride.boardAt - T_POLL_DUE) {
          // T−60~T−45：发起人数轮询
          patch = { poll: { active: true, status: "pending", askedAt: now, dueAt: ride.boardAt - T_POLL_DUE, responses: [] }, updatedAt: now };
        }
      } else if (ride.poll.active && now >= ride.poll.dueAt) {
        // 到期：未回复默认接受；显式"否"者在应答时已免费退出（respondPoll）
        patch = { poll: { ...ride.poll, active: false, status: "accepted", responses: ride.poll.responses || [] }, updatedAt: now };
      }
    }
  } else if (ride.status === "locked" && now >= ride.boardAt) {
    patch = { status: "ongoing", updatedAt: now };
  } else if (ride.status === "ongoing" && now >= ride.boardAt + T_SETTLE) {
    // 结算：到点签到者 +1；仍在局内且未签到者按爽约 −20（自动，无需人工）
    const noShows = [];
    for (const m of ride.members || []) {
      if (m.checkedInAt && m.checkedInAt > 0) {
        await applyCreditDelta(m.openid, CREDIT_RIDE_OK);
      } else if (now <= ride.boardAt + T_CHECKIN_GRACE || m.joinedAt) {
        await applyCreditDelta(m.openid, CREDIT_LEAVE_NO_SHOW);
        noShows.push(m.openid);
      }
    }
    patch = { status: "done", settled: true, noShowConfirmed: (ride.noShowConfirmed || []).concat(noShows), updatedAt: now };
  }

  if (patch) {
    await db.collection("rides").doc(ride._id).update({ data: patch });
    return 1;
  }
  return 0;
}

/** 扫一批到期推进（rideSweep 每分钟触发 __sweep 调用本函数）。 */
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
