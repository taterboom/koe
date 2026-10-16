# Koe（声）

44san 旗下各产品共用的用户反馈服务，以产品标识（product key）区分产品。首个接入的产品是飛雷神 `hiraishin`。

一个 Cloudflare Worker、一个 D1、静态产品配置，与 [menkyo](../menkyo) 同一套技术栈和原则。用户在网页上主动填写并提交反馈；产品本身不上报任何数据。开发者在一个简单的管理后台查看反馈，并配置邮件和飞书通知。

背景、需求与已定事项见 [PLAN.md](PLAN.md)，开发约束见 [AGENTS.md](AGENTS.md)。

## 当前状态

已实现并通过本地测试；**测试环境和正式环境都已上线**，Turnstile、Email Routing、邮件通知都已开通并实测。

- `GET /<product>`：反馈页。字段为类型、内容（最多 2000 字）、回复邮箱（选填），加 Turnstile 人机验证。页面按 `config/products.json` 显示产品名和 logo，只显示该产品允许的反馈类型。中日英三语，规则与 menkyo 付款完成页相同：`?lang=` 优先，其次按浏览器语言，默认英文。
- 链接只读取 `v`（版本）和 `lang` 两个参数，其他参数忽略、也不会回显。版本格式不对时按"未知"处理，反馈照常提交。
- `POST /<product>`：普通表单提交。服务端依次做这些事：按实际读到的字节数限制请求体（32 KiB）；只读取白名单字段；校验类型、长度和邮箱格式；调用 Turnstile siteverify；写入 D1；303 跳转到确认页。校验失败时重新显示表单，保留已填内容。siteverify 不可用时提示稍后重试，不会当作验证失败。
- 保存的字段：内容、类型、回复邮箱、产品、版本、语言、国家 / 地区代码（取自 Cloudflare 的 `request.cf.country`）、时间。不保存 IP 和 User-Agent。
- `GET /<product>/thanks`：确认页。
- 通知：写库成功后在 `waitUntil` 中发出，发给所有启用、且产品范围匹配的渠道。
  - 邮件走 `send_email` 绑定，发件人为 `MAIL_FROM`。用户留了邮箱时，Reply-To 设为用户邮箱，直接回复通知邮件即可回复用户。
  - 飞书 / Lark 自定义机器人，支持签名校验。
  - 任一渠道失败只记日志（渠道 id 和错误码），不影响已保存的反馈。
- `/admin`：管理后台，只做中文。
  - 登录：用 `ADMIN_TOKEN` 登录，会话 cookie 保存 7 天，内容是用 token 签名的过期时间，更换 token 即让所有登录失效。
  - 反馈：按产品、类型、是否收藏筛选；可收藏（星标）重要的反馈；可删除。
  - 通知渠道：添加、启停、删除，发送测试通知。飞书只接受 `open.feishu.cn` / `open.larksuite.com` 的机器人地址，页面上打码显示，签名密钥不回显。
  - 所有 POST 都必须同源（校验 Origin）。
- `GET /health`。

## 产品接入

在产品里打开链接即可，不需要 SDK：

```text
https://koe.44san.com/<product>?v=<产品版本>&lang=<zh|ja|en>
```

新增产品：在 `config/products.json` 加一项（key、`name`、三语 `display_name`、`logo_url`、`kinds`），然后部署。key 只能用小写字母、数字、`-`、`_`，不能叫 `admin`。

## 本地开发

```sh
npm ci
cp .dev.vars.example .dev.vars        # 填一个至少 32 字符的 ADMIN_TOKEN；Turnstile 用的是官方测试密钥
npx wrangler d1 migrations apply koe-test --local
npm run dev                           # http://localhost:8787/hiraishin 、 /admin
```

本地的 `send_email` 绑定不会真的发信，邮件内容写在 `.wrangler/tmp/email/` 下。

```sh
npm test          # 关键行为测试（真实 workerd + D1）
npm run check     # 类型生成 + tsc + 部署预检，不会发布
```

查看数据也可以直接用 SQL：

```sh
npx wrangler d1 execute koe --env production --remote --command "SELECT id, product, kind, starred, created_at, content FROM feedback ORDER BY id DESC LIMIT 20"
```

## 环境变量

**密钥（2 个）**：名称写在 `wrangler.jsonc` 的 `secrets.required` 中。本地放在 `.dev.vars`，线上用 `wrangler secret put <NAME> [--env production]` 设置。

| 名称 | 用途 |
| --- | --- |
| `TURNSTILE_SECRET_KEY` | Turnstile 服务端校验。本地用官方测试密钥 `1x0000000000000000000000000000000AA`（永远通过） |
| `ADMIN_TOKEN` | 后台登录，同时用来给会话 cookie 签名。至少 32 个字符：`node -e "console.log(crypto.randomBytes(32).toString('base64url'))"` |

**普通变量（2 个）**：直接写在 `wrangler.jsonc` 的 `vars`，测试与正式环境各一份。

| 名称 | 用途 |
| --- | --- |
| `TURNSTILE_SITE_KEY` | Turnstile 公开站点密钥，为空时反馈页返回 503。本地开发由 `.dev.vars` 覆盖为官方测试 key |
| `MAIL_FROM` | 通知邮件的发件人，必须是开启了 Email Routing 的域名下的地址（`koe@44san.com`） |

## 环境与部署

| | 测试环境 | 正式环境 |
| --- | --- | --- |
| 地址 | `https://koe-test.44san.com` | `https://koe.44san.com` |
| Worker / D1 | `koe-test` / `koe-test` | `koe` / `koe` |
| 部署 | `npm run deploy:test` | `npm run deploy:production` |

`wrangler.jsonc` 顶层是测试环境，`npm run dev` 和不带参数的部署都碰不到正式环境。

## 上线记录与待办

已完成（2026-10-16）：
- D1 `koe-test`、`koe` 已建好并迁移；两个环境已部署到 `koe-test.44san.com`、`koe.44san.com`。
- Turnstile widget `koe`（站点密钥 `0x4AAAAAAFYRXdO-syJF90ED`）同时用于两个域名；私钥已设为两个环境的 secret。
- 44san.com 已开启 Email Routing，`koe@44san.com` 转发到开发者的 Gmail。
  - 实测免费套餐**不能**直接发到 `koe@44san.com`，会返回 `E_RECIPIENT_NOT_ALLOWED`。所以两个环境的通知渠道都填那个已验证的 Gmail。
  - `koe@44san.com` 仍是发件人和对外地址。
- 两个环境的后台都已发出测试通知。后台口令和 Turnstile 私钥已存进密码管理器；Turnstile 私钥也可以在 Cloudflare 后台查看。
- 飛雷神已接入，官网已重新部署：首页三语页脚和三语隐私页都带 Koe 链接。设置页里的入口随下一个扩展版本发布。

暂不配置限流：免费套餐每个域名只能建一条速率限制规则，这一条现在给了 menkyo。改用付费套餐后，再给 Koe 单独建一条，在 Cloudflare 后台 → 44san.com → Security → WAF → Rate limiting rules 新建。建议表达式（只限制 POST，按 IP 计数）：

```text
(http.host in {"koe.44san.com" "koe-test.44san.com"} and http.request.method eq "POST")
```

在此之前，提交靠 Turnstile 挡机器人。后台登录靠至少 32 位的随机 `ADMIN_TOKEN`，在线暴力猜测不可行。

还剩（需要你操作）：
1. **44san 总的隐私说明**（如果有）：写明反馈长期保存、如何申请删除、用到的外部服务（Cloudflare、飞书）。
