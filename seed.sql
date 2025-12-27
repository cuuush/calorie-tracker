-- Development seed data
-- Run this in local dev: npx wrangler d1 execute nutrition-db --local --file=./seed.sql

-- Create test user for BYPASS_AUTH mode
INSERT OR IGNORE INTO users (id, email, created_at, updated_at)
VALUES ('test-user-123', 'test@example.com', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
