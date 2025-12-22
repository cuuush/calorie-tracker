DROP TABLE IF EXISTS nutrition_entries;

CREATE TABLE nutrition_entries (
  id TEXT PRIMARY KEY,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
  user_message TEXT,
  meal_title TEXT,
  total_calories INTEGER,
  total_protein REAL,
  total_carbs REAL,
  items TEXT -- Keep small JSON summary in D1
);

CREATE INDEX idx_timestamp ON nutrition_entries(timestamp DESC);
