require('dotenv').config();

const express = require('express');
const axios = require('axios');
const pino = require('pino');
const path = require('path');
const fs = require('fs');

const {
  default: makeWASocket,
  useMultiFileAuthState,
  delay,
  fetchLatestBaileysVersion,
  DisconnectReason
} = require('@whiskeysockets/baileys');

const { Boom } = require('@hapi/boom');

const app = express();
const PORT = process.env.PORT || 3000;

const AUTH_DIR =
  process.env.AUTH_DIR || path.join(__dirname, 'auth_info');

const API_KEY = process.env.NXT_API_KEY;

const API_URL =
  'https://nxtai.zipohostbd.workers.dev/api/use?gem=c477280c-3abb-4a93-8b8a-fdc8e56830dc';

/* =========================
   BOT INFORMATION
========================= */

const BOT_NAME =
  process.env.BOT_NAME || 'RIYAD THE AI';

const OWNER_INFO = `
নাম: ${process.env.OWNER_NAME || ''}
আমি কী করি: ${process.env.OWNER_WORK || ''}
আমার সম্পর্কে: ${process.env.OWNER_ABOUT || ''}
`;

/* =========================
   SERVER STATE
========================= */

let logs = [];

let botEnabled = true;
let offlineMode = false;

let waSocket = null;
let waConnected = false;
let waStarting = false;
let waPhoneNumber = null;
let pairingCode = null;

let reconnectTimer = null;

/* =========================
   LOG
========================= */

function log(message) {
  const time = new Date().toLocaleTimeString('bn-BD');
  const line = `[${time}] ${message}`;

  console.log(line);

  logs.push(line);

  if (logs.length > 200) {
    logs = logs.slice(-200);
  }
}

/* =========================
   PROFILES
========================= */

const profilesFile =
  path.join(__dirname, 'profiles.json');

const contactsFile =
  path.join(__dirname, 'contacts.json');

function readJSON(file, fallback) {
  try {
    if (!fs.existsSync(file)) {
      return fallback;
    }

    return JSON.parse(
      fs.readFileSync(file, 'utf8')
    );
  } catch (error) {
    log(`JSON read error: ${error.message}`);
    return fallback;
  }
}

function writeJSON(file, data) {
  fs.writeFileSync(
    file,
    JSON.stringify(data, null, 2),
    'utf8'
  );
}

let profiles = readJSON(
  profilesFile,
  {
    default: {
      name: 'Default',
      instruction:
        'ভদ্র, স্বাভাবিক এবং সংক্ষিপ্তভাবে উত্তর দাও।'
    },

    friend: {
      name: 'বন্ধু',
      instruction:
        'বন্ধুর মতো সহজ, স্বাভাবিক এবং casual ভাষায় উত্তর দাও।'
    },

    family: {
      name: 'পরিবার',
      instruction:
        'আন্তরিক, ভদ্র এবং স্বাভাবিকভাবে উত্তর দাও।'
    },

    sir: {
      name: 'স্যার',
      instruction:
        'অত্যন্ত ভদ্র ও সম্মানজনক ভাষায় উত্তর দাও।'
    },

    unknown: {
      name: 'অপরিচিত',
      instruction:
        'ভদ্র, সংক্ষিপ্ত এবং নিরাপদভাবে উত্তর দাও।'
    }
  }
);

let contacts = readJSON(
  contactsFile,
  {}
);

function saveProfiles() {
  writeJSON(
    profilesFile,
    profiles
  );
}

function saveContacts() {
  writeJSON(
    contactsFile,
    contacts
  );
}

/* =========================
   CONTACT SETTINGS
========================= */

function getContactSettings(jid) {
  return contacts[jid] || {
    profile: 'default',
    enabled: true
  };
}

/* =========================
   AI
========================= */

async function askAI(message, jid) {

  if (!API_KEY) {
    log('❌ NXT_API_KEY পাওয়া যায়নি');

    return '⚠️ AI API key সেট করা হয়নি।';
  }

  const settings =
    getContactSettings(jid);

  let profile =
    profiles[settings.profile] ||
    profiles.default;

  if (offlineMode) {
    profile = {
      name: 'Offline',
      instruction:
        'সংক্ষেপে জানাও যে RIYAD এখন ফোনে নেই এবং পরে উত্তর দেবে।'
    };
  }

  const prompt = `
তুমি "${BOT_NAME}" নামের একজন ব্যক্তিগত AI assistant।

তোমার কাজ হলো আমার WhatsApp-এ আসা মেসেজের উত্তর তৈরি করা।

আমার তথ্য:
${OWNER_INFO}

বর্তমান ব্যক্তির profile:
${profile.name}

এই ব্যক্তির জন্য বিশেষ নির্দেশনা:
${profile.instruction}

নিয়ম:
- ব্যবহারকারী যে ভাষায় লিখবে সেই ভাষায় উত্তর দাও।
- বাংলা হলে বাংলা ভাষায় উত্তর দাও।
- English হলে English-এ উত্তর দাও।
- স্বাভাবিকভাবে উত্তর দাও।
- অপ্রয়োজনীয় বড় উত্তর দিও না।
- কোনো তথ্য নিশ্চিতভাবে জানা না থাকলে বানিয়ে বলবে না।
- নিজেকে AI বলে অপ্রয়োজনে পরিচয় দিও না।
- আমার ব্যক্তিগত তথ্য প্রয়োজন ছাড়া প্রকাশ করো না।

ব্যবহারকারীর মেসেজ:
${message}
`;

  try {

    const response =
      await axios.post(
        API_URL,
        {
          api_key: API_KEY,
          message: prompt
        },
        {
          headers: {
            'Content-Type':
              'application/json',

            Accept:
              'application/json'
          },

          timeout: 30000
        }
      );

    const data =
      response.data;

    return (
      data.message ||
      data.response ||
      data.reply ||
      data.text ||
      data.content ||
      '⚠️ কোনো উত্তর পাওয়া যায়নি।'
    );

  } catch (error) {

    log(
      '❌ AI Error: ' +
      (error.response?.status ||
        error.message)
    );

    return (
      '⚠️ দুঃখিত, এখন AI সার্ভারে সমস্যা হচ্ছে।'
    );
  }
}

/* =========================
   HEALTH
========================= */

app.get('/health', (req, res) => {

  res.json({
    status: 'ok',

    whatsapp:
      waConnected
        ? 'connected'
        : waStarting
        ? 'pairing'
        : 'offline',

    botEnabled,

    offlineMode,

    uptime:
      Math.floor(process.uptime())
  });

});

/* =========================
   STATUS
========================= */

app.get('/api/status', (req, res) => {

  res.json({

    botName: BOT_NAME,

    whatsapp:
      waConnected
        ? 'connected'
        : waStarting
        ? 'pairing'
        : 'offline',

    phoneNumber:
      waPhoneNumber,

    pairingCode,

    botEnabled,

    offlineMode,

    profiles,

    contacts
  });

});

/* =========================
   BOT ON / OFF
========================= */

app.post('/api/bot/toggle', (req, res) => {

  botEnabled =
    !botEnabled;

  log(
    botEnabled
      ? '🟢 Bot ON'
      : '🔴 Bot OFF'
  );

  res.json({
    ok: true,
    botEnabled
  });

});

/* =========================
   OFFLINE MODE
========================= */

app.post('/api/offline/toggle', (req, res) => {

  offlineMode =
    !offlineMode;

  log(
    offlineMode
      ? '🌙 Offline mode ON'
      : '☀️ Offline mode OFF'
  );

  res.json({
    ok: true,
    offlineMode
  });

});

/* =========================
   CONTACT PROFILE
========================= */

app.post('/api/contact', (req, res) => {

  const jid =
    String(
      req.body?.jid || ''
    ).trim();

  const profile =
    String(
      req.body?.profile || 'default'
    ).trim();

  const enabled =
    req.body?.enabled !== false;

  if (!jid) {

    return res.status(400).json({
      error: 'jid required'
    });

  }

  if (!profiles[profile]) {

    return res.status(400).json({
      error: 'Profile not found'
    });

  }

  contacts[jid] = {
    profile,
    enabled
  };

  saveContacts();

  log(
    `👤 ${jid} → ${profile}`
  );

  res.json({
    ok: true,
    contact: contacts[jid]
  });

});

/* =========================
   CREATE PROFILE
========================= */

app.post('/api/profile', (req, res) => {

  const id =
    String(
      req.body?.id || ''
    )
    .trim()
    .toLowerCase();

  const name =
    String(
      req.body?.name || ''
    ).trim();

  const instruction =
    String(
      req.body?.instruction || ''
    ).trim();

  if (!id || !name || !instruction) {

    return res.status(400).json({
      error:
        'id, name এবং instruction প্রয়োজন'
    });

  }

  profiles[id] = {
    name,
    instruction
  };

  saveProfiles();

  log(
    `🧠 Profile created: ${id}`
  );

  res.json({
    ok: true,
    profile: profiles[id]
  });

});

/* =========================
   START WHATSAPP
========================= */

app.post('/api/wa/start', async (req, res) => {

  const phone =
    String(
      req.body?.phone || ''
    )
    .replace(/\D/g, '');

  if (!phone || phone.length < 8) {

    return res.status(400).json({
      error:
        'Country code সহ সঠিক নম্বর দিন।'
    });

  }

  if (waConnected) {

    return res.json({
      ok: true,
      message:
        'WhatsApp ইতিমধ্যে connected',
      phone:
        waPhoneNumber
    });

  }

  if (waStarting) {

    return res.json({
      ok: true,
      message:
        'Pairing চলছে',
      pairingCode
    });

  }

  waPhoneNumber =
    phone;

  waStarting = true;
  pairingCode = null;

  log(
    `📱 WhatsApp pairing শুরু: ${phone}`
  );

  startWhatsApp()
    .catch(error => {

      log(
        '❌ WhatsApp error: ' +
        error.message
      );

      waStarting = false;

    });

  res.json({
    ok: true,
    message:
      'Pairing শুরু হয়েছে'
  });

});

/* =========================
   RESET
========================= */

app.post('/api/wa/reset', (req, res) => {

  try {

    if (waSocket) {

      try {
        waSocket.end();
      } catch (_) {}

      waSocket = null;
    }

    if (
      fs.existsSync(AUTH_DIR)
    ) {

      fs.rmSync(
        AUTH_DIR,
        {
          recursive: true,
          force: true
        }
      );

    }

    waConnected = false;
    waStarting = false;
    pairingCode = null;
    waPhoneNumber = null;

    log(
      '🧹 WhatsApp session reset'
    );

    res.json({
      ok: true
    });

  } catch (error) {

    res.status(500).json({
      error:
        error.message
    });

  }

});

/* =========================
   WHATSAPP BOT
========================= */

async function startWhatsApp() {

  fs.mkdirSync(
    AUTH_DIR,
    {
      recursive: true
    }
  );

  const {
    state,
    saveCreds
  } =
    await useMultiFileAuthState(
      AUTH_DIR
    );

  let version;

  try {

    const result =
      await fetchLatestBaileysVersion();

    version =
      result.version;

    log(
      `📦 Baileys: ${version.join('.')}`
    );

  } catch {

    version =
      [2, 3000, 1020576855];

    log(
      '⚠️ Baileys fallback version'
    );

  }

  const sock =
    makeWASocket({

      version,

      auth: state,

      logger:
        pino({
          level: 'silent'
        }),

      printQRInTerminal:
        false,

      browser: [
        'RIYAD THE AI',
        'Chrome',
        '1.0'
      ],

      connectTimeoutMs:
        60000,

      defaultQueryTimeoutMs:
        30000,

      keepAliveIntervalMs:
        25000,

      markOnlineOnConnect:
        true
    });

  waSocket =
    sock;

  sock.ev.on(
    'creds.update',
    saveCreds
  );

  /* Pairing */

  if (
    !sock.authState.creds.registered
  ) {

    if (!waPhoneNumber) {

      log(
        '⚠️ WhatsApp number পাওয়া যায়নি'
      );

      waStarting = false;

      return;
    }

    try {

      await delay(3000);

      pairingCode =
        await sock.requestPairingCode(
          waPhoneNumber
        );

      log(
        `🔑 Pairing code: ${pairingCode}`
      );

    } catch (error) {

      log(
        '❌ Pairing error: ' +
        error.message
      );

      waStarting = false;

      return;
    }

  }

  /* Connection */

  sock.ev.on(
    'connection.update',
    update => {

      const {
        connection,
        lastDisconnect
      } = update;

      if (
        connection === 'open'
      ) {

        waConnected = true;
        waStarting = false;
        pairingCode = null;

        log(
          '🎉 RIYAD THE AI ONLINE!'
        );

      }

      if (
        connection === 'close'
      ) {

        waConnected = false;

        const code =
          new Boom(
            lastDisconnect?.error
          )
          ?.output
          ?.statusCode;

        if (
          code ===
          DisconnectReason.loggedOut
        ) {

          log(
            '🚪 WhatsApp logged out'
          );

          waStarting = false;

          return;
        }

        if (reconnectTimer) {
          return;
        }

        log(
          `🔄 Connection closed: ${code}`
        );

        waStarting = true;

        reconnectTimer =
          setTimeout(() => {

            reconnectTimer = null;

            startWhatsApp()
              .catch(error => {

                log(
                  '❌ Reconnect error: ' +
                  error.message
                );

                waStarting = false;

              });

          }, 5000);

      }

    }
  );

  /* Messages */

  const seenMessages =
    new Set();

  const busyChats =
    new Set();

  sock.ev.on(
    'messages.upsert',
    async ({
      messages
    }) => {

      const msg =
        messages[0];

      if (
        !msg?.message ||
        msg.key.fromMe
      ) {
        return;
      }

      const jid =
        msg.key.remoteJid;

      const text =
        msg.message.conversation ||
        msg.message
          ?.extendedTextMessage
          ?.text ||
        '';

      if (!text.trim()) {
        return;
      }

      const messageId =
        msg.key.id;

      if (
        seenMessages.has(
          messageId
        )
      ) {
        return;
      }

      seenMessages.add(
        messageId
      );

      if (
        seenMessages.size > 500
      ) {
        seenMessages.clear();
      }

      log(
        `📩 ${jid}: ${text}`
      );

      /* Bot OFF */

      if (!botEnabled) {

        log(
          '⏭️ Bot OFF'
        );

        return;
      }

      /* Contact settings */

      const settings =
        getContactSettings(
          jid
        );

      if (
        settings.enabled === false
      ) {

        log(
          `⏭️ Reply disabled: ${jid}`
        );

        return;
      }

      /* Prevent duplicate processing */

      if (
        busyChats.has(jid)
      ) {

        log(
          `⏭️ Busy chat: ${jid}`
        );

        return;
      }

      busyChats.add(jid);

      try {

        try {

          await sock.readMessages([
            msg.key
          ]);

        } catch (_) {}

        try {

          await sock.sendPresenceUpdate(
            'composing',
            jid
          );

        } catch (_) {}

        const reply =
          await askAI(
            text,
            jid
          );

        try {

          await sock.sendPresenceUpdate(
            'paused',
            jid
          );

        } catch (_) {}

        await sock.sendMessage(
          jid,
          {
            text:
              String(reply)
          }
        );

        log(
          `📤 Reply sent: ${jid}`
        );

      } catch (error) {

        log(
          '❌ Message error: ' +
          error.message
        );

      } finally {

        busyChats.delete(jid);

      }

    }
  );
}

/* =========================
   DASHBOARD
========================= */

app.get('/', (req, res) => {

  const status =
    waConnected
      ? '🟢 CONNECTED'
      : waStarting
      ? '🟡 PAIRING'
      : '🔴 OFFLINE';

  res.send(`

<!DOCTYPE html>

<html lang="bn">

<head>

<meta charset="UTF-8">

<meta name="viewport"
content="width=device-width,initial-scale=1">

<title>${BOT_NAME}</title>

<style>

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  padding: 20px;
  background: #05070d;
  color: #e8f7ff;
  font-family: Arial, sans-serif;
  max-width: 800px;
  margin-left: auto;
  margin-right: auto;
}

h1 {
  color: #00d4ff;
}

.card {
  background: #111827;
  border: 1px solid #26354a;
  border-radius: 16px;
  padding: 18px;
  margin-bottom: 15px;
}

input,
select,
button,
textarea {
  width: 100%;
  padding: 13px;
  margin-top: 8px;
  border-radius: 10px;
  border: 1px solid #334155;
  background: #080d17;
  color: white;
}

button {
  background: #087fce;
  border: none;
  font-weight: bold;
}

button:active {
  transform: scale(.98);
}

.code {
  font-size: 28px;
  font-weight: bold;
  letter-spacing: 6px;
  color: #00ffae;
  text-align: center;
  padding: 15px;
}

.log {
  white-space: pre-wrap;
  background: #020617;
  padding: 12px;
  border-radius: 10px;
  max-height: 300px;
  overflow: auto;
  font-size: 12px;
}

.green {
  color: #00ff99;
}

.red {
  color: #ff5577;
}

.yellow {
  color: #ffd166;
}

</style>

</head>

<body>

<h1>🤖 ${BOT_NAME}</h1>

<div class="card">

<h3>WhatsApp Status</h3>

<p>${status}</p>

<p>
Phone:
${waPhoneNumber || 'Not connected'}
</p>

${
  pairingCode
    ? `
    <div class="code">
      ${pairingCode}
    </div>

    <p>
    WhatsApp → Settings → Linked Devices →
    Link a Device → Link with phone number
    </p>
    `
    : ''
}

</div>

<div class="card">

<h3>📱 WhatsApp Login</h3>

<input
id="phone"
placeholder="8801XXXXXXXXX"
inputmode="numeric">

<button onclick="startWA()">
🚀 START PAIRING
</button>

</div>

<div class="card">

<h3>⚙️ Bot Control</h3>

<p>
Bot:
${botEnabled
  ? '🟢 ON'
  : '🔴 OFF'}
</p>

<button onclick="toggleBot()">
BOT ON / OFF
</button>

<p>
Offline Mode:
${offlineMode
  ? '🌙 ON'
  : '☀️ OFF'}
</p>

<button onclick="toggleOffline()">
OFFLINE MODE ON / OFF
</button>

</div>

<div class="card">

<h3>👥 Contact Profile</h3>

<p>
এখানে পরে Dashboard থেকে
ব্যক্তিভেদে profile নির্বাচন করা যাবে।
</p>

<p>
Friend → বন্ধু
<br>
Family → পরিবার
<br>
Sir → স্যার
<br>
Default → সাধারণ
</p>

</div>

<div class="card">

<h3>📜 Logs</h3>

<div class="log">
${logs
  .slice(-40)
  .reverse()
  .join('\\n')}
</div>

</div>

<script>

async function startWA() {

  const phone =
    document
      .getElementById('phone')
      .value
      .trim();

  if (!phone) {
    alert('WhatsApp number দিন');
    return;
  }

  await fetch(
    '/api/wa/start',
    {
      method: 'POST',
      headers: {
        'Content-Type':
          'application/json'
      },
      body:
        JSON.stringify({
          phone
        })
    }
  );

  location.reload();

}

async function toggleBot() {

  await fetch(
    '/api/bot/toggle',
    {
      method: 'POST'
    }
  );

  location.reload();

}

async function toggleOffline() {

  await fetch(
    '/api/offline/toggle',
    {
      method: 'POST'
    }
  );

  location.reload();

}

setTimeout(
  () => location.reload(),
  5000
);

</script>

</body>

</html>

`);

});

/* =========================
   START SERVER
========================= */

app.listen(
  PORT,
  '0.0.0.0',
  () => {

    log(
      `🚀 Server running on port ${PORT}`
    );

    log(
      `📁 Auth directory: ${AUTH_DIR}`
    );

    if (
      fs.existsSync(AUTH_DIR) &&
      fs.readdirSync(AUTH_DIR).length > 0
    ) {

      log(
        '🔁 Existing WhatsApp session found'
      );

      waStarting = true;

      startWhatsApp()
        .catch(error => {

          log(
            '❌ Resume error: ' +
            error.message
          );

          waStarting = false;

        });

    }

  }
);
