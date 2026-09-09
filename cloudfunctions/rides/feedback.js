// feedback.js —— 用户反馈与建议（仅注册用户可提交；管理员列表/标记处理）
// 集合：feedbacks { openid, nickName(快照), kind, text, contact(选填), status, createdAt }。
const { db, ok, fail, ensureUser, ensureRegistered, isAdmin } = require("./db");
const { checkText } = require("./safe"); // 内容安全：反馈文字入库前拦截违规

const KIND_LABEL = { suggestion: "建议", bug: "问题/Bug", other: "其它" };
const FB_TEXT_MAX = 500;
const FB_CONTACT_MAX = 60;

async function submit(event, openid) {
  const needReg = await ensureRegistered(openid); // 仅注册用户；游客引导去注册
  if (needReg) return needReg;
  const kind = Object.prototype.hasOwnProperty.call(KIND_LABEL, event.kind) ? event.kind : "other";
  const text = String(event.text || "").trim().slice(0, FB_TEXT_MAX);
  if (!text) return fail("EMPTY", "请写下你的反馈");
  const textSafe = await checkText(text);
  if (!textSafe.safe) return fail("UNSAFE_CONTENT", "反馈含违规或不当内容，请修改后再提交");
  const u = await ensureUser(openid);
  await db.collection("feedbacks").add({
    data: {
      openid,
      nickName: u.nickName || "拼友",
      kind,
      text: text.slice(0, FB_TEXT_MAX),
      contact: String(event.contact || "").trim().slice(0, FB_CONTACT_MAX),
      status: "pending",
      createdAt: Date.now(),
    },
  });
  return ok({ sent: true });
}

async function adminList(event, openid) {
  if (!isAdmin(openid)) return fail("NO_ADMIN", "无管理员权限");
  const res = await db.collection("feedbacks").orderBy("createdAt", "desc").limit(100).get();
  return ok({
    list: (res.data || []).map((f) => ({
      _id: f._id,
      nickName: f.nickName,
      kind: f.kind,
      kindLabel: KIND_LABEL[f.kind] || f.kind || "其它",
      text: f.text,
      contact: f.contact || "",
      status: f.status,
      createdAt: f.createdAt,
    })),
  });
}

async function markHandled(event, openid) {
  if (!isAdmin(openid)) return fail("NO_ADMIN", "无管理员权限");
  const id = String(event.id || "");
  if (!id) return fail("BAD_ID", "缺少 id");
  const handled = event.handled !== false;
  await db.collection("feedbacks").doc(id).update({
    data: { status: handled ? "handled" : "pending", handledAt: handled ? Date.now() : 0 },
  });
  return ok({ status: handled ? "handled" : "pending" });
}

module.exports = { submit, adminList, markHandled };
