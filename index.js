const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  jidDecode
} = require("@whiskeysockets/baileys");

const express = require("express");
const P = require("pino");
const path = require("path");
const crypto = require("crypto");

const app = express();

app.use(express.json());

const PORT = process.env.PORT || 10000;

/*
====================================================
CONFIGURATION
====================================================
*/

const AUTH_DIR =
  process.env.AUTH_DIR ||
  path.join(__dirname, "auth_info");

const PAIRING_NUMBER =
  process.env.PAIRING_NUMBER || "";

/*
====================================================
API ACCESS TOKEN
====================================================

Set ACCESS_TOKEN in Render environment variables.

Example:

ACCESS_TOKEN=JONTEZ-123456789

If no token is supplied, one is generated.
For Render, it is better to create your own
ACCESS_TOKEN environment variable.
*/

const ACCESS_TOKEN =
  process.env.ACCESS_TOKEN ||
  crypto.randomBytes(32).toString("hex");

/*
====================================================
BOT STATE
====================================================
*/

let sock = null;

let connectionStatus = "starting";

let accountJid = null;

let accountPhone = null;

let pairingCodeRequested = false;

const groupCache = new Map();

/*
====================================================
LID ↔ PHONE CACHE
====================================================
*/

const lidToPhoneCache = new Map();

const phoneToLidCache = new Map();

/*
====================================================
MESSAGE CACHE
====================================================
*/

const messageStore = new Map();

const MAX_STORED_MESSAGES = 5000;

/*
====================================================
JID HELPERS
====================================================
*/

function decodeJid(jid) {
  if (!jid) return null;

  try {
    return jidDecode(jid);
  } catch {
    return null;
  }
}

function phoneFromJid(jid) {
  if (!jid) return null;

  const decoded = decodeJid(jid);

  if (
    decoded?.user &&
    decoded.server === "s.whatsapp.net"
  ) {
    return decoded.user;
  }

  if (
    typeof jid === "string" &&
    jid.endsWith("@s.whatsapp.net")
  ) {
    return jid.split("@")[0];
  }

  return null;
}

function isGroup(jid) {
  return (
    typeof jid === "string" &&
    jid.endsWith("@g.us")
  );
}

function isLid(jid) {
  return (
    typeof jid === "string" &&
    (
      jid.endsWith("@lid") ||
      jid.endsWith("@hosted.lid")
    )
  );
}

function cleanPhone(phone) {
  if (!phone) return null;

  const value =
    String(phone).replace(/\D/g, "");

  return value || null;
}

/*
====================================================
REMEMBER LID ↔ PHONE
====================================================
*/

function rememberLidPhone(lid, phone) {
  if (!lid || !phone) return;

  const clean = cleanPhone(phone);

  if (!isLid(lid) || !clean) {
    return;
  }

  lidToPhoneCache.set(lid, clean);

  phoneToLidCache.set(clean, lid);

  console.log(
    "LID mapping learned:",
    lid,
    "→",
    clean
  );
}

/*
====================================================
RESOLVE PHONE NUMBER
====================================================
*/

async function resolvePhone(jid) {
  if (!jid) return null;

  /*
  Normal WhatsApp JID.
  */

  const direct = phoneFromJid(jid);

  if (direct) {
    return direct;
  }

  /*
  Local LID cache.
  */

  if (isLid(jid)) {
    const cached =
      lidToPhoneCache.get(jid);

    if (cached) {
      return cached;
    }
  }

  /*
  Ask Baileys for LID mapping.
  */

  if (!sock || !isLid(jid)) {
    return null;
  }

  try {
    const mapping =
      sock.signalRepository?.lidMapping;

    if (
      mapping &&
      typeof mapping.getPNForLID === "function"
    ) {
      const pn =
        await mapping.getPNForLID(jid);

      if (pn) {
        const phone =
          phoneFromJid(pn) ||
          cleanPhone(pn);

        if (phone) {
          rememberLidPhone(
            jid,
            phone
          );

          return phone;
        }
      }
    }
  } catch (err) {
    console.log(
      "LID → phone lookup failed:",
      err.message
    );
  }

  return null;
}

/*
====================================================
LEARN MESSAGE MAPPING
====================================================
*/

async function learnMessageMapping(message) {
  if (!message?.key) return;

  const key = message.key;

  const sender =
    key.participant ||
    key.remoteJid;

  /*
  Some Baileys versions expose participantPn.
  */

  if (
    sender &&
    isLid(sender) &&
    key.participantPn
  ) {
    rememberLidPhone(
      sender,
      key.participantPn
    );
  }

  /*
  Some versions may expose senderPn.
  */

  if (
    sender &&
    isLid(sender) &&
    key.senderPn
  ) {
    rememberLidPhone(
      sender,
      key.senderPn
    );
  }

  /*
  Ask Baileys if necessary.
  */

  if (
    sender &&
    isLid(sender)
  ) {
    await resolvePhone(sender);
  }
}

/*
====================================================
GROUP METADATA
====================================================
*/

async function getGroupMetadata(groupId) {
  if (!sock || !groupId) {
    return null;
  }

  try {
    const metadata =
      await sock.groupMetadata(groupId);

    if (metadata) {
      groupCache.set(
        groupId,
        metadata
      );
    }

    return metadata;
  } catch {
    return (
      groupCache.get(groupId) ||
      null
    );
  }
}

/*
====================================================
ADMIN CHECK
====================================================
*/

async function isGroupAdmin(
  groupId,
  userJid
) {
  const metadata =
    await getGroupMetadata(groupId);

  if (!metadata) {
    return false;
  }

  const participant =
    metadata.participants?.find(
      p => p.id === userJid
    );

  if (!participant) {
    return false;
  }

  return (
    participant.admin === "admin" ||
    participant.admin === "superadmin"
  );
}

async function isBotAdmin(groupId) {
  if (!sock?.user?.id) {
    return false;
  }

  const botJid =
    sock.user.id.includes(":")
      ? sock.user.id.split(":")[0] +
        "@s.whatsapp.net"
      : sock.user.id;

  return isGroupAdmin(
    groupId,
    botJid
  );
}

/*
====================================================
MESSAGE TEXT
====================================================
*/

function getMessageText(message) {
  if (!message?.message) {
    return "";
  }

  const msg = message.message;

  if (msg.conversation) {
    return msg.conversation;
  }

  if (
    msg.extendedTextMessage?.text
  ) {
    return msg.extendedTextMessage.text;
  }

  if (
    msg.imageMessage?.caption
  ) {
    return msg.imageMessage.caption;
  }

  if (
    msg.videoMessage?.caption
  ) {
    return msg.videoMessage.caption;
  }

  return "";
}

/*
====================================================
MESSAGE TYPE
====================================================
*/

function getMessageType(message) {
  const msg =
    message?.message;

  if (!msg) {
    return "unknown";
  }

  if (msg.conversation)
    return "text";

  if (msg.extendedTextMessage)
    return "text";

  if (msg.imageMessage)
    return "image";

  if (msg.videoMessage)
    return "video";

  if (msg.audioMessage)
    return "audio";

  if (msg.documentMessage)
    return "document";

  if (msg.stickerMessage)
    return "sticker";

  if (msg.contactMessage)
    return "contact";

  if (msg.locationMessage)
    return "location";

  return (
    Object.keys(msg)[0] ||
    "unknown"
  );
}

/*
====================================================
ANTI-DELETE STORAGE
====================================================
*/

function storeMessage(message) {
  if (!message?.key?.id) {
    return;
  }

  messageStore.set(
    message.key.id,
    {
      message,
      storedAt: Date.now()
    }
  );

  if (
    messageStore.size >
    MAX_STORED_MESSAGES
  ) {
    const oldest =
      messageStore.keys()
        .next().value;

    messageStore.delete(oldest);
  }
}

function findStoredMessage(messageId) {
  return messageStore.get(messageId);
}

/*
====================================================
ANTI-DELETE
====================================================
*/

async function handleDeletedMessage(message) {
  const deletedId =
    message
      ?.message
      ?.protocolMessage
      ?.key
      ?.id;

  if (!deletedId) {
    return;
  }

  const original =
    findStoredMessage(deletedId);

  console.log("");
  console.log(
    "================================"
  );
  console.log(
    "DELETED MESSAGE"
  );
  console.log(
    "================================"
  );

  console.log(
    "Message ID:",
    deletedId
  );

  if (!original) {
    console.log(
      "Original message not found."
    );

    return;
  }

  const originalMessage =
    original.message;

  const chatId =
    originalMessage.key.remoteJid;

  const senderId =
    originalMessage.key.participant ||
    originalMessage.key.remoteJid;

  const phone =
    await resolvePhone(senderId);

  console.log(
    "Chat ID:",
    chatId
  );

  console.log(
    "Sender JID:",
    senderId
  );

  console.log(
    "Phone:",
    phone || "Not resolved"
  );

  console.log(
    "Type:",
    getMessageType(
      originalMessage
    )
  );

  const text =
    getMessageText(
      originalMessage
    );

  if (text) {
    console.log(
      "Original text:",
      text
    );
  }

  if (sock && chatId) {
    try {
      let notice =
        "🛡️ *Anti-delete*\n\n" +
        "A message was deleted.";

      if (text) {
        notice +=
          "\n\nOriginal message:\n" +
          text;
      } else {
        notice +=
          "\n\nMessage type: " +
          getMessageType(
            originalMessage
          );
      }

      await sock.sendMessage(
        chatId,
        {
          text: notice
        }
      );
    } catch (err) {
      console.log(
        "Anti-delete notice failed:",
        err.message
      );
    }
  }
}

/*
====================================================
WELCOME / GOODBYE
====================================================
*/

async function handleGroupParticipantsUpdate(
  update
) {
  const {
    id: groupId,
    participants,
    action
  } = update;

  if (
    !groupId ||
    !participants?.length
  ) {
    return;
  }

  if (
    action !== "add" &&
    action !== "remove"
  ) {
    return;
  }

  const metadata =
    await getGroupMetadata(groupId);

  const groupName =
    metadata?.subject ||
    "the group";

  for (
    const participant of participants
  ) {
    const phone =
      await resolvePhone(
        participant
      );

    const display =
      phone ||
      participant.split("@")[0];

    if (action === "add") {
      console.log(
        `WELCOME: ${participant} (${phone || "unknown"}) joined ${groupName}`
      );

      try {
        await sock.sendMessage(
          groupId,
          {
            text:
              `👋 Welcome to *${groupName}*!\n\n` +
              `@${display}, welcome to the group!`,
            mentions: [
              participant
            ]
          }
        );
      } catch (err) {
        console.log(
          "Welcome failed:",
          err.message
        );
      }
    }

    if (action === "remove") {
      console.log(
        `GOODBYE: ${participant} (${phone || "unknown"}) left ${groupName}`
      );

      try {
        await sock.sendMessage(
          groupId,
          {
            text:
              `👋 Goodbye @${display}.\n` +
              `You have left *${groupName}*.`,
            mentions: [
              participant
            ]
          }
        );
      } catch (err) {
        console.log(
          "Goodbye failed:",
          err.message
        );
      }
    }
  }
}

/*
====================================================
HELP
====================================================
*/

async function sendHelp(chatId) {
  const help = `
🤖 *JONTEZ BOT*

GROUP COMMANDS

!help
!groups
!groupinfo
!members

!add 2547XXXXXXXX
!remove 2547XXXXXXXX
!promote 2547XXXXXXXX
!demote 2547XXXXXXXX

MESSAGING

!send 2547XXXXXXXX Hello

OTHER

!chatid
!status

Admin-only:
add, remove, promote, demote
`;

  await sock.sendMessage(
    chatId,
    {
      text: help
    }
  );
}

/*
====================================================
PHONE → JID
====================================================
*/

function phoneToJid(phone) {
  const clean =
    String(phone || "")
      .replace(/\D/g, "");

  if (!clean) {
    return null;
  }

  return (
    clean +
    "@s.whatsapp.net"
  );
}

/*
====================================================
GROUP COMMANDS
====================================================
*/

async function handleCommand(message) {
  if (!message?.message) {
    return;
  }

  const chatId =
    message.key.remoteJid;

  const sender =
    message.key.participant ||
    message.key.remoteJid;

  const text =
    getMessageText(message)
      .trim();

  if (
    !text.startsWith("!")
  ) {
    return;
  }

  const parts =
    text.split(/\s+/);

  const command =
    parts[0].toLowerCase();

  const args =
    parts.slice(1);

  /*
  !help
  */

  if (command === "!help") {
    await sendHelp(chatId);
    return;
  }

  /*
  !status
  */

  if (command === "!status") {
    await sock.sendMessage(
      chatId,
      {
        text:
          `🤖 *Jontez Bot*\n\n` +
          `WhatsApp: ${connectionStatus}\n` +
          `Account JID: ${accountJid || "unknown"}\n` +
          `Phone: ${accountPhone || "not resolved"}`
      }
    );

    return;
  }

  /*
  !chatid
  */

  if (command === "!chatid") {
    await sock.sendMessage(
      chatId,
      {
        text:
          `Chat ID:\n${chatId}`
      }
    );

    return;
  }

  /*
  !groups
  */

  if (command === "!groups") {
    try {
      const groups =
        await sock.groupFetchAllParticipating();

      let output =
        `📋 *GROUPS: ${Object.keys(groups).length}*\n\n`;

      for (
        const id of Object.keys(groups)
      ) {
        output +=
          `Name: ${groups[id].subject || "Unknown"}\n` +
          `ID: ${id}\n\n`;
      }

      await sock.sendMessage(
        chatId,
        {
          text:
            output.substring(
              0,
              60000
            )
        }
      );
    } catch (err) {
      await sock.sendMessage(
        chatId,
        {
          text:
            `❌ ${err.message}`
        }
      );
    }

    return;
  }

  /*
  Group-only commands.
  */

  const groupCommands = [
    "!groupinfo",
    "!members",
    "!add",
    "!remove",
    "!promote",
    "!demote"
  ];

  if (!isGroup(chatId)) {
    if (
      groupCommands.includes(command)
    ) {
      await sock.sendMessage(
        chatId,
        {
          text:
            "❌ This command can only be used in a group."
        }
      );
    }

    return;
  }

  /*
  !groupinfo
  */

  if (command === "!groupinfo") {
    const metadata =
      await getGroupMetadata(chatId);

    if (!metadata) {
      await sock.sendMessage(
        chatId,
        {
          text:
            "❌ Could not get group information."
        }
      );

      return;
    }

    await sock.sendMessage(
      chatId,
      {
        text:
          `📋 *GROUP INFO*\n\n` +
          `Name: ${metadata.subject || "Unknown"}\n` +
          `Group ID: ${metadata.id}\n` +
          `Participants: ${metadata.participants?.length || 0}\n` +
          `Owner: ${metadata.owner || "Unknown"}`
      }
    );

    return;
  }

  /*
  !members
  */

  if (command === "!members") {
    const metadata =
      await getGroupMetadata(chatId);

    if (!metadata) {
      return;
    }

    let output =
      `👥 *${metadata.subject || "Group"}*\n\n`;

    for (
      const p of
        metadata.participants || []
    ) {
      const phone =
        await resolvePhone(p.id);

      output +=
        `${phone || p.id} — ${p.admin || "member"}\n`;
    }

    if (output.length > 60000) {
      output =
        output.substring(0, 59000) +
        "\n\n[Output truncated]";
    }

    await sock.sendMessage(
      chatId,
      {
        text: output
      }
    );

    return;
  }

  /*
  ADMIN COMMANDS
  */

  const adminCommands = [
    "!add",
    "!remove",
    "!promote",
    "!demote"
  ];

  if (
    adminCommands.includes(command)
  ) {
    const senderIsAdmin =
      await isGroupAdmin(
        chatId,
        sender
      );

    if (!senderIsAdmin) {
      await sock.sendMessage(
        chatId,
        {
          text:
            "❌ Only group admins can use this command."
        }
      );

      return;
    }

    const botAdmin =
      await isBotAdmin(chatId);

    if (!botAdmin) {
      await sock.sendMessage(
        chatId,
        {
          text:
            "❌ The bot must be a group admin first."
        }
      );

      return;
    }
  }

  /*
  !add
  */

  if (command === "!add") {
    if (!args[0]) {
      await sock.sendMessage(
        chatId,
        {
          text:
            "Usage: !add 2547XXXXXXXX"
        }
      );

      return;
    }

    const jid =
      phoneToJid(args[0]);

    try {
      const result =
        await sock.groupParticipantsUpdate(
          chatId,
          [jid],
          "add"
        );

      console.log(
        "ADD RESULT:",
        result
      );

      await sock.sendMessage(
        chatId,
        {
          text:
            `Add request sent for ${args[0]}`
        }
      );
    } catch (err) {
      await sock.sendMessage(
        chatId,
        {
          text:
            `❌ Add failed: ${err.message}`
        }
      );
    }

    return;
  }

  /*
  !remove
  */

  if (command === "!remove") {
    if (!args[0]) {
      await sock.sendMessage(
        chatId,
        {
          text:
            "Usage: !remove 2547XXXXXXXX"
        }
      );

      return;
    }

    const jid =
      phoneToJid(args[0]);

    try {
      const result =
        await sock.groupParticipantsUpdate(
          chatId,
          [jid],
          "remove"
        );

      console.log(
        "REMOVE RESULT:",
        result
      );

      await sock.sendMessage(
        chatId,
        {
          text:
            `Remove request sent for ${args[0]}`
        }
      );
    } catch (err) {
      await sock.sendMessage(
        chatId,
        {
          text:
            `❌ Remove failed: ${err.message}`
        }
      );
    }

    return;
  }

  /*
  !promote
  */

  if (command === "!promote") {
    if (!args[0]) {
      await sock.sendMessage(
        chatId,
        {
          text:
            "Usage: !promote 2547XXXXXXXX"
        }
      );

      return;
    }

    const jid =
      phoneToJid(args[0]);

    try {
      const result =
        await sock.groupParticipantsUpdate(
          chatId,
          [jid],
          "promote"
        );

      console.log(
        "PROMOTE RESULT:",
        result
      );

      await sock.sendMessage(
        chatId,
        {
          text:
            `Promotion request sent for ${args[0]}`
        }
      );
    } catch (err) {
      await sock.sendMessage(
        chatId,
        {
          text:
            `❌ Promote failed: ${err.message}`
        }
      );
    }

    return;
  }

  /*
  !demote
  */

  if (command === "!demote") {
    if (!args[0]) {
      await sock.sendMessage(
        chatId,
        {
          text:
            "Usage: !demote 2547XXXXXXXX"
        }
      );

      return;
    }

    const jid =
      phoneToJid(args[0]);

    try {
      const result =
        await sock.groupParticipantsUpdate(
          chatId,
          [jid],
          "demote"
        );

      console.log(
        "DEMOTE RESULT:",
        result
      );

      await sock.sendMessage(
        chatId,
        {
          text:
            `Demotion request sent for ${args[0]}`
        }
      );
    } catch (err) {
      await sock.sendMessage(
        chatId,
        {
          text:
            `❌ Demote failed: ${err.message}`
        }
      );
    }

    return;
  }
}

/*
====================================================
PRINT MESSAGE
====================================================
*/

async function printMessage(message) {
  const key =
    message.key;

  const chatId =
    key.remoteJid;

  const senderId =
    key.participant ||
    key.remoteJid;

  console.log("");
  console.log(
    "================================"
  );
  console.log(
    "NEW MESSAGE"
  );
  console.log(
    "================================"
  );

  console.log(
    "Chat ID:",
    chatId
  );

  console.log(
    "Message ID:",
    key.id
  );

  console.log(
    "From me:",
    key.fromMe
  );

  console.log(
    "Chat type:",
    isGroup(chatId)
      ? "GROUP"
      : "PRIVATE"
  );

  console.log(
    "Sender JID:",
    senderId
  );

  console.log(
    "Sender phone:",
    await resolvePhone(senderId) ||
    "Not resolved"
  );

  if (isGroup(chatId)) {
    const group =
      await getGroupMetadata(chatId);

    console.log(
      "Group name:",
      group?.subject ||
      "Unknown"
    );

    console.log(
      "Group ID:",
      chatId
    );
  }

  console.log(
    "Type:",
    getMessageType(message)
  );

  const text =
    getMessageText(message);

  if (text) {
    console.log(
      "Text:",
      text
    );
  }
}

/*
====================================================
START WHATSAPP
====================================================
*/

async function startBot() {
  const {
    state,
    saveCreds
  } =
    await useMultiFileAuthState(
      AUTH_DIR
    );

  let version;

  try {
    const latest =
      await fetchLatestBaileysVersion();

    version =
      latest.version;

    console.log(
      "Baileys version:",
      version.join(".")
    );
  } catch (err) {
    console.log(
      "Could not fetch latest Baileys version:",
      err.message
    );

    /*
    Let Baileys use its installed/default
    version if fetching fails.
    */

    version = undefined;
  }

  console.log(
    "Auth directory:",
    AUTH_DIR
  );

  sock =
    makeWASocket({
      ...(version ? { version } : {}),

      auth: state,

      logger: P({
        level: "silent"
      }),

      browser: [
        "Chrome",
        "Chrome",
        "120.0.0"
      ],

      markOnlineOnConnect:
        false
    });

  sock.ev.on(
    "creds.update",
    saveCreds
  );

  /*
  ==================================================
  PAIRING CODE
  ==================================================
  */

  if (
    !state.creds.registered &&
    PAIRING_NUMBER &&
    !pairingCodeRequested
  ) {
    pairingCodeRequested = true;

    try {
      await new Promise(
        resolve =>
          setTimeout(
            resolve,
            2000
          )
      );

      const number =
        String(PAIRING_NUMBER)
          .replace(/\D/g, "");

      if (!number) {
        throw new Error(
          "PAIRING_NUMBER is invalid."
        );
      }

      console.log("");
      console.log(
        "================================"
      );
      console.log(
        "WHATSAPP PAIRING"
      );
      console.log(
        "================================"
      );

      console.log(
        "Phone:",
        number
      );

      console.log(
        "Requesting pairing code..."
      );

      const code =
        await sock.requestPairingCode(
          number
        );

      console.log("");
      console.log(
        "================================"
      );
      console.log(
        "PAIRING CODE"
      );
      console.log(
        "================================"
      );

      console.log(
        code
      );

      console.log(
        "================================"
      );

      console.log(
        "WhatsApp → Settings → Linked Devices"
      );

      console.log(
        "→ Link a Device"
      );

      console.log(
        "→ Link with phone number instead"
      );

      console.log(
        "→ Enter the code above"
      );

      console.log(
        "================================"
      );
    } catch (err) {
      pairingCodeRequested = false;

      console.error(
        "PAIRING CODE ERROR:",
        err.message
      );
    }
  }

  /*
  ==================================================
  CONNECTION UPDATE
  ==================================================
  */

  sock.ev.on(
    "connection.update",
    async update => {
      const {
        connection,
        lastDisconnect
      } = update;

      if (
        connection === "connecting"
      ) {
        connectionStatus =
          "connecting";

        console.log(
          "WhatsApp: connecting..."
        );
      }

      if (
        connection === "open"
      ) {
        connectionStatus =
          "open";

        accountJid =
          sock.user?.id ||
          null;

        accountPhone =
          await resolvePhone(
            accountJid
          );

        /*
        Sometimes the account JID is
        already a phone JID.
        */

        if (!accountPhone) {
          accountPhone =
            phoneFromJid(
              accountJid
            );
        }

        console.log("");
        console.log(
          "================================"
        );

        console.log(
          "WHATSAPP CONNECTED"
        );

        console.log(
          "================================"
        );

        console.log(
          "Account JID:",
          accountJid
        );

        console.log(
          "Account phone:",
          accountPhone ||
          "Not resolved"
        );

        console.log(
          "Session status: AUTHENTICATED"
        );

        console.log(
          "API access token:",
          ACCESS_TOKEN
        );

        console.log(
          "Credentials saved in:",
          AUTH_DIR
        );

        await printAllGroups();
      }

      if (
        connection === "close"
      ) {
        connectionStatus =
          "closed";

        const statusCode =
          lastDisconnect
            ?.error
            ?.output
            ?.statusCode;

        console.log(
          "WhatsApp disconnected."
        );

        console.log(
          "Disconnect code:",
          statusCode
        );

        if (
          !state.creds.registered
        ) {
          pairingCodeRequested =
            false;
        }

        if (
          statusCode !==
          DisconnectReason.loggedOut
        ) {
          console.log(
            "Reconnecting..."
          );

          setTimeout(
            () => {
              startBot()
                .catch(
                  err => {
                    console.error(
                      "Reconnect failed:",
                      err.message
                    );
                  }
                );
            },
            3000
          );
        } else {
          console.log(
            "Logged out."
          );

          console.log(
            "Delete auth_info and link again."
          );
        }
      }
    }
  );

  /*
  ==================================================
  INCOMING MESSAGES
  ==================================================
  */

  sock.ev.on(
    "messages.upsert",
    async ({
      messages
    }) => {
      for (
        const message of messages
      ) {
        try {
          await learnMessageMapping(
            message
          );

          storeMessage(
            message
          );

          /*
          Protocol delete message.
          */

          if (
            message.message
              ?.protocolMessage
              ?.type === 0
          ) {
            await handleDeletedMessage(
              message
            );

            continue;
          }

          await printMessage(
            message
          );

          await handleCommand(
            message
          );
        } catch (err) {
          console.error(
            "Message processing error:",
            err.message
          );
        }
      }
    }
  );

  /*
  ==================================================
  GROUP PARTICIPANTS
  ==================================================
  */

  sock.ev.on(
    "group-participants.update",
    async update => {
      try {
        await handleGroupParticipantsUpdate(
          update
        );
      } catch (err) {
        console.error(
          "Group participant error:",
          err.message
        );
      }
    }
  );
}

/*
====================================================
API TOKEN AUTHENTICATION
====================================================
*/

function checkApiToken(req, res, next) {
  const supplied =
    req.headers.authorization?.startsWith(
      "Bearer "
    )
      ? req.headers.authorization.substring(7)
      : req.headers["x-api-token"];

  if (supplied !== ACCESS_TOKEN) {
    return res.status(401).json({
      error: "Invalid or missing API access token"
    });
  }

  next();
}

/*
====================================================
HTML DASHBOARD
====================================================
*/

function dashboardHTML() {
  return `
<!DOCTYPE html>

<html>

<head>

<meta charset="UTF-8">

<meta
  name="viewport"
  content="width=device-width, initial-scale=1.0"
>

<title>Jontez WhatsApp Bot</title>

<style>

body {
  margin: 0;
  font-family: Arial, sans-serif;
  background: #111827;
  color: white;
}

.container {
  max-width: 1000px;
  margin: auto;
  padding: 25px;
}

h1 {
  margin-bottom: 5px;
}

.subtitle {
  color: #9ca3af;
}

.grid {
  display: grid;
  grid-template-columns:
    repeat(auto-fit, minmax(250px, 1fr));
  gap: 15px;
  margin-top: 25px;
}

.card {
  background: #1f2937;
  border-radius: 12px;
  padding: 20px;
  box-shadow:
    0 5px 20px rgba(0,0,0,.2);
}

.label {
  color: #9ca3af;
  font-size: 13px;
  margin-bottom: 8px;
}

.value {
  font-size: 18px;
  word-break: break-all;
}

.connected {
  color: #22c55e;
  font-weight: bold;
}

.disconnected {
  color: #ef4444;
  font-weight: bold;
}

.token {
  background: #111827;
  padding: 12px;
  border-radius: 8px;
  word-break: break-all;
  font-family: monospace;
  font-size: 13px;
}

button {
  background: #2563eb;
  color: white;
  border: 0;
  padding: 10px 15px;
  border-radius: 8px;
  cursor: pointer;
  margin-top: 10px;
}

button:hover {
  background: #1d4ed8;
}

pre {
  white-space: pre-wrap;
  word-break: break-word;
}

.footer {
  margin-top: 30px;
  color: #9ca3af;
  font-size: 13px;
}

</style>

</head>

<body>

<div class="container">

<h1>🤖 Jontez WhatsApp Bot</h1>

<div class="subtitle">
WhatsApp automation and API dashboard
</div>

<div class="grid">

<div class="card">

<div class="label">
WhatsApp Status
</div>

<div
  id="status"
  class="value"
>
Loading...
</div>

</div>

<div class="card">

<div class="label">
Account JID
</div>

<div
  id="jid"
  class="value"
>
Loading...
</div>

</div>

<div class="card">

<div class="label">
Phone Number
</div>

<div
  id="phone"
  class="value"
>
Loading...
</div>

</div>

<div class="card">

<div class="label">
Authentication
</div>

<div
  id="auth"
  class="value"
>
Loading...
</div>

</div>

<div class="card">

<div class="label">
API Access Token
</div>

<div
  id="token"
  class="token"
>
Loading...
</div>

<button onclick="copyToken()">
Copy Access Token
</button>

</div>

<div class="card">

<div class="label">
Groups
</div>

<div
  id="groups"
  class="value"
>
Loading...
</div>

</div>

</div>

<div class="card" style="margin-top:20px">

<h2>API Endpoints</h2>

<pre>
GET  /health
GET  /session
GET  /groups
POST /send
</pre>

</div>

<div class="card" style="margin-top:20px">

<h2>Authorization</h2>

<p>
For protected API requests use:
</p>

<pre>
Authorization: Bearer YOUR_ACCESS_TOKEN
</pre>

</div>

<div class="footer">
Jontez WhatsApp Bot
</div>

</div>

<script>

let currentToken = "";

async function loadSession() {

  try {

    const response =
      await fetch("/session");

    const data =
      await response.json();

    document.getElementById(
      "status"
    ).textContent =
      data.status || "unknown";

    document.getElementById(
      "status"
    ).className =
      data.authenticated
        ? "value connected"
        : "value disconnected";

    document.getElementById(
      "jid"
    ).textContent =
      data.accountJid ||
      "Not connected";

    document.getElementById(
      "phone"
    ).textContent =
      data.phone ||
      "Not resolved";

    document.getElementById(
      "auth"
    ).textContent =
      data.authenticated
        ? "AUTHENTICATED"
        : "NOT AUTHENTICATED";

    currentToken =
      data.accessToken || "";

    document.getElementById(
      "token"
    ).textContent =
      currentToken ||
      "Not available";

    document.getElementById(
      "groups"
    ).textContent =
      data.groupCount ??
      "Unknown";

  } catch (error) {

    document.getElementById(
      "status"
    ).textContent =
      "Dashboard error";

  }

}

async function copyToken() {

  if (!currentToken) {
    return;
  }

  try {

    await navigator.clipboard.writeText(
      currentToken
    );

    alert(
      "Access token copied."
    );

  } catch {

    alert(
      "Copy failed. Select and copy the token manually."
    );

  }

}

loadSession();

setInterval(
  loadSession,
  5000
);

</script>

</body>

</html>
`;
}

/*
====================================================
ROOT DASHBOARD
====================================================
*/

app.get(
  "/",
  (req, res) => {
    res.send(
      dashboardHTML()
    );
  }
);

/*
====================================================
HEALTH
====================================================
*/

app.get(
  "/health",
  (req, res) => {
    res.json({
      status: "online",
      whatsapp: connectionStatus,
      authenticated:
        connectionStatus === "open",
      phone:
        accountPhone
    });
  }
);

/*
====================================================
SESSION
====================================================
*/

app.get(
  "/session",
  async (req, res) => {

    let phone =
      accountPhone;

    if (!phone && accountJid) {
      phone =
        await resolvePhone(
          accountJid
        );
    }

    let groupCount = 0;

    if (
      sock &&
      connectionStatus === "open"
    ) {
      try {
        const groups =
          await sock.groupFetchAllParticipating();

        groupCount =
          Object.keys(groups).length;
      } catch {
        groupCount = 0;
      }
    }

    res.json({
      authenticated:
        connectionStatus === "open",

      status:
        connectionStatus,

      accountJid:
        accountJid,

      phone:
        phone || null,

      accessToken:
        ACCESS_TOKEN,

      groupCount
    });
  }
);

/*
====================================================
GROUPS API
====================================================
*/

app.get(
  "/groups",
  checkApiToken,
  async (req, res) => {

    if (
      !sock ||
      connectionStatus !== "open"
    ) {
      return res
        .status(503)
        .json({
          error:
            "WhatsApp is not connected"
        });
    }

    try {

      const groups =
        await sock.groupFetchAllParticipating();

      const result = [];

      for (
        const id of Object.keys(groups)
      ) {

        const group =
          groups[id];

        result.push({

          name:
            group.subject ||
            null,

          groupId:
            group.id,

          owner:
            group.owner ||
            null,

          participants:
            await Promise.all(

              (
                group.participants ||
                []
              ).map(
                async p => ({
                  jid:
                    p.id,

                  phone:
                    await resolvePhone(
                      p.id
                    ),

                  admin:
                    p.admin ||
                    null
                })
              )
            )
        });
      }

      res.json({
        count:
          result.length,

        groups:
          result
      });

    } catch (err) {

      res.status(500)
        .json({
          error:
            err.message
        });
    }
  }
);

/*
====================================================
SEND API
====================================================
*/

app.post(
  "/send",
  checkApiToken,
  async (req, res) => {

    if (
      !sock ||
      connectionStatus !== "open"
    ) {
      return res
        .status(503)
        .json({
          error:
            "WhatsApp is not connected"
        });
    }

    const {
      chatId,
      message
    } = req.body;

    if (
      !chatId ||
      !message
    ) {
      return res
        .status(400)
        .json({
          error:
            "chatId and message are required"
        });
    }

    try {

      const result =
        await sock.sendMessage(
          chatId,
          {
            text:
              String(message)
          }
        );

      console.log("");
      console.log(
        "MESSAGE SENT"
      );

      console.log(
        "Chat ID:",
        chatId
      );

      console.log(
        "Message:",
        message
      );

      res.json({
        success:
          true,

        chatId,

        messageId:
          result?.key?.id ||
          null
      });

    } catch (err) {

      console.error(
        "Send error:",
        err.message
      );

      res.status(500)
        .json({
          success:
            false,

          error:
            err.message
        });
    }
  }
);

/*
====================================================
HTTP SERVER
====================================================
*/

app.listen(
  PORT,
  () => {

    console.log(
      `HTTP server running on port ${PORT}`
    );

    console.log(
      `Dashboard: http://localhost:${PORT}/`
    );

    console.log(
      `Auth directory: ${AUTH_DIR}`
    );

    console.log(
      "API access token:",
      ACCESS_TOKEN
    );
  }
);
/*
====================================================
PRINT ALL GROUPS
====================================================
*/

async function printAllGroups() {
  if (!sock || connectionStatus !== "open") {
    console.log("WhatsApp is not connected.");
    return;
  }

  try {
    const groups =
      await sock.groupFetchAllParticipating();

    const groupIds =
      Object.keys(groups);

    console.log("");
    console.log(
      "================================"
    );
    console.log(
      "WHATSAPP GROUPS"
    );
    console.log(
      "================================"
    );

    console.log(
      "Total groups:",
      groupIds.length
    );

    for (const id of groupIds) {
      const group =
        groups[id];

      console.log("");
      console.log(
        "Group name:",
        group.subject || "Unknown"
      );

      console.log(
        "Group ID:",
        group.id || id
      );

      console.log(
        "Participants:",
        group.participants?.length || 0
      );

      console.log(
        "Owner:",
        group.owner || "Unknown"
      );

      console.log(
        "--------------------------------"
      );
    }

    console.log(
      "================================"
    );

    return groups;

  } catch (err) {
    console.error(
      "Failed to fetch groups:",
      err.message
    );

    return null;
  }
}
/*

====================================================
START BOT
====================================================
*/

startBot()
  .catch(
    err => {

      console.error(
        "Bot startup failed:",
        err
      );

    }
  );
