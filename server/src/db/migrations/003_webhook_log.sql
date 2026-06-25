-- Migration 003: Webhook event log (idempotency)
BEGIN;

CREATE TABLE webhook_events (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_name      VARCHAR(100) NOT NULL,
    ls_event_id     VARCHAR(255) UNIQUE,
    payload         JSONB NOT NULL DEFAULT '{}',
    processed       BOOLEAN NOT NULL DEFAULT FALSE,
    error_message   TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at    TIMESTAMPTZ
);

CREATE INDEX idx_we_ls_event_id ON webhook_events(ls_event_id) WHERE ls_event_id IS NOT NULL;
CREATE INDEX idx_we_processed ON webhook_events(processed) WHERE NOT processed;
CREATE INDEX idx_we_created ON webhook_events(created_at);

COMMENT ON TABLE webhook_events IS 'Webhook 事件日志，用于幂等性校验和问题排查';

COMMIT;
