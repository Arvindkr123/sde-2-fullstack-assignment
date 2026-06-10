import fs from 'fs';
import path from 'path';
import mysql from 'mysql2/promise';
import bcrypt from 'bcrypt';
import dotenv from 'dotenv';
import { Queue } from 'bullmq';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config();

const dbName = process.env.DB_NAME ?? 'sequencer';

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER ?? 'root',
    password: process.env.DB_PASSWORD ?? '',
    multipleStatements: true,
  });

  try {
    console.log(`Creating database "${dbName}" if it does not exist...`);
    await conn.query(
      `CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
    await conn.query(`USE \`${dbName}\``);

    console.log('Applying schema...');
    const schema = fs.readFileSync(
      path.resolve(__dirname, '../src/db/schema.sql'),
      'utf8'
    );
    await conn.query(schema);

    console.log('Seeding users...');
    const hash = await bcrypt.hash('password123', 10);
    await conn.query(
      'INSERT INTO users (email, password_hash) VALUES (?, ?), (?, ?)',
      ['alice@test.com', hash, 'bob@test.com', hash]
    );

    console.log('Seeding data...');
    const seed = fs.readFileSync(
      path.resolve(__dirname, '../src/db/seed.sql'),
      'utf8'
    );
    await conn.query(seed);

    console.log('Enqueueing BullMQ jobs for seeded scheduled_emails...');
    const [pendingRows] = await conn.query(
      "SELECT id FROM scheduled_emails WHERE status = 'pending'"
    ) as [Array<{ id: number }>, unknown];

    const sendQueue = new Queue('email-send', {
      connection: {
        host: process.env.REDIS_HOST ?? '127.0.0.1',
        port: Number(process.env.REDIS_PORT ?? 6379),
      },
    });
    for (const row of pendingRows) {
      await sendQueue.add('send', { scheduledEmailId: row.id }, { jobId: `se-${row.id}` });
    }
    await sendQueue.close();
    console.log(`Enqueued ${pendingRows.length} job(s).`);

    console.log('Done! Seed accounts:');
    console.log('  alice@test.com / password123  — 3 mailboxes, 2 sequences');
    console.log('  bob@test.com   / password123  — 1 mailbox,  0 sequences');
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error('Setup failed:', err.message ?? err);
  process.exit(1);
});
