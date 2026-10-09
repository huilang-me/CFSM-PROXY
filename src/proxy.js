// CF-Server-Monitor Workers 反向代理核心逻辑（Cloudflare Pages Functions）
//
// 作用：把一个 Cloudflare Pages 域名作为入口，透明反代到 CF-Server-Monitor 的
//       Workers 源站（https 接口 + wss WebSocket），用于解决 Workers 默认域名
//       （*.workers.dev）无法直接绑定非托管自定义域名的场景。
//
// 该模块被两个路由文件共享引用：
//   - functions/index.js      -> 匹配根路径 `/`（面板入口）
//   - functions/[[path]].js   -> 匹配其余所有路径（catchall，两方括号是 CF 语法）
//
// 部署方式见同目录 README.md。核心只需配置一个环境变量：
//   UPSTREAM_ORIGIN = https://<你的-worker>.workers.dev   （或 Worker 已绑定的自定义域名）
//
// 专门处理的场景：
//   - WebSocket 升级（/api/ws、/update）：直接返回上游 101 响应，绝不重组 body，
//     否则 Cloudflare 运行时的透明 WebSocket 代理会失效。
//   - 3xx 跳转（/admin/ -> /#/admin）：把 Location 重写回当前 Pages 域名。
//   - 客户端国家码：透传 cf-ipcountry，保证 Worker 侧地区/运营商判断准确。

function parseUpstream(rawUpstream) {
  const value = (rawUpstream || '').trim();
  if (!value) return null;
  // 允许用户填写时不带协议，默认补 https
  const normalized = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  try {
    const url = new URL(normalized);
    if (!url.hostname) return null;
    // 仅保留 origin（协议 + host）
    return url;
  } catch {
    return null;
  }
}

//  hop-by-hop / 需要由上游重新计算的头，转发时应剔除
const DROP_REQUEST_HEADERS = new Set([
  'host',            // 由目标 URL 决定
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade-insecure-requests'
]);

//  Hop-by-hop 响应头不应原样回传给浏览器
const DROP_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding'
]);

export async function onRequest(context) {
  const { request, env } = context;

  const upstream = parseUpstream(env.UPSTREAM_ORIGIN);
  if (!upstream) {
    return new Response(
      JSON.stringify({
        error: 'UPSTREAM_ORIGIN is not configured on this Pages project',
        hint: '在 Pages 项目的 Settings -> Environment variables 中配置 UPSTREAM_ORIGIN，例如 https://xxx.workers.dev'
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // 基于原始请求 URL 构造上游 URL，只替换协议与 host，保留 path 与 query
  const currentUrl = new URL(request.url);
  const targetUrl = new URL(request.url);
  targetUrl.protocol = upstream.protocol;
  targetUrl.host = upstream.host;

  // 复制请求头，剔除 hop-by-hop，保留 Upgrade / Sec-WebSocket-* 以支持 WebSocket 透传
  const headers = new Headers(request.headers);
  for (const key of [...headers.keys()]) {
    if (DROP_REQUEST_HEADERS.has(key.toLowerCase())) {
      headers.delete(key);
    }
  }

  // 透传客户端真实来源信息，方便 Worker 侧记录 / 地区判断
  const incomingCf = request.cf || {};
  if (incomingCf.country && !headers.get('cf-ipcountry')) {
    headers.set('cf-ipcountry', incomingCf.country);
  }
  headers.set('x-forwarded-host', currentUrl.host);
  headers.set('x-forwarded-proto', currentUrl.protocol.replace(':', ''));
  // 追加（而非覆盖）到既有 X-Forwarded-For 链
  const clientIp = incomingCf.clientIp || request.headers.get('cf-connecting-ip') || '';
  if (clientIp) {
    const prev = request.headers.get('X-Forwarded-For');
    headers.set('X-Forwarded-For', prev ? `${prev}, ${clientIp}` : clientIp);
  }

  // 主题静态资源（/assets/*）由 Workers 源站反代 GitHub 得到。
  // 让 Pages 边缘对这类 GET/HEAD 做缓存，避免每次请求都走
  // Pages→Worker→GitHub 两次反代；API / WebSocket / admin 仍不缓存。
  // 仅缓存公共主题产物（GitHub 上的公开文件），401/403/3xx 等
  // 不会被边缘缓存（Cloudflare 对不可缓存状态不会存储）。
  const isStaticAsset =
    (request.method === 'GET' || request.method === 'HEAD') &&
    currentUrl.pathname.startsWith('/assets/');
  const assetCacheTtl = Number(env.ASSET_CACHE_TTL) > 0 ? Number(env.ASSET_CACHE_TTL) : 3600;

  const upstreamRequest = new Request(targetUrl.toString(), {
    method: request.method,
    headers,
    body: request.body,
    redirect: 'manual', // 手动处理跳转，便于重写 Location
    cf: isStaticAsset ? { cacheTtl: assetCacheTtl } : { cacheTtl: 0 } // 主题资源边缘缓存，其余不缓存
  });

  let upstreamResponse;
  try {
    upstreamResponse = await fetch(upstreamRequest);
  } catch (e) {
    return new Response(
      JSON.stringify({
        error: 'upstream_fetch_failed',
        message: e && e.message ? e.message : String(e)
      }),
      { status: 502, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const isWebSocket = upstreamResponse.status === 101 ||
    (upstreamResponse.headers.get('Upgrade') || '').toLowerCase() === 'websocket';

  //  WebSocket：必须原样返回上游响应对象，任何重组都会破坏透明代理
  if (isWebSocket) {
    return upstreamResponse;
  }

  //  3xx 跳转：把指向源站的 Location 重写回当前 Pages 域名
  const status = upstreamResponse.status;
  const location = upstreamResponse.headers.get('Location');
  if (status >= 300 && status < 400 && location) {
    const rewritten = rewriteLocation(location, upstream, currentUrl);
    const newHeaders = buildResponseHeaders(upstreamResponse.headers);
    newHeaders.set('Location', rewritten);
    return new Response(upstreamResponse.body, {
      status,
      statusText: upstreamResponse.statusText,
      headers: newHeaders
    });
  }

  //  普通响应：清理 hop-by-hop 响应头后原样透传
  const cleanHeaders = buildResponseHeaders(upstreamResponse.headers);
  return new Response(upstreamResponse.body, {
    status,
    statusText: upstreamResponse.statusText,
    headers: cleanHeaders
  });
}

function buildResponseHeaders(sourceHeaders) {
  const headers = new Headers(sourceHeaders);
  for (const key of [...headers.keys()]) {
    if (DROP_RESPONSE_HEADERS.has(key.toLowerCase())) {
      headers.delete(key);
    }
  }
  // 反代结果不应被下游缓存
  if (!headers.get('Cache-Control')) {
    headers.set('Cache-Control', 'no-store');
  }
  return headers;
}

function rewriteLocation(location, upstream, currentUrl) {
  try {
    const abs = new URL(location, currentUrl.toString());
    // 仅当跳转目标是源站时，才改写回当前 Pages 域名
    if (upstream.hostname === abs.hostname) {
      abs.protocol = currentUrl.protocol;
      abs.host = currentUrl.host;
      return abs.toString();
    }
    return location;
  } catch {
    return location;
  }
}
