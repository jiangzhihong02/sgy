// cloudfunctions/routeInit/catalog.js —— 一期线路目录（纯数据，不 require wx-server-sdk）
// 单独成文件的目的：让 node 能同时 require 它和客户端的离线快照 sgy/utils/domain.js 的 ROUTES，
// 由 tests/contract.spec.js 断言两侧一致——两个部署单元无法共享代码，只能靠这道一致性检查防漂移。
// 命名约定：口岸集合点保留"的士站"（见 ADR-0002）；大埔墟本身就是"站"，不再加"的士站"。
const ROUTES = [
  { routeId: "in-liantang", directionId: "in", from: "莲塘口岸（香园围）的士站", to: "香港教育大学" },
  { routeId: "in-futian", directionId: "in", from: "福田口岸（落马洲）的士站", to: "香港教育大学" },
  { routeId: "in-szbay", directionId: "in", from: "深圳湾口岸的士站", to: "香港教育大学" },
  { routeId: "in-taimarket", directionId: "in", from: "大埔墟站（东铁线）", to: "香港教育大学" },
  { routeId: "out-liantang", directionId: "out", from: "香港教育大学", to: "莲塘口岸（香园围）香港侧" },
  { routeId: "out-futian", directionId: "out", from: "香港教育大学", to: "福田口岸（落马洲）香港侧" },
  { routeId: "out-szbay", directionId: "out", from: "香港教育大学", to: "深圳湾口岸香港侧" },
];

module.exports = { ROUTES };
