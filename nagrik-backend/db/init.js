'use strict';
/**
 * db/init.js — Run this ONCE to set up the database
 * Usage: node db/init.js
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

async function init() {
  console.log('\n╔══════════════════════════════════════╗');
  console.log('║  NAGRIK OS · DATABASE INITIALIZER    ║');
  console.log('╚══════════════════════════════════════╝\n');

  const client = await pool.connect();
  try {
    // Run schema
    console.log('▶  Running schema.sql...');
    const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    await client.query(schema);
    console.log('✅ Schema applied successfully\n');

    // Verify tables
    const { rows } = await client.query(`
      SELECT tablename FROM pg_tables 
      WHERE schemaname = 'public' 
      ORDER BY tablename
    `);
    console.log('📋 Tables created:');
    rows.forEach(r => console.log(`   • ${r.tablename}`));

    // Check cities
    const { rows: cities } = await client.query('SELECT id, name, active FROM cities');
    console.log('\n🏙  Cities seeded:');
    cities.forEach(c => console.log(`   • ${c.id} (${c.name}) — active: ${c.active}`));

    console.log('\n✅ Database ready. You can now start the server.\n');
  } catch (err) {
    console.error('\n❌ Error:', err.message);
    console.error('\nFull error:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

init();
