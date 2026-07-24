# 🌐 双线路网站存活检测（Cloudflare Worker）

> 基于 Cloudflare Workers 的全球双线路网站可用性检测工具。  
> 一键部署，零成本，无需服务器。

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/YOUR_USER/YOUR_REPO)

---

## 📸 预览

| 国外线路检测 | 亚太节点检测 | 检测结果 |
|:---:|:---:|:---:|
| Cloudflare Edge 直接探测 | check-host.net 香港节点 | 双线路表格对比展示 |

---

## ✨ 功能特点

- **双线路并行检测** —— 每个 URL 同时触发「国外 + 亚太」两条线路检测，互不阻塞
- **批量检测** —— 一次输入最多 50 个网址，全部并行执行，秒级出结果
- **智能输入解析** —— 支持逗号、中文逗号、顿号、换行分隔，自动补全 `https://`
- **Cloudflare 识别** —— 自动检测目标站点是否使用了 Cloudflare CDN
- **精美前端界面** —— 响应式表格，状态颜色标注，总耗时统计
- **零成本部署** —— 完全免费，无需购买服务器或域名

---

## 🔍 检测原理

```
用户输入 ──→ POST /api/check ──→ 解析 URL 列表
                                        │
                          ┌─────────────┴─────────────┐
                          ▼                           ▼
                   🌎 国外线路                  🌏 亚太线路
              (CF Worker Edge)           (check-host.net 香港节点)
                          │                           │
                   fetch(GET)              API 请求 + 轮询结果
                  超时 8s                  超时 ~12s
                          │                           │
                          └─────────────┬─────────────┘
                                        ▼
                               JSON 返回前端渲染
```

### 线路说明

| 线路 | 检测方式 | 节点位置 | 超时 |
|:---|:---|---:|:---:|
| 🌎 **国外** | Cloudflare Worker 原生 `fetch()` | Cloudflare 全球边缘节点（就近） | 8s |
| 🌏 **亚太/近中国** | check-host.net HTTP Check API | 🇭🇰 香港 (hk1.node.check-host.net) | ~12s |

> 💡 亚太节点使用香港作为检测源，这是免费可编程 API 中最接近中国大陆的节点，可作为 GFW 阻断 / 跨国访问质量的参考。

---

## 🚀 部署到 Cloudflare Workers

### 方式一：通过 Cloudflare Dashboard（推荐新手）

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. 进入 **Workers & Pages**
3. 点击 **创建应用程序** → **创建 Worker**
4. 将 `_worker.js` 的代码全部复制粘贴到编辑器
5. 点击 **部署**
6. （可选）绑定自定义域名：Worker 设置 → 触发器 → 自定义域名

### 方式二：通过 Wrangler CLI

```bash
# 安装 Wrangler
npm install -g wrangler

# 登录
wrangler login

# 克隆仓库
git clone https://github.com/YOUR_USER/YOUR_REPO.git
cd YOUR_REPO

# 部署
wrangler deploy
```

### 方式三：一键部署按钮

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/YOUR_USER/YOUR_REPO)

---

## 📖 API 文档

### `POST /api/check`

检测一个或多个网址的可用性。

**请求体：** 纯文本，网址用逗号、换行或中文标点分隔

```
https://www.baidu.com
www.github.com
cf代理的站点.com, https://example.com/#/path
```

**响应：**

```json
{
  "results": [
    {
      "origin": "www.baidu.com",
      "oversea": {
        "alive": true,
        "status": 200,
        "time": "234ms",
        "useCF": "✅ 是",
        "msg": "正常存活"
      },
      "china": {
        "alive": true,
        "status": "200",
        "time": "3120ms",
        "msg": "正常存活"
      }
    }
  ],
  "total": "3456ms"
}
```

| 字段 | 类型 | 说明 |
|:---|:---|:---|
| `results[].origin` | string | 用户输入的原始网址 |
| `oversea.alive` | boolean | 国外线路是否存活 |
| `oversea.status` | number | HTTP 状态码 |
| `oversea.time` | string | 响应耗时 |
| `oversea.useCF` | string | 是否使用 Cloudflare |
| `china.alive` | boolean | 亚太线路是否存活 |
| `china.status` | string | HTTP 状态码 |
| `china.time` | string | 检测总耗时（含 API 轮询） |
| `total` | string | 全部检测总耗时 |

---

## 🧩 项目结构

```
双线路网站存活检测（国内 + 国外）.js
├── export default { fetch() }    # Worker 入口
│   ├── GET  /                    # 返回前端 HTML 页面
│   └── POST /api/check           # 检测 API 接口
│
├── handleCheck()                 # 处理检测请求
│   ├── parseUrlList()            # 解析输入文本
│   ├── checkSingleUrl()          # 检测单个 URL
│   │   ├── normalizeUrl()        # URL 标准化
│   │   ├── checkOversea()        # 🌎 国外线路检测
│   │   └── checkChina()          # 🌏 亚太线路检测
├── htmlTemplate()                # 前端 HTML 模板
│   ├── CSS (内联)
│   └── JavaScript (内联)
```

---

## ⚙️ 自定义配置

编辑文件顶部常量：

```javascript
const OVERSEA_TIMEOUT = 8000;       // 国外检测超时 (ms)
const CHINA_POLL_INTERVAL = 2500;   // 亚太轮询间隔 (ms)
const CHINA_MAX_POLLS = 5;          // 亚太最多轮询次数
const MAX_URLS = 50;                // 最大检测数量
const MAX_BODY_SIZE = 1024 * 10;    // 请求体最大 10KB
```

---

## ⚠️ 已知限制

| 限制 | 说明 |
|:---|:---|
| **中国大陆节点** | 免费 API 无法获取真正的大陆内地检测节点。香港节点作为亚太/近中国侧参考，大部分场景（GFW 阻断、跨国延迟）有参考价值 |
| **同时检测上限** | 默认最多 50 个 URL，可在常量中调整。注意 Workers 免费计划 CPU 时间限制 10ms（I/O 等待不计入） |
| **`setTimeout` 轮询** | `checkChina()` 使用 `await new Promise(r => setTimeout(r, N))` 轮询，这是 Worker 环境中合法的非阻塞等待方式 |

---

## 📝 许可证

[MIT](./LICENSE)

---

## 🙏 致谢

- [check-host.net](https://check-host.net/) — 提供免费全球节点 HTTP 检测 API
- [Cloudflare Workers](https://workers.cloudflare.com/) — 提供强大的 Serverless 边缘计算平台

---

*如有问题或建议，欢迎提交 Issue 或 Pull Request！*
