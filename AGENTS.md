# 开发约束

先读 README.md 和 PLAN.md。优先小而精、快速交付和 Cloudflare 免费套餐预算。与 menkyo（../menkyo）保持同一套风格。

- 服务面向同一开发者的多个产品，用稳定且公开的 product key 区分。它不是密码或凭据。
- 只用一个 Worker、一个 D1 和静态配置。按需求增加少量直接的函数，避免微服务、插件机制和多租户平台。
- 不做账号体系、公开需求墙或投票；不预埋分析上传。管理后台只供开发者本人使用，用 `ADMIN_TOKEN` 登录，只做中文。
- 只保存用户主动填写的内容和必要的归类字段（产品、版本、语言、国家 / 地区代码、时间）。国家 / 地区代码取自 `request.cf.country`；不保存 IP、IP 哈希、User-Agent 原文或任何浏览数据；服务端只接受白名单参数，拒绝未知产品。
- 防滥用用 Turnstile 和 Cloudflare 后台的速率限制规则，不自建限流存储。
- 先用平台自带的 Fetch、Web Crypto、D1 绑定；邮件用 Cloudflare Email Service 的 Workers 绑定，只发到已验证地址，不自建邮件基础设施。通知渠道只做邮件和飞书 / Lark webhook。
- 不预设 KV、Queues、Durable Objects、Cron 或 ORM。出现具体需要后再评估。
- 禁止在源码、配置、日志中存放真实密钥、`ADMIN_TOKEN`、Turnstile 私钥、webhook 地址与签名密钥或用户邮箱原文。webhook 凭据只存 D1，后台显示时打码。开发密钥用 .dev.vars，线上用 Worker secrets。
- 使用 wrangler types 生成绑定类型，不手写 Env。新增查询必须明确索引和读写成本。
- 反馈页支持中日英三语，与 menkyo 付款完成页的语言规则一致。
- 测试只覆盖关键行为：未知产品拒绝、参数白名单、Turnstile 校验失败、长度与类型限制、后台未登录拒绝、通知失败不丢反馈。不为样式和字面量堆测试。
- 更新说明只写已实现行为。
