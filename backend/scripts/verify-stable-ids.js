/**
 * Verification script to check if IDs remain stable across restarts
 *
 * Usage:
 * 1. Run: node scripts/verify-stable-ids.js save
 * 2. Restart your server
 * 3. Run: node scripts/verify-stable-ids.js check
 */

const pool = require('../config/db');
const fs = require('fs').promises;
const path = require('path');

const SNAPSHOT_FILE = path.join(__dirname, '.id-snapshot.json');

async function saveSnapshot() {
  console.log('=== Saving ID Snapshot ===\n');

  try {
    const result = await pool.query(`
      SELECT id, path, type, name
      FROM files
      WHERE path IS NOT NULL AND deleted_at IS NULL
      ORDER BY path, type
    `);

    const snapshot = {
      timestamp: new Date().toISOString(),
      count: result.rows.length,
      files: result.rows,
    };

    await fs.writeFile(SNAPSHOT_FILE, JSON.stringify(snapshot, null, 2));

    console.log(`✅ Saved snapshot of ${snapshot.count} files`);
    console.log(`   Timestamp: ${snapshot.timestamp}`);
    console.log(`\nNow restart your server and run:`);
    console.log(`   node scripts/verify-stable-ids.js check`);
  } catch (error) {
    console.error('❌ Error saving snapshot:', error);
    throw error;
  }
}

async function checkSnapshot() {
  console.log('=== Checking ID Stability ===\n');

  try {
    // Load snapshot
    const snapshotData = await fs.readFile(SNAPSHOT_FILE, 'utf-8');
    const snapshot = JSON.parse(snapshotData);

    console.log(`Comparing against snapshot from: ${snapshot.timestamp}`);
    console.log(`Snapshot had ${snapshot.count} files\n`);

    // Get current data
    const current = await pool.query(`
      SELECT id, path, type, name
      FROM files
      WHERE path IS NOT NULL AND deleted_at IS NULL
      ORDER BY path, type
    `);

    console.log(`Current database has ${current.rows.length} files\n`);

    // Create maps for comparison
    const snapshotMap = new Map();
    snapshot.files.forEach(file => {
      const key = `${file.path}|${file.type}`;
      snapshotMap.set(key, file);
    });

    const currentMap = new Map();
    current.rows.forEach(file => {
      const key = `${file.path}|${file.type}`;
      currentMap.set(key, file);
    });

    // Compare IDs
    let unchanged = 0;
    let changed = 0;
    let newFiles = 0;
    let deletedFiles = 0;

    const changes = [];

    // Check for changed or unchanged IDs
    for (const [key, oldFile] of snapshotMap) {
      const newFile = currentMap.get(key);

      if (!newFile) {
        deletedFiles++;
      } else if (oldFile.id === newFile.id) {
        unchanged++;
      } else {
        changed++;
        changes.push({
          path: oldFile.path,
          type: oldFile.type,
          name: oldFile.name,
          oldId: oldFile.id,
          newId: newFile.id,
        });
      }
    }

    // Check for new files
    for (const [key] of currentMap) {
      if (!snapshotMap.has(key)) {
        newFiles++;
      }
    }

    // Print results
    console.log('Results:');
    console.log(`  ✅ Unchanged IDs: ${unchanged}`);
    console.log(`  ⚠️  Changed IDs:   ${changed}`);
    console.log(`  ➕ New files:     ${newFiles}`);
    console.log(`  ➖ Deleted files: ${deletedFiles}`);
    console.log();

    if (changed > 0) {
      console.log('❌ IDs changed! Here are the first 10:');
      changes.slice(0, 10).forEach(change => {
        console.log(`  ${change.name} (${change.type})`);
        console.log(`    Old ID: ${change.oldId}`);
        console.log(`    New ID: ${change.newId}`);
      });
      console.log();
      console.log('This means the fix is NOT working correctly.');
    } else if (unchanged > 0) {
      console.log('✅ All IDs remained stable! The fix is working correctly.');
    } else {
      console.log('⚠️  No files to compare. Make sure you have data in your database.');
    }
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.error('❌ No snapshot found!');
      console.log('Please run: node scripts/verify-stable-ids.js save');
    } else {
      console.error('❌ Error checking snapshot:', error);
      throw error;
    }
  }
}

// Parse command
const command = process.argv[2];

if (command === 'save') {
  saveSnapshot()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
} else if (command === 'check') {
  checkSnapshot()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
} else {
  console.log('Usage:');
  console.log('  node scripts/verify-stable-ids.js save   - Save current IDs');
  console.log('  node scripts/verify-stable-ids.js check  - Check if IDs changed');
  process.exit(1);
}
