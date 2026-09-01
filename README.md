# Your WhatsApp Bot

A personal WhatsApp bot linked to your account as a device (same as WhatsApp Web). You control it from your own **"Message Yourself"** chat; it can message an allow-listed set of friends and groups, send scheduled messages, stickers, images pulled from the web, and give AI replies.

Read `WHATSAPP_BOT_GUIDE.md` first for the full explanation of how this works and the ToS/ban-risk reality — this README is just the "how do I run it" quick reference.

## 1. Install

```
npm install
```

## 2. (Optional) add API keys

Copy `.env.example` to a new file named `.env` in this same folder, then open `.env` and fill in what you want:

- `GEMINI_API_KEY` — **placeholder, needs your own key.** Free, no card required. Get one at https://aistudio.google.com/apikey. Without it, `/ai` and the natural-chat fallback will just tell you AI isn't configured yet — everything else still works.
- `SERPAPI_KEY` — **placeholder, optional.** Only needed if you want `/img` to return a real top image instead of a Google Images search link. Free trial credit only, then paid — see `SERPAPI.md` note in the guide. Leave blank to skip.

## 3. Set up your allow-list

Open `targets.json`. Replace the example entries with real ones:

```json
{
  "friends": {
    "sarah": "94771234567@s.whatsapp.net"
  },
  "groups": {
    "family": "120363012345678901@g.us"
  }
}
```

- Friend JIDs: `<full number with country code, no +, no spaces>@s.whatsapp.net`
- Group IDs: you can't guess these — start the bot, send `/groups` from your own chat, and copy the ID it prints for the group you want.

Only names listed here can ever receive a message from the bot — see `WHATSAPP_BOT_GUIDE.md` §Phase 2.5 for why this is enforced everywhere.

## 4. Run it

```
npm start
```

A QR code prints in the terminal. On your phone: **WhatsApp → Settings → Linked Devices → Link a Device**, and scan it. Once connected, it stays linked — you won't need to rescan unless you log it out or delete the `auth_session/` folder.

## 5. Try it

Open your own **"Message Yourself"** chat in WhatsApp (search your own name, or tap your own contact) and send:

```
/help
```

That lists every command. A few to try immediately:

```
/list
/groups
/send sarah Hey, testing my bot!
/yt lofi hip hop
/schedule sarah 2026-09-05T18:00 Don't forget the meeting
```

## Notes

- `auth_session/` holds your real WhatsApp login — never share it or commit it to git (already in `.gitignore`).
- This only reacts to messages in your own "Message Yourself" chat. Messages from friends/groups are never read as commands — the bot only *sends* to them, it doesn't take instructions from them.
- For 24/7 uptime instead of just "while my PC is running," see `WHATSAPP_BOT_GUIDE.md` §Phase 6 (deploying to a free Oracle Cloud VM with pm2).
