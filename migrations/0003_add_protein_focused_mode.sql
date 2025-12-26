-- Migration: Add protein_focused_mode setting
-- This allows users to hide calories and focus only on protein tracking

ALTER TABLE user_settings ADD COLUMN protein_focused_mode INTEGER DEFAULT 0;
