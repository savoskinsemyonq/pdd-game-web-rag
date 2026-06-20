-- PDD game database schema

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  login VARCHAR(32) UNIQUE NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  display_name VARCHAR(64) NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Migration for existing databases
ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name VARCHAR(64);
UPDATE users SET display_name = login WHERE display_name IS NULL OR display_name = '';

ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(64) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_active BOOLEAN NOT NULL DEFAULT FALSE,
  best_by_mission JSONB NOT NULL DEFAULT '{}',
  topics_to_review JSONB NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  mission_id VARCHAR(64) NOT NULL,
  mission_title VARCHAR(255) NOT NULL,
  completed_at BIGINT NOT NULL,
  correct INT NOT NULL DEFAULT 0,
  total INT NOT NULL DEFAULT 0,
  total_fine INT NOT NULL DEFAULT 0,
  total_lost_time INT NOT NULL DEFAULT 0,
  history JSONB NOT NULL DEFAULT '[]',
  chat_sessions JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS query_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  query_text TEXT NOT NULL,
  answer_text TEXT,
  chunk_ids TEXT[],
  latency_ms INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_profiles_user_id ON profiles(user_id);
CREATE INDEX IF NOT EXISTS idx_runs_profile_id ON runs(profile_id);
CREATE INDEX IF NOT EXISTS idx_runs_completed_at ON runs(completed_at DESC);
