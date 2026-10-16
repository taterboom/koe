# Koe 架构文档

更新：2026-10-16。状态：首版已实现，测试与正式环境均已上线。需求与取舍见 PLAN.md，约束见 AGENTS.md；本文只讲"怎么做"。

## 1. 定位

44san 旗下各产品共用的用户反馈服务，组成是一个 Cloudflare Worker、一个 D1 数据库和一份静态产品配置（`config/products.json`）。

- 用户在网页上主动填写并提交反馈；产品只负责打开一个链接，不嵌 SDK，也不上报任何数据。
- 开发者在 `/admin` 查看和处理反馈，并配置通知渠道。通知渠道有两种：邮件、飞书 / Lark 机器人。
- 不做账号体系、公开需求墙、附件上传，也不做自动清理。

## 2. 系统架构

```text
                        ┌──────────────── Cloudflare 边缘 ────────────────┐
 用户浏览器              │  速率限制规则（付费后配置；按 IP，只在边缘计数）    │
 ┌───────────────┐      │                                                │
 │ 产品（飛雷神）  │ 打开链接 /hiraishin?v=1.2.0&lang=ja                   │
 │ 设置页 / 官网   │──────┼──►┌──────────────── Koe Worker ─────────────┐ │
 └───────────────┘      │   │ app.ts     路由、提交流程                  │ │
 ┌───────────────┐      │   │ pages.ts   反馈页 / 确认页（三语）          │ │
 │ 反馈页（表单）  │─POST─┼──►│ feedback.ts 校验、D1 读写                  │ │
 │ Turnstile 组件 │      │   │ turnstile.ts siteverify                    │ │
 └───────────────┘      │   │ notify.ts  通知渠道、邮件、飞书             │ │
                        │   │ admin.ts   后台、登录会话                  │ │
 开发者浏览器 ───/admin──┼──►│ config/products.json（打包进 Worker）      │ │
                        │   └──┬──────────┬───────────┬────────────────┘ │
                        │      │          │           │                  │
                        │      ▼          ▼           ▼                  │
                        │   ┌─────┐  ┌──────────┐  ┌────────────────┐    │
                        │   │ D1  │  │Turnstile │  │ Email Service  │    │
                        │   │feedback│ siteverify│  │ send_email 绑定 │    │
                        │   │channels│          │  └──────┬─────────┘    │
                        │   └─────┘  └──────────┘         │              │
                        └──────────────────────────────────┼──────────────┘
                                                           ▼
                         飞书 / Lark 开放平台 ◄─fetch─ Worker      开发者邮箱（已验证地址）
```

外部依赖只有三个：Turnstile、Email Service（都属于 Cloudflare）和飞书开放平台。Worker 没有运行时 npm 依赖。

## 3. 模块

| 文件 | 职责 |
| --- | --- |
| `src/index.ts` | 入口：载入产品配置，创建处理器 |
| `src/app.ts` | 路由；反馈页、提交、确认页的处理流程；兜底错误处理 |
| `src/http.ts` | 按实际读取字节数限制请求体；文本响应与 303 跳转 |
| `src/html.ts` | HTML 转义；统一的页面外壳与安全头（CSP nonce、noindex 等） |
| `src/pages.ts` | 反馈页、确认页、不可用页的 HTML |
| `src/i18n.ts` | 语言选择规则（与 menkyo 相同）和三语文案 |
| `src/feedback.ts` | 字段白名单与校验、`feedback` 表读写、标签与时间格式 |
| `src/turnstile.ts` | Turnstile 服务端校验 |
| `src/notify.ts` | `channels` 表读写、地址校验与打码、邮件与飞书投递、新反馈通知 |
| `src/admin.ts` | 后台页面、登录会话、同源校验、各项操作 |
| `src/crypto.ts` | HMAC、SHA-256、常数时间比较、随机 nonce（Web Crypto） |

## 4. 路由

| 方法与路径 | 说明 |
| --- | --- |
| `GET /<product>` | 反馈页。只读取 `v`、`lang` 两个参数 |
| `POST /<product>` | 提交（表单编码）。成功返回 303 到确认页；失败重新显示表单并保留已填内容 |
| `GET /<product>/thanks` | 确认页 |
| `GET /admin` | 未登录时显示登录页；登录后显示反馈列表（`?id=`、`?product=`、`?kind=`、`?starred=1`、`?before=`） |
| `POST /admin/login`、`/admin/logout` | 登录、退出 |
| `POST /admin/feedback/<id>/star`、`/delete` | 收藏或取消收藏（`starred=1/0`）、删除 |
| `GET /admin/channels`，`POST /admin/channels` | 渠道列表、添加渠道 |
| `POST /admin/channels/<id>/test`、`/toggle`、`/delete` | 测试、启停、删除 |
| `GET /health` | 健康检查 |

未知产品一律返回 404。`/admin` 先于产品路由匹配，所以 `admin` 不能用作产品 key。

## 5. 提交流程

```text
用户浏览器                      Koe Worker                          Turnstile    D1        通知渠道
    │ GET /hiraishin?v=1.2.0&lang=ja │                                      │         │            │
    │──────────────────────────────►│ 产品已知？否 → 404                     │         │            │
    │                               │ 只取 v、lang；v 不合法 → 视为未知       │         │            │
    │◄────── 表单 + Turnstile 组件 ───│ （站点密钥或私钥为空 → 503）            │         │            │
    │  Turnstile 在浏览器内完成验证，令牌写进隐藏字段，提交按钮才可用             │         │            │
    │ POST 表单                      │                                      │         │            │
    │──────────────────────────────►│ ① 按实际读取字节限 32 KiB，超出 → 413   │         │            │
    │                               │ ② 只读 kind/content/email/v/lang/令牌  │         │            │
    │                               │ ③ 校验：类型在该产品允许范围内、内容      │         │            │
    │                               │    非空且 ≤2000 字（换行归一后）、邮箱格式 │         │            │
    │◄──── 400 表单（保留已填内容） ──│    任一不合格；此时不调用 Turnstile      │         │            │
    │                               │ ④ siteverify ──────────────────────►│         │            │
    │◄──── 400 "验证失败" ───────────│ ◄──── success:false ─────────────────│         │            │
    │◄──── 500 "稍后再试" ───────────│ ◄──── 非 2xx（服务故障）──────────────│         │            │
    │                               │ ⑤ INSERT … RETURNING id ────────────────────────►│            │
    │                               │    国家取自 request.cf.country          │         │            │
    │◄──── 303 → /hiraishin/thanks ──│ ⑥ waitUntil(通知) ─────── 响应已返回之后执行 ───────────────►│
    │ GET 确认页                     │                                      │         │            │
```

关键点：
- **先写库再通知**。通知在 `waitUntil` 里异步执行，任何渠道出错都只记日志，用户拿到的结果和已保存的反馈都不受影响。
- **只用表单 POST**。提交成功后用 303 跳转（PRG 模式），刷新确认页不会重复提交。页面上唯一的脚本只负责在拿到 Turnstile 令牌后启用按钮，并防止重复点击。
- **字段白名单靠"只读取"实现**：服务端只读取那几个字段。收藏标记、国家、时间等都由服务端决定，表单里传什么都会被忽略。

## 6. 通知流程

```text
notifyNew(record)
  │ SELECT … FROM channels WHERE enabled = 1        （预计个位数行）
  │ 过滤：products 为 NULL（全部产品）或包含 record.product
  │ 生成消息：产品、类型、版本、语言、国家、回复邮箱、时间（东京）、内容、后台链接
  ├─► 邮件：env.EMAIL.send({ from: MAIL_FROM, to, subject, text, replyTo: 用户邮箱 })
  │        失败时记录 E_* 错误码（如 E_RECIPIENT_NOT_ALLOWED）
  └─► 飞书：POST 机器人 webhook { msg_type: "text", content, [timestamp, sign] }
           sign = base64(HMAC-SHA256(key = timestamp + "\n" + secret, message = ""))
           HTTP 200 且 code = 0 才算成功；否则记 feishu_<code> 或 feishu_unreachable
  各渠道并行投递，单独兜底：console.error('notify_failed', 渠道 id, 类型, 错误码)
```

日志里不出现渠道地址、反馈内容和用户邮箱。后台的"发送测试通知"走同一个 `deliver()`，并在页面上直接显示错误码。

## 7. 后台登录与会话

```text
GET /admin（无有效 cookie）→ 登录页，带上 next=原地址
POST /admin/login  token=…
  ├ Origin 必须等于本站，否则 403
  ├ SHA-256(输入) 与 SHA-256(ADMIN_TOKEN) 做常数时间比较，不对 → 401
  └ Set-Cookie: koe_admin=<exp>.<HMAC-SHA256(ADMIN_TOKEN, "koe-admin:"+exp)>
                Path=/admin; Max-Age=7 天; HttpOnly; Secure; SameSite=Lax
     303 → next（只允许 /admin 开头的站内地址，防开放重定向）

之后每个后台请求：
  POST 先查 Origin（跨站或 Origin 为 null → 403）
  cookie 格式、是否过期、签名逐项校验 → 失败：GET 显示登录页，POST 返回 401
```

- **服务端不存会话**。cookie 自带过期时间和签名，更换 `ADMIN_TOKEN` 即让所有已登录会话失效。
- **SameSite=Lax**：从飞书或邮件里点后台链接时，浏览器会带上 cookie，不用重新登录。跨站 POST 还要过 Origin 校验，这一关挡掉 CSRF。
- **后台页用 `Referrer-Policy: same-origin`**：如果用 `no-referrer`，浏览器提交表单时会发 `Origin: null`，后台自己的表单都会被拒绝（见 tasks/lessons.md）。

## 8. 数据模型（ER 图）

```text
 config/products.json（静态，随 Worker 打包）
 ┌──────────────────────────────┐
 │ <product key>  例 hiraishin   │
 │   name           飛雷神        │
 │   display_name   {zh,ja,en}   │
 │   logo_url                    │
 │   kinds          [feature,…]  │
 └──────────────┬───────────────┘
                │ 1 : N（按 key 逻辑关联，无外键）
     ┌──────────┴──────────────────┐            ┌──────────────────────────────┐
     ▼                             │            │ channels                     │
 ┌──────────────────────────────┐  │  N : M     ├──────────────────────────────┤
 │ feedback                     │  └ ─ ─ ─ ─ ─ ►│ id          INTEGER PK       │
 ├──────────────────────────────┤  products 为   │ kind        email | feishu   │
 │ id          INTEGER PK       │  NULL = 全部， │ target      邮箱 / webhook    │
 │ product     TEXT  NOT NULL   │  否则 JSON     │ secret      TEXT（飞书签名）   │
 │ kind        feature|bug|other│  数组列出产品  │ products    TEXT（JSON 或 NULL）│
 │ content     TEXT  ≤2000 字   │               │ enabled     0 | 1            │
 │ email       TEXT  可空        │               │ created_at  INTEGER (ms)     │
 │ version     TEXT  可空        │               └──────────────────────────────┘
 │ lang        zh | ja | en     │
 │ country     TEXT  可空（cf）   │
 │ starred     0 | 1（星标）     │
 │ created_at  INTEGER (ms)     │
 └──────────────────────────────┘
```

- **没有外键**：产品存在静态配置里，不在库里。配置里删掉某个产品后，它的旧反馈仍会显示，产品列显示为 key 本身。
- **没有二级索引**：提交只做插入；后台按主键倒序翻页（每页 50 条）。按收藏等条件筛选时会顺着主键扫描，直到凑满一页。预计数据量在千条级，而且只有后台会查询，代价可以忽略。数据量明显变大时，再加 `(starred, id)` 索引。
- **CHECK 约束**：枚举字段都在库里也做了限制，即使代码出错也写不进非法值。

读写成本：

| 操作 | D1 读 | D1 写 |
| --- | --- | --- |
| 提交一条反馈 | 渠道数（个位数） | 1 行 |
| 后台列表一页 | ≤ 51 行（带筛选时可能扫描更多） | 0 |
| 收藏 / 删除 | 1 行 | 1 行 |
| 渠道页 / 测试通知 | 渠道数 | 0 |

## 9. 安全与隐私边界

| 风险 | 对策 |
| --- | --- |
| 机器人刷反馈 | Turnstile 服务端校验（令牌一次性，5 分钟过期）；升级付费套餐后再加边缘速率限制规则 |
| 超大请求体 | 按实际读取的字节数限制（提交 32 KiB，后台 8 KiB），不信任 Content-Length |
| 链接夹带浏览数据 | 只读 `v` / `lang`；其他参数既不存储，也不回显 |
| 伪造收藏标记、国家、时间等字段 | 服务端只读取白名单字段，其余一律由服务端决定 |
| XSS | 所有输出都经过 HTML 转义；CSP 只允许带 nonce 的脚本和 Turnstile 来源；`frame-ancestors 'none'` |
| CSRF / 后台被盗用 | 签名 cookie（HttpOnly、Secure、Lax）+ 每个 POST 校验 Origin；`ADMIN_TOKEN` 至少 32 位随机字符，在线暴力猜测不可行 |
| 开放重定向 | 登录回跳和操作回跳只允许 `/admin` 开头的地址 |
| 渠道被指向任意地址（SSRF） | 飞书只接受 `open.feishu.cn` / `open.larksuite.com` 的机器人路径 |
| 凭据泄露 | webhook 地址和签名密钥只存 D1，页面打码显示，日志只记渠道 id 和错误码；`ADMIN_TOKEN`、Turnstile 私钥放在 Worker secrets |
| 个人信息 | 不存 IP 和 User-Agent；国家由 Cloudflare 判定；回复邮箱选填；反馈长期保存，需要时在后台手动删除 |

用户数据会流向哪些地方：D1（Cloudflare），以及开发者配置的通知渠道（开发者邮箱、飞书）。隐私说明里要列出 Cloudflare 和飞书（PLAN.md §2.5）。

## 10. 免费套餐预算

| 资源 | 免费额度 | Koe 用量 |
| --- | --- | --- |
| Workers 请求 | 10 万次 / 天 | 每条反馈约 3 次（打开页面、提交、确认页） |
| Workers CPU | 每次请求 10 ms | 线上实测（2026-10-16，`wrangler tail`）：提交 5 ms，含写库与邮件通知；反馈页 1–2 ms；确认页 1 ms；后台页 1–5 ms；测试通知 2 ms；扫描器打到的 404 约 0 ms |
| D1 | 读 500 万行 / 天，写 10 万行 / 天，存储 5 GB | 每条反馈写 1 行；一万条反馈约 20 MB |
| Turnstile | 免费 | 每条反馈调用 1 次 siteverify |
| Email Service | 发往已验证地址免费，不占额度 | 每条反馈每个邮件渠道 1 封 |
| 飞书机器人 | 每分钟 100 条、每秒 5 条 | 远低于上限 |
| 速率限制规则 | 每个域名 1 条（已给 menkyo） | Koe 暂不配置，升级付费套餐后单独配一条 |

## 11. 环境与配置

| | 测试环境 | 正式环境 |
| --- | --- | --- |
| 地址 | `koe-test.44san.com` | `koe.44san.com` |
| Worker / D1 | `koe-test` / `koe-test` | `koe` / `koe` |
| Turnstile | 一个 widget，两个域名共用 | 同一个 |
| `ADMIN_TOKEN` | 测试环境单独一个 | 正式环境单独一个 |

`wrangler.jsonc` 顶层是测试环境，`--env production` 才是正式环境，这与 menkyo 一致。变量与密钥的说明见 README。

## 12. 已知限制与以后可做

- **没有自动清理**：反馈长期保存，需要时在后台手动删除。
- **通知不重试**：失败只记日志，反馈仍在后台。需要时可以加"重发通知"按钮，或者每周汇总邮件（PLAN.md 的后续可选项）。
- **后台功能很少**：没有搜索，也没有回复记录。回复靠通知邮件的 Reply-To 直接回给用户。
- **渠道只有两种**：邮件和飞书 / Lark。企业微信、钉钉、Slack 等用到时再加。
