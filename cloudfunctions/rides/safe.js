// safe.js —— 内容安全检测（文本；微信云调用 security.msgSecCheck）
// 覆盖面 = 所有"用户可写、他人可读"的文本：局内聊天文字、自定义上车/下车点、备注、昵称、
// 校内身份姓名、反馈。入库前各调用点先过 checkText，命中违规（87014 / suggest=risky）直接拦截不入库。
//
// ⚠ 范围（如实，别越界宣称）：
//   * 图片**未**接机器检测——个人主体经云调用不支持 imgSecCheck（在 config.json 声明该权限 DevTools 上传即
//     报 ResourceInUse，2026-09-09 实证）；mediaCheckAsync 需公开 mediaUrl + 异步回调域名，与本工具
//     "图片 base64 直存、不落云存储"的架构冲突。聊天图靠：仅同局成员可见 + 每人每局限 1 张 +
//     建议用途(群二维码) + 成员举报/管理员复核兜底（见 docs/ugc-security-statement.md）。
//   * 文本 msgSecCheck 需在 config.json permissions.openapi 声明 ["security.msgSecCheck"]；
//     重传云函数后权限约 10 分钟缓存生效。对外宣称"已接入内容安全"前先跑 admin.secProbe 确认 errCode 0。
// ⚠ 降级：msgSecCheck 自身不可用（-604101 权限未生效 / 网络 / 超频）→ 放行 + console.error 记一条，
//   不因安全服务故障拖垮正常组局。
const { cloud } = require("./db");

/** 判读一次正常返回：errCode 87014 / suggest=risky → 违规拦截；errCode 非 0（权限/超频等）→ 降级放行并记一条；0 → 放行。 */
function classify(res) {
  if (res && res.result && res.result.suggest === "risky") return { safe: false, degraded: false };
  const code = res && (res.errCode != null ? res.errCode : res.errcode);
  if (code === 87014) return { safe: false, degraded: false };
  if (code != null && code !== 0) {
    console.error("[safe-degraded] 内容安全接口异常 code=", code, res && (res.errMsg || res.message), "→ 本次放行");
    return { safe: true, degraded: true };
  }
  return { safe: true, degraded: false };
}

/** 判读抛出的错误：87014 违规拦截；其他（权限/网络/超频…）→ 降级放行并记一条。 */
function classifyErr(e) {
  const code = e && (e.errCode != null ? e.errCode : e.errcode);
  if (code === 87014) return { safe: false, degraded: false };
  console.error("[safe-degraded] 内容安全接口不可用 code=", code, e && (e.errMsg || e.message), "→ 本次放行");
  return { safe: true, degraded: true };
}

/** 文本检测（msgSecCheck）。空串跳过。 */
async function checkText(content) {
  const text = String(content || "").trim();
  if (!text) return { safe: true, degraded: false };
  try {
    return classify(await cloud.openapi.security.msgSecCheck({ content: text }));
  } catch (e) {
    return classifyErr(e);
  }
}

module.exports = { checkText };
