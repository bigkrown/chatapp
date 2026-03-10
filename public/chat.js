/*  RTCA  -  Real-Time Chat App
    *  Author: Shola Adewale <shola@adesho.la>
    *  Website: https://adesho.la
    * Version: 1.0.0
    * This file contains the client-side JavaScript for the chat application, handling UI interactions,
    * WebSocket communication, and dynamic updates to the chat interface.
    * Key features include:
    * - User authentication and session management
    * - Dynamic room navigation and creation
    * Real-time message rendering with support for mentions and reactions
    * Typing indicators and presence updates
    * Emoji picker and quick reactions
    * The code is structured to maintain a responsive and interactive chat experience, leveraging Socket.IO for real-time communication with the server.
    * Note: This file assumes the existence of certain HTML elements and CSS styles defined in the accompanying index.html and style.css files.
    * For security, all user-generated content is escaped to prevent XSS attacks, and the server is responsible for validating and sanitizing inputs as well.
    * The application is designed to be simple and efficient, using in-memory data structures on the server for demonstration purposes. In a production environment, consider using a database for persistence and scalability.
    * This code is intended for educational and illustrative purposes, showcasing how to build a real-time chat application with modern web technologies.
    * For any questions or feedback, please contact the author at hello@adesho.la
    * © 2026 Shola Adewale. All rights reserved.
    * License: MIT (https://opensource.org/licenses/MIT)
 */


// ─── Constants ────────────────────────────────────────────────────────────────
const QUICK_EMOJIS = ['👍','❤️','😂','🔥','😮','🎉','👀','💯','✨','🚀','😢','🤔','💀','🫡','⚡'];
const ROOM_EMOJIS  = ['💬','🌍','🎯','⚡','🧪','📚','🎵','🎨','🏆','🌈','🍕','🤖','💡','🎲','🦋','🛸','🌙','🔮'];

const SERVER_URL = (window.location.protocol === 'file:' || !window.location.hostname)
  ? 'http://localhost:3000' : window.location.origin;

// ─── State ────────────────────────────────────────────────────────────────────
let token = localStorage.getItem('relay_token');
let myUser = null, socket = null, currentRoom = 'lounge';
let allRooms = {};
let typingTimer, typingUsers = new Map();
let unread = {}, isAtBottom = true;

// ─── Auth Tabs ────────────────────────────────────────────────────────────────
document.querySelectorAll('.auth-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.auth-panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('panel-' + tab.dataset.tab).classList.add('active');
    clearErrors();
  });
});

function clearErrors() {
  document.querySelectorAll('.err-msg').forEach(e => e.classList.remove('show'));
  document.querySelectorAll('.fi').forEach(f => f.classList.remove('error'));
}

function showErr(elId, msg) {
  const el = document.getElementById(elId);
  el.textContent = msg; el.classList.add('show');
}

// ─── Register ─────────────────────────────────────────────────────────────────
document.getElementById('reg-btn').addEventListener('click', doRegister);
document.getElementById('r-pass2').addEventListener('keydown', e => { if(e.key==='Enter') doRegister(); });

async function doRegister() {
  clearErrors();
  const u = document.getElementById('r-user').value.trim();
  const p = document.getElementById('r-pass').value;
  const p2 = document.getElementById('r-pass2').value;
  if (!u) { document.getElementById('r-user').classList.add('error'); return showErr('reg-err','Username is required.'); }
  if (p.length < 4) { document.getElementById('r-pass').classList.add('error'); return showErr('reg-err','Password must be at least 4 characters.'); }
  if (p !== p2) { document.getElementById('r-pass2').classList.add('error'); return showErr('reg-err','Passwords do not match.'); }
  const btn = document.getElementById('reg-btn');
  btn.disabled = true; btn.textContent = 'CREATING…';
  try {
    const res = await fetch(SERVER_URL + '/api/register', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ username:u, password:p })
    });
    const data = await res.json();
    if (!res.ok) { showErr('reg-err', data.error || 'Registration failed.'); return; }
    localStorage.setItem('relay_token', data.token);
    token = data.token;
    connectChat('lounge');
  } catch(e) {
    showErr('reg-err', 'Could not connect to server.');
  } finally {
    btn.disabled = false; btn.textContent = 'CREATE ACCOUNT';
  }
}

// ─── Login ────────────────────────────────────────────────────────────────────
document.getElementById('login-btn').addEventListener('click', doLogin);
document.getElementById('l-pass').addEventListener('keydown', e => { if(e.key==='Enter') doLogin(); });

async function doLogin() {
  clearErrors();
  const u = document.getElementById('l-user').value.trim();
  const p = document.getElementById('l-pass').value;
  if (!u) { document.getElementById('l-user').classList.add('error'); return showErr('login-err','Username is required.'); }
  if (!p) { document.getElementById('l-pass').classList.add('error'); return showErr('login-err','Password is required.'); }
  const btn = document.getElementById('login-btn');
  btn.disabled = true; btn.textContent = 'SIGNING IN…';
  try {
    const res = await fetch(SERVER_URL + '/api/login', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ username:u, password:p })
    });
    const data = await res.json();
    if (!res.ok) { showErr('login-err', data.error || 'Login failed.'); return; }
    localStorage.setItem('relay_token', data.token);
    token = data.token;
    connectChat('lounge');
  } catch(e) {
    showErr('login-err', 'Could not connect to server.');
  } finally {
    btn.disabled = false; btn.textContent = 'SIGN IN';
  }
}

// ─── Logout ───────────────────────────────────────────────────────────────────
document.getElementById('logout-btn').addEventListener('click', () => {
  if (socket) { socket.disconnect(); socket = null; }
  localStorage.removeItem('relay_token');
  token = null; myUser = null; allRooms = {};
  document.getElementById('app').classList.remove('active');
  document.getElementById('app').style.display = 'none';
  document.getElementById('auth-screen').classList.remove('hidden','gone');
  document.getElementById('auth-screen').style.display = '';
  document.getElementById('msg-list').innerHTML = '';
  document.getElementById('room-nav').innerHTML = '';
});

// ─── Auto-login if token saved ────────────────────────────────────────────────
if (token) connectChat('lounge');

// ─── Connect + Socket ─────────────────────────────────────────────────────────
function connectChat(startRoom) {
  socket = io(SERVER_URL, { auth: { token } });

  socket.on('connect_error', err => {
    // Token invalid — go back to login
    if (err.message === 'Unauthorized') {
      localStorage.removeItem('relay_token'); token = null;
      showErr('login-err', 'Session expired. Please sign in again.');
    }
  });

  socket.on('connect', () => socket.emit('user:join', { roomId: startRoom }));

  socket.on('init', ({ user, rooms, history }) => {
    myUser = user;
    currentRoom = startRoom;
    rooms.forEach(r => allRooms[r.id] = r);
    buildNav();
    renderHistory(history);
    updateTopbar(currentRoom);
    updateMyFooter();
    document.getElementById('auth-screen').classList.add('hidden');
    setTimeout(() => document.getElementById('auth-screen').classList.add('gone'), 400);
    document.getElementById('app').style.display = '';
    document.getElementById('app').classList.add('active');
    document.getElementById('ci').focus();
    scrollBottom(true);
  });

  socket.on('room:created', room => {
    allRooms[room.id] = room;
    buildNav();
  });

  socket.on('room:switched', ({ roomId, history }) => {
    currentRoom = roomId;
    updateTopbar(roomId);
    clearMsgs(); renderHistory(history);
    highlightNav(roomId);
    unread[roomId] = 0; refreshBadges();
    typingUsers.clear(); renderTyping();
    scrollBottom(true);
  });

  socket.on('message:new', msg => {
    if (msg.room && msg.room !== currentRoom) {
      unread[msg.room] = (unread[msg.room]||0)+1;
      refreshBadges();
      // toast if we're mentioned in another room
      if (msg.type === 'user' && myUser && msg.mentions && msg.userId !== socket.id) {
        const myName = myUser.username.toLowerCase();
        const tagged = msg.mentions.some(m => m.toLowerCase() === myName || m.toLowerCase() === 'everyone');
        if (tagged) showMentionToast(msg);
      }
      return;
    }
    appendMsg(msg);
    // toast if mentioned while in this room but scrolled up
    if (msg.type === 'user' && myUser && msg.mentions && msg.userId !== socket.id) {
      const myName = myUser.username.toLowerCase();
      const tagged = msg.mentions.some(m => m.toLowerCase() === myName || m.toLowerCase() === 'everyone');
      if (tagged && !isAtBottom) showMentionToast(msg);
    }
    if (isAtBottom) scrollBottom(); else showFab();
  });

  socket.on('presence:update', ({ users }) => {
    document.getElementById('cp-online').textContent = users.length;
    document.getElementById('sr-count').textContent = users.length;
    renderPresence(users);
  });

  socket.on('typing:update', ({ userId, username, isTyping }) => {
    if (isTyping) typingUsers.set(userId, username);
    else typingUsers.delete(userId);
    renderTyping();
  });

  socket.on('message:reactions', ({ messageId, reactions }) => updateReactions(messageId, reactions));
  socket.on('disconnect', () => appendSysMsg('Connection lost…'));
}

// ─── Nav ──────────────────────────────────────────────────────────────────────
function buildNav() {
  const nav = document.getElementById('room-nav');
  nav.innerHTML = '';
  Object.values(allRooms).sort((a,b) => a.createdAt - b.createdAt).forEach(r => {
    const el = document.createElement('div');
    el.className = 'rni' + (r.id === currentRoom ? ' active' : '');
    el.dataset.rid = r.id;
    el.innerHTML = `
      <span class="rni-emoji">${r.emoji}</span>
      <div class="rni-text"><div class="rni-name">${esc(r.name)}</div></div>
      <span class="rni-badge" id="badge-${r.id}"></span>`;
    el.addEventListener('click', () => switchRoom(r.id));
    nav.appendChild(el);
  });
  refreshBadges();
}

function highlightNav(rid) {
  document.querySelectorAll('.rni').forEach(el => el.classList.toggle('active', el.dataset.rid === rid));
}

function switchRoom(id) {
  if (id === currentRoom || !socket) return;
  socket.emit('room:switch', id);
}

function refreshBadges() {
  for (const [id, count] of Object.entries(unread)) {
    const b = document.getElementById('badge-'+id);
    if (!b) continue;
    b.textContent = count; b.classList.toggle('on', count > 0);
  }
}

// ─── Topbar ───────────────────────────────────────────────────────────────────
function updateTopbar(rid) {
  const r = allRooms[rid]; if (!r) return;
  document.getElementById('cp-emoji').textContent = r.emoji;
  document.getElementById('cp-name').textContent  = r.name;
  document.getElementById('cp-desc').textContent  = r.description;
  document.getElementById('cp-strip').style.background = r.color;
}

// ─── My footer ────────────────────────────────────────────────────────────────
function updateMyFooter() {
  if (!myUser) return;
  const av = document.getElementById('my-av');
  av.textContent = myUser.avatar; av.style.background = myUser.color+'33';
  document.getElementById('my-name').textContent = myUser.username;
}


// ─── Messages ─────────────────────────────────────────────────────────────────
function renderHistory(h) { h.forEach(m => appendMsg(m, true)); }
function clearMsgs() { document.getElementById('msg-list').innerHTML = ''; }

function appendMsg(msg, _silent=false) {
  const list = document.getElementById('msg-list');
  if (msg.type === 'system') { appendSysMsg(msg.content, list); return; }
  const own = myUser && msg.userId === socket?.id;
  const row = document.createElement('div');
  row.className='mrow'+(own?' own':''); row.dataset.msgId=msg.id;
  const rbar = QUICK_EMOJIS.slice(0,8).map(e=>`<button class="rbtn" data-e="${e}" data-m="${msg.id}">${e}</button>`).join('');
  const pills = buildPills(msg.id, msg.reactions||{});
  // use renderContent so @mentions become chips (falls back to esc if renderContent not yet defined)
  const contentHtml = typeof renderContent === 'function' ? renderContent(msg.content) : esc(msg.content);
  row.innerHTML=`
    <div class="mav" style="background:${msg.color}22">${msg.avatar}</div>
    <div class="mbody">
      <div class="mmeta"><span class="muser" style="color:${msg.color}">${esc(msg.username)}</span><span class="mtime">${fmtTime(msg.timestamp)}</span></div>
      <div class="bwrap"><div class="bubble"><div class="rbar">${rbar}</div>${contentHtml}</div></div>
      <div class="rpills" id="pills-${msg.id}">${pills}</div>
    </div>`;
  row.querySelectorAll('.rbtn').forEach(btn => {
    btn.addEventListener('click', () => socket.emit('message:react', { messageId:btn.dataset.m, emoji:btn.dataset.e }));
  });
  list.appendChild(row);
}

function appendSysMsg(text, listEl) {
  const list = listEl || document.getElementById('msg-list');
  const div = document.createElement('div'); div.className='sys-msg';
  div.innerHTML=`<div class="sys-line"></div><div class="sys-txt">${esc(text)}</div><div class="sys-line"></div>`;
  list.appendChild(div);
}

function buildPills(mid, reactions) {
  return Object.entries(reactions).filter(([,c])=>c>0)
    .map(([e,c])=>`<div class="pill" data-e="${e}" data-m="${mid}">${e}<span class="pcnt">${c}</span></div>`).join('');
}

document.getElementById('msg-list').addEventListener('click', e => {
  const pill = e.target.closest('.pill');
  if (pill && socket) socket.emit('message:react', { messageId:pill.dataset.m, emoji:pill.dataset.e });
});

function updateReactions(mid, reactions) {
  const el = document.getElementById('pills-'+mid);
  if (el) el.innerHTML = buildPills(mid, reactions);
}

// ─── Typing ───────────────────────────────────────────────────────────────────
function renderTyping() {
  const zone = document.getElementById('typ-zone');
  const others = [...typingUsers.entries()].filter(([id])=>id!==socket?.id).map(([,n])=>n);
  if (!others.length) { zone.innerHTML=''; return; }
  const lbl = others.slice(0,3).join(', ') + (others.length===1?' is typing':' are typing');
  zone.innerHTML=`<div class="tanim"><span></span><span></span><span></span></div><span>${esc(lbl)}…</span>`;
}

// ─── Mention State ────────────────────────────────────────────────────────────
let roomUsers = [];          // [{ id, username, avatar, color }] — current room
let mentionQuery  = null;    // null = inactive, string = current search
let mentionStart  = -1;      // cursor index where '@' was typed
let focusedMention = 0;      // keyboard nav index in dropdown

// Keep roomUsers in sync
socket && socket.on && null; // placeholder — wired below in renderPresence patch

// ─── Presence (patched to also keep roomUsers) ────────────────────────────────
function renderPresence(users) {
  roomUsers = users;
  const list = document.getElementById('pres-list');
  list.innerHTML = '';
  if (!users.length) { list.innerHTML='<div class="pres-empty">No one else here.<br>Invite a friend!</div>'; return; }
  users.forEach(u => {
    const me = u.id === socket?.id;
    const div = document.createElement('div'); div.className='pu';
    div.innerHTML=`
      <div class="pav" style="background:${u.color}22">${u.avatar}</div>
      <div class="pinf"><div class="pname">${esc(u.username)}</div>${me?'<div class="pyou">you</div>':''}</div>
      <div class="pdot"></div>`;
    // clicking a user in presence panel inserts @mention
    div.addEventListener('click', () => {
      if (me) return;
      insertMention(u.username);
    });
    list.appendChild(div);
  });
}

// ─── Mention Autocomplete ─────────────────────────────────────────────────────
const mentionBox  = document.getElementById('mention-box');
const mentionList = document.getElementById('mention-list');

function getMentionCandidates(query) {
  const q = query.toLowerCase();
  const others = roomUsers.filter(u => u.id !== socket?.id);
  const everyone = { id:'__everyone__', username:'everyone', avatar:'📢', color:'#f5a623', isEveryone:true };
  const pool = [everyone, ...others];
  return q === '' ? pool : pool.filter(u => u.username.toLowerCase().startsWith(q));
}

function showMentionBox(query) {
  const candidates = getMentionCandidates(query);
  if (!candidates.length) { closeMentionBox(); return; }
  focusedMention = 0;
  mentionList.innerHTML = '';
  candidates.forEach((u, i) => {
    const item = document.createElement('div');
    item.className = 'mention-item' + (i === 0 ? ' focused' : '');
    item.dataset.username = u.username;
    item.innerHTML = `
      <span class="mention-av">${u.avatar}</span>
      <span class="mention-name ${u.isEveryone ? 'mention-everyone' : ''}">@${esc(u.username)}</span>
      ${u.id === socket?.id ? '<span class="mention-you">you</span>' : ''}`;
    item.addEventListener('mousedown', e => {
      e.preventDefault(); // prevent textarea blur
      insertMention(u.username);
    });
    mentionList.appendChild(item);
  });
  mentionBox.classList.add('open');
}

function closeMentionBox() {
  mentionBox.classList.remove('open');
  mentionQuery = null;
  mentionStart = -1;
}

function moveMentionFocus(dir) {
  const items = mentionList.querySelectorAll('.mention-item');
  if (!items.length) return;
  items[focusedMention].classList.remove('focused');
  focusedMention = (focusedMention + dir + items.length) % items.length;
  items[focusedMention].classList.add('focused');
  items[focusedMention].scrollIntoView({ block:'nearest' });
}

function confirmMentionSelection() {
  const items = mentionList.querySelectorAll('.mention-item');
  if (!items.length) return false;
  const username = items[focusedMention]?.dataset.username;
  if (username) { insertMention(username); return true; }
  return false;
}

function insertMention(username) {
  const val   = ci.value;
  const before = val.slice(0, mentionStart);
  const after  = val.slice(ci.selectionStart);
  ci.value = before + '@' + username + ' ' + after;
  // move cursor after inserted mention
  const pos = before.length + username.length + 2;
  ci.setSelectionRange(pos, pos);
  ci.focus();
  closeMentionBox();
  // auto-resize
  ci.style.height = 'auto';
  ci.style.height = Math.min(ci.scrollHeight, 120) + 'px';
}

// ─── Input ────────────────────────────────────────────────────────────────────
const ci = document.getElementById('ci');

ci.addEventListener('input', () => {
  ci.style.height='auto'; ci.style.height=Math.min(ci.scrollHeight,120)+'px';
  if (!socket) return;
  socket.emit('typing:start');
  clearTimeout(typingTimer);
  typingTimer = setTimeout(()=>socket.emit('typing:stop'),1400);

  // ── @ detection ──
  const val    = ci.value;
  const cursor = ci.selectionStart;
  // look backwards from cursor for '@'
  let atPos = -1;
  for (let i = cursor - 1; i >= 0; i--) {
    if (val[i] === '@') { atPos = i; break; }
    if (val[i] === ' ' || val[i] === '\n') break;
  }
  if (atPos !== -1) {
    const query = val.slice(atPos + 1, cursor);
    // only trigger if query has no spaces (mid-word)
    if (!/\s/.test(query)) {
      mentionStart = atPos;
      mentionQuery = query;
      showMentionBox(query);
      return;
    }
  }
  closeMentionBox();
});

ci.addEventListener('keydown', e => {
  // intercept arrow keys / enter / escape when mention box open
  if (mentionBox.classList.contains('open')) {
    if (e.key === 'ArrowDown')  { e.preventDefault(); moveMentionFocus(1);  return; }
    if (e.key === 'ArrowUp')    { e.preventDefault(); moveMentionFocus(-1); return; }
    if (e.key === 'Escape')     { e.preventDefault(); closeMentionBox();    return; }
    if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
      e.preventDefault();
      confirmMentionSelection();
      return;
    }
  }
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMsg(); }
});

// close mention box on click outside
document.addEventListener('mousedown', e => {
  if (!mentionBox.contains(e.target) && e.target !== ci) closeMentionBox();
});

document.getElementById('snd-btn').addEventListener('click', sendMsg);

function sendMsg() {
  const txt = ci.value.trim();
  if (!txt||!socket) return;
  closeMentionBox();
  // extract mentioned usernames from message for server
  const mentionedSet = new Set();
  const allRe = /@everyone\b/gi;
  if (allRe.test(txt)) mentionedSet.add('everyone');
  const userRe = /@(\w[\w\d_-]{0,23})\b/g;
  let m;
  while ((m = userRe.exec(txt)) !== null) {
    const name = m[1].toLowerCase();
    if (roomUsers.some(u => u.username.toLowerCase() === name)) mentionedSet.add(m[1]);
  }
  socket.emit('message:send', { content: txt, mentions: [...mentionedSet] });
  socket.emit('typing:stop'); clearTimeout(typingTimer);
  ci.value=''; ci.style.height='auto'; ci.focus();
}

// ─── Emoji float ──────────────────────────────────────────────────────────────
const efloat = document.getElementById('efloat');
QUICK_EMOJIS.forEach(e => {
  const btn=document.createElement('button'); btn.textContent=e;
  btn.addEventListener('click',()=>{ ci.value+=e; ci.focus(); efloat.classList.remove('open'); });
  efloat.appendChild(btn);
});
document.getElementById('eq-tog').addEventListener('click', ev=>{ ev.stopPropagation(); efloat.classList.toggle('open'); });
document.addEventListener('click',()=>efloat.classList.remove('open'));

// ─── Scroll ───────────────────────────────────────────────────────────────────
const msgList = document.getElementById('msg-list');
const fab     = document.getElementById('scr-fab');
msgList.addEventListener('scroll',()=>{
  isAtBottom = msgList.scrollHeight - msgList.scrollTop - msgList.clientHeight < 100;
  if(isAtBottom) fab.classList.remove('on');
});
fab.addEventListener('click',()=>scrollBottom());
function scrollBottom(instant=false){ msgList.scrollTo({top:msgList.scrollHeight,behavior:instant?'instant':'smooth'}); fab.classList.remove('on'); isAtBottom=true; }
function showFab(){ fab.classList.add('on'); }

// ─── Create Room Modal ────────────────────────────────────────────────────────
const modal   = document.getElementById('create-modal');
let selectedEmoji = '💬';

const emojiRow = document.getElementById('emoji-row');
ROOM_EMOJIS.forEach(e => {
  const btn = document.createElement('div'); btn.className='emoji-opt'+(e==='💬'?' selected':''); btn.textContent=e;
  btn.addEventListener('click',()=>{
    emojiRow.querySelectorAll('.emoji-opt').forEach(b=>b.classList.remove('selected'));
    btn.classList.add('selected'); selectedEmoji=e;
  });
  emojiRow.appendChild(btn);
});

document.getElementById('open-create').addEventListener('click', ()=>modal.classList.add('open'));
document.getElementById('modal-close').addEventListener('click', closeModal);
modal.addEventListener('click', e=>{ if(e.target===modal) closeModal(); });
function closeModal(){ modal.classList.remove('open'); document.getElementById('cr-err').classList.remove('show'); }

document.getElementById('cr-btn').addEventListener('click', doCreateRoom);
document.getElementById('cr-name').addEventListener('keydown', e=>{ if(e.key==='Enter') doCreateRoom(); });

async function doCreateRoom() {
  const err = document.getElementById('cr-err');
  err.classList.remove('show');
  const name = document.getElementById('cr-name').value.trim();
  const desc = document.getElementById('cr-desc').value.trim();
  if (!name) { err.textContent='Room name is required.'; err.classList.add('show'); return; }
  const btn = document.getElementById('cr-btn');
  btn.disabled=true; btn.textContent='CREATING…';
  try {
    const res = await fetch(SERVER_URL+'/api/rooms', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ token, name, emoji:selectedEmoji, description:desc })
    });
    const data = await res.json();
    if (!res.ok) { err.textContent=data.error||'Failed to create room.'; err.classList.add('show'); return; }
    closeModal();
    document.getElementById('cr-name').value='';
    document.getElementById('cr-desc').value='';
    setTimeout(()=>switchRoom(data.id), 200);
  } catch(e) {
    err.textContent='Server error.'; err.classList.add('show');
  } finally {
    btn.disabled=false; btn.textContent='CREATE ROOM';
  }
}

// ─── Mention Toast Notification ───────────────────────────────────────────────
function showMentionToast(msg) {
  const room = allRooms[msg.room];
  const toast = document.createElement('div');
  toast.className = 'mention-toast';
  toast.innerHTML = `
    <span class="toast-icon">🔔</span>
    <div class="toast-text">
      <strong>${esc(msg.username)}</strong> mentioned you in
      <span class="toast-room">${room ? esc(room.name) : 'a room'}</span>
    </div>
    <span class="toast-dismiss">✕</span>`;
  toast.addEventListener('click', () => {
    switchRoom(msg.room);
    toast.remove();
  });
  toast.querySelector('.toast-dismiss').addEventListener('click', e => { e.stopPropagation(); toast.remove(); });
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 6000);
}

// ─── Utils ────────────────────────────────────────────────────────────────────
function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function fmtTime(ts){ return new Date(ts).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}); }

// Render message content with @mention chips highlighted
function renderContent(text) {
  const myName = myUser?.username?.toLowerCase();
  // escape first, then replace @tags with chips
  return esc(text).replace(/@(\w[\w\d_-]{0,23})\b/g, (match, name) => {
    const isMe = name.toLowerCase() === myName;
    const isEveryone = name.toLowerCase() === 'everyone';
    const isValid = isEveryone || roomUsers.some(u => u.username.toLowerCase() === name.toLowerCase());
    if (!isValid) return match;
    return `<span class="mention-chip${(isMe || isEveryone) ? ' mention-me' : ''}">${match}</span>`;
  });
}