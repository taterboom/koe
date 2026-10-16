-- Processing states (new / planned / done / wontdo) give way to a single star:
-- the developer marks what matters and filters on it.
ALTER TABLE feedback ADD COLUMN starred INTEGER NOT NULL DEFAULT 0 CHECK (starred IN (0, 1));
ALTER TABLE feedback DROP COLUMN status;
