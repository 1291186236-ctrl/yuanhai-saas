# ═══════════════════════════════════════════════════════════
# 商品自动化助手 SaaS - 环境变量配置清单
# ═══════════════════════════════════════════════════════════

# ── 数据库 ──
# Neon PostgreSQL 连接字符串
# 格式: postgresql://user:password@ep-xxx.region.aws.neon.tech/yuanhai?sslmode=require
DATABASE_URL=

# ── JWT 鉴权 ──
# 生产环境必须使用 64 位以上随机字符串
# 生成方法: openssl rand -hex 32
JWT_SECRET=
JWT_ACCESS_EXPIRES=15m
JWT_REFRESH_EXPIRES=7d

# ── Google OAuth ──
# 从 Google Cloud Console 获取
# https://console.cloud.google.com/apis/credentials
GOOGLE_CLIENT_ID=

# ── Lemon Squeezy 支付 ──
# 从 Lemon Squeezy Dashboard 获取
# https://app.lemonsqueezy.com/settings/api
LS_API_KEY=
LS_STORE_ID=
LS_WEBHOOK_SECRET=

# 产品 Variant ID（在 Lemon Squeezy 创建产品后获取）
LS_PRODUCT_PRO_MONTHLY_VARIANT_ID=
LS_PRODUCT_PRO_YEARLY_VARIANT_ID=
LS_PRODUCT_ENT_MONTHLY_VARIANT_ID=
LS_PRODUCT_ENT_YEARLY_VARIANT_ID=

# ── 邮件服务 ──
# 使用 Resend (https://resend.com)
RESEND_API_KEY=
MAIL_FROM=noreply@yourdomain.com

# ── 前端 ──
# Web 控制台地址
WEB_ORIGIN=https://app.yourdomain.com
# Chrome 插件 ID（上架后获取）
EXTENSION_ID=

# ── 环境 ──
NODE_ENV=production
PORT=3000

# ═══════════════════════════════════════════════════════════
# 配置步骤：
# 1. 复制此文件为 .env
# 2. 填写所有必填项
# 3. 运行 npm run setup 初始化数据库
# 4. 运行 npm start 启动服务
# ═══════════════════════════════════════════════════════════
