-- Migration 001: Initial schema
-- 创建所有核心表

BEGIN;

-- ═══════════════════════════════════════════
-- 1. 用户表
-- ═══════════════════════════════════════════
CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email           VARCHAR(255) UNIQUE NOT NULL,
    password_hash   VARCHAR(255),
    google_id       VARCHAR(255) UNIQUE,
    name            VARCHAR(100) NOT NULL DEFAULT '',
    avatar_url      TEXT,

    plan            VARCHAR(20) NOT NULL DEFAULT 'free'
                        CHECK (plan IN ('free', 'pro', 'enterprise')),
    quota_total     INTEGER NOT NULL DEFAULT 10,
    quota_used      INTEGER NOT NULL DEFAULT 0,
    quota_reset_at  TIMESTAMPTZ NOT NULL DEFAULT
                        date_trunc('month', NOW() + INTERVAL '1 month'),

    auth_provider   VARCHAR(20) NOT NULL DEFAULT 'email'
                        CHECK (auth_provider IN ('email', 'google')),
    email_verified  BOOLEAN NOT NULL DEFAULT FALSE,

    last_login_at   TIMESTAMPTZ,
    last_login_ip   INET,

    status          VARCHAR(20) NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'suspended', 'deleted')),

    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_google_id ON users(google_id) WHERE google_id IS NOT NULL;
CREATE INDEX idx_users_plan ON users(plan);
CREATE INDEX idx_users_quota_reset_at ON users(quota_reset_at);

COMMENT ON TABLE users IS '用户主表';
COMMENT ON COLUMN users.quota_total IS '当月可用额度（Free=10, Pro/Enterprise=999999）';
COMMENT ON COLUMN users.quota_used IS '当月已用额度';
COMMENT ON COLUMN users.quota_reset_at IS '额度下次重置时间（每月1号自动重置）';

-- ═══════════════════════════════════════════
-- 2. 订阅表
-- ═══════════════════════════════════════════
CREATE TABLE subscriptions (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id               UUID UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    ls_subscription_id    VARCHAR(255) UNIQUE,
    ls_customer_id        VARCHAR(255),
    ls_product_id         VARCHAR(255),
    ls_variant_id         VARCHAR(255),

    plan                  VARCHAR(20) NOT NULL
                              CHECK (plan IN ('pro', 'enterprise')),
    status                VARCHAR(30) NOT NULL DEFAULT 'active'
                              CHECK (status IN (
                                  'active', 'past_due', 'cancelled',
                                  'expired', 'paused', 'unpaid'
                              )),

    current_period_start  TIMESTAMPTZ,
    current_period_end    TIMESTAMPTZ,
    cancel_at_period_end  BOOLEAN NOT NULL DEFAULT FALSE,
    cancelled_at          TIMESTAMPTZ,

    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_subs_user ON subscriptions(user_id);
CREATE INDEX idx_subs_ls_sub_id ON subscriptions(ls_subscription_id) WHERE ls_subscription_id IS NOT NULL;
CREATE INDEX idx_subs_status ON subscriptions(status);
CREATE INDEX idx_subs_period_end ON subscriptions(current_period_end) WHERE status = 'active';

COMMENT ON TABLE subscriptions IS 'Lemon Squeezy 订阅记录，一个用户最多一条活跃订阅';
COMMENT ON COLUMN subscriptions.ls_subscription_id IS 'Lemon Squeezy 侧的订阅 ID';
COMMENT ON COLUMN subscriptions.cancel_at_period_end IS '用户已取消但当前周期未结束';

-- ═══════════════════════════════════════════
-- 3. 订单表
-- ═══════════════════════════════════════════
CREATE TABLE orders (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    ls_order_id         VARCHAR(255),
    ls_order_item_id    VARCHAR(255),
    order_number        VARCHAR(100),

    product_name        VARCHAR(255),
    variant_name        VARCHAR(255),

    amount              INTEGER NOT NULL DEFAULT 0,
    currency            VARCHAR(10) NOT NULL DEFAULT 'USD',

    status              VARCHAR(30) NOT NULL DEFAULT 'pending'
                            CHECK (status IN (
                                'pending', 'paid', 'refunded',
                                'partially_refunded', 'voided'
                            )),

    ls_subscription_id  VARCHAR(255),

    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_orders_user ON orders(user_id);
CREATE INDEX idx_orders_ls_order_id ON orders(ls_order_id) WHERE ls_order_id IS NOT NULL;
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_orders_created ON orders(created_at);

COMMENT ON TABLE orders IS 'Lemon Squeezy 订单记录，amount 单位为分（cents）';

-- ═══════════════════════════════════════════
-- 4. 使用记录表
-- ═══════════════════════════════════════════
CREATE TABLE usage_records (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    action          VARCHAR(50) NOT NULL DEFAULT 'task_start'
                        CHECK (action IN (
                            'task_start', 'analysis_only',
                            'imagegen_only', 'export'
                        )),

    product_count   INTEGER NOT NULL DEFAULT 0,
    image_count     INTEGER NOT NULL DEFAULT 0,
    quota_charged   INTEGER NOT NULL DEFAULT 1,

    metadata        JSONB DEFAULT '{}',

    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_usage_user ON usage_records(user_id);
CREATE INDEX idx_usage_action ON usage_records(action);
CREATE INDEX idx_usage_created ON usage_records(created_at);
CREATE INDEX idx_usage_user_created ON usage_records(user_id, created_at);

COMMENT ON TABLE usage_records IS '每次任务启动/导出时记录，用于额度扣减审计和统计分析';
COMMENT ON COLUMN usage_records.quota_charged IS '本次扣减的额度数（通常为1）';
COMMENT ON COLUMN usage_records.metadata IS '额外信息：商品名列表、耗时等';

-- ═══════════════════════════════════════════
-- 5. Refresh Token 表
-- ═══════════════════════════════════════════
CREATE TABLE refresh_tokens (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    token_hash      VARCHAR(255) NOT NULL,
    device_info     VARCHAR(255) DEFAULT '',
    expires_at      TIMESTAMPTZ NOT NULL,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_rt_user ON refresh_tokens(user_id);
CREATE INDEX idx_rt_hash ON refresh_tokens(token_hash);
CREATE INDEX idx_rt_expires ON refresh_tokens(expires_at);

COMMENT ON TABLE refresh_tokens IS 'JWT refresh token，支持多设备登录';

-- ═══════════════════════════════════════════
-- 6. 邮箱验证码表
-- ═══════════════════════════════════════════
CREATE TABLE email_verifications (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    email           VARCHAR(255) NOT NULL,
    code            VARCHAR(10) NOT NULL,

    expires_at      TIMESTAMPTZ NOT NULL,
    verified_at     TIMESTAMPTZ,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_ev_email ON email_verifications(email);
CREATE INDEX idx_ev_expires ON email_verifications(expires_at);

COMMENT ON TABLE email_verifications IS '注册/重置密码时的邮箱验证码';

-- ═══════════════════════════════════════════
-- 7. License Key 表（企业版激活码）
-- ═══════════════════════════════════════════
CREATE TABLE license_keys (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID REFERENCES users(id) ON DELETE SET NULL,

    key                 VARCHAR(64) UNIQUE NOT NULL,

    plan                VARCHAR(20) NOT NULL
                            CHECK (plan IN ('pro', 'enterprise')),

    status              VARCHAR(20) NOT NULL DEFAULT 'unused'
                            CHECK (status IN ('unused', 'active', 'expired', 'revoked')),

    max_activations     INTEGER NOT NULL DEFAULT 1,
    activation_count    INTEGER NOT NULL DEFAULT 0,

    expires_at          TIMESTAMPTZ,

    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_lk_key ON license_keys(key);
CREATE INDEX idx_lk_user ON license_keys(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX idx_lk_status ON license_keys(status);

COMMENT ON TABLE license_keys IS '企业版批量分发激活码，也可用于促销码';

-- ═══════════════════════════════════════════
-- 8. 触发器：自动更新 updated_at
-- ═══════════════════════════════════════════
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_updated BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER trg_subscriptions_updated BEFORE UPDATE ON subscriptions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER trg_license_keys_updated BEFORE UPDATE ON license_keys
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ═══════════════════════════════════════════
-- 9. 视图：用户订阅摘要（常用查询封装）
-- ═══════════════════════════════════════════
CREATE OR REPLACE VIEW v_user_subscription AS
SELECT
    u.id AS user_id,
    u.email,
    u.name,
    u.plan,
    u.quota_total,
    u.quota_used,
    GREATEST(0, u.quota_total - u.quota_used) AS quota_remaining,
    u.quota_reset_at,
    u.email_verified,
    u.status AS user_status,
    s.ls_subscription_id,
    s.status AS subscription_status,
    s.current_period_start,
    s.current_period_end,
    s.cancel_at_period_end,
    s.plan AS subscription_plan
FROM users u
LEFT JOIN subscriptions s ON s.user_id = u.id AND s.status = 'active';

COMMENT ON VIEW v_user_subscription IS '用户+订阅联合视图，插件端 /api/me 直接查此视图';

COMMIT;
