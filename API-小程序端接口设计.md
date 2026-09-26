# WorkHogee 生图伙计 · 小程序端接口设计（v1 契约）

> 适用端：微信小程序「WorkHogee 生图伙计」（二手车行版）。
> 原则：**小程序与 Web 工作台共用同一套服务端接口（Cloudflare Worker 薄代理层）**，不另起后端；
> 模型密钥只存在服务端，小程序端与网页端都不持有任何 API Key。
> 本文先定稿接口契约，正式小程序开发前需具备：**微信小程序 AppID、企业主体认证、微信开发者工具、服务器域名备案**。

---

## 0. 现状与版本边界

| 能力 | v1 内测（当前） | v2 正式版 |
|---|---|---|
| 部署形态 | Worker 单服务，同步出图 | Worker + 对象存储(R2/OSS) + 异步任务队列 |
| 鉴权 | 不登录，IP 限流 | 微信登录 + JWT，RBAC（车行/成员） |
| 上传 | 小程序端选图压缩后转 base64 随 `/generate` 提交（≤8MB） | 签名 URL 直传对象存储，服务端拉取 |
| 出图 | 同步等待（单场景约 15–30s） | 提交任务返回 taskId，轮询/回调 |
| 知识库 | 内置热门车型，GET `/kb` | RAG（embedding + pgvector + rerank） |
| 计费 | 内测免费、不限量 | 套餐 + 按量，GET `/billing/*` |
| 合规 | AI 标识、禁用词（端侧）；色差/瑕疵/脱敏标“待后端” | 服务端像素校验、自动脱敏、合规报告 |

---

## 1. 通用约定

- **Base URL**
  - 生产（自定义域名，国内优先）：`https://api.workhogee.com`
  - 兜底（workers.dev）：`https://workhogee-image-api.<account-subdomain>.workers.dev`
- **协议**：HTTPS；请求/响应统一 `application/json; charset=utf-8`。
- **鉴权（v2）**：`Authorization: Bearer <accessToken>`；v1 内测接口暂不鉴权，仅 IP 限流。
- **跨域**：Web 走 CORS（白名单 `www.workhogee.com`、`hiaeo.github.io`）；小程序为服务端请求，不受 CORS 限制。
- **限流**：单 IP 每分钟 30 次生成，超限返回 `429 rate_limited`，带 `Retry-After`。
- **统一响应**

  成功：
  ```json
  { "ok": true, "...": "..." }
  ```
  失败：
  ```json
  { "ok": false, "error": { "code": "bad_image", "message": "缺少合法的图片 dataURL" } }
  ```

### 错误码表

| HTTP | code | 含义 | 小程序处理建议 |
|---|---|---|---|
| 400 | bad_json / bad_prompt / bad_image | 入参不合法 | 提示重新选择图片/重试 |
| 413 | image_too_large | 图片超 8MB | 先 `wx.compressImage` 压缩 |
| 429 | rate_limited | 触发限流 | 按 `Retry-After` 等待后重试 |
| 500 | server_misconfigured | 服务端密钥缺失 | 提示稍后重试，上报监控 |
| 502 | upstream_network / upstream_5xx / no_image | 模型侧异常 | 自动重试 2 次后提示 |
| 504（前端归一） | timeout | 生成超时 | 进度条保留，允许手动重试 |
| 404 | not_found | 接口不存在 | 检查 Base URL 与路径 |

---

## 2. 接口清单（v1 已实现 / 已定稿）

### 2.1 健康检查
`GET /health` → `{ ok:true, status:"healthy", ts }`
小程序启动时探活，用于在 Base URL 主备之间切换。

### 2.2 公开配置与合规能力开关
`GET /config`
```json
{
  "ok": true,
  "version": "1.0.0",
  "image": { "provider": "volcengine-seedream", "sizes": ["2048x2048"], "minPixels": 3686400 },
  "capabilities": {
    "aiLabel": true,
    "bannedWordsFilter": true,
    "colorConsistencyVerify": false,
    "accidentTracePreserve": false,
    "plateFaceVinMask": false
  }
}
```
> 小程序据 `capabilities` 渲染合规项状态：`true` 显示“已生效”，`false` 显示“即将上线/待后端”，**不得在端侧硬编码承诺**。

### 2.3 车型知识库
`GET /kb?brand=福特&series=探险者&year=2020`
```json
{
  "ok": true,
  "year": "2020",
  "kb": {
    "brand": "福特", "series": "探险者", "matched": "series", "class": "中大型 SUV",
    "points": ["同价位少见的纵置后驱平台与大尺寸车身", "三排空间宽裕、适合多人口家庭"],
    "config": ["区分后驱/四驱及各配置版本", "核对全景天窗、座椅加热通风、电动尾门"],
    "hints": ["主打“大空间、强动力、高配置的家庭硬派 SUV”"],
    "caution": ["车身大、市区油耗与停车需客观说明", "美系车保值率一般，定价务实"]
  }
}
```
- `matched`：`series`（车系精确/别名命中）/ `brand`（仅命中品牌）/ `generic`（通用兜底）。
- v2 由同路径切换为 RAG 检索，**响应结构保持不变，小程序无需改版**。
- 小程序交互：用户选择/输入品牌车系后拉取，`points` 渲染为可点选标签，点选追加到“车况补充”；`caution` 以浅色提示条展示。

### 2.4 生成（v1 同步）
`POST /generate`

请求：
```json
{
  "prompt": "（由小程序按场景模板拼好的中文生图指令）",
  "image": "data:image/jpeg;base64,/9j/4AAQ...",
  "size": "2048x2048"
}
```
- `image`：JPEG/PNG/WebP 的 dataURL，base64 体积 ≤ 约 1100 万字符（≈8MB 原图）。
- `size`：当前仅支持 `2048x2048`（火山要求输出像素 ≥ 3,686,400）。

响应：
```json
{ "ok": true, "b64": "/9j/4AAQ...（JPEG base64，不含 data 前缀）", "size": "2048x2048" }
```
小程序：拼接 `data:image/jpeg;base64,` + `b64` 预览；用 `wx.getFileSystemManager().writeFile` 落临时文件后再 `wx.saveImageToPhotosAlbum`。

> 多场景/多平台尺寸：v1 由小程序端对同一原图循环调用 `/generate`（展厅/城市/户外），平台裁剪在端侧 canvas 完成（与 Web 一致）；v2 改为一次提交多任务。

---

## 3. v2 正式版接口（预留，对齐开发文档第 8 节 `/api/v1`）

正式版统一加前缀 `/api/v1`，采用异步任务与对象存储直传，兼容 Web 与小程序。

### 3.1 登录（微信）
- `POST /auth/wx-login`
  ```json
  { "code": "wx.login 返回的 code" }
  ```
  服务端用 AppID + AppSecret 调 `code2session` 换 openid/session_key，签发：
  ```json
  { "ok": true, "accessToken": "…", "refreshToken": "…", "shop": { "id": "sh_1", "name": "示例车行" } }
  ```
- 密钥（AppSecret、JWT_SECRET）仅存服务端。

### 3.2 车辆与素材
- `POST /vehicles` 建档；`GET /vehicles`、`PATCH /vehicles/{id}`。
- `POST /vehicles/{id}/assets/upload-url` → 返回对象存储**预签名直传 URL**（小程序 `wx.uploadFile` 直传 R2/OSS，不经 Worker 转发，省带宽、破 8MB 限制）。
- `POST /vehicles/{id}/assets/confirm` 上传完成回调登记。
- `POST /vehicles/{id}/analyze` 触发车型/年款智能识别（v2）。

### 3.3 异步生成
- `POST /vehicles/{id}/generate`
  ```json
  {
    "taskType": "full_package",
    "platforms": ["dongchedi","autohome","guazi","xianyu","xiaohongshu","moments","douyin"],
    "imageOptions": { "background": "showroom", "enhance": true, "removeLicensePlate": true, "sceneImages": 2 },
    "copyOptions": { "styles": ["professional","friendly","price_attractive"], "length": "medium" },
    "compliance": { "keepAccidentTraces": true, "noColorChange": true, "aiDisclosure": true }
  }
  ```
  → `{ "taskId": "task_abc" }`
- `GET /tasks/{taskId}` 轮询（建议 3s）：
  ```json
  { "taskId": "task_abc", "status": "generating_images", "progress": 55,
    "steps": [ {"name":"prechecking","status":"completed"}, {"name":"generating_images","status":"running"} ],
    "estimatedRemainingSeconds": 180 }
  ```
- `POST /tasks/{taskId}/cancel`、`POST /tasks/{taskId}/retry`。
- `GET /vehicles/{id}/outputs` 取成品（多尺寸图、场景图、文案五件套打包下载地址）。

### 3.4 文案
- v1 文案在小程序端按模板本地生成（与 Web 一致，含禁用词清洗）。
- v2：`POST /vehicles/{id}/copy`，服务端用 LLM + 知识库生成，统一合规过滤。

### 3.5 计费
- `GET /billing/usage`（剩余张数/套餐）、`POST /billing/estimate`、`GET /billing/records`。
- 微信支付下单与回调在 v2 接入（需商户号），内测期不暴露价格。

### 3.6 反馈
- `POST /feedback`（任务 id、类型、备注、可选对比图），用于知识库与风格迭代。

---

## 4. 小程序端实现要点

1. **选图与压缩**：`wx.chooseMedia({count, mediaType:['image'], sizeType:['compressed']})`；超过约 6MB 时用 `wx.compressImage({quality})` 循环压缩到安全体积，再 `FileSystemManager.readFile` 转 base64。
2. **EXIF 与方向**：小程序压缩通常已校正方向；服务端 v2 统一做 EXIF 旋转。
3. **请求超时**：`wx.request` timeout 设 110s；展示分阶段进度（质检→场景生成→平台适配），失败保留“手动重试”。
4. **保存成品**：多尺寸图逐张 `writeFile` 到本地临时路径 → `wx.saveImageToPhotosAlbum`，首次需 `scope.writePhotosAlbum` 授权引导。
5. **域名白名单**：在小程序管理后台「开发管理→服务器域名」配置 request/downloadFile 合法域名（生产 `https://api.workhogee.com`）；**该域名须已 ICP 备案且为 HTTPS**。开发期可在微信开发者工具勾选“不校验合法域名”联调 workers.dev。
6. **AI 标识与合规**：成品图左下角“AI 生成”角标由服务端/端侧保证；文案提交前过禁用词表；色差后验、事故瑕疵保留、车牌人脸 VIN 脱敏在 v2 服务端上线前端侧仅标注“即将上线”。
7. **无密钥原则**：小程序包内不得出现火山 Ark Key、任何模型直连地址；所有模型调用经 `/generate` 或 v2 任务接口。

---

## 5. 正式小程序上线前置清单（需用户提供/操作）

- [ ] 注册微信小程序并提供 **AppID**；完成**企业主体认证**。
- [ ] 服务端部署到**已 ICP 备案**的自定义域名 `https://api.workhogee.com`（workers.dev 无法加入小程序合法域名）。
- [ ] 小程序后台配置 request / uploadFile / downloadFile 合法域名。
- [ ] v2 接入微信登录（AppSecret 存服务端）与微信支付（如需计费，需商户号）。
- [ ] 微信开发者工具上传代码、提交审核、发布。
- [ ] 营销页与 Web 端的“微信小程序”入口在正式版前保持“内测筹备中/预约”（邮箱 hello@workhogee.com）。

---

## 6. 数据与密钥存放边界（安全红线）

| 项 | 存放位置 | 说明 |
|---|---|---|
| 火山 Ark API Key | Worker Secret `ARK_API_KEY` | `wrangler secret put`，不进代码、不进仓库、不下发端侧 |
| 模型接入点/Endpoint | Worker vars `ARK_MODEL`/`ARK_ENDPOINT` | 非机密，可放 `wrangler.toml [vars]` |
| 微信 AppSecret / JWT_SECRET | v2 Worker Secret | 同上 |
| 对象存储密钥 | v2 服务端，仅用于签发预签名 URL | 端侧只拿临时直传 URL |
| 车型知识库 | 服务端 `/kb`（内置→RAG） | 端侧仅缓存展示，不内置全量 |
