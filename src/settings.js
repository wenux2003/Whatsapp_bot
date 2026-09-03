// Small persisted bot-wide settings (currently just the read-receipts toggle).

const fs = require('fs')
const path = require('path')

const SETTINGS_PATH = path.join(__dirname, '..', 'settings.json')
const DEFAULTS = { readReceipts: true }

function loadSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8')) }
  } catch {
    return { ...DEFAULTS }
  }
}

let settings = loadSettings()

function get(key) {
  return settings[key]
}

function set(key, value) {
  settings[key] = value
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2))
}

module.exports = { get, set }
