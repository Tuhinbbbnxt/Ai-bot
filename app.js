require("dotenv").config();

const express = require("express");
const axios = require("axios");
const pino = require("pino");
const fs = require("fs");
const path = require("path");

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require("@whiskeysockets/baileys");

const { Boom } = require("@hapi/boom");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;

const AUTH_DIR =
  process.env.AUTH_DIR || path.join(__dirname, "auth_info");

const BOT_NAME =
  process.env.BOT_NAME || "RIYAD THE AI";

const OWNER_NAME =
  process.env.OWNER_NAME || "";

const OWNER_WORK =
  process.env.OWNER_WORK || "";

const OWNER_ABOUT =
  process.env.OWNER_ABOUT || "";

const NXT_API_KEY =
  process.env.NXT_API_KEY || "";

// তোমার দেওয়া নতুন GEM ID
const NXT_GEM =
  process.env.NXT_GEM ||
  "ba0fbe0d-976e-493a-afdb-6d8469e53df0";

const profilesFile = path.join(__dirname, "profiles.json");
const contactsFile = path.join(__dirname, "contacts.json");

let sock = null;
let pairingInProgress = false;
let botEnabled = true;
let offlineMode = false;
let waStatus = "OFFLINE";
let waPhone = null;
let lastError = null;

// --------------------------------------------------
// Profiles
// --------------------------------------------------

const defaultProfiles = {
  default: {
    name: "সাধারণ",
    instruction: "ভদ্র, স্বাভাবিক এবং সংক্ষিপ্তভাবে উত্তর দাও।"
  },

  friend: {
    name: "বন্ধু",
    instruction:
      "বন্ধুর মতো সহজ, স্বাভাবিক ও casual ভাষায় কথা বলো। বন্ধুত্বপূর্ণ হও, কিন্তু অশালীন বা অপমানজনক ভাষা ব্যবহার করো না।"
  },

  family: {
    name: "পরিবার",
    instruction:
      "পরিবারের সদস্যের সঙ্গে আন্তরিক, ভদ্র ও স্বাভাবিকভাবে কথা বলো।"
  },

  sir: {
    name: "স্যার",
    instruction:
      "অত্যন্ত ভদ্র ও সম্মানজনক ভাষায় উত্তর দাও। প্রয়োজন ছাড়া casual ভাষা ব্যবহার করো না।"
  },

  unknown: {
    name: "অপরিচিত",
    instruction:
      "অপরিচিত ব্যক্তির সঙ্গে সংক্ষিপ্ত, ভদ্র ও সতর্কভাবে কথা বলো।"
  },

  offline: {
    name: "অফলাইন",
    instruction:
      "জানাও যে RIYAD বর্তমানে ফোনে নেই এবং পরে উত্তর দিতে পারে। সংক্ষিপ্ত ও স্বাভাবিকভাবে উত্তর দাও।"
  }
};

function loadJSON(file, fallback) {
  try {
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    }
  } catch (e) {
    console.log("JSON load error:", e.message);
  }

  return fallback;
}

function saveJSON(file, data) {
  try {
    fs.writeFileSync(
      file,
      JSON.stringify(data, null, 2),
      "utf8"
    );
  } catch (e) {
    console.log("JSON save error:", e.message);
  }
}

let profiles = loadJSON(profilesFile, defaultProfiles);
let contacts = loadJSON(contactsFile, {});

// --------------------------------------------------
// AI
// --------------------------------------------------

async function askAI(message, profileKey) {
  const profile =
    profiles[profileKey] ||
    profiles.default ||
    defaultProfiles.default;

  const systemInfo = `
তুমি ${BOT_NAME}-এর ব্যক্তিগত AI assistant।

Owner name: ${OWNER_NAME}
Owner work: ${OWNER_WORK}
Owner about: ${OWNER_ABOUT}

Reply style:
${profile.instruction}

নির্দেশনা:
- স্বাভাবিকভাবে উত্তর দাও।
- প্রয়োজন ছাড়া নিজের পরিচয় দিও না।
- Owner-এর ব্যক্তিগত বা সংবেদনশীল তথ্য অযথা প্রকাশ করো না।
- ব্যবহারকারীর ভাষা অনুযায়ী বাংলা/ইংরেজিতে উত্তর দাও।
`;

  if (!NXT_API_KEY) {
    throw new Error("NXT_API_KEY is not configured");
  }

  const url =
    `https://nxtai.zipohostbd.workers.dev/api/use?gem=${encodeURIComponent(NXT_GEM)}`;

  const response = await axios.post(
    url,
    {
      api_key: NXT_API_KEY,
      message: `${systemInfo}\n\nUser message:\n${message}`
    },
    {
      timeout: 60000,
      headers: {
        "Content-Type": "application/json"
      }
    }
  );

  const data = response.data;

  if (typeof data === "string") {
    return data;
  }

  return (
    data?.response ||
    data?.message ||
    data?.reply ||
    data?.result ||
    data?.text ||
    "দুঃখিত, এখন উত্তর দিতে পারছি না।"
  );
}

// --------------------------------------------------
// WhatsApp
// --------------------------------------------------

async function startWhatsApp() {
  if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
  }

  const { state, saveCreds } =
    await useMultiFileAuthState(AUTH_DIR);

  let version;

  try {
    const latest = await fetchLatestBaileysVersion();
    version = latest.version;
  } catch {
    version = [2, 3000, 1015901307];
  }

  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
    browser: ["RIYAD THE AI", "Chrome", "1.0.0"],
    generateHighQualityLinkPreview: false
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const {
      connection,
      lastDisconnect
    } = update;

    if (connection === "open") {
      waStatus = "ONLINE";
      pairingInProgress = false;
      lastError = null;

      try {
        waPhone =
          sock.user?.id?.split(":")[0] ||
          sock.user?.id ||
          null;
      } catch {
        waPhone = null;
      }

      console.log("WhatsApp connected:", waPhone);
    }

    if (connection === "close") {
      waStatus = "OFFLINE";
      waPhone = null;

      const statusCode =
        new Boom(lastDisconnect?.error)?.output?.statusCode;

      console.log(
        "WhatsApp connection closed:",
        statusCode
      );

      if (
        statusCode !== DisconnectReason.loggedOut &&
        statusCode !== DisconnectReason.forbidden
      ) {
        setTimeout(() => {
          startWhatsApp().catch((err) => {
            lastError = err.message;
            console.log("Reconnect error:", err.message);
          });
        }, 5000);
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages }) => {
    try {
      const msg = messages?.[0];

      if (!msg || !msg.message) return;

      if (msg.key.fromMe) return;

      const remoteJid = msg.key.remoteJid;

      if (!remoteJid || remoteJid.endsWith("@g.us")) {
        return;
      }

      const messageText =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        "";

      if (!messageText.trim()) return;

      console.log(
        "Incoming message:",
        remoteJid,
        messageText
      );

      if (!botEnabled) return;

      let profileKey =
        contacts[remoteJid] || "default";

      if (offlineMode) {
        profileKey = "offline";
      }

      // typing indicator
      try {
        await sock.sendPresenceUpdate(
          "composing",
          remoteJid
        );
      } catch {}

      const reply = await askAI(
        messageText,
        profileKey
      );

      if (!reply) return;

      await sock.sendMessage(remoteJid, {
        text: String(reply)
      });

      try {
        await sock.sendPresenceUpdate(
          "paused",
          remoteJid
        );
      } catch {}
    } catch (err) {
      lastError = err.message;
      console.log(
        "Message handling error:",
        err.message
      );
    }
  });
}

// --------------------------------------------------
// API
// --------------------------------------------------

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    whatsapp: waStatus,
    bot: botEnabled,
    offline: offlineMode
  });
});

app.get("/api/status", (req, res) => {
  res.json({
    whatsapp: waStatus,
    phone: waPhone,
    bot: botEnabled,
    offline: offlineMode,
    pairing: pairingInProgress,
    error: lastError
  });
});

app.post("/api/bot/toggle", (req, res) => {
  botEnabled = !botEnabled;

  res.json({
    ok: true,
    bot: botEnabled
  });
});

app.post("/api/offline/toggle", (req, res) => {
  offlineMode = !offlineMode;

  res.json({
    ok: true,
    offline: offlineMode
  });
});

// --------------------------------------------------
// Pairing
// --------------------------------------------------

app.post("/api/wa/start", async (req, res) => {
  try {
    const phone = String(req.body?.phone || "")
      .replace(/\D/g, "");

    if (!phone) {
      return res.status(400).json({
        ok: false,
        error: "WhatsApp number is required"
      });
    }

    if (waStatus === "ONLINE") {
      return res.json({
        ok: true,
        status: "ONLINE",
        phone: waPhone
      });
    }

    if (pairingInProgress) {
      return res.json({
        ok: true,
        pairing: true,
        message:
          "Pairing is already in progress. Please wait."
      });
    }

    pairingInProgress = true;
    lastError = null;

    if (!sock) {
      await startWhatsApp();
    }

    // Baileys needs the socket to initialize
    await new Promise((resolve) =>
      setTimeout(resolve, 2000)
    );

    if (sock?.authState?.creds?.registered) {
      pairingInProgress = false;

      return res.json({
        ok: true,
        status: "ONLINE",
        phone: waPhone
      });
    }

    const code =
      await sock.requestPairingCode(phone);

    pairingInProgress = false;

    return res.json({
      ok: true,
      pairing: true,
      code
    });
  } catch (err) {
    pairingInProgress = false;
    lastError = err.message;

    console.log(
      "Pairing error:",
      err.stack || err.message
    );

    return res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

app.post("/api/wa/reset", async (req, res) => {
  try {
    if (sock) {
      try {
        await sock.logout();
      } catch {}
    }

    sock = null;
    waStatus = "OFFLINE";
    waPhone = null;

    if (fs.existsSync(AUTH_DIR)) {
      fs.rmSync(AUTH_DIR, {
        recursive: true,
        force: true
      });
    }

    fs.mkdirSync(AUTH_DIR, {
      recursive: true
    });

    res.json({
      ok: true,
      message: "WhatsApp session reset"
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

// --------------------------------------------------
// Contact Profile
// --------------------------------------------------

app.get("/api/profiles", (req, res) => {
  res.json(profiles);
});

app.get("/api/contacts", (req, res) => {
  res.json(contacts);
});

app.post("/api/contact", (req, res) => {
  const jid = String(req.body?.jid || "").trim();
  const profile = String(
    req.body?.profile || "default"
  ).trim();

  if (!jid) {
    return res.status(400).json({
      ok: false,
      error: "jid is required"
    });
  }

  if (!profiles[profile]) {
    return res.status(400).json({
      ok: false,
      error: "Invalid profile"
    });
  }

  contacts[jid] = profile;
  saveJSON(contactsFile, contacts);

  res.json({
    ok: true,
    jid,
    profile
  });
});

// --------------------------------------------------
// Dashboard
// --------------------------------------------------

app.get("/", (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="bn">
<head>
<meta charset="UTF-8">
<meta
  name="viewport"
  content="width=device-width,initial-scale=1.0"
>
<title>${BOT_NAME}</title>

<style>
* {
  box-sizing: border-box;
}

body {
  margin: 0;
  padding: 20px;
  background: #05070c;
  color: #fff;
  font-family: Arial, sans-serif;
}

.container {
  max-width: 600px;
  margin: auto;
}

h1 {
  color: #00d9ff;
  font-size: 30px;
  margin-bottom: 25px;
}

.card {
  background: #111827;
  border: 1px solid #29354a;
  border-radius: 20px;
  padding: 22px;
  margin-bottom: 20px;
}

h2 {
  margin-top: 0;
}

.status {
  font-size: 20px;
  margin: 10px 0;
}

input,
select,
button {
  width: 100%;
  padding: 15px;
  margin-top: 12px;
  border-radius: 12px;
  border: 1px solid #344054;
  font-size: 16px;
}

input,
select {
  background: #0b1220;
  color: white;
}

button {
  background: #078bd6;
  color: white;
  border: none;
  font-weight: bold;
}

button:active {
  transform: scale(.98);
}

#pairCode {
  margin-top: 15px;
  padding: 15px;
  background: #071b2b;
  border-radius: 12px;
  text-align: center;
  font-size: 24px;
  letter-spacing: 3px;
  display: none;
}

.small {
  color: #aeb8c8;
  font-size: 14px;
  margin-top: 10px;
}
</style>
</head>

<body>

<div class="container">

<h1>🤖 ${BOT_NAME}</h1>

<div class="card">
<h2>WhatsApp Status</h2>

<div class="status">
<span id="statusDot">🔴</span>
<span id="waStatus">OFFLINE</span>
</div>

<div>
Phone:
<span id="waPhone">Not connected</span>
</div>
</div>


<div class="card">

<h2>📱 WhatsApp Login</h2>

<input
  id="phone"
  type="tel"
  inputmode="numeric"
  autocomplete="tel"
  placeholder="8801XXXXXXXXX"
/>

<button id="pairBtn">
🚀 START PAIRING
</button>

<div id="pairCode"></div>

<div id="pairMessage" class="small"></div>

</div>


<div class="card">

<h2>⚙️ Bot Control</h2>

<div class="status">
Bot:
<span id="botStatus">🟢 ON</span>
</div>

<button id="botBtn">
BOT ON / OFF
</button>

<div class="status">
Offline Mode:
<span id="offlineStatus">☀️ OFF</span>
</div>

<button id="offlineBtn">
OFFLINE MODE ON / OFF
</button>

</div>


<div class="card">

<h2>👥 Contact Profile</h2>

<p>
Dashboard থেকে contact অনুযায়ী profile
নির্বাচন করা যাবে।
</p>

<p>
Friend → বন্ধু<br>
Family → পরিবার<br>
Sir → স্যার<br>
Default → সাধারণ<br>
Unknown → অপরিচিত
</p>

</div>

</div>


<script>

const phoneInput =
  document.getElementById("phone");

const pairBtn =
  document.getElementById("pairBtn");

const pairCode =
  document.getElementById("pairCode");

const pairMessage =
  document.getElementById("pairMessage");


// --------------------------------------
// Pairing
// --------------------------------------

pairBtn.addEventListener("click", async () => {

  const phone =
    phoneInput.value.replace(/\\D/g, "");

  if (!phone) {
    pairMessage.textContent =
      "প্রথমে WhatsApp নম্বর লিখুন।";
    return;
  }

  pairBtn.disabled = true;
  pairBtn.textContent = "⏳ PAIRING...";

  pairCode.style.display = "none";
  pairCode.textContent = "";

  pairMessage.textContent =
    "Pairing code তৈরি হচ্ছে...";

  try {

    const response =
      await fetch("/api/wa/start", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          phone: phone
        })
      });

    const data =
      await response.json();

    if (data.ok && data.code) {

      pairCode.textContent =
        data.code;

      pairCode.style.display =
        "block";

      pairMessage.textContent =
        "এই code WhatsApp-এর Link with phone number অপশনে ব্যবহার করুন।";

    } else if (data.status === "ONLINE") {

      pairMessage.textContent =
        "✅ WhatsApp ইতিমধ্যে connected.";

    } else {

      pairMessage.textContent =
        "❌ " +
        (data.error ||
        "Pairing শুরু করা যায়নি।");

    }

  } catch (error) {

    pairMessage.textContent =
      "❌ Server error: " +
      error.message;

  } finally {

    pairBtn.disabled = false;
    pairBtn.textContent =
      "🚀 START PAIRING";

  }

});


// --------------------------------------
// Bot toggle
// --------------------------------------

document
  .getElementById("botBtn")
  .addEventListener("click", async () => {

    await fetch("/api/bot/toggle", {
      method: "POST"
    });

    updateStatus();
  });


// --------------------------------------
// Offline toggle
// --------------------------------------

document
  .getElementById("offlineBtn")
  .addEventListener("click", async () => {

    await fetch("/api/offline/toggle", {
      method: "POST"
    });

    updateStatus();
  });


// --------------------------------------
// Status update
// IMPORTANT:
// Page reload করা হচ্ছে না.
// শুধু text update হচ্ছে.
// --------------------------------------

async function updateStatus() {

  try {

    const response =
      await fetch("/api/status", {
        cache: "no-store"
      });

    const data =
      await response.json();

    const online =
      data.whatsapp === "ONLINE";

    document.getElementById(
      "waStatus"
    ).textContent =
      online ? "ONLINE" : "OFFLINE";

    document.getElementById(
      "statusDot"
    ).textContent =
      online ? "🟢" : "🔴";

    document.getElementById(
      "waPhone"
    ).textContent =
      data.phone ||
      "Not connected";

    document.getElementById(
      "botStatus"
    ).textContent =
      data.bot ? "🟢 ON" : "🔴 OFF";

    document.getElementById(
      "offlineStatus"
    ).textContent =
      data.offline ? "🌙 ON" : "☀️ OFF";

  } catch (error) {
    console.log(
      "Status update error:",
      error.message
    );
  }
}


// প্রথম status
updateStatus();


// প্রতি ৫ সেকেন্ডে শুধু status update হবে.
// পুরো webpage reload হবে না.
setInterval(updateStatus, 5000);

</script>

</body>
</html>`);
});


// --------------------------------------------------
// Start Server
// --------------------------------------------------

app.listen(PORT, async () => {

  console.log(
    `🚀 Server running on port ${PORT}`
  );

  console.log(
    `📁 Auth directory: ${AUTH_DIR}`
  );

  try {
    await startWhatsApp();
  } catch (err) {
    lastError = err.message;

    console.log(
      "WhatsApp startup error:",
      err.message
    );
  }

});
