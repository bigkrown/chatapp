# RTCA — Real-Time Chat App

A sleek, production-ready real-time chat application built with **Node.js + Express + Socket.io**. Features user authentication, dynamic room creation, live presence, typing indicators, and emoji reactions — all with no build step.

---

## ✦ Features

| Feature | Details |
|---|---|
| **Register & Login** | Username/password accounts with SHA-256 hashed passwords |
| **Session Persistence** | Token stored in `localStorage` — stay logged in on refresh |
| **5 Default Rooms** | Lounge, Dev Corner, Design Studio, Game Room, Music Box |
| **Create Rooms** | Any logged-in user can create a custom room with name, description & emoji |
| **Live Room Updates** | New rooms broadcast to all connected clients instantly |
| **User Presence** | Right sidebar shows who's online in the current room |
| **@Mentions** | Tag individuals with `@username` or the whole room with `@everyone` |
| **Mention Autocomplete** | Dropdown appears on `@` with fuzzy filtering, keyboard nav & click-to-insert |
| **Mention Highlighting** | Tagged names render as amber chips; your own mentions glow |
| **Mention Toasts** | Pop-up notification when you're tagged in another room or while scrolled up |
| **Typing Indicators** | Animated dots when others are typing |
| **Message History** | Last 150 messages per room kept in memory |
| **Emoji Reactions** | Hover any message → quick-react bar; click pills to toggle |
| **Unread Badges** | Room nav badges count messages received while away |
| **Auto-scroll** | Pins to bottom; floating button appears when scrolled up |
| **Responsive** | 3-column → 2-column → single-column layout |



**Demo** https://chatapp-five-coral.vercel.app/

---

## 🚀 Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Start the server
npm start

# 3. Open in browser
open http://localhost:3000
```

> For development with auto-reload: `npm run dev` (requires nodemon)

Register an account on first visit. Open multiple browser tabs to test real-time features.

---

## 📁 File Structure

```
chatapp/
├── server.js           # Express REST API + Socket.io backend
├── package.json
├── README.md
└── public/
    └── index.html      # Complete frontend — HTML, CSS, and JS in one file
```

---

## 🔐 REST API

### `POST /api/register`
Create a new account.

**Body:** `{ username, password }`
**Returns:** `{ token, username, avatar, color }`
**Errors:** 400 (missing fields / too short), 409 (username taken)

### `POST /api/login`
Authenticate an existing account.

**Body:** `{ username, password }`
**Returns:** `{ token, username, avatar, color }`
**Errors:** 400 (missing fields), 401 (wrong credentials)

### `GET /api/rooms`
List all rooms (default + user-created). No auth required.

### `POST /api/rooms`
Create a new room. Requires a valid session token.

**Body:** `{ token, name, emoji, description }`
**Returns:** Room object
**Errors:** 401 (not authenticated), 400 (name too short), 409 (name taken)

---

## 🔌 Socket.io Event Reference

Socket connections require a valid token passed via `io(url, { auth: { token } })`. Unauthenticated connections are rejected.

### Client → Server
| Event | Payload | Description |
|---|---|---|
| `user:join` | `{ roomId }` | Enter a room after connecting |
| `room:switch` | `roomId` | Switch to a different room |
| `message:send` | `{ content, mentions }` | Send a chat message (mentions is `string[]`) |
| `typing:start` | — | Notify others you're typing |
| `typing:stop` | — | Notify others you stopped typing |
| `message:react` | `{ messageId, emoji }` | Toggle an emoji reaction |

### Server → Client
| Event | Payload | Description |
|---|---|---|
| `init` | `{ user, rooms, history }` | Full initial state on join |
| `room:created` | Room object | A new room was created (sent to all) |
| `room:switched` | `{ roomId, history }` | Room switch confirmed + history |
| `message:new` | Message object | New message in the current room |
| `presence:update` | `{ roomId, users }` | Online user list for a room |
| `typing:update` | `{ userId, username, isTyping }` | Typing status changed |
| `message:reactions` | `{ messageId, reactions }` | Updated reaction counts |

---

## @ Mentions

Type `@` anywhere in the message box to trigger the mention system.

**Individual mention** — type `@` followed by part of a username. The autocomplete dropdown filters in real time and shows all matching users in the current room. Select with `↑ ↓` arrow keys and confirm with `Enter` or `Tab`. Clicking any user in the right-side presence panel also inserts their `@mention`.

**Broadcast mention** — type `@everyone` (or select it from the top of the dropdown) to notify every user currently in the room.

**In messages** — mentions render as highlighted amber chips instead of plain text. Mentions of yourself or `@everyone` display with a brighter glow so they're impossible to miss.

**Toast notifications** — if you're tagged while viewing a different room, or while scrolled up in the current room, a toast notification slides in from the top-right corner. Click it to jump directly to the room. Toasts auto-dismiss after 6 seconds.

---

## ⚙️ Configuration

| Setting | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP server port (set via env var) |
| Max message history | `150` | Messages retained per room in memory |
| Max username length | `24 chars` | Enforced on register |
| Min password length | `4 chars` | Enforced on register |
| Max message length | `1000 chars` | Enforced on send |
| Max room name length | `32 chars` | Enforced on room creation |
| Max room description | `80 chars` | Enforced on room creation |

---

## 🛠 Tech Stack

- **Runtime**: Node.js 18+
- **Server**: Express 4
- **WebSockets**: Socket.io 4
- **Auth**: Session tokens + SHA-256 password hashing (Node `crypto`)
- **Frontend**: Vanilla JS, HTML5, CSS3 — no framework, no build step
- **Fonts**: IBM Plex Mono + Instrument Serif (Google Fonts)

---

## 📝 Notes

- All data is **in-memory only** — accounts, rooms, and messages reset on server restart. Swap the `accounts`, `sessions`, `rooms`, and `history` objects for a database (e.g. SQLite, MongoDB) to make data persistent.
- This project is intentionally dependency-light. The only runtime packages are `express` and `socket.io`.

---

## 👤 Author

**Shola Adewale**
🌐 [adesho.la](https://adesho.la)

