const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys')
const qrcode = require('qrcode-terminal')
const pino = require('pino')
const { handleCommand } = require('./commands')
const { handleGroupMessage } = require('./groupChat')
const { startCronJobs, startOneOffChecker } = require('./scheduler')
const { timezone } = require('./config')

const logger = pino({ level: 'silent' }) // set to 'info' or 'debug' if you need to see Baileys' own logs

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_session')
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    auth: state,
    version,
    logger,
    printQRInTerminal: false, // we render the QR ourselves below, see connection.update
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      console.log('\nScan this QR code with WhatsApp → Settings → Linked Devices → Link a Device:\n')
      qrcode.generate(qr, { small: true })
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode
      const loggedOut = statusCode === DisconnectReason.loggedOut
      console.log(loggedOut
        ? 'Logged out. Delete the auth_session/ folder and restart to link again.'
        : `Connection closed (code ${statusCode}). Reconnecting…`)
      if (!loggedOut) startBot()
    } else if (connection === 'open') {
      console.log('✅ Connected to WhatsApp as', sock.user?.id)
      startCronJobs(sock, timezone)
      startOneOffChecker(sock)
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return
    const msg = messages[0]
    if (!msg?.message || msg.key.remoteJid === 'status@broadcast') return

    // "Message Yourself" is the full-access control chat — see WHATSAPP_BOT_GUIDE.md §3.
    // Any group the bot is in gets a lighter-touch experience — see groupChat.js.
    const myNumberJid = sock.user?.id?.split(':')[0] + '@s.whatsapp.net'
    const myLidJid = sock.user?.lid?.split(':')[0] + '@lid'
    const botJids = { myNumberJid, myLidJid }
    const chatId = msg.key.remoteJid
    const isSelfChat = (chatId === myNumberJid || chatId === myLidJid) && msg.key.fromMe
    const isGroupChat = chatId.endsWith('@g.us')
    if (!isSelfChat && !isGroupChat) return

    const text = msg.message.conversation || msg.message.extendedTextMessage?.text || ''

    try {
      if (isSelfChat) {
        if (!text) return
        await handleCommand(sock, chatId, text)
      } else {
        await handleGroupMessage(sock, chatId, msg, text, botJids)
      }
    } catch (err) {
      console.error('Message handling error:', err)
      if (isSelfChat) await sock.sendMessage(chatId, { text: `⚠️ Something went wrong: ${err.message}` })
    }
  })

  return sock
}

startBot().catch((err) => {
  console.error('Fatal startup error:', err)
  process.exit(1)
})
