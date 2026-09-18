-- 016: questions an agent asks about a bug, and the answers to them.
--
-- The agent handoff was one-way: a prompt went out and work came back, so an
-- agent that could not understand a report — a missing screenshot, an ambiguous
-- sentence, a product code it cannot resolve — had nowhere to ask. It either
-- guessed or stopped, and the guess was discovered later by a tester.
--
-- A question is attributed to whoever (or whatever) asked, answerable by any
-- member of the project — the tester who filed the report is usually the only
-- person who knows — and stays open until someone answers it, so "the agent is
-- waiting on us" is a fact on the bug rather than something living in a chat
-- window. Answers are stored with their author and time for the same reason the
-- rest of the timeline is: the reader has to be able to tell who said what.
CREATE TABLE IF NOT EXISTS bug_questions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bug_id      uuid NOT NULL REFERENCES bugs(id) ON DELETE CASCADE,
  asked_by    uuid REFERENCES users(id),
  body        text NOT NULL CHECK (length(btrim(body)) > 0),
  created_at  timestamptz NOT NULL DEFAULT now(),
  answered_by uuid REFERENCES users(id),
  answered_at timestamptz,
  answer      text,
  -- An answer and its timestamp are one fact, not two: a row that is half
  -- answered would render as "answered" with no text, or as open with text
  -- nobody can see.
  CONSTRAINT bug_questions_answer_complete
    CHECK ((answered_at IS NULL) = (answer IS NULL))
);

CREATE INDEX IF NOT EXISTS bug_questions_bug_idx ON bug_questions (bug_id, created_at);
-- The question the UI and the polling agent both look for first.
CREATE INDEX IF NOT EXISTS bug_questions_open_idx
  ON bug_questions (bug_id) WHERE answered_at IS NULL;