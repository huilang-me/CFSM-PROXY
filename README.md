# CFSM Proxy（Workers 反向代理 · Cloudflare Pages）

这是一个用于 [CF Server Monitor](https://github.com/huilang-me/CF-Server-Monitor) 的**反向代理**项目，通过 **Cloudflare Pages** 部署。

## 为什么需要它

CF-Server-Monitor 后端是通过 **Cloudflare Workers** 部署的。Workers 的默认域名 `*.workers.dev` 在国内访问不稳定，而给 Worker 绑定自定义域名要求该域名**已托管在 Cloudflare**。

本项目用一个 Pages 项目作为入口，把**所有请求（https 接口 + wss WebSocket）透明反代**到你的 Workers 源站。这样你只需要访问这个 Pages 域名即可，接口与实时推送都能正常工作。

> Pages 与 Workers 一样运行在 Cloudflare 边缘，`functions/[[path]].js` 会匹配项目下的全部路径并转发到源站。

## 目录结构

```text
cfsm-proxy/
├── functions/
│   ├── index.js         # 匹配根路径 /（面板入口）
│   └── [[path]].js      # catchall：匹配其余所有路径（两方括号 = CF 多段通配语法）
├── src/
│   └── proxy.js         # 反代核心逻辑（https + wss），被上面两个路由共享引用
├── public/
│   └── _routes.json     # 将所有请求交给 Functions 处理
├── .env.example         # 环境变量示例
└── README.md
```

> 命名说明：Cloudflare Pages Functions 的「多段通配」用**两对方括号** `[[path]].js`（不是 Next.js 的 `[...path]`）。由于顶层 catchall 不一定命中裸 `/`，这里额外用 `functions/index.js` 兜底根路径，两者共享 `src/proxy.js`。

## 反代能力

- **HTTP(S)**：`/`、`/api/*`、`/assets/*`、`/admin/*`、`/theme`、`/updateDatabase`、`/clearHistory` 等全部原样转发。
- **WebSocket(wss)**：`GET /api/ws`、`GET /update` 的 101 升级响应直接透传，不重组响应体，保证实时指标广播与 Agent 上报可用。
- **Header 透传**：`Cookie`、`Authorization`、`Origin`、`X-Turnstile-Token/Verified`、`X-Agent-*` 等全部保留。
- **跳转重写**：`/admin/` 的 302 跳转会改写回当前 Pages 域名，不会泄露源站地址。
- **地区判断**：透传 `cf-ipcountry` / `X-Forwarded-For`，保证 Worker 侧运营商/地区归属准确。

## 环境变量

| 变量名 | 说明 | 示例 |
| --- | --- | --- |
| `UPSTREAM_ORIGIN` | Workers 源站地址（只填 origin，不含路径） | `https://cfs.your-sub.workers.dev` |
| `ASSET_CACHE_TTL` | 可选。主题静态资源 `/assets/*` 的 Pages 边缘缓存秒数，默认 `3600` | `3600` |

`UPSTREAM_ORIGIN` 支持两种填法：

1. Workers 默认域名：`https://<worker-name>.<account-subdomain>.workers.dev`
2. Worker 已绑定的自定义域名：`https://api.example.com`

## 部署（Cloudflare Dashboard）

1. 把本目录（`cfsm-proxy`）上传到你自己的 GitHub 仓库。
2. 登录 Cloudflare Dashboard → **Workers & Pages → Create → Pages → Connect to Git**，选择该仓库。
3. 构建配置：
   - **Framework preset**：`Other`
   - **Build command**：留空（无需构建）
   - **Build output directory**：`public`
4. 展开 **Environment variables**，添加 `UPSTREAM_ORIGIN`（值填你的 Workers 源站）。
5. 点击 **Save and Deploy**。
6. 部署完成后得到一个 `https://<project>.pages.dev` 地址，即可作为 CF-Server-Monitor 的访问入口。

## 前端全部通过本项目访问

目标：浏览器只访问 Pages 域名，**首页 / 静态资源 / API / WebSocket 全部经本站反代到 Workers**，不再直接碰 `workers.dev`。

本项目已经转发了全部路径（`/`、`/assets/*`、`/api/*`、`/admin/*`、`/api/ws`、`/update`），所以要做到「全部同源」，关键只在 **Workers 源站的 `API_BASE` 怎么填**：

- **推荐：`API_BASE` 留空（不设置）**。前端 SPA 在没有注入 `apiBase` meta 时会自动回退到 `window.location.origin`——也就是你用浏览器打开的 Pages 域名。此时 API 走 `https://<pages域名>/api/*`、WebSocket 走 `wss://<pages域名>/api/ws`，全部同源、全部经过反代。Workers 注入的 CSP `connect-src` 含 `'self'`，同源 fetch/wss 不会被拦截。
- 或者：把 Pages 域名显式填进源站 `API_BASE`，效果等价（同源）。**切勿**把 `API_BASE` 填成 `workers.dev` 源站地址——那样浏览器会绕过反代直连 `workers.dev`，失去本项目的意义。

用法：配置好后，直接用浏览器访问 `https://<你的-pages域名>` 即可打开面板（含 `/#/admin`），日常使用、Agent 上报（`/update`）、实时推送（`/api/ws`）都走这一个域名。

> 同源模式下（前端与 API 都是同一个 Pages 域名）**无需配置 CORS**。只有当你把前端单独部署到别的域名、再跨域调用本反代时，才需要在 Workers 源站的 `CORS_ALLOWED_ORIGINS` 里加入那个前端域名。

## 关于第三方主题的“两次反代”

原项目的 Workers 端本身就是一个 GitHub 反代：主题（`theme_url` 指向 GitHub 仓库）的 `index.html` 与 `/assets/*` 静态资源，由 Worker 去拉 `raw.githubusercontent.com` 再吐给浏览器（这么做是因为国内直连 GitHub raw 不稳定）。加上本 Pages 后，主题链路变成：

```text
浏览器 → Pages（本站）→ Workers（源站）→ GitHub raw
```

看起来多了一层，但其实开销很小、且已针对它做了优化：

- **Pages 与 Workers 同在 Cloudflare 边缘**，`Pages→Worker` 走 CF 内部网络，是一跳内网，成本极低；真正“贵”的只有 `Worker→GitHub` 这段，而这段已被 Worker 自身的 `caches.default` 缓存。
- **本站对 `/assets/*` 开了边缘缓存**（默认 `ASSET_CACHE_TTL=3600` 秒，见环境变量）。主题静态文件只在缓存过期/未命中时才回源一次，命中后浏览器直接从 Pages 边缘拿到，**不再触发两次反代**。API / WebSocket / admin 不缓存，保证实时。

因此推荐保持现状（Pages 透明反代 + 边缘缓存）。若你想进一步减少层级，可选：

1. **调大 `ASSET_CACHE_TTL`**：主题更新不频繁时设更大（如 `86400`），回源更少。
2. **源站改用公共 CDN 镜像 GitHub**（如 jsDelivr `cdn.jsdelivr.net/gh/<owner>/<repo>@<ref>/<path>`）替代 `raw.githubusercontent.com`——这属于修改原项目 Workers 逻辑，不在本反代范围内，但能从根源上让“那一跳”更快。

> 不建议“让 Pages 直接反代 GitHub、跳过 Workers”：主题实际仓库/分支（`theme_url`）存在 Workers 的 D1 里，Pages 无法在不复制这套逻辑的前提下还原出 GitHub 路径，反而会引入重复实现与一致性风险。

## 常见问题

- **打开是 500 且提示 `UPSTREAM_ORIGIN is not configured`**：环境变量没配对分支。Pages 的生产分支与预览分支的环境变量是分开配置的，请在你访问的对应预览/生产环境中都配置 `UPSTREAM_ORIGIN`。
- **WebSocket 连不上**：确认 `UPSTREAM_ORIGIN` 使用 `https://`（Pages 侧会自动升级为 `wss://`）；确认源站 Worker 正常运行。
- **国内仍慢**：`pages.dev` 与 `workers.dev` 一样是 Cloudflare 共享域名。如需更稳定的访问，可为该 **Pages 项目绑定你自己的自定义域名**（Pages 支持为已托管在 CF 的域名绑定，且对非直连场景通常比 workers.dev 更友好）。
