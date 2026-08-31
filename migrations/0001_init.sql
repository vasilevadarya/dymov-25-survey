CREATE TABLE IF NOT EXISTS survey_sessions (
  id UUID PRIMARY KEY,
  flow TEXT NOT NULL DEFAULT 'main',
  locale TEXT,
  workplace TEXT,
  tenure TEXT,
  survey_id TEXT,
  intro_seen BOOLEAN NOT NULL DEFAULT FALSE,
  active_block_id TEXT,
  trust_intro_seen BOOLEAN NOT NULL DEFAULT FALSE,
  completed BOOLEAN NOT NULL DEFAULT FALSE,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS survey_answers (
  id BIGSERIAL PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES survey_sessions(id) ON DELETE CASCADE,
  question_id TEXT NOT NULL,
  block_id TEXT NOT NULL,
  answer JSONB NOT NULL,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(session_id, question_id)
);

CREATE INDEX IF NOT EXISTS idx_survey_answers_session ON survey_answers(session_id);
CREATE INDEX IF NOT EXISTS idx_survey_sessions_survey ON survey_sessions(survey_id);
CREATE INDEX IF NOT EXISTS idx_survey_sessions_started ON survey_sessions(started_at);
