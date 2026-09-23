# Personal WhatsApp Bot — Guide & Build Plan

**For:** Wenura · Aggroups
**Prepared:** September 2026

This is a complete feasibility check, architecture decision, and step-by-step plan for what you described: a bot linked to your own WhatsApp number (QR / linked-device style), free-hosted, that can send/schedule messages, react with stickers/emojis, pull images and YouTube/web links on request, and behave like a small personal AI assistant inside WhatsApp.

**Short answer: yes, all of it is technically possible** — but it's built with *unofficial* libraries, not Meta's official product, and that trade-off needs to be understood before you start. Section 1 explains why, then the rest is the plan.

---

## 1. Read this first — how this actually works, and the risk

There are two completely different ways to connect code to WhatsApp:

| | **Unofficial library (what you're asking for)** | **Official WhatsApp Business Cloud API (Meta)** |
|---|---|---|
| How it connects | Emulates the WhatsApp Web/multi-device protocol. You scan a QR code from your phone, exactly like linking WhatsApp Web — the bot becomes a "linked device" on your real account. | Meta-hosted API. Requires a Meta Business account, phone number verification, and (usually) message templates pre-approved by Meta. |
| Uses your real personal number, normal chats | **Yes** — this is the only way to get what you described (own chats, own contacts, feels like your account). | Only if you migrate that number to WhatsApp Business API — which **converts it into an API-only number and removes it from the regular WhatsApp app**. |
| Free-form AI chat / search results / stickers on demand | Yes, fully flexible — you control every byte sent. | Restricted: outside a 24-hour customer-initiated window you can only send pre-approved templates. Not built for a personal assistant use case. |
| Cost | Free (just hosting) | Free tier of conversations, then paid per conversation; business verification required |
| **Compliance** | **Violates WhatsApp's Terms of Service.** Meta explicitly prohibits unofficial/automated clients and can — and does — ban numbers it detects behaving like a bot (high message velocity, bulk sends, non-standard clients). It's normally fine for personal/light use (a handful of messages, a few times a day), but there's no guarantee and no appeal process that treats it as legitimate. | Fully compliant, built for production/business use. |

**Given what you described (own number, own chats, no restrictions), the only real option is the unofficial route.** That's what this guide builds. To keep the risk manageable:

- **Don't use your only/primary number for the first few weeks.** Use a spare SIM, a second WhatsApp-compatible number, or at minimum accept that your main number is at some (usually low, but non-zero) risk while you're testing.
- Keep message volume human-like: no mass broadcasts, no messaging strangers, add small random delays, don't send hundreds of messages a day.
- Treat this as a personal tool, not something you resell or run at scale — that's when detection risk climbs sharply.

If any of that is a dealbreaker, the alternative is the official Cloud API on a **separate business number**, accepting the template/24-hour-window restrictions. Everything below assumes you're OK with the unofficial route for a personal-use bot; I've flagged where the official API differs.

---

## 2. Architecture decision

### Library: **Baileys** (`@whiskeysockets/baileys`)

There are two popular unofficial libraries:

| | **Baileys** (recommended) | **whatsapp-web.js** |
|---|---|---|
| How it works | Pure Node.js/TypeScript — talks to WhatsApp's WebSocket protocol directly | Runs an actual headless Chrome via Puppeteer that loads web.whatsapp.com |
| RAM/CPU footprint | Low (~50–150MB) — fits a free-tier VM easily | High (Chrome instance per session, 300MB+) — often too heavy for free hosting |
| Free-hosting friendly | Yes | Usually not, without a beefier server |
| Maintenance | Actively maintained fork, `@whiskeysockets/baileys` on npm | Actively maintained, but heavier |

**Baileys wins here purely because of hosting weight** — it's the difference between fitting comfortably on a free VM and needing a paid one. Install: `npm install @whiskeysockets/baileys qrcode-terminal`.

### Hosting: this is the part that kills most "free hosting" plans

Your bot needs to hold **one persistent, always-open WebSocket connection** to WhatsApp's servers 24/7 to receive messages and stay "linked." That single requirement rules out a lot of what people call "free hosting":

| Option | Works for this? | Why |
|---|---|---|
| **Firebase Cloud Functions / Cloud Run (scale-to-zero)** | ❌ No | Serverless functions are stateless and spin down between requests — they cannot hold an open socket connection. Your WhatsApp session would disconnect constantly and you'd need to rescan the QR code repeatedly. This is the one from your list to cross off. |
| Render (free web service) | ❌ Mostly no | Free web services sleep after ~15 min of no inbound HTTP traffic. A WhatsApp bot isn't an HTTP server in the normal sense, so it'll be killed and your session drops. |
| Railway | ⚠️ Limited | No longer has an indefinite free tier — just a one-time trial credit, then it's paid. Fine for a short test, not for "forever free." |
| Fly.io | ⚠️ Limited | Its free allowance has been cut back significantly in the last couple of years; mostly paid now for anything persistent. |
| **Oracle Cloud "Always Free" tier** (recommended) | ✅ Yes | A genuinely free-forever small Linux VM (up to 4 ARM OCPUs / 24GB RAM, or a couple of small AMD VMs) that you fully control — install Node, run the bot as a normal always-on process. Requires a credit card at signup for identity verification, but Always Free resources are never billed as long as you stay in the free limits. |
| A spare PC / old laptop / Raspberry Pi at home, left on | ✅ Yes | Genuinely free, zero cloud risk, but only "up" while that machine is on and your internet is up. Good for prototyping. |

**Recommendation:** prototype locally on your own PC first (fastest feedback loop), then deploy to an **Oracle Cloud Always Free VM** for 24/7 uptime. It's the only option on this list that's both persistent and actually free indefinitely.

### AI + search backend for the "mini AI" feature

"Search and show results — pictures, YouTube links, other links" needs two separate ingredients:

1. **An LLM to understand the request and write a reply** — e.g. **Groq's API free tier** (no card required to start, fast inference, generous daily request allowance) or Anthropic/OpenAI (better quality, but paid beyond a small trial credit). Groq's free tier is the practical "stays free" choice.
2. **A way to actually fetch live web/image/video results** — this is the part your message conflates with "AI," so it's worth separating: an LLM doesn't browse the web on its own unless you give it a search tool. Options:
   - **Paid-but-cheap SERP APIs** (SerpApi, Serper.dev) — reliable, structured results (images, links, etc.), but only a one-time free trial credit, then a small per-request cost.
   - **Google Programmable Search (Custom Search JSON API)** — has a 100-queries/day free tier, but heads-up: **it's closed to new sign-ups and Google is discontinuing it on January 1, 2027**, so it's not a good long-term foundation to build on now.
   - **Construct direct links instead of "real" search** (no API, fully free) — e.g. for "find me a video of X," send back a YouTube search URL (`https://www.youtube.com/results?search_query=...`) rather than trying to resolve the actual top result. Simple, free, and covers "give me a link" requests well; less magical than true search.
   - A lightweight self-hosted search wrapper (e.g. querying DuckDuckGo's HTML results) is common in hobby bots and free, but it's scraping rather than a supported API — expect it to be the flakiest piece and to need occasional fixes.

   **Practical recommendation:** start with the "construct direct links" approach for YouTube/general search (100% free, zero maintenance), and add a paid SERP API later only if you want the bot to actually pick and describe the top result rather than just link to a search page.

---

## 3. The "control chat" — how you'll talk to your own bot

You wrote you don't want to have to give it commands, but also asked for it to have "its own chat" — here's how that reconciles in practice, and the two ways to set it up:

- **Option A — "Message Yourself" chat (recommended).** WhatsApp has a built-in "Message Yourself" chat on every account. Point the bot to treat *only* that chat as its control channel: anything you type there is a command/question to the bot (search, schedule, send a sticker to someone), and everything else — your normal chats with other people — the bot leaves alone unless you explicitly ask it to act in a chat. This gives you a private "bot chat" without creating a second WhatsApp account or a fake contact.
- **Option B — a dedicated command prefix everywhere.** The bot listens in every chat but only reacts to messages starting with something like `!bot` or `.ai`. Useful if you want to trigger it from group chats too, but riskier — it's easy to end up with the bot replying somewhere you didn't intend.

I'd build Option A by default (self-chat = control room), with a config flag to add prefix-triggers in specific chats later if you want that.

For fully autonomous behavior (the bot acting *without* you typing anything — e.g., "good morning" at 8am, or auto-replying to certain contacts) — that's exactly what the **scheduler** and an optional **auto-reply rule list** below are for. You configure the behavior once; after that it runs without you sending commands.

---

## 4. Build plan (phased)

### Phase 0 — Prerequisites (on your PC)
- Node.js 20+ installed
- A WhatsApp-capable phone number for testing (ideally not your daily-driver number, see §1)
- A project folder (`Whatsapp_bot` — already set up)

### Phase 1 — Connect & stay linked
Get a minimal script that logs in via QR and **persists the session** so you don't have to rescan every restart.

```js
// index.js
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys')
const qrcode = require('qrcode-terminal')

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_session')
  const sock = makeWASocket({ auth: state, printQRInTerminal: false })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update
    if (qr) qrcode.generate(qr, { small: true }) // scan this with WhatsApp > Linked Devices
    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut
      console.log('connection closed, reconnecting:', shouldReconnect)
      if (shouldReconnect) startBot()
    } else if (connection === 'open') {
      console.log('✅ connected to WhatsApp')
    }
  })

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0]
    if (!msg.message || msg.key.fromMe === undefined) return
    // Phase 2 command handling goes here
  })

  return sock
}

startBot()
```

`auth_session/` is the folder that holds your linked-device credentials — **back it up, and never commit it to git or share it**; anyone with those files can act as your WhatsApp account. Add it to `.gitignore` immediately.

To link: run `node index.js`, open WhatsApp on your phone → **Settings → Linked Devices → Link a Device**, and scan the QR printed in your terminal.

### Phase 2 — Control chat + command router
Detect messages in your own "Message Yourself" chat and route them.

```js
sock.ev.on('messages.upsert', async ({ messages }) => {
  const msg = messages[0]
  if (!msg.message) return

  const myJid = sock.user.id // your own account's JID
  const chatId = msg.key.remoteJid
  const isSelfChat = chatId === myJid && msg.key.fromMe // messages you send to "yourself"

  if (!isSelfChat) return // ignore everything else by default

  const text = msg.message.conversation || msg.message.extendedTextMessage?.text || ''
  await handleCommand(sock, chatId, text)
})

async function handleCommand(sock, chatId, text) {
  if (text.startsWith('/send ')) {
    // /send 9477xxxxxxx Hello there
    const [, number, ...rest] = text.split(' ')
    await sock.sendMessage(`${number}@s.whatsapp.net`, { text: rest.join(' ') })
  } else if (text.startsWith('/yt ')) {
    const q = text.slice(4)
    await sock.sendMessage(chatId, { text: `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}` })
  } else {
    // fall through to the AI handler — Phase 5
  }
}
```

### Phase 2.5 — Restricting it to selected friends & groups

You asked for the bot to be able to message specific inbox chats (friends) and specific groups (ones your number is already a member of) — not just its own control chat. This works, and it's important to build it as an **explicit allow-list**, not "the bot can message whoever the command tells it to." That distinction matters once the AI layer (Phase 5) is involved — you don't want a misread command or a hallucinated reply accidentally messaging the wrong person or an unintended group.

**How WhatsApp chat IDs (JIDs) work:**
- A 1:1 chat with a friend: `<their number with country code, no +>@s.whatsapp.net` — e.g. `94771234567@s.whatsapp.net`
- A group chat: `<numeric-group-id>@g.us` — you can't guess this one; you have to fetch it (below)

**Being in the group is a hard requirement, not a config step** — the bot can only send into a group if your number is already a participant. It can't join a group on its own or message a group it isn't in.

**List the groups you're in** (run this once to get their IDs and names):
```js
const groups = await sock.groupFetchAllParticipating()
Object.values(groups).forEach(g => console.log(g.id, '—', g.subject))
// prints e.g.  120363012345678901@g.us — Family Group
```

**Build the allow-list** — a small config file you edit by hand, so *you* decide who's reachable, not the bot:
```js
// targets.json
{
  "friends": {
    "sarah": "94771234567@s.whatsapp.net",
    "kasun": "94779876543@s.whatsapp.net"
  },
  "groups": {
    "family": "120363012345678901@g.us",
    "workteam": "120363019998887776@g.us"
  }
}
```

**Enforce it in the command handler** — resolve a friendly name to a JID only if it's on the list, and refuse anything else:
```js
const targets = require('./targets.json')

function resolveTarget(name) {
  return targets.friends[name] || targets.groups[name] || null
}

// e.g. from the control chat: "/send sarah Running 10 mins late"
if (text.startsWith('/send ')) {
  const [, name, ...rest] = text.split(' ')
  const jid = resolveTarget(name)
  if (!jid) {
    await sock.sendMessage(chatId, { text: `"${name}" isn't on your allow-list. Add it to targets.json first.` })
    return
  }
  await sock.sendMessage(jid, { text: rest.join(' ') })
}
```

This same `resolveTarget()` check should gate *every* outgoing action — scheduled sends (Phase 3), stickers/images (Phase 4), and any AI-triggered send (Phase 5) — so the only people/groups the bot can ever reach are the ones you explicitly named. Adding a new friend or group later is just adding one line to `targets.json`.

### Phase 3 — Scheduled messages
Use `node-cron` for anything on a recurring schedule, or store one-off scheduled sends in a small JSON/SQLite file and check them every minute.

```js
// npm install node-cron
const cron = require('node-cron')

// Every day at 8:00 AM Asia/Colombo
cron.schedule('0 8 * * *', () => {
  sock.sendMessage('9477xxxxxxx@s.whatsapp.net', { text: 'Good morning ☀️' })
}, { timezone: 'Asia/Colombo' })
```
For "remind me / send this at 6pm today" style one-off requests from the control chat, store `{ time, chatId, text }` entries and run a `setInterval` every 30s checking for due ones — simpler than cron for dynamic, user-created schedules.

### Phase 4 — Media: stickers, images, emojis

**Emojis** — just plain Unicode text, no special handling needed: `sock.sendMessage(chatId, { text: '🔥👍' })`.

**Images from the internet** (not from your phone):
```js
const axios = require('axios')
const res = await axios.get(imageUrl, { responseType: 'arraybuffer' })
await sock.sendMessage(chatId, { image: Buffer.from(res.data), caption: 'here you go' })
```

**Stickers** — convert any image/GIF to a WhatsApp sticker with `wa-sticker-formatter`:
```js
// npm install wa-sticker-formatter
const { Sticker } = require('wa-sticker-formatter')

const sticker = new Sticker(imageBufferOrUrl, {
  pack: 'My Bot',
  author: 'Wenura',
  type: 'full', // or 'crop'
})
await sock.sendMessage(chatId, await sticker.toMessage())
```

### Phase 5 — "Mini AI" (chat + search-style answers)
Wire the fall-through in `handleCommand` to an LLM, and give it your link-construction helpers as tools it can call (YouTube search link, Google search link, and — if you add a paid SERP API later — real image/result lookups).

```js
// npm install groq-sdk   (Groq, free tier)
const Groq = require('groq-sdk')
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY })

async function askAI(question) {
  const result = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [{ role: 'user', content: question }],
  })
  return result.choices[0].message.content
}
```
Start simple (plain Q&A replies); add the "pull a real image/top search result" capability only once the SERP-API cost/benefit makes sense for you (see §2).

### Phase 6 — Deploy to the Oracle Free VM
1. Create an Oracle Cloud account → spin up an **Always Free** Ampere A1 (ARM) or Micro (AMD) instance running Ubuntu.
2. SSH in, install Node.js, `git clone`/`scp` your project over.
3. Copy your `auth_session/` folder from your PC to the VM (so you don't have to re-scan the QR on the server) — or just run it once on the VM and scan fresh.
4. Run it under **pm2** so it auto-restarts on crash and on VM reboot:
   ```
   npm install -g pm2
   pm2 start index.js --name wa-bot
   pm2 save
   pm2 startup   # follow the printed instructions to enable on boot
   ```
5. Open WhatsApp → Linked Devices occasionally to confirm it still shows as connected.

### Phase 7 — Safety/ban-risk hygiene
- Add a small random delay (300–1500ms) before sending, instead of instant machine-gun replies.
- Cap how many messages the bot can send per minute/hour and log everything so you can see if something's misbehaving.
- Never use it to message people who haven't messaged you first, and never for bulk/marketing-style sends — that's the behavior pattern that gets numbers flagged fastest.

---

## 5. What's genuinely free vs. where cost can creep in

| Piece | Free? |
|---|---|
| Baileys library | Free, open source |
| Hosting (Oracle Always Free VM) | Free forever, within the Always Free limits |
| Scheduling, stickers, sending images from URLs | Free — just code |
| Groq API (LLM for chat) | Free tier is generous for personal use; only becomes paid at high volume |
| Real search results with images (SerpApi/Serper/Google CSE) | Free trial only, then paid per request — or skip it and use direct search links (fully free, see §2) |

So the whole thing can run at **$0/month** if you stick to the link-construction approach for search and Groq's free tier for AI replies. The only place real cost enters is if you later want the bot to fetch and pick actual top search results/images rather than linking to a search page.

---

## 6. Suggested build order (recap)

1. Local prototype: QR login + session persistence (Phase 1)
2. Control-chat command router (Phase 2)
2.5. Friend/group allow-list, so it can only reach chats you've explicitly named (Phase 2.5)
3. Scheduling (Phase 3)
4. Stickers/images/emojis (Phase 4)
5. AI replies wired into the fall-through (Phase 5)
6. Deploy to Oracle Free VM + pm2 (Phase 6)
7. Rate-limiting/safety pass (Phase 7)

I can start building any of these phases with you directly in your `Whatsapp_bot` project folder whenever you're ready — happy to scaffold Phase 1 right now if you want to see it running.
