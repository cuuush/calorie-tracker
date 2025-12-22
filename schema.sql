-- D1 Database Schema for Calorie Tracker

DROP TABLE IF EXISTS nutrition_entries;

CREATE TABLE nutrition_entries (
  id TEXT PRIMARY KEY,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
  user_message TEXT,
  total_calories INTEGER,
  total_protein REAL,
  total_carbs REAL,
  items TEXT, -- JSON array of food items
  reasoning TEXT,
  reasoning_details TEXT, -- Full reasoning JSON for potential followups
  conversation_messages TEXT, -- Full conversation history JSON
  raw_response TEXT,
  notes TEXT
);

CREATE INDEX idx_timestamp ON nutrition_entries(timestamp DESC);
