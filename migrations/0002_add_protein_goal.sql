-- Migration to add protein_goal to user_settings table
ALTER TABLE user_settings ADD COLUMN protein_goal INTEGER DEFAULT 150;
