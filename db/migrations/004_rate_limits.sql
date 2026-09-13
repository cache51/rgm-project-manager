-- 004_rate_limits.sql — fixed-window counters for the unauthenticated endpoints
--
-- `request-link` and `consume` are the two endpoints reachable without
-- credentials. Counting in the database rather than in process memory means the
-- limit still holds when the app runs as several processes, and it survives a
-- restart — an in-memory counter silently multiplies by the number of workers.

BEGIN;

CREATE TABLE rate_limit_hits (
  bucket       text NOT NULL,
  window_start timestamptz NOT NULL,
  count        integer NOT NULL DEFAULT 0 CHECK (count >= 0),
  PRIMARY KEY (bucket, window_start)
);

-- Lets the sweep find expired windows without scanning the whole table.
CREATE INDEX rate_limit_hits_window ON rate_limit_hits (window_start);

COMMIT;
