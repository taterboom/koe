# Lessons

## 2026-10-16 Referrer-Policy 会影响 Origin 校验

- 错误：所有页面统一用 `Referrer-Policy: no-referrer`，后台又按 Origin 头防 CSRF。浏览器在 no-referrer 页面提交表单时发 `Origin: null`，后台所有 POST 都被拒绝。单元测试手动设置了 Origin，没能发现，直到浏览器冒烟才暴露。
- 规则：用 Origin 校验的页面，Referrer-Policy 至少设为 `same-origin`。
- 规则：涉及浏览器行为的安全头（CSP、Referrer-Policy、cookie 属性），必须在真实浏览器里走一遍，不能只靠请求级测试。

## 2026-10-16 免费套餐 CPU 要线上实测，Intl 时区很贵

- 现象：线上第一次真实提交用了 8 ms CPU，免费套餐上限是 10 ms。本地测试和 dry-run 都看不出来。
- 原因：通知里用 `Intl.DateTimeFormat` 加 `timeZone: 'Asia/Tokyo'` 格式化时间，第一次使用要加载时区数据。改成固定 UTC+9 计算（日本没有夏令时）后，后台同类请求从最多 14 ms 降到最多 5 ms。
- 规则：Worker 里避免 `Intl` 时区和语言格式化；固定偏移能满足需要时，直接做算术。
- 规则：上线后先用 `wrangler tail --format json` 看每类请求的 `cpuTime`，再在文档里写预算。
