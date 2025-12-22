-- Multi-user authentication migration
-- Creates users, sessions, and verification_tokens tables
-- Modifies nutrition_entries and user_settings for multi-user support

-- Step 1: Create users table
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_users_email ON users(email);

-- Step 2: Create sessions table
CREATE TABLE sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_used_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_sessions_user_id ON sessions(user_id);
CREATE INDEX idx_sessions_expires_at ON sessions(expires_at);

-- Step 3: Create verification_tokens table
CREATE TABLE verification_tokens (
  token TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL,
  used BOOLEAN DEFAULT 0
);

CREATE INDEX idx_verification_email ON verification_tokens(email);
CREATE INDEX idx_verification_expires_at ON verification_tokens(expires_at);

-- Step 4: Modify nutrition_entries to add user_id
ALTER TABLE nutrition_entries ADD COLUMN user_id TEXT NOT NULL DEFAULT '';
CREATE INDEX idx_nutrition_entries_user_id ON nutrition_entries(user_id);

-- Step 5: Recreate user_settings with user_id as primary key
DROP TABLE IF EXISTS user_settings;

CREATE TABLE user_settings (
  user_id TEXT PRIMARY KEY,
  weight REAL,
  weight_unit TEXT DEFAULT 'lbs',
  height REAL,
  height_unit TEXT DEFAULT 'in',
  age INTEGER,
  gender TEXT,
  activity_level TEXT,
  maintenance_calories INTEGER,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
