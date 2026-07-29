import 'dotenv/config';
import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import type { PoolClient } from 'pg';
import { all, one, pool, transaction } from './database.js';

type Actor = { id: number; username: string; role: 'admin' | 'user' };
type Row = Record<string, any>;
declare global { namespace Express { interface Request { actor?: Actor } } }

const hash = (password: string) => { const salt = randomBytes(16).toString('hex'); return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`; };
const verify = (password: string, stored: string) => { const [salt, key] = stored.split(':'); if (!salt || !key) return false; const a = Buffer.from(key, 'hex'), b = scryptSync(password, salt, 64); return a.length === b.length && timingSafeEqual(a, b); };
const cleanUser = (u: Row) => ({ id: Number(u.id), username: u.username, displayName: u.display_name, role: u.role, active: Boolean(u.active) });
const route = (handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => { void handler(req, res, next).catch(next); };
const vietnamDateAt1230 = (value: string | Date) => {
  const date = new Date(value); if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value;
  return new Date(`${get('year')}-${get('month')}-${get('day')}T12:30:00+07:00`);
};
const syncTournamentVoteHistory = async (client: PoolClient, tournamentId: number) => {
  const tournament = (await client.query("SELECT id,name,status FROM tournaments WHERE id=$1 AND status='finished'", [tournamentId])).rows[0];
  if (!tournament) return;
  const finalMatch = (await client.query("SELECT id FROM matches WHERE tournament_id=$1 AND next_match_id IS NULL AND status='finished' ORDER BY round_no DESC LIMIT 1", [tournamentId])).rows[0];
  if (!finalMatch) return;
  const maxRound = Number((await client.query('SELECT COALESCE(MAX(round_no),1)::int max_round FROM matches WHERE tournament_id=$1', [tournamentId])).rows[0].max_round);
  const history = (await client.query(`INSERT INTO tournament_vote_history(source_tournament_id,source_final_match_id,tournament_name,max_round)
    VALUES($1,$2,$3,$4)
    ON CONFLICT(source_final_match_id) DO UPDATE SET tournament_name=EXCLUDED.tournament_name,max_round=EXCLUDED.max_round,updated_at=CURRENT_TIMESTAMP
    RETURNING id`, [tournamentId, finalMatch.id, tournament.name, maxRound])).rows[0];
  await client.query(`INSERT INTO vote_history_entries(
      vote_history_id,source_match_id,round_no,position,scheduled_at,
      team_a_source_id,team_a_name,team_b_source_id,team_b_name,score_a,score_b,handicap_a,handicap_b,winner_source_id,winner_name,
      source_user_id,username,display_name,voted_team_source_id,voted_team_name,awarded,voted_at)
    SELECT $1,m.id,m.round_no,m.position,m.scheduled_at,
      m.team_a_id,a.name,m.team_b_id,b.name,m.score_a,m.score_b,m.handicap_a,m.handicap_b,m.winner_id,w.name,
      v.user_id,u.username,u.display_name,v.team_id,chosen.name,v.awarded,v.created_at
    FROM votes v
    JOIN matches m ON m.id=v.match_id
    JOIN users u ON u.id=v.user_id
    JOIN teams a ON a.id=m.team_a_id
    JOIN teams b ON b.id=m.team_b_id
    JOIN teams chosen ON chosen.id=v.team_id
    LEFT JOIN teams w ON w.id=m.winner_id
    WHERE m.tournament_id=$2
    ON CONFLICT(vote_history_id,source_match_id,source_user_id) DO UPDATE SET
      round_no=EXCLUDED.round_no,position=EXCLUDED.position,scheduled_at=EXCLUDED.scheduled_at,
      team_a_source_id=EXCLUDED.team_a_source_id,team_a_name=EXCLUDED.team_a_name,
      team_b_source_id=EXCLUDED.team_b_source_id,team_b_name=EXCLUDED.team_b_name,
      score_a=EXCLUDED.score_a,score_b=EXCLUDED.score_b,handicap_a=EXCLUDED.handicap_a,handicap_b=EXCLUDED.handicap_b,
      winner_source_id=EXCLUDED.winner_source_id,winner_name=EXCLUDED.winner_name,
      username=EXCLUDED.username,display_name=EXCLUDED.display_name,
      voted_team_source_id=EXCLUDED.voted_team_source_id,voted_team_name=EXCLUDED.voted_team_name,
      awarded=EXCLUDED.awarded,voted_at=EXCLUDED.voted_at,updated_at=CURRENT_TIMESTAMP`, [history.id, tournamentId]);
  await client.query(`UPDATE vote_history_entries e SET
      score_a=m.score_a,score_b=m.score_b,handicap_a=m.handicap_a,handicap_b=m.handicap_b,
      winner_source_id=m.winner_id,winner_name=w.name,
      awarded=CASE WHEN m.winner_id IS NULL THEN e.awarded WHEN e.voted_team_source_id=m.winner_id THEN 1 ELSE -1 END,
      updated_at=CURRENT_TIMESTAMP
    FROM matches m LEFT JOIN teams w ON w.id=m.winner_id
    WHERE e.vote_history_id=$1 AND e.source_match_id=m.id`, [history.id]);
};

const app = express();
const internalApiKey = process.env.INTERNAL_API_KEY;
if (!internalApiKey) throw new Error('INTERNAL_API_KEY is required');
app.use(cors());
app.use(express.json({ limit: '32kb' }));
app.use(route(async (req, res, next) => {
  if (req.header('x-internal-key') !== internalApiKey) { res.status(403).json({ message: 'Kênh truy cập không hợp lệ' }); return; }
  const id = Number(req.header('x-user-id'));
  if (id) {
    const u = await one<Row>('SELECT id, username, role FROM users WHERE id = $1 AND active = TRUE', [id]);
    if (!u) { res.status(401).json({ message: 'Tài khoản đã bị tạm ngưng hoặc không còn tồn tại' }); return; }
    req.actor = { id: Number(u.id), username: u.username, role: u.role };
  }
  next();
}));
const auth = (req: Request, res: Response, next: NextFunction) => req.actor ? next() : res.status(401).json({ message: 'Chưa đăng nhập' });
const admin = (req: Request, res: Response, next: NextFunction) => req.actor?.role === 'admin' ? next() : res.status(403).json({ message: 'Bạn không có quyền thực hiện thao tác này' });

app.post('/auth/verify', route(async (req, res) => {
  const u = await one<Row>('SELECT * FROM users WHERE username = $1 AND active = TRUE', [String(req.body.username || '').trim()]);
  if (!u || !verify(String(req.body.password || ''), u.password_hash)) { res.status(401).json({ message: 'Tên đăng nhập hoặc mật khẩu không đúng' }); return; }
  res.json(cleanUser(u));
}));
app.patch('/profile', auth, route(async (req, res) => {
  const u = await one<Row>('SELECT * FROM users WHERE id = $1 AND active = TRUE', [req.actor!.id]);
  if (!u) { res.status(404).json({ message: 'Không tìm thấy tài khoản' }); return; }
  const displayName = String(req.body.displayName ?? u.display_name).trim();
  if (!displayName || displayName.length > 80) { res.status(400).json({ message: 'Tên hiển thị phải từ 1 đến 80 ký tự' }); return; }
  if (req.body.newPassword) {
    if (!verify(String(req.body.currentPassword || ''), u.password_hash)) { res.status(400).json({ message: 'Mật khẩu hiện tại không đúng' }); return; }
    if (String(req.body.newPassword).length < 8) { res.status(400).json({ message: 'Mật khẩu mới phải có ít nhất 8 ký tự' }); return; }
    if (req.body.newPassword !== req.body.confirmNewPassword) { res.status(400).json({ message: 'Mật khẩu nhập lại không khớp' }); return; }
    await pool.query('UPDATE users SET display_name = $1, password_hash = $2 WHERE id = $3', [displayName, hash(String(req.body.newPassword)), u.id]);
  } else await pool.query('UPDATE users SET display_name = $1 WHERE id = $2', [displayName, u.id]);
  res.json(cleanUser((await one<Row>('SELECT * FROM users WHERE id = $1', [u.id]))!));
}));
app.get('/users', auth, admin, route(async (_req, res) => res.json((await all<Row>('SELECT id, username, display_name, role, active, created_at FROM users ORDER BY id')).map(cleanUser))));
app.post('/users', auth, admin, route(async (req, res) => {
  const { username, displayName, password, role = 'user' } = req.body;
  if (!/^[a-zA-Z0-9_.-]{3,30}$/.test(username || '') || String(password || '').length < 8 || !['admin', 'user'].includes(role)) { res.status(400).json({ message: 'Dữ liệu tài khoản không hợp lệ' }); return; }
  try { const row = await one<Row>('INSERT INTO users(username, display_name, password_hash, role) VALUES($1,$2,$3,$4) RETURNING id', [username, displayName || username, hash(password), role]); res.status(201).json({ id: Number(row!.id) }); }
  catch (error: any) { if (error?.code === '23505') { res.status(409).json({ message: 'Tên đăng nhập đã tồn tại' }); return; } throw error; }
}));
app.patch('/users/:id', auth, admin, route(async (req, res) => {
  const id = Number(req.params.id), u = await one<Row>('SELECT * FROM users WHERE id = $1', [id]);
  if (!u) { res.status(404).json({ message: 'Không tìm thấy tài khoản' }); return; }
  if (id === req.actor!.id && req.body.active === false) { res.status(400).json({ message: 'Không thể tự khóa tài khoản đang dùng' }); return; }
  const displayName = req.body.displayName == null ? u.display_name : String(req.body.displayName).trim(), roleName = req.body.role ?? u.role;
  if (!displayName || displayName.length > 80 || !['admin', 'user'].includes(roleName)) { res.status(400).json({ message: 'Thông tin tài khoản không hợp lệ' }); return; }
  if (req.body.password != null && String(req.body.password).length < 8) { res.status(400).json({ message: 'Mật khẩu mới phải có ít nhất 8 ký tự' }); return; }
  await pool.query('UPDATE users SET display_name=$1, role=$2, active=$3, password_hash=$4 WHERE id=$5', [displayName, roleName, req.body.active == null ? u.active : Boolean(req.body.active), req.body.password ? hash(String(req.body.password)) : u.password_hash, id]);
  res.json(cleanUser((await one<Row>('SELECT * FROM users WHERE id=$1', [id]))!));
}));
app.delete('/users/:id', auth, admin, route(async (req, res) => {
  const id = Number(req.params.id); if (id === req.actor!.id) { res.status(400).json({ message: 'Không thể tự xóa tài khoản đang dùng' }); return; }
  const result = await pool.query('DELETE FROM users WHERE id=$1', [id]); if (!result.rowCount) { res.status(404).json({ message: 'Không tìm thấy tài khoản' }); return; } res.json({ ok: true });
}));

app.get('/dashboard', route(async (req, res) => {
  const [tournaments, teams, matches, history] = await Promise.all([
    all<Row>('SELECT id,name,status,start_at,created_at FROM tournaments ORDER BY id DESC'),
    all<Row>('SELECT * FROM teams ORDER BY active DESC,name'),
    all<Row>(`SELECT m.id,m.tournament_id,m.round_no,m.position,m.team_a_id,m.team_b_id,m.score_a,m.score_b,
      CASE WHEN $2::boolean THEN m.handicap_a ELSE NULL END handicap_a,
      CASE WHEN $2::boolean THEN m.handicap_b ELSE NULL END handicap_b,
      m.scheduled_at,m.status,m.voting_locked,m.hidden,m.winner_id,m.next_match_id,m.next_slot,
      a.name team_a_name,a.color team_a_color,b.name team_b_name,b.color team_b_color,w.name winner_name,
      (SELECT COUNT(*)::int FROM votes v WHERE v.match_id=m.id AND v.team_id=m.team_a_id) votes_a,
      (SELECT COUNT(*)::int FROM votes v WHERE v.match_id=m.id AND v.team_id=m.team_b_id) votes_b,
      (SELECT team_id FROM votes v WHERE v.match_id=m.id AND v.user_id=$1) my_vote
      FROM matches m LEFT JOIN teams a ON a.id=m.team_a_id LEFT JOIN teams b ON b.id=m.team_b_id LEFT JOIN teams w ON w.id=m.winner_id
      WHERE m.hidden=FALSE OR $3::boolean
      ORDER BY m.tournament_id DESC,m.round_no,m.position`, [req.actor?.id ?? null, Boolean(req.actor), req.actor?.role === 'admin']),
    all<Row>(`SELECT h.id history_id,h.tournament_name,h.archived_at,m.id,m.round_no,m.position,
      COALESCE(h.max_round,MAX(m.round_no) OVER (PARTITION BY h.id))::int max_round,
      m.team_a_name,m.team_a_captain,m.team_b_name,m.team_b_captain,m.score_a,m.score_b,m.winner_name,m.status
      FROM tournament_history h JOIN match_history m ON m.history_id=h.id
      ORDER BY h.archived_at DESC,h.id DESC,m.id DESC
      LIMIT 10`),
  ]);
  res.json({ tournaments, teams, matches, history });
}));
app.get('/leaderboard', route(async (req, res) => {
  const page = Math.max(1, Number.parseInt(String(req.query.page || '1'), 10) || 1), pageSize = 10;
  const total = Number((await one<Row>("SELECT COUNT(*)::int n FROM users WHERE role='user'"))!.n), pages = Math.max(1, Math.ceil(total / pageSize));
  const items = await all<Row>(`SELECT u.id,u.username,u.display_name,u.active,COALESCE(s.points,0) points,
    COALESCE(s.correct,0) correct,COALESCE(s.wrong,0) wrong,COALESCE(s.scored_votes,0) scored_votes
    FROM users u LEFT JOIN user_prediction_scores s ON s.user_id=u.id WHERE u.role='user'
    ORDER BY points DESC,correct DESC,LOWER(u.display_name) LIMIT $1 OFFSET $2`, [pageSize, (page - 1) * pageSize]);
  res.json({ items, page, pageSize, total, pages });
}));
app.get('/vote-history', auth, route(async (req, res) => {
  const isAdmin = req.actor!.role === 'admin';
  const items = await all<Row>(`SELECT h.id,h.tournament_name,h.max_round,h.completed_at,h.updated_at,
    COUNT(e.id)::int vote_count,
    COUNT(DISTINCT e.source_match_id)::int match_count,
    COUNT(e.id) FILTER (WHERE e.removed_at IS NOT NULL)::int removed_vote_count
    FROM tournament_vote_history h
    LEFT JOIN vote_history_entries e ON e.vote_history_id=h.id AND ($1::boolean OR e.source_user_id=$2)
    WHERE $1::boolean OR e.id IS NOT NULL
    GROUP BY h.id ORDER BY h.completed_at DESC,h.id DESC LIMIT 20`, [isAdmin, req.actor!.id]);
  res.json({ items });
}));
app.get('/vote-history/:id', auth, route(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) { res.status(400).json({ message: 'Lịch sử vote không hợp lệ' }); return; }
  const isAdmin = req.actor!.role === 'admin';
  const history = await one<Row>(`SELECT h.id,h.tournament_name,h.max_round,h.completed_at,h.updated_at
    FROM tournament_vote_history h
    WHERE h.id=$1 AND ($2::boolean OR EXISTS(
      SELECT 1 FROM vote_history_entries e WHERE e.vote_history_id=h.id AND e.source_user_id=$3
    ))`, [id, isAdmin, req.actor!.id]);
  if (!history) { res.status(404).json({ message: 'Không tìm thấy lịch sử vote' }); return; }
  const entries = await all<Row>(`SELECT id,source_match_id,round_no,position,scheduled_at,
    team_a_name,team_b_name,score_a,score_b,handicap_a,handicap_b,winner_name,
    source_user_id,username,display_name,voted_team_name,awarded,voted_at,removed_at
    FROM vote_history_entries WHERE vote_history_id=$1 AND ($2::boolean OR source_user_id=$3)
    ORDER BY round_no,position,source_match_id,LOWER(display_name),source_user_id`, [id, isAdmin, req.actor!.id]);
  res.json({ history, entries });
}));
app.post('/leaderboard/reset', auth, admin, route(async (_req, res) => {
  const pendingHistory = Number((await one<Row>('SELECT COUNT(*)::int n FROM votes WHERE awarded IS NOT NULL'))!.n);
  if (pendingHistory) { res.status(409).json({ message: 'Hãy reset giải đấu hiện tại trước khi reset điểm tích lũy' }); return; }
  await pool.query('UPDATE user_prediction_scores SET points=0,correct=0,wrong=0,scored_votes=0,updated_at=CURRENT_TIMESTAMP');
  res.json({ ok: true });
}));
app.post('/teams', auth, admin, route(async (req, res) => {
  const { name, captain, color = '#c9ff47' } = req.body; if (!name || !captain) { res.status(400).json({ message: 'Tên đội và đội trưởng là bắt buộc' }); return; }
  try { const row = await one<Row>('INSERT INTO teams(name,captain,color) VALUES($1,$2,$3) RETURNING id', [name, captain, color]); res.status(201).json({ id: Number(row!.id) }); }
  catch (error: any) { if (error?.code === '23505') { res.status(409).json({ message: 'Tên đội đã tồn tại' }); return; } throw error; }
}));
app.patch('/teams/:id', auth, admin, route(async (req, res) => {
  const id = Number(req.params.id);
  if (req.body.active != null) { const used = Number((await one<Row>('SELECT COUNT(*)::int n FROM matches WHERE team_a_id=$1 OR team_b_id=$1', [id]))!.n); if (used) { res.status(409).json({ message: 'Hãy reset giải đấu trước khi đổi trạng thái đội đã được xếp lịch' }); return; } }
  const result = await pool.query('UPDATE teams SET name=COALESCE($1,name),captain=COALESCE($2,captain),color=COALESCE($3,color),active=COALESCE($4,active) WHERE id=$5', [req.body.name ?? null, req.body.captain ?? null, req.body.color ?? null, req.body.active == null ? null : Boolean(req.body.active), id]);
  if (!result.rowCount) { res.status(404).json({ message: 'Không tìm thấy đội' }); return; } res.json({ ok: true });
}));
app.delete('/teams/:id', auth, admin, route(async (req, res) => {
  const id = Number(req.params.id); if (!Number.isInteger(id) || id < 1) { res.status(400).json({ message: 'Mã đội không hợp lệ' }); return; }
  if (!(await one<Row>('SELECT id FROM teams WHERE id=$1', [id]))) { res.status(404).json({ message: 'Không tìm thấy đội' }); return; }
  const used = Number((await one<Row>('SELECT COUNT(*)::int n FROM matches WHERE team_a_id=$1 OR team_b_id=$1 OR winner_id=$1', [id]))!.n); if (used) { res.status(409).json({ message: 'Không thể xóa đội đã xuất hiện trong nhánh đấu' }); return; }
  await pool.query('DELETE FROM teams WHERE id=$1', [id]); res.json({ ok: true });
}));
app.post('/tournaments', auth, admin, route(async (req, res) => {
  const { name, startAt, teamIds = [] } = req.body; if (!name) { res.status(400).json({ message: 'Tên giải là bắt buộc' }); return; }
  const tournamentStart = vietnamDateAt1230(startAt || new Date()); if (!tournamentStart) { res.status(400).json({ message: 'Ngày diễn ra không hợp lệ' }); return; }
  const id = await transaction(async (client) => { const row = (await client.query('INSERT INTO tournaments(name,start_at) VALUES($1,$2) RETURNING id', [name, tournamentStart.toISOString()])).rows[0]; for (const teamId of teamIds) await client.query('INSERT INTO tournament_teams VALUES($1,$2)', [row.id, teamId]); return Number(row.id); });
  res.status(201).json({ id });
}));

app.post('/tournaments/:id/generate', auth, admin, route(async (req, res) => {
  const tid = Number(req.params.id), t = await one<Row>('SELECT * FROM tournaments WHERE id=$1', [tid]); if (!t) { res.status(404).json({ message: 'Không tìm thấy giải' }); return; }
  if (Number((await one<Row>('SELECT COUNT(*)::int n FROM matches WHERE tournament_id=$1', [tid]))!.n)) { res.status(409).json({ message: 'Giải đã được xếp lịch' }); return; }
  const source = (await all<Row>('SELECT id FROM teams WHERE active=TRUE ORDER BY id')).map((x) => Number(x.id)); if (source.length < 2) { res.status(400).json({ message: 'Cần ít nhất 2 đội đang hoạt động' }); return; }
  const shuffle = (values: number[]) => { const a = [...values]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const size = 2 ** Math.ceil(Math.log2(source.length)), rounds = Math.log2(size), byeCount = size - source.length; let slots: (number | null)[] = [], signature = '';
  for (let attempt = 0; attempt < 30; attempt++) { const ids = shuffle(source), pairs: (number | null)[][] = []; for (let i = 0; i < byeCount; i++) pairs.push([ids[i], null]); for (let i = byeCount; i < ids.length; i += 2) pairs.push([ids[i], ids[i + 1]]); for (let i = pairs.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pairs[i], pairs[j]] = [pairs[j], pairs[i]]; } slots = pairs.flat(); signature = slots.map((x) => x ?? 0).join(','); if (signature !== t.last_draw_signature) break; }
  if (signature === t.last_draw_signature) { slots.reverse(); signature = slots.map((x) => x ?? 0).join(','); }
  await transaction(async (client: PoolClient) => {
    const created = new Map<string, number>();
    for (let r = rounds; r >= 1; r--) for (let p = 1; p <= size / 2 ** r; p++) { const next = r === rounds ? null : created.get(`${r + 1}:${Math.ceil(p / 2)}`)!; const row = (await client.query('INSERT INTO matches(tournament_id,round_no,position,scheduled_at,next_match_id,next_slot) VALUES($1,$2,$3,$4,$5,$6) RETURNING id', [tid, r, p, null, next, p % 2 ? 'a' : 'b'])).rows[0]; created.set(`${r}:${p}`, Number(row.id)); }
    const start = vietnamDateAt1230(t.start_at || t.created_at || new Date())!;
    for (let p = 1; p <= size / 2; p++) { const teamA = slots[(p - 1) * 2], teamB = slots[(p - 1) * 2 + 1], matchId = created.get(`1:${p}`)!, at = new Date(start.getTime() + (p - 1) * 90 * 60_000).toISOString(); await client.query('UPDATE matches SET team_a_id=$1,team_b_id=$2,scheduled_at=$3 WHERE id=$4', [teamA, teamB, at, matchId]); if (teamA && !teamB) { const m = (await client.query('SELECT next_match_id,next_slot FROM matches WHERE id=$1', [matchId])).rows[0]; await client.query("UPDATE matches SET winner_id=$1,status='bye' WHERE id=$2", [teamA, matchId]); if (m.next_match_id) await client.query(`UPDATE matches SET ${m.next_slot === 'a' ? 'team_a_id' : 'team_b_id'}=$1 WHERE id=$2`, [teamA, m.next_match_id]); } }
    await client.query("UPDATE tournaments SET status='active',last_draw_signature=$1 WHERE id=$2", [signature, tid]);
  });
  res.json({ ok: true, teamCount: source.length, rounds });
}));
app.patch('/tournaments/:id/pairings', auth, admin, route(async (req, res) => {
  const tid = Number(req.params.id);
  const teamIds = Array.isArray(req.body.teamIds) ? req.body.teamIds.map(Number) : [];
  if (!Number.isInteger(tid) || tid < 1 || teamIds.some((id: number) => !Number.isInteger(id) || id < 1) || new Set(teamIds).size !== teamIds.length) {
    res.status(400).json({ message: 'Danh sách đội không hợp lệ' }); return;
  }
  await transaction(async (client) => {
    const tournament = (await client.query('SELECT id FROM tournaments WHERE id=$1 FOR UPDATE', [tid])).rows[0];
    if (!tournament) { const error: any = new Error('Không tìm thấy giải'); error.status = 404; throw error; }
    const matches = (await client.query('SELECT * FROM matches WHERE tournament_id=$1 ORDER BY round_no,position FOR UPDATE', [tid])).rows;
    const firstRound = matches.filter((m) => Number(m.round_no) === 1);
    if (!firstRound.length) { const error: any = new Error('Giải chưa được xếp lịch'); error.status = 409; throw error; }
    const currentIds = firstRound.flatMap((m) => [m.team_a_id, m.team_b_id]).filter(Boolean).map(Number).sort((a, b) => a - b);
    const requestedIds = [...teamIds].sort((a, b) => a - b);
    if (currentIds.length !== requestedIds.length || currentIds.some((id, index) => id !== requestedIds[index])) {
      const error: any = new Error('Danh sách đội phải giữ nguyên các đội đã được xếp lịch'); error.status = 400; throw error;
    }
    const voteCount = Number((await client.query('SELECT COUNT(*)::int n FROM votes v JOIN matches m ON m.id=v.match_id WHERE m.tournament_id=$1', [tid])).rows[0].n);
    const playedCount = matches.filter((m) => m.status === 'finished').length;
    if (voteCount || playedCount) {
      const error: any = new Error('Không thể đổi cặp sau khi đã có bình chọn hoặc kết quả thi đấu'); error.status = 409; throw error;
    }
    await client.query("UPDATE matches SET team_a_id=NULL,team_b_id=NULL,winner_id=NULL,score_a=NULL,score_b=NULL,status='scheduled',voting_locked=FALSE,hidden=FALSE,handicap_a=0,handicap_b=0 WHERE tournament_id=$1 AND round_no>1", [tid]);
    let index = 0;
    const signature: number[] = [];
    for (const match of firstRound) {
      const teamA = match.team_a_id == null ? null : teamIds[index++];
      const teamB = match.team_b_id == null ? null : teamIds[index++];
      signature.push(teamA ?? 0, teamB ?? 0);
      await client.query("UPDATE matches SET team_a_id=$1,team_b_id=$2,winner_id=NULL,score_a=NULL,score_b=NULL,status='scheduled',voting_locked=FALSE,hidden=FALSE,handicap_a=0,handicap_b=0 WHERE id=$3", [teamA, teamB, match.id]);
      if ((teamA == null) !== (teamB == null)) {
        const winner = teamA ?? teamB;
        await client.query("UPDATE matches SET winner_id=$1,status='bye' WHERE id=$2", [winner, match.id]);
        if (match.next_match_id) {
          const column = match.next_slot === 'a' ? 'team_a_id' : 'team_b_id';
          await client.query(`UPDATE matches SET ${column}=$1 WHERE id=$2`, [winner, match.next_match_id]);
        }
      }
    }
    await client.query('UPDATE tournaments SET last_draw_signature=$1 WHERE id=$2', [signature.join(','), tid]);
  }).catch((error: any) => {
    if (error?.status) { res.status(error.status).json({ message: error.message }); return; }
    throw error;
  });
  if (!res.headersSent) res.json({ ok: true });
}));
app.post('/tournaments/:id/reset', auth, admin, route(async (req, res) => {
  const tid = Number(req.params.id), tournament = await one<Row>('SELECT id,name FROM tournaments WHERE id=$1', [tid]); if (!tournament) { res.status(404).json({ message: 'Không tìm thấy giải' }); return; }
  const matchSummary = (await one<Row>(`SELECT
    COUNT(*) FILTER (WHERE team_a_id IS NOT NULL AND team_b_id IS NOT NULL)::int confirmed_count,
    COALESCE(MAX(round_no),1)::int max_round
    FROM matches WHERE tournament_id=$1`, [tid]))!;
  const confirmedMatchCount = Number(matchSummary.confirmed_count);
  if (!confirmedMatchCount) { res.status(409).json({ message: 'Giải chưa có cặp đấu đã xác định để lưu lịch sử' }); return; }
  await transaction(async (client) => {
    const archive = (await client.query('INSERT INTO tournament_history(source_tournament_id,tournament_name,max_round) VALUES($1,$2,$3) RETURNING id', [tid, tournament.name, matchSummary.max_round])).rows[0];
    await client.query(`INSERT INTO match_history(history_id,round_no,position,team_a_name,team_a_captain,team_b_name,team_b_captain,score_a,score_b,winner_name,status)
      SELECT $1,m.round_no,m.position,a.name,a.captain,b.name,b.captain,m.score_a,m.score_b,w.name,m.status
      FROM matches m LEFT JOIN teams a ON a.id=m.team_a_id LEFT JOIN teams b ON b.id=m.team_b_id LEFT JOIN teams w ON w.id=m.winner_id
      WHERE m.tournament_id=$2 AND m.team_a_id IS NOT NULL AND m.team_b_id IS NOT NULL
      ORDER BY m.round_no,m.position`, [archive.id, tid]);
    await client.query('DELETE FROM matches WHERE tournament_id=$1', [tid]);
    await client.query("UPDATE tournaments SET status='draft' WHERE id=$1", [tid]);
  }); res.json({ ok: true, archivedMatches: confirmedMatchCount });
}));
app.post('/tournaments/:id/cancel', auth, admin, route(async (req, res) => {
  const tid = Number(req.params.id);
  if (!(await one<Row>('SELECT id FROM tournaments WHERE id=$1', [tid]))) { res.status(404).json({ message: 'Không tìm thấy giải' }); return; }
  const matchCount = Number((await one<Row>('SELECT COUNT(*)::int n FROM matches WHERE tournament_id=$1', [tid]))!.n);
  if (!matchCount) { res.status(409).json({ message: 'Giải chưa có lịch đấu để huỷ' }); return; }
  await transaction(async (client) => {
    await client.query('DELETE FROM matches WHERE tournament_id=$1', [tid]);
    await client.query("UPDATE tournaments SET status='draft' WHERE id=$1", [tid]);
  });
  res.json({ ok: true, cancelledMatches: matchCount });
}));
app.patch('/matches/:id', auth, admin, route(async (req, res) => {
  const id = Number(req.params.id), m = await one<Row>('SELECT * FROM matches WHERE id=$1', [id]); if (!m) { res.status(404).json({ message: 'Không tìm thấy trận' }); return; }
  const { handicapA, handicapB, scheduledAt, scoreA, scoreB, votingLocked, hidden } = req.body, hA = Number(handicapA ?? m.handicap_a), hB = Number(handicapB ?? m.handicap_b);
  if (!Number.isFinite(hA) || !Number.isFinite(hB) || hA < 0 || hB < 0) { res.status(400).json({ message: 'Điểm chấp phải là số không âm' }); return; }
  if (scoreA != null && scoreB != null && (!m.team_a_id || !m.team_b_id)) { res.status(400).json({ message: 'Trận đấu chưa đủ hai đội' }); return; }
  const finalA = Number(scoreA) + hA, finalB = Number(scoreB) + hB; if (scoreA != null && scoreB != null && finalA === finalB) { res.status(400).json({ message: 'Tổng điểm sau chấp không được hòa' }); return; }
  await transaction(async (client) => {
    await client.query('UPDATE matches SET handicap_a=$1,handicap_b=$2,scheduled_at=COALESCE($3,scheduled_at),voting_locked=COALESCE($4,voting_locked),hidden=COALESCE($5,hidden) WHERE id=$6', [hA, hB, scheduledAt ?? null, votingLocked == null ? null : Boolean(votingLocked), hidden == null ? null : Boolean(hidden), id]);
    if (scoreA != null && scoreB != null) { const winner = finalA > finalB ? m.team_a_id : m.team_b_id; await client.query("UPDATE matches SET score_a=$1,score_b=$2,winner_id=$3,status='finished',voting_locked=TRUE WHERE id=$4", [scoreA, scoreB, winner, id]); const scored=(await client.query('SELECT user_id,awarded,CASE WHEN team_id=$1 THEN 1 ELSE -1 END new_awarded FROM votes WHERE match_id=$2 FOR UPDATE',[winner,id])).rows;for(const vote of scored){const oldAward=vote.awarded==null?null:Number(vote.awarded),newAward=Number(vote.new_awarded);await client.query('UPDATE votes SET awarded=$1 WHERE user_id=$2 AND match_id=$3',[newAward,vote.user_id,id]);await client.query(`INSERT INTO user_prediction_scores(user_id,points,correct,wrong,scored_votes) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(user_id) DO UPDATE SET points=user_prediction_scores.points+EXCLUDED.points,correct=user_prediction_scores.correct+EXCLUDED.correct,wrong=user_prediction_scores.wrong+EXCLUDED.wrong,scored_votes=user_prediction_scores.scored_votes+EXCLUDED.scored_votes,updated_at=CURRENT_TIMESTAMP`,[vote.user_id,newAward-(oldAward??0),(newAward===1?1:0)-(oldAward===1?1:0),(newAward===-1?1:0)-(oldAward===-1?1:0),oldAward==null?1:0]);} if (m.next_match_id) await client.query(`UPDATE matches SET ${m.next_slot === 'a' ? 'team_a_id' : 'team_b_id'}=$1 WHERE id=$2`, [winner, m.next_match_id]); else await client.query("UPDATE tournaments SET status='finished' WHERE id=$1", [m.tournament_id]); await syncTournamentVoteHistory(client, Number(m.tournament_id)); }
  }); res.json({ ok: true });
}));
app.get('/matches/:id/votes', auth, admin, route(async (req, res) => {
  const id = Number(req.params.id), match = await one<Row>('SELECT m.id,m.team_a_id,m.team_b_id,a.name team_a_name,b.name team_b_name FROM matches m LEFT JOIN teams a ON a.id=m.team_a_id LEFT JOIN teams b ON b.id=m.team_b_id WHERE m.id=$1', [id]);
  if (!match) { res.status(404).json({ message: 'Không tìm thấy trận' }); return; }
  const votes = await all<Row>('SELECT v.user_id,v.team_id,v.awarded,v.created_at,u.username,u.display_name,t.name team_name FROM votes v JOIN users u ON u.id=v.user_id JOIN teams t ON t.id=v.team_id WHERE v.match_id=$1 ORDER BY v.created_at DESC,u.display_name', [id]); res.json({ match, votes });
}));
app.delete('/matches/:matchId/votes/:userId', auth, admin, route(async (req, res) => {
  const matchId = Number(req.params.matchId), userId = Number(req.params.userId);
  if (!Number.isInteger(matchId) || matchId < 1 || !Number.isInteger(userId) || userId < 1) { res.status(400).json({ message: 'Thông tin vote không hợp lệ' }); return; }
  const removed = await transaction(async (client) => {
    const vote = (await client.query('SELECT user_id,match_id,awarded FROM votes WHERE user_id=$1 AND match_id=$2 FOR UPDATE', [userId, matchId])).rows[0];
    if (!vote) return false;
    if (vote.awarded != null) {
      const awarded = Number(vote.awarded);
      await client.query(`UPDATE user_prediction_scores SET
        points=points-$1,
        correct=GREATEST(correct-$2,0),
        wrong=GREATEST(wrong-$3,0),
        scored_votes=GREATEST(scored_votes-1,0),
        updated_at=CURRENT_TIMESTAMP
        WHERE user_id=$4`, [awarded, awarded === 1 ? 1 : 0, awarded === -1 ? 1 : 0, userId]);
    }
    await client.query('UPDATE vote_history_entries SET removed_at=COALESCE(removed_at,CURRENT_TIMESTAMP),updated_at=CURRENT_TIMESTAMP WHERE source_match_id=$1 AND source_user_id=$2', [matchId, userId]);
    await client.query('DELETE FROM votes WHERE user_id=$1 AND match_id=$2', [userId, matchId]);
    return true;
  });
  if (!removed) { res.status(404).json({ message: 'Không tìm thấy vote cần xoá' }); return; }
  res.json({ ok: true });
}));
app.post('/matches/:id/vote', auth, route(async (req, res) => {
  if (req.actor!.role !== 'user') { res.status(403).json({ message: 'Chỉ tài khoản user được bình chọn' }); return; }
  const id = Number(req.params.id), team = Number(req.body.teamId), m = await one<Row>('SELECT * FROM matches WHERE id=$1', [id]);
  if (!m || m.status !== 'scheduled' || m.voting_locked || ![Number(m.team_a_id), Number(m.team_b_id)].includes(team)) { res.status(400).json({ message: m?.voting_locked ? 'Bình chọn đã bị khóa' : 'Không thể bình chọn cho trận này' }); return; }
  await pool.query(`INSERT INTO votes(user_id,match_id,team_id,awarded) VALUES($1,$2,$3,NULL) ON CONFLICT(user_id,match_id) DO UPDATE SET team_id=EXCLUDED.team_id,awarded=NULL,created_at=CURRENT_TIMESTAMP`, [req.actor!.id, id, team]); res.json({ ok: true });
}));

app.get('/health', async (_req, res) => { await pool.query('SELECT 1'); res.json({ ok: true }); });
app.use((_req, res) => res.status(404).json({ message: 'Không tìm thấy tài nguyên' }));
app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => { console.error(error); res.status(500).json({ message: 'Lỗi máy chủ' }); });
const apiPort = Number(process.env.API_PORT || 4001);
const server = app.listen(apiPort, '127.0.0.1', () => console.log(`API listening on ${apiPort}`));
const shutdown = () => server.close(() => { void pool.end().finally(() => process.exit(0)); });
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
