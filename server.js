/**
 * RTCA — Real-Time Chat App
 *
 * @author  Shola Adewale <hello@adesho.la>
 * @website https://adesho.la
 * @version 2.0.0
 */

const express   = require('express');
const http      = require('http');
const socketIO  = require('socket.io');
const path      = require('path');
const crypto    = require('crypto');
const Database  = require('better-sqlite3');

// ─── App / Server setup ───────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = socketIO(server, { cors: { origin: '*', methods: ['GET','POST'] } });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ─── SQLite setup ─────────────────────────────────────────────────────────────
const db = new Database(path.join(__dirname, 'rtca.db'));
db.pragma('journal_mode = WAL');   // better concurrent reads
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    username    TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    username_lc TEXT    NOT NULL UNIQUE,
    password_hash TEXT  NOT NULL,
    avatar      TEXT    NOT NULL,
    color       TEXT    NOT NULL,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL   -- unix ms; row deleted after this
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token       TEXT    PRIMARY KEY,
    username_lc TEXT    NOT NULL,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL
  );

  -- track which username_lc currently has an active socket connection
  -- (enforces single-session-per-account rule)
  CREATE TABLE IF NOT EXISTS active_logins (
    username_lc TEXT PRIMARY KEY,
    socket_id   TEXT NOT NULL
  );
`);

// ─── Constants ────────────────────────────────────────────────────────────────
const TTL_MS     = 24 * 60 * 60 * 1000;   // 24 h in milliseconds
const hashPw     = pw  => crypto.createHash('sha256').update(pw).digest('hex');
const uuid       = ()  => crypto.randomUUID();
const randOf     = arr => arr[Math.floor(Math.random() * arr.length)];
const nowMs      = ()  => Date.now();

const AVATARS = ['🦊','🐺','🦁','🐯','🐻','🐼','🦝','🐨','🦉','🦋','🐬','🦄','🐙','🦖','🦚'];
const COLORS  = ['#6366f1','#10b981','#f59e0b','#ef4444','#8b5cf6','#06b6d4','#ec4899','#84cc16','#f97316','#14b8a6'];

// ─── Prepared statements ──────────────────────────────────────────────────────
const stmt = {
  // users
  insertUser:    db.prepare(`INSERT INTO users (username, username_lc, password_hash, avatar, color, created_at, expires_at)
                             VALUES (@username, @username_lc, @password_hash, @avatar, @color, @created_at, @expires_at)`),
  getUserByKey:  db.prepare(`SELECT * FROM users WHERE username_lc = ? AND expires_at > ?`),
  deleteExpiredUsers: db.prepare(`DELETE FROM users WHERE expires_at <= ?`),
  renewUser:     db.prepare(`UPDATE users SET expires_at = ? WHERE username_lc = ?`),

  // sessions
  insertSession: db.prepare(`INSERT INTO sessions (token, username_lc, created_at, expires_at)
                             VALUES (@token, @username_lc, @created_at, @expires_at)`),
  getSession:    db.prepare(`SELECT * FROM sessions WHERE token = ? AND expires_at > ?`),
  deleteSession: db.prepare(`DELETE FROM sessions WHERE token = ?`),
  deleteExpiredSessions: db.prepare(`DELETE FROM sessions WHERE expires_at <= ?`),
  deleteUserSessions:    db.prepare(`DELETE FROM sessions WHERE username_lc = ?`),

  // active logins (single-session enforcement)
  setActiveLogin:    db.prepare(`INSERT OR REPLACE INTO active_logins (username_lc, socket_id) VALUES (?, ?)`),
  getActiveLogin:    db.prepare(`SELECT socket_id FROM active_logins WHERE username_lc = ?`),
  deleteActiveLogin: db.prepare(`DELETE FROM active_logins WHERE username_lc = ?`),
  deleteActiveBySocket: db.prepare(`DELETE FROM active_logins WHERE socket_id = ?`),
};

// ─── Cleanup job — runs every hour, purges expired rows ───────────────────────
function purgeExpired() {
  const now = nowMs();
  const u = stmt.deleteExpiredUsers.run(now);
  const s = stmt.deleteExpiredSessions.run(now);
  if (u.changes || s.changes)
    console.log(`[cleanup] purged ${u.changes} user(s), ${s.changes} session(s)`);
}
purgeExpired();                          // run once on startup
setInterval(purgeExpired, 60 * 60 * 1000); // then every hour

// ─── Helpers ──────────────────────────────────────────────────────────────────
function getValidSession(token) {
  if (!token) return null;
  return stmt.getSession.get(token, nowMs()) || null;
}

function getValidUser(username_lc) {
  return stmt.getUserByKey.get(username_lc, nowMs()) || null;
}

// ─── In-memory chat state (rooms + message history + socket map) ──────────────
// Rooms survive server restarts via defaults; user-created rooms are in-memory only
// (add a rooms table if you want them persisted too)
const rooms = {
  lounge: { id:'lounge', name:'The Lounge',   emoji:'🛋️', description:'Chill convos & general chat',   color:'#6366f1', createdBy:'system', createdAt:nowMs(), isDefault:true },
  dev:    { id:'dev',    name:'Dev Corner',    emoji:'💻', description:'Code, bugs & late-night fixes', color:'#10b981', createdBy:'system', createdAt:nowMs(), isDefault:true },
  design: { id:'design', name:'Design Studio', emoji:'🎨', description:'UI, UX, pixels and vibes',      color:'#f59e0b', createdBy:'system', createdAt:nowMs(), isDefault:true },
  gaming: { id:'gaming', name:'Game Room',     emoji:'🎮', description:'GGs, strats & controller rage', color:'#ef4444', createdBy:'system', createdAt:nowMs(), isDefault:true },
  music:  { id:'music',  name:'Music Box',     emoji:'🎵', description:'Beats, recs & mood playlists',  color:'#8b5cf6', createdBy:'system', createdAt:nowMs(), isDefault:true },
};
const history = {};
Object.keys(rooms).forEach(id => history[id] = []);

// activeSockets[socketId] = { socketId, username_lc, room }
const activeSockets = {};

// ─── REST: Register ───────────────────────────────────────────────────────────
app.post('/api/register', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required.' });
  const u   = username.trim().slice(0, 24);
  const key = u.toLowerCase();
  if (u.length < 2)    return res.status(400).json({ error: 'Username must be at least 2 characters.' });
  if (password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters.' });

  // Check if username already exists AND is not expired
  if (getValidUser(key)) return res.status(409).json({ error: 'Username already taken.' });

  // If expired row exists for this key it will be overwritten by DELETE + INSERT
  db.prepare(`DELETE FROM users WHERE username_lc = ?`).run(key);

  const now = nowMs();
  try {
    stmt.insertUser.run({
      username: u, username_lc: key,
      password_hash: hashPw(password),
      avatar: randOf(AVATARS), color: randOf(COLORS),
      created_at: now, expires_at: now + TTL_MS,
    });
  } catch (e) {
    return res.status(409).json({ error: 'Username already taken.' });
  }

  const user  = getValidUser(key);
  const token = uuid();
  stmt.insertSession.run({ token, username_lc: key, created_at: now, expires_at: now + TTL_MS });
  res.json({ token, username: user.username, avatar: user.avatar, color: user.color });
});

// ─── REST: Login ──────────────────────────────────────────────────────────────
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required.' });
  const key  = username.trim().toLowerCase();
  const user = getValidUser(key);
  if (!user || user.password_hash !== hashPw(password))
    return res.status(401).json({ error: 'Invalid username or password.' });

  // ── Single-session enforcement ──────────────────────────────────────────────
  // Check if this account already has an active socket connection
  const existing = stmt.getActiveLogin.get(key);
  if (existing) {
    return res.status(409).json({
      error: 'This account is already logged in on another device or tab. Please sign out there first.',
      code:  'ALREADY_LOGGED_IN',
    });
  }

  // Renew the 24-hour expiry on every login
  const now = nowMs();
  stmt.renewUser.run(now + TTL_MS, key);
  stmt.deleteUserSessions.run(key);   // invalidate old sessions
  const token = uuid();
  stmt.insertSession.run({ token, username_lc: key, created_at: now, expires_at: now + TTL_MS });
  res.json({ token, username: user.username, avatar: user.avatar, color: user.color });
});

// ─── REST: Logout ─────────────────────────────────────────────────────────────
app.post('/api/logout', (req, res) => {
  const { token } = req.body || {};
  if (!token) return res.sendStatus(204);
  const session = getValidSession(token);
  if (session) {
    stmt.deleteSession.run(token);
    stmt.deleteActiveLogin.run(session.username_lc);
  }
  res.sendStatus(204);
});

// ─── REST: Rooms ──────────────────────────────────────────────────────────────
app.get('/api/rooms', (_req, res) => res.json(Object.values(rooms)));

app.post('/api/rooms', (req, res) => {
  const { token, name, emoji, description } = req.body || {};
  const session = getValidSession(token);
  if (!session) return res.status(401).json({ error: 'Not authenticated.' });
  const user = getValidUser(session.username_lc);
  if (!user)   return res.status(401).json({ error: 'Account expired. Please register again.' });

  const cleanName = (name || '').trim().slice(0, 32);
  if (cleanName.length < 2) return res.status(400).json({ error: 'Room name must be at least 2 characters.' });
  if (Object.values(rooms).some(r => r.name.toLowerCase() === cleanName.toLowerCase()))
    return res.status(409).json({ error: 'A room with that name already exists.' });

  const ROOM_COLORS = ['#6366f1','#10b981','#f59e0b','#ef4444','#8b5cf6','#06b6d4','#ec4899','#84cc16'];
  const id   = cleanName.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'') + '-' + Date.now().toString(36);
  const room = {
    id, name: cleanName,
    emoji:       (emoji || '💬').trim().slice(0, 4),
    description: (description || '').trim().slice(0, 80) || `Created by ${user.username}`,
    color:       randOf(ROOM_COLORS),
    createdBy:   user.username,
    createdAt:   nowMs(),
    isDefault:   false,
  };
  rooms[id]  = room;
  history[id] = [];
  io.emit('room:created', room);
  res.json(room);
});

// ─── Socket Auth Middleware ────────────────────────────────────────────────────
io.use((socket, next) => {
  const token   = socket.handshake.auth?.token;
  const session = getValidSession(token);
  if (!session) return next(new Error('Unauthorized'));
  const user = getValidUser(session.username_lc);
  if (!user)   return next(new Error('AccountExpired'));
  socket._accountKey = session.username_lc;
  socket._user       = user;
  next();
});

// ─── Socket Helpers ────────────────────────────────────────────────────────────
function getRoomUserList(roomId) {
  return Object.values(activeSockets)
    .filter(s => s.room === roomId)
    .map(s => {
      const u = s.user;
      return { id: s.socketId, username: u.username, avatar: u.avatar, color: u.color };
    });
}
function broadcastPresence(roomId) {
  io.to(roomId).emit('presence:update', { roomId, users: getRoomUserList(roomId) });
}
function serializeMsg(msg) {
  const reactions = {};
  for (const [e, s] of Object.entries(msg.reactions || {})) {
    const n = s instanceof Set ? s.size : s;
    if (n > 0) reactions[e] = n;
  }
  return { ...msg, reactions };
}
function sysMsg(roomId, content) {
  const msg = { id: uuid(), type: 'system', content, timestamp: nowMs(), room: roomId };
  history[roomId].push(msg);
  io.to(roomId).emit('message:new', msg);
}

// ─── Socket Events ─────────────────────────────────────────────────────────────
io.on('connection', socket => {
  const user = socket._user;
  const key  = socket._accountKey;

  // ── Enforce single concurrent session ────────────────────────────────────────
  const already = stmt.getActiveLogin.get(key);
  if (already && already.socket_id !== socket.id) {
    // kick the old socket out gracefully
    const oldSocket = io.sockets.sockets.get(already.socket_id);
    if (oldSocket) {
      oldSocket.emit('force:logout', { reason: 'You were signed in from another location.' });
      oldSocket.disconnect(true);
    }
  }
  stmt.setActiveLogin.run(key, socket.id);

  socket.on('user:join', ({ roomId }) => {
    const rid = rooms[roomId] ? roomId : 'lounge';
    activeSockets[socket.id] = { socketId: socket.id, accountKey: key, user, room: rid };
    socket.join(rid);
    socket.emit('init', {
      user:    { id: socket.id, username: user.username, avatar: user.avatar, color: user.color },
      rooms:   Object.values(rooms),
      history: history[rid].map(serializeMsg),
    });
    sysMsg(rid, `${user.username} joined`);
    broadcastPresence(rid);
  });

  socket.on('room:switch', newId => {
    const s = activeSockets[socket.id];
    if (!s || !rooms[newId] || s.room === newId) return;
    const old = s.room;
    socket.leave(old);
    sysMsg(old, `${user.username} left`);
    broadcastPresence(old);
    s.room = newId;
    socket.join(newId);
    socket.emit('room:switched', { roomId: newId, history: history[newId].map(serializeMsg) });
    sysMsg(newId, `${user.username} joined`);
    broadcastPresence(newId);
  });

  socket.on('message:send', ({ content, mentions }) => {
    const s = activeSockets[socket.id];
    if (!s || !content?.trim()) return;
    const msg = {
      id: uuid(), type: 'user', userId: socket.id,
      username: user.username, avatar: user.avatar, color: user.color,
      content: content.trim().slice(0, 1000),
      timestamp: nowMs(), room: s.room,
      mentions: Array.isArray(mentions) ? mentions.slice(0, 20) : [],
      reactions: {},
    };
    history[s.room].push(msg);
    if (history[s.room].length > 150) history[s.room].shift();
    io.to(s.room).emit('message:new', serializeMsg(msg));
  });

  socket.on('typing:start', () => {
    const s = activeSockets[socket.id];
    if (s) socket.to(s.room).emit('typing:update', { userId: socket.id, username: user.username, isTyping: true });
  });
  socket.on('typing:stop', () => {
    const s = activeSockets[socket.id];
    if (s) socket.to(s.room).emit('typing:update', { userId: socket.id, username: user.username, isTyping: false });
  });

  socket.on('message:react', ({ messageId, emoji }) => {
    const s = activeSockets[socket.id];
    if (!s) return;
    const msg = history[s.room].find(m => m.id === messageId);
    if (!msg || msg.type !== 'user') return;
    if (!msg.reactions[emoji]) msg.reactions[emoji] = new Set();
    if (msg.reactions[emoji].has(socket.id)) msg.reactions[emoji].delete(socket.id);
    else msg.reactions[emoji].add(socket.id);
    const counts = {};
    for (const [e, set] of Object.entries(msg.reactions)) if (set.size > 0) counts[e] = set.size;
    io.to(s.room).emit('message:reactions', { messageId, reactions: counts });
  });

  socket.on('disconnect', () => {
    const s = activeSockets[socket.id];
    // Only clear active_login if it's still pointing at THIS socket
    const current = stmt.getActiveLogin.get(key);
    if (current && current.socket_id === socket.id) {
      stmt.deleteActiveLogin.run(key);
    }
    if (!s) return;
    sysMsg(s.room, `${user.username} disconnected`);
    delete activeSockets[socket.id];
    broadcastPresence(s.room);
  });
});

// ─── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`\n  ✦  RTCA  →  http://localhost:${PORT}\n`));
