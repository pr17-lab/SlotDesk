-- Up Migration
-- Step 3's exclusion constraint combines equality on a resource id (bigint)
-- with a time-range overlap (tstzrange). PostgreSQL's default GiST operator
-- class only handles geometric types; btree_gist adds a GiST operator class
-- for plain scalar types (like integer), making the mixed exclusion constraint
-- possible. CREATE EXTENSION IF NOT EXISTS is safe to run more than once.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Down Migration
DROP EXTENSION IF EXISTS btree_gist;
