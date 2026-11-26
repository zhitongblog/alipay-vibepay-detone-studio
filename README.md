# DeTone Studio｜文章去 AI 味三层体检与精修工作台（支付宝 Vibe Pay 参赛作品）

面向自媒体创作者、职场写作者与高校学生的中文文章「三层去 AI 味」体检与精修 Web 应用，完整接入 **支付宝 AI 网页应用收款（Vibe Pay / `alipay.trade.page.pay`）**。

## 核心特性

1. **三层确定性去 AI 味引擎**（零幻觉、秒级出结果）：
   - **A 级机械套话层**：覆盖 20+ 高频大模型翻译腔与黑话（值得注意的是、综上所述、赋能、抓手、形成闭环、双刃剑等）；
   - **B 级结构指纹层**：自动检测结论冒号轰炸、破折号译制腔、三连排比、“不仅…而且…”、“不是…而是…”模板；
   - **C 级逐句精修层**：定位病灶并生成自然口语化改写对照与 Markdown 报告下载。
2. **支付宝 AI 网页应用收款全链路闭环**：
   - `POST /api/orders/create`：服务端 RSA2 签名生成 `alipay.trade.page.pay` 跳转链接（覆盖 PC 网页与手机浏览器 H5）；
   - `GET /api/orders/:outTradeNo/status`：主动调用 `alipay.trade.query` 对账确认金额与交易状态，即使未配置公网 `notify_url` 或用户关页也能可靠履约；
   - `POST /api/alipay/notify`：服务端 RSA2 验签 + `app_id` / `total_amount` / `out_trade_no` 校验 + 幂等落单 + 标准回写 `success`；
   - 私钥仅保留在服务端环境变量，前端零密钥暴露。

## 快速运行与测试

```bash
npm install
npm test
npm start
# 打开 http://127.0.0.1:3088
```
