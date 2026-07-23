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
    all<Row>(`SELECT m.*,a.name team_a_name,a.color team_a_color,b.name team_b_name,b.color team_b_color,w.name winner_name,
      (SELECT COUNT(*)::int FROM votes v WHERE v.match_id=m.id AND v.team_id=m.team_a_id) votes_a,
      (SELECT COUNT(*)::int FROM votes v WHERE v.match_id=m.id AND v.team_id=m.team_b_id) votes_b,
      (SELECT team_id FROM votes v WHERE v.match_id=m.id AND v.user_id=$1) my_vote
      FROM matches m LEFT JOIN teams a ON a.id=m.team_a_id LEFT JOIN teams b ON b.id=m.team_b_id LEFT JOIN teams w ON w.id=m.winner_id
      ORDER BY m.tournament_id DESC,m.round_no,m.position`, [req.actor?.id ?? null]),
    all<Row>(`SELECT h.id history_id,h.tournament_name,h.archived_at,m.id,m.round_no,m.position,
      MAX(m.round_no) OVER (PARTITION BY h.id)::int max_round,
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
app.post('/tournaments/:id/reset', auth, admin, route(async (req, res) => {
  const tid = Number(req.params.id), tournament = await one<Row>('SELECT id,name FROM tournaments WHERE id=$1', [tid]); if (!tournament) { res.status(404).json({ message: 'Không tìm thấy giải' }); return; }
  const matchCount = Number((await one<Row>('SELECT COUNT(*)::int n FROM matches WHERE tournament_id=$1', [tid]))!.n);
  if (!matchCount) { res.status(409).json({ message: 'Giải chưa có trận đấu để lưu lịch sử' }); return; }
  await transaction(async (client) => {
    const archive = (await client.query('INSERT INTO tournament_history(source_tournament_id,tournament_name) VALUES($1,$2) RETURNING id', [tid, tournament.name])).rows[0];
    await client.query(`INSERT INTO match_history(history_id,round_no,position,team_a_name,team_a_captain,team_b_name,team_b_captain,score_a,score_b,winner_name,status)
      SELECT $1,m.round_no,m.position,a.name,a.captain,b.name,b.captain,m.score_a,m.score_b,w.name,m.status
      FROM matches m LEFT JOIN teams a ON a.id=m.team_a_id LEFT JOIN teams b ON b.id=m.team_b_id LEFT JOIN teams w ON w.id=m.winner_id
      WHERE m.tournament_id=$2 ORDER BY m.round_no,m.position`, [archive.id, tid]);
    await client.query('DELETE FROM matches WHERE tournament_id=$1', [tid]);
    await client.query("UPDATE tournaments SET status='draft' WHERE id=$1", [tid]);
  }); res.json({ ok: true, archivedMatches: matchCount });
}));
app.patch('/matches/:id', auth, admin, route(async (req, res) => {
  const id = Number(req.params.id), m = await one<Row>('SELECT * FROM matches WHERE id=$1', [id]); if (!m) { res.status(404).json({ message: 'Không tìm thấy trận' }); return; }
  const { handicapA, handicapB, scheduledAt, scoreA, scoreB, votingLocked } = req.body, hA = Number(handicapA ?? m.handicap_a), hB = Number(handicapB ?? m.handicap_b);
  if (!Number.isFinite(hA) || !Number.isFinite(hB) || hA < 0 || hB < 0) { res.status(400).json({ message: 'Điểm chấp phải là số không âm' }); return; }
  if (scoreA != null && scoreB != null && (!m.team_a_id || !m.team_b_id)) { res.status(400).json({ message: 'Trận đấu chưa đủ hai đội' }); return; }
  const finalA = Number(scoreA) + hA, finalB = Number(scoreB) + hB; if (scoreA != null && scoreB != null && finalA === finalB) { res.status(400).json({ message: 'Tổng điểm sau chấp không được hòa' }); return; }
  await transaction(async (client) => {
    await client.query('UPDATE matches SET handicap_a=$1,handicap_b=$2,scheduled_at=COALESCE($3,scheduled_at),voting_locked=COALESCE($4,voting_locked) WHERE id=$5', [hA, hB, scheduledAt ?? null, votingLocked == null ? null : Boolean(votingLocked), id]);
    if (scoreA != null && scoreB != null) { const winner = finalA > finalB ? m.team_a_id : m.team_b_id; await client.query("UPDATE matches SET score_a=$1,score_b=$2,winner_id=$3,status='finished',voting_locked=TRUE WHERE id=$4", [scoreA, scoreB, winner, id]); const scored=(await client.query('SELECT user_id,awarded,CASE WHEN team_id=$1 THEN 1 ELSE -1 END new_awarded FROM votes WHERE match_id=$2 FOR UPDATE',[winner,id])).rows;for(const vote of scored){const oldAward=vote.awarded==null?null:Number(vote.awarded),newAward=Number(vote.new_awarded);await client.query('UPDATE votes SET awarded=$1 WHERE user_id=$2 AND match_id=$3',[newAward,vote.user_id,id]);await client.query(`INSERT INTO user_prediction_scores(user_id,points,correct,wrong,scored_votes) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(user_id) DO UPDATE SET points=user_prediction_scores.points+EXCLUDED.points,correct=user_prediction_scores.correct+EXCLUDED.correct,wrong=user_prediction_scores.wrong+EXCLUDED.wrong,scored_votes=user_prediction_scores.scored_votes+EXCLUDED.scored_votes,updated_at=CURRENT_TIMESTAMP`,[vote.user_id,newAward-(oldAward??0),(newAward===1?1:0)-(oldAward===1?1:0),(newAward===-1?1:0)-(oldAward===-1?1:0),oldAward==null?1:0]);} if (m.next_match_id) await client.query(`UPDATE matches SET ${m.next_slot === 'a' ? 'team_a_id' : 'team_b_id'}=$1 WHERE id=$2`, [winner, m.next_match_id]); else await client.query("UPDATE tournaments SET status='finished' WHERE id=$1", [m.tournament_id]); }
  }); res.json({ ok: true });
}));
app.get('/matches/:id/votes', auth, admin, route(async (req, res) => {
  const id = Number(req.params.id), match = await one<Row>('SELECT m.id,m.team_a_id,m.team_b_id,a.name team_a_name,b.name team_b_name FROM matches m LEFT JOIN teams a ON a.id=m.team_a_id LEFT JOIN teams b ON b.id=m.team_b_id WHERE m.id=$1', [id]);
  if (!match) { res.status(404).json({ message: 'Không tìm thấy trận' }); return; }
  const votes = await all<Row>('SELECT v.user_id,v.team_id,v.awarded,v.created_at,u.username,u.display_name,t.name team_name FROM votes v JOIN users u ON u.id=v.user_id JOIN teams t ON t.id=v.team_id WHERE v.match_id=$1 ORDER BY v.created_at DESC,u.display_name', [id]); res.json({ match, votes });
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
