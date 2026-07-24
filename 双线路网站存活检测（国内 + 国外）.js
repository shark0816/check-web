export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 检测接口
    if (url.pathname === "/api/check") {
      return await handleCheck(request);
    }

    // 前端主页
    return new Response(htmlTemplate(), {
      headers: { "Content-Type": "text/html; charset=utf-8" }
    });
  }
};

// 常量配置
const OVERSEA_TIMEOUT = 8000;       // 国外检测超时 (ms)
const CHINA_POLL_INTERVAL = 2500;   // 国内轮询间隔 (ms)
const CHINA_MAX_POLLS = 5;          // 国内最多轮询次数
const MAX_URLS = 50;                // 最大检测数量
const MAX_BODY_SIZE = 1024 * 10;    // 请求体最大 10KB

// 处理批量检测请求
async function handleCheck(request) {
  // 验证请求方法
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "请使用 POST 请求" }), { status: 405 });
  }

  // 限流：检查 Content-Length
  const contentLength = parseInt(request.headers.get("Content-Length") || "0");
  if (contentLength > MAX_BODY_SIZE) {
    return new Response(JSON.stringify({ error: `请求体过大，最大 ${MAX_BODY_SIZE / 1024}KB` }), { status: 413 });
  }

  try {
    const body = await request.text();
    if (body.length > MAX_BODY_SIZE) {
      return new Response(JSON.stringify({ error: `请求体过大，最大 ${MAX_BODY_SIZE / 1024}KB` }), { status: 413 });
    }

    const urlList = parseUrlList(body);
    if (!urlList.length) {
      return new Response(JSON.stringify({ error: "请输入至少一个网址" }), { status: 400 });
    }

    if (urlList.length > MAX_URLS) {
      return new Response(JSON.stringify({ error: `最多检测 ${MAX_URLS} 个网址` }), { status: 400 });
    }

    const startTotal = Date.now();

    // 并行检测所有URL（每个URL的内部国外+国内也是并行的）
    const settledResults = await Promise.allSettled(
      urlList.map(url => checkSingleUrl(url))
    );

    const results = settledResults.map((r, i) =>
      r.status === "fulfilled" ? r.value : {
        origin: urlList[i],
        oversea: { alive: false, status: "Error", time: "-", useCF: "-", msg: "检测进程崩溃" },
        china: { alive: false, status: "Error", time: "-", msg: "检测进程崩溃" }
      }
    );

    const totalCost = Date.now() - startTotal;

    return new Response(JSON.stringify({ results, total: totalCost + "ms" }, null, 2), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*"
      }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500 });
  }
}

// 检测单个URL（国外+国内并行）
async function checkSingleUrl(rawUrl) {
  const url = normalizeUrl(rawUrl);
  if (!url) {
    return {
      origin: rawUrl,
      oversea: { alive: false, status: "Error", time: "-", useCF: "-", msg: "无效URL" },
      china: { alive: false, status: "Error", time: "-", msg: "无效URL" }
    };
  }

  const [overseaResult, chinaResult] = await Promise.allSettled([
    checkOversea(url),
    checkChina(url)
  ]);

  const oversea = overseaResult.status === "fulfilled"
    ? overseaResult.value
    : { alive: false, status: "Error", time: "-", useCF: "-", msg: "国外检测异常" };

  const china = chinaResult.status === "fulfilled"
    ? chinaResult.value
    : { alive: false, status: "Error", time: "-", msg: "国内检测异常" };

  return { origin: rawUrl, oversea, china };
}

// 标准化URL：去hash、补协议、基本格式校验
function normalizeUrl(input) {
  let url = (input || "").trim().split("#")[0];
  if (!url) return null;

  // 补协议
  if (!/^https?:\/\//i.test(url)) {
    url = "https://" + url;
  }

  // 基本格式校验：必须包含域名
  try {
    const parsed = new URL(url);
    // 必须有点（域名）或localhost
    if (!parsed.hostname.includes(".") && parsed.hostname !== "localhost") return null;
    return url;
  } catch {
    return null;
  }
}

// 解析输入：逗号、换行、中文逗号 分割
function parseUrlList(text) {
  return text
    .replace(/[,，、]/g, "\n")
    .split("\n")
    .map(u => u.trim())
    .filter(u => u !== "");
}

// ------------------------------
// 1. 国外线路检测（Cloudflare Workers 原生请求）
// ------------------------------
async function checkOversea(target) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), OVERSEA_TIMEOUT);

  try {
    const start = Date.now();
    const resp = await fetch(target, {
      method: "GET",
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
      }
    });
    clearTimeout(timeoutId);
    const cost = Date.now() - start;

    // 判断是否使用Cloudflare
    const server = (resp.headers.get("server") || "").toLowerCase();
    const cfRay = resp.headers.get("cf-ray") || "";
    const isCF = server.includes("cloudflare") || !!cfRay;

    const isAlive = resp.status >= 200 && resp.status < 400;

    return {
      alive: isAlive,
      status: resp.status,
      time: cost + "ms",
      useCF: isCF ? "✅ 是" : "❌ 否",
      msg: isAlive ? "正常存活" : "访问异常"
    };
  } catch (err) {
    clearTimeout(timeoutId);
    return {
      alive: false,
      status: "错误",
      time: "-",
      useCF: "-",
      msg: err.name === "AbortError" ? "请求超时" : "无法连接"
    };
  }
}

// ------------------------------
// 2. 国内/亚太线路检测（check-host.net 香港节点）
//    ⚠️ 说明：check-host.net 有全球多节点，这里指定香港节点
//    作为亚太/近中国侧检测参考，并非真正大陆节点检测
// ------------------------------
async function checkChina(target) {
  try {
    const start = Date.now();

    // Step 1: 请求 check-host.net 发起 HTTP 检测（指定香港节点）
    const reqUrl = `https://check-host.net/check-http?host=${encodeURIComponent(target)}&max_nodes=1&node=hk1.node.check-host.net`;
    const reqResp = await fetch(reqUrl, {
      headers: { "Accept": "application/json" },
      signal: AbortSignal.timeout(10000)
    });

    if (!reqResp.ok) throw new Error(`API请求失败 (HTTP ${reqResp.status})`);

    const reqData = await reqResp.json();
    const requestId = reqData.request_id;
    if (!requestId) throw new Error("未获取到检测任务ID");

    // Step 2: 轮询获取结果
    let result = null;
    for (let i = 0; i < CHINA_MAX_POLLS; i++) {
      await new Promise(r => setTimeout(r, CHINA_POLL_INTERVAL));

      const resResp = await fetch(`https://check-host.net/check-result/${requestId}`, {
        headers: { "Accept": "application/json" },
        signal: AbortSignal.timeout(5000)
      });

      if (!resResp.ok) continue;

      const text = await resResp.text();
      if (text && text !== "{}" && text.length > 4) {
        try {
          const parsed = JSON.parse(text);
          const nodeKey = Object.keys(parsed)[0];
          const nodeData = nodeKey ? parsed[nodeKey] : null;
          if (nodeData && Array.isArray(nodeData) && nodeData.length > 0 && nodeData[0].length >= 4) {
            result = nodeData[0];
            break;
          }
        } catch { /* 继续轮询 */ }
      }
    }

    if (!result) throw new Error("检测结果超时");

    const totalTime = Date.now() - start;

    // result: [status(0/1), responseTime(s), statusText, httpStatusCode, resolvedIP]
    const nodeStatus = result[0];       // 1=成功, 0=失败
    const statusCode = result[3];       // HTTP状态码字符串
    const isAlive = nodeStatus === 1 && parseInt(statusCode) >= 200 && parseInt(statusCode) < 400;

    return {
      alive: isAlive,
      status: statusCode || "-",
      time: totalTime + "ms",
      msg: isAlive ? "正常存活" : "访问异常"
    };
  } catch (err) {
    return {
      alive: false,
      status: "Error",
      time: "-",
      msg: err.message.includes("超时") ? "国内节点检测超时" : "国内检测失败"
    };
  }
}

// ------------------------------
// 前端交互式页面
// ------------------------------
function htmlTemplate() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>网站存活检测 | 双线路（国外+亚太）</title>
<style>
*{margin:0;padding:0;box-sizing:border-box;}
body{font-family:system-ui,Segoe UI;background:#f0f2f5;padding:20px;color:#1a1a1a;}
.container{max-width:1200px;margin:0 auto;background:#fff;border-radius:12px;padding:24px;box-shadow:0 2px 15px rgba(0,0,0,0.08);}
h2{margin-bottom:16px;}
.tip{color:#666;font-size:14px;margin-bottom:12px;line-height:1.6;}
textarea{width:100%;height:180px;padding:14px;border:1px solid #ddd;border-radius:8px;resize:vertical;font-size:15px;line-height:1.6;font-family:inherit;}
textarea:focus{outline:none;border-color:#0071e3;box-shadow:0 0 0 3px rgba(0,113,227,0.15);}
.toolbar{display:flex;align-items:center;gap:12px;margin:16px 0;flex-wrap:wrap;}
.btn{padding:12px 28px;background:#0071e3;color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:15px;font-weight:500;transition:background 0.2s;}
.btn:hover{background:#0077ed;}
.btn:active{transform:scale(0.98);}
.btn:disabled{background:#999;cursor:not-allowed;transform:none;}
.loading{color:#0071e3;font-size:14px;display:none;align-items:center;gap:6px;}
.loading .spinner{display:inline-block;width:16px;height:16px;border:2px solid #ddd;border-top-color:#0071e3;border-radius:50%;animation:spin 0.8s linear infinite;}
@keyframes spin{to{transform:rotate(360deg);}}
.status-bar{font-size:13px;color:#666;display:none;}
table{width:100%;border-collapse:collapse;margin-top:16px;display:none;}
th,td{border:1px solid #e8e8e8;padding:10px;text-align:center;font-size:13px;}
th{background:#f7f8fa;font-weight:600;white-space:nowrap;}
tr:hover td{background:#fafbfc;}
.alive{color:#00b42a;font-weight:600;}
.down{color:#f53f3f;font-weight:600;}
.pending{color:#999;}
.url-col{text-align:left;max-width:240px;word-break:break-all;}
.badge{display:inline-block;padding:1px 6px;border-radius:4px;font-size:11px;margin-left:4px;}
.badge-cf{background:#e8f4fd;color:#0071e3;}
.badge-hk{background:#f0f5e8;color:#5a8a1a;}
.error-msg{color:#f53f3f;font-size:12px;}
.footer{text-align:center;color:#999;font-size:12px;margin-top:20px;}
.footer a{color:#0071e3;text-decoration:none;}
@media(max-width:768px){
  .container{padding:16px;}
  table{font-size:12px;}
  th,td{padding:6px 4px;}
  .url-col{max-width:120px;}
}
</style>
</head>
<body>
<div class="container">
  <h2>🌐 双线路网站存活检测</h2>
  <div class="tip">
    输入规则：多条链接支持 <b>逗号</b>、<b>回车换行</b> 或 <b>中文逗号</b> 分隔<br>
    可省略 http/https，自动处理 #hash 部分，最多同时检测 <b>50</b> 个网址
  </div>
  <textarea id="urls" placeholder="示例：
www.baidu.com
www.github.com, cf代理的站点.com
https://airudp.vip/#/login"></textarea>
  <div class="toolbar">
    <button class="btn" id="btnCheck" onclick="startCheck()">🚀 开始检测</button>
    <div class="loading" id="loading"><span class="spinner"></span><span id="loadingText">检测中...</span></div>
    <span class="status-bar" id="statusBar"></span>
  </div>
  <table id="resultTable">
    <thead>
      <tr>
        <th rowspan="2">🌍 网站地址</th>
        <th colspan="3">🌎 国外线路（Cloudflare Edge）</th>
        <th colspan="2">🌏 亚太节点（香港）</th>
        <th rowspan="2">🛡️ 是否CF</th>
      </tr>
      <tr>
        <th>状态</th>
        <th>状态码</th>
        <th>耗时</th>
        <th>状态</th>
        <th>耗时</th>
      </tr>
    </thead>
    <tbody id="tbody"></tbody>
  </table>
</div>
<div class="footer">
  检测节点：国外=Cloudflare Worker Edge · 亚太=check-host.net 香港节点
  <br><small>🌏 亚太节点用作近中国侧参考，结果仅供参考</small>
</div>

<script>
async function startCheck(){
  const text = document.getElementById('urls').value.trim();
  if (!text) { alert('请输入要检测的网址'); return; }

  const btn = document.getElementById('btnCheck');
  const tbody = document.getElementById('tbody');
  const loading = document.getElementById('loading');
  const loadingText = document.getElementById('loadingText');
  const statusBar = document.getElementById('statusBar');
  const table = document.getElementById('resultTable');

  tbody.innerHTML = '';
  table.style.display = 'none';
  statusBar.style.display = 'none';
  loading.style.display = 'flex';
  btn.disabled = true;

  const startTime = Date.now();

  try{
    const res = await fetch('/api/check', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: text
    });

    const data = await res.json();
    const elapsed = Date.now() - startTime;

    loading.style.display = 'none';
    btn.disabled = false;
    if (!res.ok) { alert('❌ ' + (data.error || '检测失败')); return; }

    const list = data.results;
    if (!list || !list.length) { alert('无检测结果'); return; }

    table.style.display = 'table';
    statusBar.style.display = 'inline';
    statusBar.textContent = '✅ 共检测 ' + list.length + ' 个网站，总耗时 ' + (data.total || elapsed + 'ms');

    list.forEach(item => {
      const tr = document.createElement('tr');
      const oversea = item.oversea || {};
      const china = item.china || {};

      const overseaMsg = oversea.msg || '-';
      const chinaMsg = china.msg || '-';
      const overseaAlive = !!oversea.alive;
      const chinaAlive = !!china.alive;

      tr.innerHTML = [
        '<td class="url-col">' + escHtml(item.origin) + '</td>',
        '<td class="' + (overseaAlive ? 'alive' : 'down') + '">' + escHtml(overseaMsg) + '</td>',
        '<td>' + escHtml(oversea.status ?? '-') + '</td>',
        '<td>' + escHtml(oversea.time ?? '-') + '</td>',
        '<td class="' + (chinaAlive ? 'alive' : 'down') + '">' + escHtml(chinaMsg) + '</td>',
        '<td>' + escHtml(china.time ?? '-') + '</td>',
        '<td>' + (oversea.useCF || '-') + '</td>'
      ].join('');
      tbody.appendChild(tr);
    });
  } catch(e){
    loading.style.display = 'none';
    btn.disabled = false;
    alert('❌ 检测请求失败：' + e.message);
  }
}

function escHtml(s) {
  const d = document.createElement('div');
  d.textContent = String(s);
  return d.innerHTML;
}
</script>
</body>
</html>`;
}
