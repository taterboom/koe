# Koe 首版实施

方案：PLAN.md（2026-10-16 确认）。结构与工具链沿用 menkyo。

## 设计要点

- 路由：`GET /<product>` 反馈页、`POST /<product>` 提交（表单 POST，成功后 303 到 `/<product>/thanks`）、`/admin*` 后台、`GET /health`。
- 链接参数白名单：`v`（版本）、`lang`；其他参数一律忽略。版本格式不合法时按未填处理，不拒绝反馈。
- 提交：字节上限读表单 → 校验产品 / 类型 / 内容 / 邮箱 → Turnstile siteverify → 写 D1 → `waitUntil` 发通知。通知失败只记日志。
- 后台：`ADMIN_TOKEN` 登录，cookie = `过期时间.HMAC(ADMIN_TOKEN, 过期时间)`，HttpOnly、Secure、SameSite=Strict、Path=/admin，7 天；POST 同时校验 Origin。
- 通知：邮件走 `send_email` 绑定（发件人 `MAIL_FROM`，Reply-To 设为用户邮箱）；飞书 / Lark 自定义机器人（可选签名），只接受官方 webhook 域名。
- 环境：起初与 menkyo 相同，分测试和正式两个环境；2026-10-21 撤掉了测试环境，只保留 `koe.44san.com`。

## 数据与读写成本

- `feedback`：主键自增 id。提交写 1 行；后台列表按 id 倒序翻页，每页 50 条，筛选不建索引（数据量预计千级，只有后台访问）。
- `channels`：每条新反馈读一次启用的渠道（预计个位数行）。

## 清单

- [x] 项目骨架：package.json、tsconfig、wrangler.jsonc、vitest 配置、.dev.vars.example
- [x] migrations/0001_init.sql、config/products.json
- [x] 反馈页与确认页（三语、Turnstile、CSP）
- [x] 提交接口（白名单、长度与类型限制、Turnstile、写库、通知）
- [x] 管理后台（登录、列表筛选、改状态、删除、通知渠道增删 / 启停 / 测试）
- [x] 通知（邮件、飞书签名）
- [x] 关键行为测试
- [x] npm test、npm run check、本地 dev + 浏览器冒烟
- [x] README：已实现行为、本地开发、环境变量、部署与上线待办

- [x] ARCHITECTURE.md：架构图、提交 / 通知 / 登录流程、ER 图、安全边界、预算
- [x] D1 创建与远端迁移；测试 / 正式环境部署；ADMIN_TOKEN 设置（已存进密码管理器，本地文件已删除）
- [x] 飛雷神接入：设置页、官网页脚、商店描述、三语隐私页（hiraishin npm test / check 通过）
- [x] Turnstile widget、Email Routing、两个环境的邮件渠道与测试通知
- [x] 限流：决定暂不配置，升级付费套餐后每个产品单独一条（README）
- [x] 部署飛雷神官网
- [x] 真人线上提交两次（自动化浏览器过不了真实 Turnstile）：入库字段正确；提交 CPU 从 8 ms 降到 5 ms（去掉 Intl 时区），已写进 ARCHITECTURE.md §10

## Review（2026-10-16）

- 测试 17 项：未知产品拒绝；链接只读 `v` / `lang` 且不回显；提交只存白名单字段，国家取自 `cf`；版本畸形不拒绝；类型 / 空内容 / 超长 / 邮箱格式；按换行归一后计数；回显内容转义；流式超大请求体 413；Turnstile 缺失 / 失败 / 服务不可用 / 未配置；所有渠道失败不丢反馈且日志不含目标和用户数据；按产品和启用状态投递、Reply-To、飞书签名；后台未登录 / 伪造 / 过期 cookie / 错误 token 拒绝；跨源 POST 拒绝；登录回跳与开放重定向防护；改状态、删除；飞书地址白名单、打码、测试通知。
- 变异验证：去掉 Origin 校验、去掉 Turnstile、去掉单渠道错误兜底、国家改从表单读、去掉换行归一，各自都有测试失败。
- 浏览器冒烟（本地 wrangler dev + 官方 Turnstile 测试 key）：中 / 日 / 英反馈页、提交跳确认页、D1 落库、后台登录回跳、改状态、添加邮件渠道、测试通知、新反馈邮件内容；无 CSP 违规。
- 冒烟发现并修复：页面统一的 `Referrer-Policy: no-referrer` 会让浏览器在表单 POST 时发 `Origin: null`，后台所有操作被同源校验拒绝。后台页改为 `same-origin`，并加了测试。
- 打包 49 KiB（gzip 15 KiB），无运行时依赖。
- 未验证：真实飞书 webhook（按官方文档实现签名，测试按同一算法核对）。Email Routing 已实测：不能直接发到 `koe@44san.com`，通知改发已验证的 Gmail。

## 撤掉测试环境（2026-10-21）

- [x] `wrangler.jsonc` 只保留正式环境（Worker 名仍是 `koe`，原有 secrets 和域名不变）；脚本合并成 `npm run deploy`
- [x] 重新部署正式环境：健康检查、反馈页、Turnstile 站点密钥、后台拒绝未登录都正常，两个 secret 都在
- [x] 删除云端的 `koe-test` Worker（连同 `koe-test.44san.com` 域名）和 `koe-test` D1（里面只有 3 条测试反馈）
- [x] Turnstile widget 的域名只留 `koe.44san.com`
- [x] README、ARCHITECTURE §11 同步更新；新建 STATUS.md
- 验证：`npm test` 17/17，`npm run check` 通过
