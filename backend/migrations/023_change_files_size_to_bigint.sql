-- Change files.size column from INTEGER to BIGINT to support large file sizes
-- INTEGER max value is 2,147,483,647 (2GB), but files can exceed this
ALTER TABLE files ALTER COLUMN size TYPE BIGINT;
