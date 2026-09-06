// chat.js —— 局内聊天：发消息（文本 / 图片 base64）
const { MSG_MAX, MSG_IMG_MAX } = require("./rules");
const { db, ok, fail, ensureUser, ensureRegistered, getMember, getRide } = require("./db");

async function sendMessage(event, openid) {
  const ride = await getRide(event.rideId);
  if (!ride) return fail("NOT_FOUND", "这一局不存在或已被删除");
  if (!getMember(ride, openid)) return fail("NOT_IN", "只有成员能在局内发言");
  const needReg = await ensureRegistered(openid);
  if (needReg) return needReg;
  const isImage = event.type === "image";
  const text = String(event.text || "").trim();
  if (!text) return fail("EMPTY", "内容为空");
  if (isImage) {
    // 图片走 base64 存消息，不用云存储（免存储流量/权限）
    if (text.length > MSG_IMG_MAX) return fail("TOO_BIG", "图片太大，请换张更小的（建议 ≤100KB）");
    const cnt = await db.collection("messages").where({ rideId: ride._id, openid, type: "image" }).count();
    if (cnt.total >= 1) return fail("IMG_LIMIT", "每人每局最多发 1 张图（建议发群二维码，队友长按保存后扫码加群）");
  }
  const user = await ensureUser(openid);
  await db.collection("messages").add({
    data: {
      rideId: ride._id,
      openid,
      name: user.nickName || "拼友",
      text: isImage ? text : text.slice(0, MSG_MAX),
      type: isImage ? "image" : "text",
      createdAt: Date.now(),
    },
  });
  return ok({ sent: true });
}

module.exports = { sendMessage };
