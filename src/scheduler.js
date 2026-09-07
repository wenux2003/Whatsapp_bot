// Three kinds of scheduled sends, all going through resolveTarget() so a
// schedule can only ever fire at an allow-listed friend or group:
//   1. One-off — created via /schedule, stored in schedules.json, checked every 30s.
//   2. Recurring — daily/weekly (via /remind) or hand-written cron (cronjobs.json),
//      all loaded at startup and re-scheduled live when added at runtime.

const cron = require('node-cron')
const fs = require('fs')
const path = require('path')
const { resolveTarget } = require('./targets')
const { safeSend } = require('./safeSend')

const CRONJOBS_PATH = path.join(__dirname, '..', 'cronjobs.json')
const SCHEDULES_PATH = path.join(__dirname, '..', 'schedules.json')

const DAY_NUMBERS = {
  sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, wednesday: 3, wed: 3,
  thursday: 4, thu: 4, friday: 5, fri: 5, saturday: 6, sat: 6,
}
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

function loadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
  } catch {
    return []
  }
}

function saveJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2))
}

// ---- Recurring cron jobs (cronjobs.json) ----
// Format: [{ "name": "morning", "cron": "0 8 * * *", "target": "sarah", "message": "..." }]
// Entries created via /remind daily|weekly also carry a "type" (+ time/day) so
// /reminders can show them in plain English instead of raw cron syntax.
function scheduleCronJob(sock, timezone, job) {
  if (!cron.validate(job.cron)) {
    console.warn(`Skipping cron job "${job.name}" — invalid cron expression "${job.cron}"`)
    return
  }
  cron.schedule(
    job.cron,
    async () => {
      const jid = resolveTarget(job.target)
      if (!jid) {
        console.warn(`Skipping cron job "${job.name}" — target "${job.target}" not in targets.json`)
        return
      }
      await safeSend(sock, jid, { text: job.message })
    },
    { timezone }
  )
}

function startCronJobs(sock, timezone) {
  const jobs = loadJson(CRONJOBS_PATH)
  jobs.forEach((job) => scheduleCronJob(sock, timezone, job))
  console.log(`Loaded ${jobs.length} recurring cron job(s).`)
}

// Adds a recurring job to cronjobs.json AND schedules it immediately, so it's
// live right away without needing a restart.
function addCronJob(sock, timezone, job) {
  const jobs = loadJson(CRONJOBS_PATH)
  jobs.push(job)
  saveJson(CRONJOBS_PATH, jobs)
  scheduleCronJob(sock, timezone, job)
}

function dailyCron(time) {
  const [h, m] = time.split(':').map(Number)
  return `${m} ${h} * * *`
}

function weeklyCron(day, time) {
  const dayNum = DAY_NUMBERS[day.toLowerCase()]
  const [h, m] = time.split(':').map(Number)
  return `${m} ${h} * * ${dayNum}`
}

function isValidTime(time) {
  return /^([01]?\d|2[0-3]):([0-5]\d)$/.test(time)
}

// ---- One-off schedules (schedules.json), created via the /schedule command ----
// Entry shape: { "atISO": "2026-09-05T18:00:00", "target": "sarah", "message": "..." }
function addOneOff({ atISO, target, message }) {
  const list = loadJson(SCHEDULES_PATH)
  list.push({ atISO, target, message })
  saveJson(SCHEDULES_PATH, list)
}

function startOneOffChecker(sock) {
  setInterval(async () => {
    const list = loadJson(SCHEDULES_PATH)
    if (list.length === 0) return

    const now = Date.now()
    const due = list.filter((s) => new Date(s.atISO).getTime() <= now)
    if (due.length === 0) return

    for (const s of due) {
      const jid = resolveTarget(s.target)
      if (jid) {
        await safeSend(sock, jid, { text: s.message })
      } else {
        console.warn(`Skipped a one-off schedule — target "${s.target}" not in targets.json`)
      }
    }

    const remaining = list.filter((s) => new Date(s.atISO).getTime() > now)
    saveJson(SCHEDULES_PATH, remaining)
  }, 30 * 1000)
}

// A plain-English summary of everything scheduled, for the /reminders command.
function describeReminders() {
  const oneOffs = loadJson(SCHEDULES_PATH)
  const jobs = loadJson(CRONJOBS_PATH)
  const daily = jobs.filter((j) => j.type === 'daily')
  const weekly = jobs.filter((j) => j.type === 'weekly')
  const other = jobs.filter((j) => j.type !== 'daily' && j.type !== 'weekly')

  const lines = []
  lines.push('*⏰ One-time:*')
  lines.push(oneOffs.length
    ? oneOffs.map((s) => `• ${s.target} — ${new Date(s.atISO).toLocaleString()} — "${s.message}"`).join('\n')
    : '(none)')

  lines.push('\n*🔁 Daily:*')
  lines.push(daily.length
    ? daily.map((j) => `• ${j.target} — ${j.time} — "${j.message}"`).join('\n')
    : '(none)')

  lines.push('\n*📅 Weekly:*')
  lines.push(weekly.length
    ? weekly.map((j) => `• ${j.target} — ${DAY_NAMES[DAY_NUMBERS[j.day.toLowerCase()]]} ${j.time} — "${j.message}"`).join('\n')
    : '(none)')

  if (other.length) {
    lines.push('\n*⚙️ Custom cron (cronjobs.json):*')
    lines.push(other.map((j) => `• ${j.name} — ${j.target} — \`${j.cron}\` — "${j.message}"`).join('\n'))
  }

  return lines.join('\n')
}

module.exports = {
  startCronJobs,
  startOneOffChecker,
  addOneOff,
  addCronJob,
  dailyCron,
  weeklyCron,
  isValidTime,
  describeReminders,
  DAY_NUMBERS,
}
