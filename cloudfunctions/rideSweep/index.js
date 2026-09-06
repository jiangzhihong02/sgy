// cloudfunctions/rideSweep —— 状态机定时推进（每分钟触发器；也可手动调用 event.force=true）
// 契约见 SPEC.md §3/§4/§5。不依赖用户 openid。
const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const T_JOIN_CLOSE = 10 * 60 * 1000;
const T_POLL_ASK = 60 * 60 * 1000;
const T_POLL_DUE = 45 * 60 * 1000;
const T_CHECKIN_GRACE = 10 * 60 * 1000;
const T_SETTLE = 60 * 60 * 1000; // 预订时间后 1 小时关闭并结算（此前为 2 小时）
const CREDIT_CAP = 120;

async function ensureUser(openid) {
  const res = await db.collection("users").where({ openid }).limit(1).get();
  if (res.data[0]) return res.data[0];
  const now = Date.now();
  const data = {
    openid, nickName: "通勤者", avatarUrl: "", gender: "", phoneVerified: false,
    credit: 100, bannedUntil: 0, createdAt: now, updatedAt: now,
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
          patch = {
            poll: {
              active: true, status: "pending", askedAt: now,
              dueAt: ride.boardAt - T_POLL_DUE, responses: [],
            },
            updatedAt: now,
          };
        }
      } else if (ride.poll.active && now >= ride.poll.dueAt) {
        // 到期：未回复默认接受；显式"否"者在应答时已免费退出（rides.respondPoll）
        patch = {
          poll: { ...ride.poll, active: false, status: "accepted", responses: ride.poll.responses || [] },
          updatedAt: now,
        };
      }
    }
  } else if (ride.status === "locked" && now >= ride.boardAt) {
    patch = { status: "ongoing", updatedAt: now };
  } else if (ride.status === "ongoing" && now >= ride.boardAt + T_SETTLE) {
    // 结算：到点签到者 +1；仍在局内且未签到者记爽约 −20
    const noShows = [];
    for (const m of ride.members || []) {
      if (m.checkedInAt && m.checkedInAt > 0) {
        await applyCreditDelta(m.openid, 1);
      } else if (now <= ride.boardAt + T_CHECKIN_GRACE || m.joinedAt) {
        // 仍未签到且没退出 → 爽约
        await applyCreditDelta(m.openid, -20);
        noShows.push(m.openid);
      }
    }
    patch = { status: "done", settled: true, noShowConfirmed: ride.noShowConfirmed.concat(noShows), updatedAt: now };
  }

  if (patch) {
    await db.collection("rides").doc(ride._id).update({ data: patch });
    return 1;
  }
  return 0;
}

exports.main = async (event = {}) => {
  try {
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
    return { ok: true, data: { scanned: res.data.length, changed } };
  } catch (e) {
    console.error("[rideSweep]", e);
    return { ok: false, err: "EXCEPTION", msg: e.message };
  }
};
