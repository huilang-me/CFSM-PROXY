// 匹配其余所有路径（catchall）。Cloudflare Pages 语法：两方括号 = 多段通配。
// 实际反代逻辑与根路径共用 ../src/proxy.js，保持单一实现。
export { onRequest } from "../src/proxy.js";
