-- Model Tracking - Track models used and per-model token usage
-- Ported from kuato for cost analysis capabilities

-- Add model tracking columns
ALTER TABLE sessions.sessions ADD COLUMN models_used JSONB DEFAULT '[]';
ALTER TABLE sessions.sessions ADD COLUMN model_tokens JSONB DEFAULT '{}';

-- Index for model filtering (e.g., find all sessions using claude-sonnet-4)
CREATE INDEX idx_sessions_models ON sessions.sessions USING GIN(models_used jsonb_path_ops);
