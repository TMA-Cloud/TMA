/**
 * Clean up duplicate entries before fixing the scanner
 * This removes duplicates and keeps only the oldest record for each path
 */

const pool = require('../config/db');

async function cleanupDuplicates() {
  console.log('=== Cleaning Up Duplicate Entries ===\n');

  try {
    // Find duplicates (case-insensitive)
    const duplicates = await pool.query(`
      SELECT LOWER(path) as path, user_id, type, COUNT(*) as count
      FROM files
      WHERE path IS NOT NULL AND deleted_at IS NULL
      GROUP BY LOWER(path), user_id, type
      HAVING COUNT(*) > 1
    `);

    console.log(`Found ${duplicates.rows.length} sets of duplicates`);

    if (duplicates.rows.length === 0) {
      console.log('✅ No duplicates found!');
      return;
    }

    console.log('\nSample duplicates:');
    duplicates.rows.slice(0, 10).forEach(row => {
      console.log(`  - ${row.path} (${row.type}) x${row.count}`);
    });
    console.log();

    // Count total records before cleanup
    const beforeCount = await pool.query(
      'SELECT COUNT(*) as count FROM files WHERE path IS NOT NULL AND deleted_at IS NULL'
    );
    console.log(`Total records before cleanup: ${beforeCount.rows[0].count}`);

    // Delete duplicates, keeping the oldest (first created) record using case-insensitive path
    console.log('\nCleaning up duplicates (case-insensitive)...');

    const result = await pool.query(`
      DELETE FROM files
      WHERE id IN (
        SELECT id
        FROM (
          SELECT id,
                 ROW_NUMBER() OVER (
                   PARTITION BY LOWER(path), user_id, type
                   ORDER BY modified ASC
                 ) AS rn
          FROM files
          WHERE path IS NOT NULL AND deleted_at IS NULL
        ) t
        WHERE rn > 1
      )
    `);

    console.log(`Deleted ${result.rowCount} duplicate records`);

    // Count total records after cleanup
    const afterCount = await pool.query(
      'SELECT COUNT(*) as count FROM files WHERE path IS NOT NULL AND deleted_at IS NULL'
    );
    console.log(`Total records after cleanup: ${afterCount.rows[0].count}`);

    // Verify no duplicates remain (case-insensitive)
    const remainingDuplicates = await pool.query(`
      SELECT LOWER(path) as path, user_id, type, COUNT(*) as count
      FROM files
      WHERE path IS NOT NULL AND deleted_at IS NULL
      GROUP BY LOWER(path), user_id, type
      HAVING COUNT(*) > 1
    `);

    if (remainingDuplicates.rows.length === 0) {
      console.log('\n✅ All duplicates cleaned up successfully!');
    } else {
      console.log(`\n⚠️  ${remainingDuplicates.rows.length} duplicates still remain`);
    }

  } catch (error) {
    console.error('❌ Error during cleanup:', error);
    throw error;
  }
}

// Run cleanup
cleanupDuplicates()
  .then(() => {
    console.log('\nCleanup complete! You can now restart your server.');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\nCleanup failed:', error);
    process.exit(1);
  });
