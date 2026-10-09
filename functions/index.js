// 匹配根路径 `/`（CF-Server-Monitor 面板入口）。
// Cloudflare Pages 语法：functions/index.js -> /；顶层 catchall 不一定命中裸 `/`，
// 因此单独提供本文件，确保首页请求也被反代到 Workers 源站。
export { onRequest } from "../src/proxy.js";
