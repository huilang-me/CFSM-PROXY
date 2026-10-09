# CFSM Proxy（Workers 反向代理 · Cloudflare Pages）

用 **Cloudflare Pages** 部署的一个反向代理，把 Pages 域名作为统一入口，透明反代到 [CF Server Monitor](https://github.com/huilang-me/CF-Server-Monitor) 的 Workers 源站（https 接口 + wss WebSocket 全部转发）。

## 为什么需要它

CF-Server-Monitor 后端通过 Cloudflare Workers 部署，默认域名 `*.workers.dev` 在国内访问不稳定，而给 Worker 绑定自定义域名又要求该域名已托管在 Cloudflare。本项目用 Pages 做一层反代，你只需访问 Pages 域名即可，接口与实时推送都能正常工作。并且相比 Workers，**Pages 可以自由绑定你自己的自定义域名**（见下方“绑定自定义域名”），方便用一个稳定、可控的域名作为访问入口。

## 部署

1. Fork 本项目 [CF-Server-Monitor](https://github.com/huilang-me/CF-Server-Monitor) 到你自己的 GitHub 账号。
2. 打开 [新建 Pages](https://dash.cloudflare.com/?to=/:account/workers-and-pages/create/pages) → **导入现有 Git 存储库**，选择你 fork 的仓库。
3. 构建配置：框架预设 选 `无`，构建命令 留空，**构建输出目录 填 `public`**。
4. 点击展开 **环境变量（高级）** 添加 变量名称 `UPSTREAM_ORIGIN`，值填 `https://cf-server-monitor.your-sub.workers.dev` Workers 源站地址（只填 origin，不含路径） 点击 **保存并部署**。

<img width="992" height="754" alt="image" src="https://github.com/user-attachments/assets/4a4e79da-91ad-419d-a4a8-f46c9b19b57e" />

## 使用

部署后得到 `https://<project>.pages.dev`，直接用浏览器打开即是监控面板。前端全部经这一个域名访问（首页、`/api/*`、`/assets/*`、`/#/admin`、Agent 上报 `/update`、实时推送 `/api/ws` 都会被反代到源站），**同源模式下无需配置 CORS，Workers 端无需额外改动（除非开启了 Turnstile，见下）**。

> 只需保证 Workers 源站的 `API_BASE` 留空（前端会自动使用当前 Pages 域名作为同源接口地址）；切勿把它填成 `workers.dev` 地址，否则浏览器会绕过反代直连源站。

### 绑定自定义域名

Pages 支持自由绑定自定义域名（相比 Workers 更宽松）：

1. 进入你的 Pages 项目 → **Settings → Domains & Routes（域名和路由）** → **Set up a custom domain**。
2. 输入想绑定的域名（如 `cfsm.example.com`），按提示为它添加 **CNAME**（以及验证用的 **TXT**）记录。
3. 等待状态变为 Active（Cloudflare 会自动签发 TLS 证书），之后用该域名访问即可（与 `pages.dev` 并存）。

> 绑定后，`UPSTREAM_ORIGIN` 无需改动；若开启了 Turnstile，记得把这个新域名也加入 widget 的 Hostnames 白名单（见下）。

### 免费额度

反代后每个请求会变成两跳函数调用：**Pages Functions 一次 + 回源 Workers 一次**（直连时只有 Workers 一次）。因此 Workers / Pages 的每日免费请求额度会**约 ×2 消耗**、更快用尽。请求量大时建议：给高频静态资源依赖边缘缓存命中（`/assets/*`），或升级 Workers Standard。

### 开启 Turnstile 时

若源站开启了 Turnstile 验证，前端会在 Pages 域名上渲染验证组件，而 `siteverify` 校验的是 widget 配置的主机名白名单。需到 **Cloudflare Dashboard → Turnstile → 对应站点组件（Widgets）→ 编辑 → Hostnames**，把 Pages 域名（如 `<project>.pages.dev`，以及你绑定的自定义域名）加入白名单，否则验证不通过、API 会被 403 拦截。
