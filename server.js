/**
 * RELAY — Real-Time Chat App
 *
 * @author  Shola Adewale <hello@adesho.la>
 * @website https://adesho.la
 * @version 1.0.0
 */

const express    = require('express');
const http       = require('http');
const socketIO   = require('socket.io');
const path       = require('path');
const crypto     = require('crypto');

const app    = express();
const server = http.createServer(app);
const io     = socketIO(server, { cors: { origin: '*', methods: ['GET','POST'] } });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ─── Helpers ──────────────────────────────────────────────────────────────────
const hashPw  = pw  => crypto.createHash('sha256').update(pw).digest('hex');
const uuid    = ()  => crypto.randomUUID();
const randOf  = arr => arr[Math.floor(Math.random() * arr.length)];

const AVATARS = ['🦊','🐺','🦁','🐯','🐻','🐼','🦝','🐨','🦉','🦋','🐬','🦄','🐙','🦖','🦚'];
const COLORS  = ['#6366f1','#10b981','#f59e0b','#ef4444','#8b5cf6','#06b6d4','#ec4899','#84cc16','#f97316','#14b8a6'];

// ─── In-Memory State ──────────────────────────────────────────────────────────
// accounts[username_lower] = { username, passwordHash, avatar, color, createdAt }
const accounts = {};
// sessions[token] = username_lower
const sessions = {};
// rooms[id] = { id, name, emoji, description, color, createdBy, createdAt, isDefault }
const rooms = {
  lounge: { id:'lounge', name:'The Lounge',   emoji:'🛋️', description:'Chill convos & general chat',   color:'#6366f1', createdBy:'system', createdAt:Date.now(), isDefault:true },
  dev:    { id:'dev',    name:'Dev Corner',    emoji:'💻', description:'Code, bugs & late-night fixes', color:'#10b981', createdBy:'system', createdAt:Date.now(), isDefault:true },
  design: { id:'design', name:'Design Studio', emoji:'🎨', description:'UI, UX, pixels and vibes',      color:'#f59e0b', createdBy:'system', createdAt:Date.now(), isDefault:true },
  gaming: { id:'gaming', name:'Game Room',     emoji:'🎮', description:'GGs, strats & controller rage', color:'#ef4444', createdBy:'system', createdAt:Date.now(), isDefault:true },
  music:  { id:'music',  name:'Music Box',     emoji:'🎵', description:'Beats, recs & mood playlists',  color:'#8b5cf6', createdBy:'system', createdAt:Date.now(), isDefault:true },
};
// history[roomId] = [msg, ...]
const history = {};
Object.keys(rooms).forEach(id => history[id] = []);
// activeSockets[socketId] = { socketId, usernameKey, room }
const activeSockets = {};

// ─── REST: Auth ───────────────────────────────────────────────────────────────
app.post('/api/register', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required.' });
  const u = username.trim().slice(0,24);
  if (u.length < 2) return res.status(400).json({ error: 'Username must be at least 2 characters.' });
  if (password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters.' });
  const key = u.toLowerCase();
  if (accounts[key]) return res.status(409).json({ error: 'Username already taken.' });
  accounts[key] = { username: u, passwordHash: hashPw(password), avatar: randOf(AVATARS), color: randOf(COLORS), createdAt: Date.now() };
  const token = uuid();
  sessions[token] = key;
  const acc = accounts[key];
  res.json({ token, username: acc.username, avatar: acc.avatar, color: acc.color });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required.' });
  const key = username.trim().toLowerCase();
  const acc = accounts[key];
  if (!acc || acc.passwordHash !== hashPw(password)) return res.status(401).json({ error: 'Invalid username or password.' });
  const token = uuid();
  sessions[token] = key;
  res.json({ token, username: acc.username, avatar: acc.avatar, color: acc.color });
});

// ─── REST: Rooms ──────────────────────────────────────────────────────────────
app.get('/api/rooms', (_req, res) => res.json(Object.values(rooms)));

app.post('/api/rooms', (req, res) => {
  const { token, name, emoji, description } = req.body || {};
  const key = sessions[token];
  if (!key) return res.status(401).json({ error: 'Not authenticated.' });
  const cleanName = (name || '').trim().slice(0,32);
  if (cleanName.length < 2) return res.status(400).json({ error: 'Room name must be at least 2 characters.' });
  if (Object.values(rooms).some(r => r.name.toLowerCase() === cleanName.toLowerCase()))
    return res.status(409).json({ error: 'A room with that name already exists.' });
  const slug = cleanName.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
  const id   = slug + '-' + Date.now().toString(36);
  const ROOM_COLORS = ['#6366f1','#10b981','#f59e0b','#ef4444','#8b5cf6','#06b6d4','#ec4899','#84cc16'];
  const room = {
    id, name: cleanName,
    emoji:       (emoji || '💬').trim().slice(0,4),
    description: (description || '').trim().slice(0,80) || `Created by ${accounts[key].username}`,
    color:       randOf(ROOM_COLORS),
    createdBy:   accounts[key].username,
    createdAt:   Date.now(),
    isDefault:   false,
  };
  rooms[id] = room;
  history[id] = [];
  io.emit('room:created', room);
  res.json(room);
});

// ─── Socket Auth ──────────────────────────────────────────────────────────────
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token || !sessions[token]) return next(new Error('Unauthorized'));
  socket._accountKey = sessions[token];
  next();
});

// ─── Socket Events ────────────────────────────────────────────────────────────
function getRoomUserList(roomId) {
  return Object.values(activeSockets)
    .filter(s => s.room === roomId)
    .map(s => {
      const a = accounts[s.accountKey];
      return { id:s.socketId, username:a.username, avatar:a.avatar, color:a.color };
    });
}
function broadcastPresence(roomId) {
  io.to(roomId).emit('presence:update', { roomId, users: getRoomUserList(roomId) });
}
function serializeMsg(msg) {
  const reactions = {};
  for (const [e,s] of Object.entries(msg.reactions||{})) {
    const n = s instanceof Set ? s.size : s;
    if (n > 0) reactions[e] = n;
  }
  return { ...msg, reactions };
}
function sysMsg(roomId, content) {
  const msg = { id:uuid(), type:'system', content, timestamp:Date.now(), room:roomId };
  history[roomId].push(msg);
  io.to(roomId).emit('message:new', msg);
}

io.on('connection', socket => {
  const acc = accounts[socket._accountKey];

  socket.on('user:join', ({ roomId }) => {
    const rid = rooms[roomId] ? roomId : 'lounge';
    activeSockets[socket.id] = { socketId:socket.id, accountKey:socket._accountKey, room:rid };
    socket.join(rid);
    socket.emit('init', {
      user:    { id:socket.id, username:acc.username, avatar:acc.avatar, color:acc.color },
      rooms:   Object.values(rooms),
      history: history[rid].map(serializeMsg),
    });
    sysMsg(rid, `${acc.username} joined`);
    broadcastPresence(rid);
  });

  socket.on('room:switch', newId => {
    const s = activeSockets[socket.id];
    if (!s || !rooms[newId] || s.room === newId) return;
    const old = s.room;
    socket.leave(old);
    sysMsg(old, `${acc.username} left`);
    broadcastPresence(old);
    s.room = newId;
    socket.join(newId);
    socket.emit('room:switched', { roomId:newId, history:history[newId].map(serializeMsg) });
    sysMsg(newId, `${acc.username} joined`);
    broadcastPresence(newId);
  });

  socket.on('message:send', ({ content, mentions }) => {
    const s = activeSockets[socket.id];
    if (!s || !content?.trim()) return;
    const msg = {
      id:uuid(), type:'user', userId:socket.id,
      username:acc.username, avatar:acc.avatar, color:acc.color,
      content:content.trim().slice(0,1000), timestamp:Date.now(), room:s.room,
      mentions: Array.isArray(mentions) ? mentions.slice(0,20) : [],
      reactions:{},
    };
    history[s.room].push(msg);
    if (history[s.room].length > 150) history[s.room].shift();
    io.to(s.room).emit('message:new', serializeMsg(msg));
  });

  socket.on('typing:start', () => {
    const s = activeSockets[socket.id];
    if (s) socket.to(s.room).emit('typing:update', { userId:socket.id, username:acc.username, isTyping:true });
  });
  socket.on('typing:stop', () => {
    const s = activeSockets[socket.id];
    if (s) socket.to(s.room).emit('typing:update', { userId:socket.id, username:acc.username, isTyping:false });
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
    for (const [e,set] of Object.entries(msg.reactions)) if (set.size>0) counts[e]=set.size;
    io.to(s.room).emit('message:reactions', { messageId, reactions:counts });
  });

  socket.on('disconnect', () => {
    const s = activeSockets[socket.id];
    if (!s) return;
    sysMsg(s.room, `${acc.username} disconnected`);
    delete activeSockets[socket.id];
    broadcastPresence(s.room);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`\n  ✦  RELAY  →  http://localhost:${PORT}\n`));
