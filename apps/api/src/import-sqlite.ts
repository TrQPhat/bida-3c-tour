import 'dotenv/config';
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PoolClient } from 'pg';
import { pool, transaction } from './database.js';

type SourceRow = Record<string, any>;
const tables = ['users', 'teams', 'tournaments', 'tournament_teams', 'matches', 'votes'] as const;
const execute = process.argv.includes('--execute');
const sourcePath = resolve(process.cwd(), process.env.SQLITE_SOURCE_PATH || 'data/cue-arena.db');

if (!existsSync(sourcePath)) throw new Error(`SQLite source not found: ${sourcePath}`);
const sqlite = new DatabaseSync(sourcePath, { readOnly: true });

const source: Record<(typeof tables)[number], SourceRow[]> = {
  users: sqlite.prepare('SELECT * FROM users ORDER BY id').all() as SourceRow[],
  teams: sqlite.prepare('SELECT * FROM teams ORDER BY id').all() as SourceRow[],
  tournaments: sqlite.prepare('SELECT * FROM tournaments ORDER BY id').all() as SourceRow[],
  tournament_teams: sqlite.prepare('SELECT * FROM tournament_teams ORDER BY tournament_id, team_id').all() as SourceRow[],
  matches: sqlite.prepare('SELECT * FROM matches ORDER BY id').all() as SourceRow[],
  votes: sqlite.prepare('SELECT * FROM votes ORDER BY user_id, match_id').all() as SourceRow[],
};
const foreignKeyProblems = sqlite.prepare('PRAGMA foreign_key_check').all();
sqlite.close();

if (foreignKeyProblems.length) throw new Error(`SQLite has ${foreignKeyProblems.length} foreign-key violation(s)`);
for (const table of tables) console.log(`Source ${table}: ${source[table].length}`);

const destinationCounts: Record<string, number> = {};
for (const table of tables) {
  const result = await pool.query(`SELECT COUNT(*)::int AS count FROM ${table}`);
  destinationCounts[table] = result.rows[0].count;
}
console.log(`Destination rows: ${Object.entries(destinationCounts).map(([table, count]) => `${table}=${count}`).join(', ')}`);

const destinationHasData = Object.values(destinationCounts).some((count) => count > 0);
if (!execute) {
  console.log(destinationHasData
    ? 'DRY RUN BLOCKED: Neon contains application data; import would be refused.'
    : 'DRY RUN OK: source is valid and Neon application tables are empty.');
  await pool.end();
  process.exit(destinationHasData ? 2 : 0);
}
if (destinationHasData) throw new Error('Import refused: Neon application tables must all be empty');

const insert = async (client: PoolClient, sql: string, rows: SourceRow[], values: (row: SourceRow) => unknown[]) => {
  for (const row of rows) await client.query(sql, values(row));
};

await transaction(async (client) => {
  await insert(client, `INSERT INTO users(id,username,display_name,password_hash,role,active,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)`, source.users,
    (r) => [r.id, r.username, r.display_name, r.password_hash, r.role, Boolean(r.active), r.created_at]);
  await insert(client, `INSERT INTO teams(id,name,captain,color,active,created_at) VALUES($1,$2,$3,$4,$5,$6)`, source.teams,
    (r) => [r.id, r.name, r.captain, r.color, Boolean(r.active), r.created_at]);
  await insert(client, `INSERT INTO tournaments(id,name,status,start_at,last_draw_signature,created_at) VALUES($1,$2,$3,$4,$5,$6)`, source.tournaments,
    (r) => [r.id, r.name, r.status, r.start_at, r.last_draw_signature, r.created_at]);
  await insert(client, `INSERT INTO tournament_teams(tournament_id,team_id) VALUES($1,$2)`, source.tournament_teams,
    (r) => [r.tournament_id, r.team_id]);

  // Insert self-referencing matches in two phases so source row order does not matter.
  await insert(client, `INSERT INTO matches(id,tournament_id,round_no,position,team_a_id,team_b_id,score_a,score_b,handicap_a,handicap_b,scheduled_at,status,voting_locked,winner_id,next_match_id,next_slot) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NULL,$15)`, source.matches,
    (r) => [r.id, r.tournament_id, r.round_no, r.position, r.team_a_id, r.team_b_id, r.score_a, r.score_b, r.handicap_a, r.handicap_b, r.scheduled_at, r.status, Boolean(r.voting_locked), r.winner_id, r.next_slot]);
  for (const row of source.matches) if (row.next_match_id != null) await client.query('UPDATE matches SET next_match_id=$1 WHERE id=$2', [row.next_match_id, row.id]);
  await insert(client, `INSERT INTO votes(user_id,match_id,team_id,awarded,created_at) VALUES($1,$2,$3,$4,$5)`, source.votes,
    (r) => [r.user_id, r.match_id, r.team_id, r.awarded, r.created_at]);

  for (const table of ['users', 'teams', 'tournaments', 'matches']) {
    await client.query(`SELECT setval(pg_get_serial_sequence('${table}','id'), COALESCE(MAX(id),1), COUNT(*) > 0) FROM ${table}`);
  }
  for (const table of tables) {
    const count = (await client.query(`SELECT COUNT(*)::int AS count FROM ${table}`)).rows[0].count;
    if (count !== source[table].length) throw new Error(`Count mismatch for ${table}: source=${source[table].length}, destination=${count}`);
  }
});

console.log('IMPORT OK: all rows committed and identity sequences synchronized.');
await pool.end();
