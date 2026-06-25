-- Migration 002: Seed data & helper functions
-- 会员等级默认值、额度重置函数、测试用户

BEGIN;

-- ═══════════════════════════════════════════
-- 1. 会员等级配置表（可选，也可硬编码在应用层）
-- ═══════════════════════════════════════════
CREATE TABLE plan_config (
    plan            VARCHAR(20) PRIMARY KEY
                        CHECK (plan IN ('free', 'pro', 'enterprise')),

    display_name    VARCHAR(50) NOT NULL,
    quota_monthly   INTEGER NOT NULL,
    max_products    INTEGER NOT NULL DEFAULT 0,
    max_images      INTEGER NOT NULL DEFAULT 0,
    max_templates   INTEGER NOT NULL DEFAULT 1,
    can_export      BOOLEAN NOT NULL DEFAULT FALSE,
    can_resume      BOOLEAN NOT NULL DEFAULT FALSE,
    custom_sites    BOOLEAN NOT NULL DEFAULT FALSE,
    team_sharing    BOOLEAN NOT NULL DEFAULT FALSE,

    price_monthly   INTEGER NOT NULL DEFAULT 0,
    price_yearly    INTEGER NOT NULL DEFAULT 0,
    currency        VARCHAR(10) NOT NULL DEFAULT 'USD',

    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO plan_config (plan, display_name, quota_monthly, max_products, max_images, max_templates, can_export, can_resume, custom_sites, team_sharing, price_monthly, price_yearly) VALUES
    ('free',       'Free',       10,     5,   10, 1, FALSE, FALSE, FALSE, FALSE,    0,    0),
    ('pro',        'Pro',        999999, 0,   0,  0, TRUE,  TRUE,  FALSE, FALSE,  990, 9900),
    ('enterprise', 'Enterprise',  999999, 0,   0,  0, TRUE,  TRUE,  TRUE,  TRUE,  29900, 299000);

COMMENT ON TABLE plan_config IS '会员等级功能配置（0 = 无限制）';
COMMENT ON COLUMN plan_config.price_monthly IS '月付价格，单位：美分（cents），990 = $9.90';
COMMENT ON COLUMN plan_config.price_yearly IS '年付价格，单位：美分（cents），9900 = $99.00';

-- ═══════════════════════════════════════════
-- 2. 额度月度重置函数
-- ═══════════════════════════════════════════
CREATE OR REPLACE FUNCTION reset_monthly_quota()
RETURNS void AS $$
BEGIN
    UPDATE users
    SET quota_used  = 0,
        quota_total = COALESCE(
            (SELECT quota_monthly FROM plan_config WHERE plan = users.plan),
            10
        ),
        quota_reset_at = date_trunc('month', NOW() + INTERVAL '1 month')
    WHERE quota_reset_at <= NOW();
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION reset_monthly_quota IS '每月1号由定时任务调用，重置所有用户的额度';

-- ═══════════════════════════════════════════
-- 3. 额度扣减函数（事务安全，防超扣）
-- ═══════════════════════════════════════════
CREATE OR REPLACE FUNCTION deduct_quota(
    p_user_id UUID,
    p_amount  INTEGER DEFAULT 1
)
RETURNS TABLE(success BOOLEAN, remaining INTEGER, plan VARCHAR) AS $$
DECLARE
    v_plan VARCHAR(20);
    v_used INTEGER;
    v_total INTEGER;
BEGIN
    SELECT plan, quota_used, quota_total
    INTO v_plan, v_used, v_total
    FROM users WHERE id = p_user_id FOR UPDATE;

    IF v_plan IN ('pro', 'enterprise') THEN
        UPDATE users SET quota_used = quota_used + p_amount WHERE id = p_user_id;
        RETURN QUERY SELECT TRUE, 999999, v_plan::VARCHAR;
        RETURN;
    END IF;

    IF v_used + p_amount > v_total THEN
        RETURN QUERY SELECT FALSE, GREATEST(0, v_total - v_used), v_plan::VARCHAR;
        RETURN;
    END IF;

    UPDATE users SET quota_used = quota_used + p_amount WHERE id = p_user_id;
    RETURN QUERY SELECT TRUE, v_total - v_used - p_amount, v_plan::VARCHAR;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION deduct_quota IS '原子扣减额度，Pro/Enterprise 不限额，Free 防超扣';

-- ═══════════════════════════════════════════
-- 4. 用户升级函数（订阅激活时调用）
-- ═══════════════════════════════════════════
CREATE OR REPLACE FUNCTION upgrade_user_plan(
    p_user_id UUID,
    p_new_plan VARCHAR
)
RETURNS void AS $$
BEGIN
    UPDATE users
    SET plan        = p_new_plan,
        quota_total = COALESCE(
            (SELECT quota_monthly FROM plan_config WHERE plan = p_new_plan),
            999999
        )
    WHERE id = p_user_id;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION upgrade_user_plan IS '订阅激活/升级时更新用户会员等级和额度';

COMMIT;
