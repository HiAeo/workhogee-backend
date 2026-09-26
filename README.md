# WorkHogee Backend

WorkHogee（你生意的好伙计）的 Cloudflare Worker 后端。

## 能力
- 阿图：商品图生成 / 抠图 / 超分 / 保真分级
- 阿文：多平台爆款文案
- 阿视：分镜与营销视频
- 阿发：素材打包与发布引导
- 阿果：效果数据与分析
- 会员体系、官方素材墙、火山 TOS 跨端存储

## 技术栈
- Cloudflare Workers + Workers KV
- 火山方舟（视觉 / 文案 / 图像）、AI MediaKit、火山 TOS、AutoDL

## 本地开发
1. `npm install`
2. 复制 `.dev.vars.example` 为 `.dev.vars` 并填入密钥（该文件不提交）
3. `npx wrangler dev`

## 部署
`npx wrangler deploy`

密钥通过 `npx wrangler secret put <NAME>` 管理，仓库内不含任何明文凭据。
