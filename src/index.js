const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys')
const qrcode = require('qrcode-terminal')
const pino = require('pino')
const { handleCommand } = require('./commands')
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

    // Only messages you send to your own "Message Yourself" chat drive the bot.
    // Everything else is left alone — see WHATSAPP_BOT_GUIDE.md §3.
    const myNumberJid = sock.user?.id?.split(':')[0] + '@s.whatsapp.net'
    const chatId = msg.key.remoteJid
    const isSelfChat = chatId === myNumberJid && msg.key.fromMe
    if (!isSelfChat) return

    const text = msg.message.conversation || msg.message.extendedTextMessage?.text || ''
    if (!text) return

    try {
      await handleCommand(sock, chatId, text)
    } catch (err) {
      console.error('Command error:', err)
      await sock.sendMessage(chatId, { text: `⚠️ Something went wrong: ${err.message}` })
    }
  })

  return sock
}

startBot().catch((err) => {
  console.error('Fatal startup error:', err)
  process.exit(1)
})
