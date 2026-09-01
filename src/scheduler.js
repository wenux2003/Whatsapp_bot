// Two kinds of scheduled sends:
//   1. Recurring — defined in cronjobs.json, loaded once at startup.
//   2. One-off — created at runtime via the /schedule command, stored in
//      schedules.json, checked every 30s.
// Both go through resolveTarget(), so a schedule can only ever fire at an
// allow-listed friend or group (see targets.js / README.md).

const cron = require('node-cron')
const fs = require('fs')
const path = require('path')
const { resolveTarget } = require('./targets')
const { safeSend } = require('./safeSend')

const CRONJOBS_PATH = path.join(__dirname, '..', 'cronjobs.json')
const SCHEDULES_PATH = path.join(__dirname, '..', 'schedules.json')

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
// Format: [{ "name": "morning", "cron": "0 8 * * *", "target": "sarah", "message": "Good morning ☀️" }]
function startCronJobs(sock, timezone) {
  const jobs = loadJson(CRONJOBS_PATH)
  jobs.forEach((job) => {
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
  })
  console.log(`Loaded ${jobs.length} recurring cron job(s).`)
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

module.exports = { startCronJobs, startOneOffChecker, addOneOff }
