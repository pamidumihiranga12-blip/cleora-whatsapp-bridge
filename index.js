/**
 * Cleora Fashion — Dedicated WhatsApp AI Assistant Bridge
 * ========================================================
 * - Pure Dedicated WhatsApp Bridge for Cleora Fashion (https://cleora.lk)
 * - Connects strictly to Cleora Fashion PHP Backend
 * - Isolated session stored in ./sessions/merchant_cleora
 */

import makeWASocket, {
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    Browsers,
    delay,
    downloadMediaMessage,
} from '@whiskeysockets/baileys';
import express from 'express';
import pino from 'pino';
import fetch from 'node-fetch';
import qrcode from 'qrcode';
import { Boom } from '@hapi/boom';
import { mkdir, readdir, rm, readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import 'dotenv/config';

// ============================================
// CONFIG (100% Cleora Dedicated)
// ============================================
const PHP_BACKEND_URL = (process.env.PHP_BACKEND_URL || process.env.CLEORA_BACKEND_URL || 'https://cleora.lk').replace(/\/$/, '');

function getBackendUrl(merchantId) {
    return PHP_BACKEND_URL;
}
const BRIDGE_SECRET   = process.env.BRIDGE_SECRET   || 'cleora_baileys_secret_2026';
const PORT            = process.env.PORT            || 3000;
const SESSIONS_BASE   = process.env.SESSION_DIR     || './sessions';

const COMMON_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*'
};

const logger = pino({ level: 'silent' });

// In-memory circular debug logs (last 150 events)
const debugLogs = [];
function addDebugLog(msg) {
    const entry = `[${new Date().toISOString()}] ${msg}`;
    debugLogs.push(entry);
    if (debugLogs.length > 150) debugLogs.shift();
    console.log(entry);
}

// ============================================
// IN-MEMORY SESSIONS REGISTRY
// Map<merchantId, SessionData>
// ============================================
const sessions = new Map();

// Ensure base sessions directory exists
if (!existsSync(SESSIONS_BASE)) {
    await mkdir(SESSIONS_BASE, { recursive: true });
}

// ============================================
// HELPER: Format Phone to JID
// ============================================
function formatJID(jidOrPhone) {
    if (typeof jidOrPhone !== 'string') return '';
    if (jidOrPhone.includes('@lid')) {
        return jidOrPhone;
    }
    if (jidOrPhone.includes('@')) {
        return jidOrPhone.replace('@c.us', '@s.whatsapp.net');
    }
    let clean = jidOrPhone.replace(/[^0-9]/g, '');
    if (clean.startsWith('0') && clean.length === 10) {
        clean = '94' + clean.substring(1);
    }
    return clean + '@s.whatsapp.net';
}

async function resolveSenderInfo(sock, msg) {
    const remoteJid = msg.key?.remoteJid || '';
    let realPhone = null;
    const pushName = msg.pushName || '';

    if (remoteJid.endsWith('@s.whatsapp.net')) {
        realPhone = remoteJid.replace(/@.*/, '');
    } else if (remoteJid.endsWith('@lid')) {
        // 1. Check alternate properties in Baileys message key
        const altJid = msg.key?.remoteJidAlt || msg.key?.participantAlt || msg.key?.participant || msg.participant;
        if (altJid && typeof altJid === 'string' && altJid.endsWith('@s.whatsapp.net')) {
            realPhone = altJid.replace(/@.*/, '');
        }

        // 2. Query Baileys signalRepository LID to Phone (PN) mapping cache
        if (!realPhone) {
            try {
                if (sock?.signalRepository?.lidMapping?.getPNForLID) {
                    const pnJid = await sock.signalRepository.lidMapping.getPNForLID(remoteJid);
                    if (pnJid && typeof pnJid === 'string' && pnJid.endsWith('@s.whatsapp.net')) {
                        realPhone = pnJid.replace(/@.*/, '');
                    }
                }
            } catch (e) {
                // not yet in LID cache
            }
        }
    }

    const senderPhone = realPhone || remoteJid.replace(/@.*/, '');
    const senderName = pushName || (realPhone ? ('+' + realPhone) : 'WhatsApp User');

    return {
        senderPhone,
        realPhone,
        senderName,
        senderJID: remoteJid
    };
}

function extractMessageText(msg) {
    let m = msg.message;
    if (!m) return null;

    // Ephemeral / View Once / Edited unwrapping
    if (m.ephemeralMessage?.message) m = m.ephemeralMessage.message;
    if (m.viewOnceMessage?.message) m = m.viewOnceMessage.message;
    if (m.viewOnceMessageV2?.message) m = m.viewOnceMessageV2.message;
    if (m.viewOnceMessageV2Extension?.message) m = m.viewOnceMessageV2Extension.message;
    if (m.documentWithCaptionMessage?.message) m = m.documentWithCaptionMessage.message;
    if (m.editedMessage?.message?.protocolMessage?.editedMessage) m = m.editedMessage.message.protocolMessage.editedMessage;

    return (
        m.conversation ||
        m.extendedTextMessage?.text ||
        m.imageMessage?.caption ||
        m.videoMessage?.caption ||
        m.documentMessage?.caption ||
        m.buttonsResponseMessage?.selectedButtonId ||
        m.templateButtonReplyMessage?.selectedId ||
        m.interactiveResponseMessage?.body?.text ||
        null
    );
}

// ============================================
// NOTIFY PHP BACKEND
// ============================================
async function notifyPHPStatus(merchantId, event, data) {
    try {
        await fetch(`${getBackendUrl(merchantId)}/api/bridge_status.php?secret=${encodeURIComponent(BRIDGE_SECRET)}`, {
            method: 'POST',
            headers: {
                ...COMMON_HEADERS,
                'Content-Type': 'application/json',
                'X-Bridge-Secret': BRIDGE_SECRET,
            },
            body: JSON.stringify({
                merchant_id: String(merchantId),
                event,
                data,
                timestamp: Date.now(),
            }),
            signal: AbortSignal.timeout(10000),
        });
    } catch (err) {
        console.warn(`[Merchant ${merchantId}] Could not notify PHP status (${event}):`, err.message);
    }
}

function isContactSaved(session, senderJid, senderPhone) {
    if (!session || !session.contacts || session.contacts.size === 0) {
        return false;
    }

    const clean = String(senderPhone || '').replace(/[^0-9]/g, '');
    const candidates = [
        senderJid,
        clean + '@s.whatsapp.net',
        (clean.startsWith('0') ? '94' + clean.slice(1) : clean) + '@s.whatsapp.net',
    ];

    for (const jid of candidates) {
        if (!jid) continue;
        const c = session.contacts.get(jid);
        if (c && c.name && typeof c.name === 'string' && c.name.trim().length > 0) {
            return true;
        }
    }
    return false;
}

async function forwardMessageToPHP(merchantId, phone, name, messageText, messageId, sock, remoteJid, imageBase64 = null, mimeType = 'image/jpeg', isSavedContact = false) {
    try {
        const payload = {
            merchant_id: String(merchantId),
            phone,
            name,
            message: messageText,
            message_id: messageId,
            is_saved_contact: isSavedContact ? 1 : 0,
            timestamp: Date.now(),
        };
        if (imageBase64) {
            payload.image_base64 = imageBase64;
            payload.mime_type = mimeType;
        }

        let targetUrl = `${getBackendUrl(merchantId)}/api/bridge_receive.php?secret=${encodeURIComponent(BRIDGE_SECRET)}`;
        let response = await fetch(targetUrl, {
            method: 'POST',
            headers: {
                ...COMMON_HEADERS,
                'Content-Type': 'application/json',
                'X-Bridge-Secret': BRIDGE_SECRET,
            },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(35000),
        });

        // Fallback to root bridge_receive.php if 404
        if (response.status === 404) {
            console.warn(`[Merchant ${merchantId}] /api/bridge_receive.php was 404, falling back to root bridge_receive.php...`);
            targetUrl = `${getBackendUrl(merchantId)}/bridge_receive.php?secret=${encodeURIComponent(BRIDGE_SECRET)}`;
            response = await fetch(targetUrl, {
                method: 'POST',
                headers: {
                    ...COMMON_HEADERS,
                    'Content-Type': 'application/json',
                    'X-Bridge-Secret': BRIDGE_SECRET,
                },
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(35000),
            });
        }

        if (!response.ok) {
            console.error(`[Merchant ${merchantId}] PHP error: ${response.status}`, await response.text());
            return;
        }

        const result = await response.json();

        // If PHP returns a reply or image_url, send it out immediately via WhatsApp
        if (result && (result.reply || result.image_url) && sock) {
            const targetJid = remoteJid || formatJID(phone);

            // Fast natural typing indicator
            try {
                await sock.sendPresenceUpdate('composing', targetJid);
                await delay(200);
                await sock.sendPresenceUpdate('paused', targetJid);
            } catch (e) {
                // ignore presence error
            }

            let sentImage = false;
            if (result.image_url) {
                try {
                    await sock.sendMessage(targetJid, {
                        image: { url: result.image_url },
                        caption: result.reply || ''
                    });
                    sentImage = true;
                    console.log(`[Merchant ${merchantId}] 📸 Sent image reply to ${targetJid}: ${result.image_url}`);
                } catch (sendImgErr) {
                    console.warn(`[Merchant ${merchantId}] Image send failed (${sendImgErr.message}). Falling back to text...`);
                    if (targetJid && targetJid.includes('@lid') && phone) {
                        try {
                            const fallbackJid = formatJID(phone);
                            await sock.sendMessage(fallbackJid, {
                                image: { url: result.image_url },
                                caption: result.reply || ''
                            });
                            sentImage = true;
                            console.log(`[Merchant ${merchantId}] 📸 Image fallback sent to ${fallbackJid}`);
                        } catch (e2) {}
                    }
                }
            }

            // If image wasn't sent (or no image requested), send text reply
            if (!sentImage && result.reply) {
                try {
                    await sock.sendMessage(targetJid, { text: result.reply });
                    console.log(`[Merchant ${merchantId}] 📤 Sent text reply to ${targetJid}: ${result.reply.substring(0, 40)}...`);
                } catch (sendErr) {
                    console.warn(`[Merchant ${merchantId}] Failed to send to ${targetJid}, trying fallback:`, sendErr.message);
                    if (targetJid && targetJid.includes('@lid') && phone) {
                        try {
                            const fallbackJid = formatJID(phone);
                            await sock.sendMessage(fallbackJid, { text: result.reply });
                            console.log(`[Merchant ${merchantId}] 📤 Fallback sent to ${fallbackJid}`);
                        } catch (e3) {
                            console.error(`[Merchant ${merchantId}] All fallback text sends failed:`, e3.message);
                        }
                    }
                }
            }
        }

    } catch (err) {
        console.error(`[Merchant ${merchantId}] Error forwarding to PHP:`, err.message);
    }
}

// ============================================
// CORE: GET OR CREATE SESSION
// ============================================
const contactsDebounceTimers = new Map();
function scheduleContactsSave(merchantId, contactsMap) {
    const id = String(merchantId);
    if (contactsDebounceTimers.has(id)) {
        clearTimeout(contactsDebounceTimers.get(id));
    }
    const timer = setTimeout(async () => {
        contactsDebounceTimers.delete(id);
        const sessionDir = path.join(SESSIONS_BASE, `merchant_${id}`);
        if (!existsSync(sessionDir)) return;
        try {
            const obj = Object.fromEntries(contactsMap);
            await writeFile(path.join(sessionDir, 'contacts.json'), JSON.stringify(obj));
        } catch (e) {}
    }, 4000);
    contactsDebounceTimers.set(id, timer);
}

async function getOrCreateSession(merchantId) {
    const id = String(merchantId);
    if (sessions.has(id)) {
        return sessions.get(id);
    }

    const sessionData = {
        merchantId: id,
        sock: null,
        qrCodeData: null,
        lastQrTime: null,
        lastConnectAttempt: null,
        connectionState: 'disconnected', // disconnected | connecting | connected
        phone: null,
        reconnectTimer: null,
        contacts: new Map(),
    };

    sessions.set(id, sessionData);
    return sessionData;
}

// ============================================
// CLOUD PERSISTENCE HELPERS (MySQL Sync via PHP)
// ============================================
const syncDebounceTimers = new Map();

function scheduleCloudSync(merchantId) {
    const id = String(merchantId);
    if (syncDebounceTimers.has(id)) {
        clearTimeout(syncDebounceTimers.get(id));
    }
    const timer = setTimeout(async () => {
        syncDebounceTimers.delete(id);
        await syncSessionToCloud(id);
    }, 3500); // Debounce 3.5 seconds
    syncDebounceTimers.set(id, timer);
}

async function syncSessionToCloud(merchantId) {
    const id = String(merchantId);
    const sessionDir = path.join(SESSIONS_BASE, `merchant_${id}`);
    if (!existsSync(sessionDir)) return;

    try {
        const fileNames = await readdir(sessionDir);
        const filesObj = {};
        for (const f of fileNames) {
            const filePath = path.join(sessionDir, f);
            const content = await readFile(filePath);
            filesObj[f] = content.toString('base64');
        }

        if (Object.keys(filesObj).length === 0 || !filesObj['creds.json']) return;

        console.log(`[Merchant ${id}] 📤 Syncing ${Object.keys(filesObj).length} session files to cloud backup (${getBackendUrl(id)})...`);
        const res = await fetch(`${getBackendUrl(id)}/api/bridge_session_sync.php`, {
            method: 'POST',
            headers: {
                ...COMMON_HEADERS,
                'Content-Type': 'application/json',
                'X-Bridge-Secret': BRIDGE_SECRET,
            },
            body: JSON.stringify({
                action: 'save',
                merchant_id: String(id),
                files: filesObj,
            }),
            signal: AbortSignal.timeout(15000),
        });
        const result = await res.json();
        if (result && result.success) {
            console.log(`[Merchant ${id}] ☁️ Cloud backup synced successfully!`);
        }
    } catch (e) {
        console.warn(`[Merchant ${id}] Cloud sync error:`, e.message);
    }
}

async function restoreSessionFromCloud(merchantId) {
    const id = String(merchantId);
    const sessionDir = path.join(SESSIONS_BASE, `merchant_${id}`);

    try {
        console.log(`[Merchant ${id}] 📥 Checking cloud backup for saved credentials on ${getBackendUrl(id)}...`);
        const res = await fetch(`${getBackendUrl(id)}/api/bridge_session_sync.php?action=load&merchant_id=${id}`, {
            headers: {
                ...COMMON_HEADERS,
                'X-Bridge-Secret': BRIDGE_SECRET,
            },
            signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) return false;
        const data = await res.json();
        if (data && data.success && data.files && data.files['creds.json']) {
            if (!existsSync(sessionDir)) {
                await mkdir(sessionDir, { recursive: true });
            }
            for (const [fileName, base64Content] of Object.entries(data.files)) {
                const filePath = path.join(sessionDir, fileName);
                const buf = Buffer.from(base64Content, 'base64');
                await writeFile(filePath, buf);
            }
            console.log(`[Merchant ${id}] ✅ Restored ${Object.keys(data.files).length} session files from ${getBackendUrl(id)}!`);
            return true;
        }
    } catch (e) {
        console.warn(`[Merchant ${id}] Cloud restore probe failed on ${getBackendUrl(id)}:`, e.message);
    }
    return false;
}

async function deleteSessionFromCloud(merchantId) {
    const id = String(merchantId);
    try {
        await fetch(`${getBackendUrl(id)}/api/bridge_session_sync.php`, {
            method: 'POST',
            headers: {
                ...COMMON_HEADERS,
                'Content-Type': 'application/json',
                'X-Bridge-Secret': BRIDGE_SECRET,
            },
            body: JSON.stringify({
                action: 'delete',
                merchant_id: String(id),
            }),
            signal: AbortSignal.timeout(8000),
        });
    } catch (e) {}
}

// ============================================
// CONNECT SESSION TO WHATSAPP
// ============================================
async function connectSession(merchantId) {
    const session = await getOrCreateSession(merchantId);
    const id = session.merchantId;
    const sessionDir = path.join(SESSIONS_BASE, `merchant_${id}`);

    // If already connected with an active socket, return current session
    if (session.connectionState === 'connected' && session.sock) {
        return session;
    }

    // Concurrency guard: If currently connecting and has an active socket within last 45s, do NOT restart socket!
    if (session.connectionState === 'connecting' && session.sock) {
        const attemptAge = Date.now() - (session.lastConnectAttempt || 0);
        if (attemptAge < 45000) {
            console.log(`[Merchant ${id}] ⏳ Connection already in progress (${Math.round(attemptAge / 1000)}s ago). Reusing existing socket.`);
            return session;
        }
    }

    // Safely tear down any previous hanging socket before starting a fresh one
    if (session.sock) {
        try {
            console.log(`[Merchant ${id}] 🧹 Cleaning up previous socket...`);
            session.sock.ev.removeAllListeners();
            session.sock.end(undefined);
        } catch (e) {}
        session.sock = null;
    }

    clearTimeout(session.reconnectTimer);

    if (!existsSync(sessionDir)) {
        await mkdir(sessionDir, { recursive: true });
    }

    // If local creds are missing (e.g. after Render container restart), restore from MySQL cloud backup
    if (!existsSync(path.join(sessionDir, 'creds.json'))) {
        await restoreSessionFromCloud(id);
    }

    // Load local contacts cache if present
    const contactsFile = path.join(sessionDir, 'contacts.json');
    if (existsSync(contactsFile) && (!session.contacts || session.contacts.size === 0)) {
        try {
            const rawContacts = await readFile(contactsFile, 'utf8');
            const parsed = JSON.parse(rawContacts);
            session.contacts = new Map(Object.entries(parsed));
            console.log(`[Merchant ${id}] 📇 Loaded ${session.contacts.size} cached contacts from disk`);
        } catch (e) {}
    }

    console.log(`[Merchant ${id}] 🔄 Connecting session...`);
    session.connectionState = 'connecting';
    session.lastConnectAttempt = Date.now();

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version }          = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        logger,
        auth: state,
        browser: Browsers.ubuntu('Chrome'),
        printQRInTerminal: false,
        syncFullHistory: false,
        generateHighQualityLinkPreview: false,
        retryRequestDelayMs: 2500,
        maxMsgRetryCount: 5,
        markOnlineOnConnect: false,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 25000,
    });

    session.sock = sock;

    // ==========================================
    // Event: Connection Update
    // ==========================================
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log(`[Merchant ${id}] 📱 New QR code generated`);
            session.connectionState = 'connecting';
            session.lastQrTime = Date.now();
            try {
                session.qrCodeData = await qrcode.toDataURL(qr);
                await notifyPHPStatus(id, 'qr_update', { qr_base64: session.qrCodeData });
            } catch (qrErr) {
                console.error(`[Merchant ${id}] QR encode error:`, qrErr);
            }
        }

        if (connection === 'close') {
            session.connectionState = 'disconnected';
            session.qrCodeData = null;

            const statusCode = lastDisconnect?.error?.output?.statusCode || lastDisconnect?.error?.statusCode || null;
            console.log(`[Merchant ${id}] ❌ Connection closed. Code: ${statusCode}`);
            addDebugLog(`[Merchant ${id}] ❌ Connection closed. Code: ${statusCode}`);

            if (statusCode === DisconnectReason.loggedOut) {
                console.log(`[Merchant ${id}] 🚪 Logged out event from WhatsApp. Clearing local directory.`);
                session.phone = null;
                await notifyPHPStatus(id, 'disconnected', { reason: 'logged_out' });
                // Clean auth directory for fresh start, but preserve cloud backup so it is only deleted on deliberate user logout
                try {
                    await rm(sessionDir, { recursive: true, force: true });
                } catch (e) {}
            } else if (statusCode === DisconnectReason.connectionReplaced) {
                console.log(`[Merchant ${id}] 📱 Connection replaced by another session.`);
                await notifyPHPStatus(id, 'disconnected', { reason: 'replaced' });
            } else if (statusCode === DisconnectReason.restartRequired || statusCode === 515) {
                console.log(`[Merchant ${id}] 🔄 Restart required (Pairing handshake complete). Reconnecting immediately...`);
                clearTimeout(session.reconnectTimer);
                session.reconnectTimer = setTimeout(() => connectSession(id), 500);
            } else {
                // Auto reconnect after 3s
                console.log(`[Merchant ${id}] 🔄 Reconnecting in 3 seconds...`);
                clearTimeout(session.reconnectTimer);
                session.reconnectTimer = setTimeout(() => connectSession(id), 3000);
            }

        } else if (connection === 'open') {
            session.connectionState = 'connected';
            session.qrCodeData = null;
            session.phone = sock.user?.id ? sock.user.id.split(':')[0] : null;
            addDebugLog(`[Merchant ${id}] ✅ WhatsApp Connected! Number: +${session.phone}`);

            // Ensure creds are marked registered if authenticated
            if (sock.authState?.creds && !sock.authState.creds.registered) {
                sock.authState.creds.registered = true;
                try { await saveCreds(); } catch (e) {}
            }

            await notifyPHPStatus(id, 'connected', {
                phone: session.phone,
                name: sock.user?.name || null,
            });

            // Ensure credentials are backed up immediately after successful link
            scheduleCloudSync(id);
        }
    });

    // ==========================================
    // Event: Save Credentials (Local + Cloud Backup)
    // ==========================================
    sock.ev.on('creds.update', async () => {
        await saveCreds();
        scheduleCloudSync(id);
    });

    // ==========================================
    // Event: Sync Contacts (Address Book Detection)
    // ==========================================
    sock.ev.on('contacts.upsert', (contactsList) => {
        for (const c of contactsList) {
            if (!c || !c.id) continue;
            const existing = session.contacts.get(c.id) || {};
            session.contacts.set(c.id, { ...existing, ...c });
        }
        scheduleContactsSave(id, session.contacts);
    });

    sock.ev.on('contacts.update', (updatesList) => {
        for (const u of updatesList) {
            if (!u || !u.id) continue;
            const existing = session.contacts.get(u.id) || {};
            session.contacts.set(u.id, { ...existing, ...u });
        }
        scheduleContactsSave(id, session.contacts);
    });

    // ==========================================
    // Event: Incoming Messages
    // ==========================================
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        for (const msg of messages) {
            const senderJid = msg.key?.remoteJid || 'unknown';
            if (msg.key.fromMe) {
                // Outbound message from own phone, ignore
                continue;
            }
            if (senderJid === 'status@broadcast' || senderJid.endsWith('@g.us')) {
                continue;
            }

            addDebugLog(`[Merchant ${id}] 📩 Incoming message event from ${senderJid} (type: ${type})`);

            // If message was received via 'append' (offline sync upon reconnecting), ignore only if older than 15 mins
            if (type === 'append') {
                const nowSec = Math.floor(Date.now() / 1000);
                const msgSec = Number(msg.messageTimestamp || 0);
                const ageSec = nowSec - msgSec;
                if (msgSec > 0 && ageSec > 900) {
                    addDebugLog(`[Merchant ${id}] Skipped old append message (age: ${ageSec}s)`);
                    continue; // Skip ancient history messages
                }
            }

            if (!msg.message) {
                addDebugLog(`[Merchant ${id}] ⚠️ Received message without payload from ${senderJid} (stubType: ${msg.messageStubType || 'none'})`);
                continue;
            }

            let imageBase64 = null;
            let mimeType = 'image/jpeg';
            if (msg.message?.imageMessage) {
                try {
                    const buffer = await downloadMediaMessage(msg, 'buffer', {});
                    imageBase64 = buffer.toString('base64');
                    mimeType = msg.message.imageMessage.mimetype || 'image/jpeg';
                } catch (imgErr) {
                    addDebugLog(`[Merchant ${id}] Failed to download media image: ${imgErr.message}`);
                }
            }

            const messageText = extractMessageText(msg) || (imageBase64 ? 'Customer sent an image. Please inspect it.' : null);
            if (!messageText && !imageBase64) {
                addDebugLog(`[Merchant ${id}] ⚠️ extractMessageText was null for keys: ${Object.keys(msg.message).join(', ')}`);
                continue;
            }

            const { senderPhone, senderName, senderJID } = await resolveSenderInfo(sock, msg);

            const isSaved = isContactSaved(session, senderJID, senderPhone);
            addDebugLog(`[Merchant ${id}] 💬 Processing from ${senderName} (${senderPhone}) [Saved: ${isSaved ? 'YES' : 'NO'}]: "${messageText}"`);

            await forwardMessageToPHP(id, senderPhone, senderName, messageText, msg.key.id, sock, senderJID, imageBase64, mimeType, isSaved);
        }
    });

    return session;
}

// ============================================
// DISCONNECT / LOGOUT SESSION
// ============================================
async function disconnectSession(merchantId) {
    const id = String(merchantId);
    if (sessions.has(id)) {
        const session = sessions.get(id);
        clearTimeout(session.reconnectTimer);

        try {
            if (session.sock) {
                session.sock.ev.removeAllListeners();
                await session.sock.logout();
            }
        } catch (e) {
            // ignore
        }

        session.connectionState = 'disconnected';
        session.qrCodeData = null;
        session.phone = null;
        session.sock = null;
        sessions.delete(id);
    }

    const sessionDir = path.join(SESSIONS_BASE, `merchant_${id}`);
    try {
        await rm(sessionDir, { recursive: true, force: true });
    } catch (e) {}

    // Explicit user logout: clear cloud backup in MySQL
    await deleteSessionFromCloud(id);
    await notifyPHPStatus(id, 'disconnected', { reason: 'user_logout' });
    addDebugLog(`[Merchant ${id}] Session cleanly disconnected and wiped.`);
    return true;
}

// ============================================
// EXPRESS API SERVER
// ============================================
const app = express();
app.use(express.json());

// Auth Middleware (Cleora Dedicated)
const verifySecret = (req, res, next) => {
    const secret = req.headers['x-bridge-secret'] || req.query.secret;
    const allowed = [BRIDGE_SECRET, 'cleora_baileys_secret_2026'];
    if (!allowed.includes(secret)) {
        return res.status(403).json({ error: 'Unauthorized: Invalid bridge secret' });
    }
    next();
};

/**
 * Health check & Ping (Used by Render keep-alive)
 */
app.get('/', (req, res) => {
    res.json({
        service: 'WhatsApp Baileys Multi-Merchant Bridge',
        version: '2.0.0',
        activeSessions: Array.from(sessions.entries()).map(([mId, s]) => ({
            merchant_id: mId,
            status: s.connectionState,
            phone: s.phone,
        })),
    });
});

app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

app.get('/session/:merchantId/debug-logs', verifySecret, (req, res) => {
    const { merchantId } = req.params;
    res.json({
        success: true,
        merchant_id: merchantId,
        logs: debugLogs
    });
});

/**
 * GET /session/:merchantId/status
 * Get connection state and QR code for a specific merchant
 */
app.get('/session/:merchantId/status', verifySecret, async (req, res) => {
    const { merchantId } = req.params;
    const session = await getOrCreateSession(merchantId);

    // Auto-reconnect if session is disconnected and not currently attempting
    if (session.connectionState === 'disconnected') {
        const timeSinceAttempt = Date.now() - (session.lastConnectAttempt || 0);
        if (timeSinceAttempt > 30000) {
            console.log(`[Merchant ${merchantId}] 🔄 Session disconnected during status check. Triggering auto-reconnect...`);
            connectSession(merchantId).catch(err => {
                console.warn(`[Merchant ${merchantId}] Auto-reconnect on status check:`, err.message);
            });
        }
    }

    res.json({
        merchant_id: merchantId,
        state: session.connectionState,
        phone: session.phone,
        qr: session.connectionState === 'connecting' ? session.qrCodeData : null,
    });
});

/**
 * POST /session/:merchantId/connect
 * Initiate WhatsApp connection / QR generation for a specific merchant
 */
app.post('/session/:merchantId/connect', verifySecret, async (req, res) => {
    const { merchantId } = req.params;
    const session = await connectSession(merchantId);

    // If QR is initializing and not ready yet, wait up to 3.5 seconds for it to arrive
    if (!session.qrCodeData && session.connectionState === 'connecting') {
        for (let i = 0; i < 18; i++) {
            await delay(200);
            if (session.qrCodeData || session.connectionState === 'connected') break;
        }
    }

    res.json({
        success: true,
        merchant_id: merchantId,
        state: session.connectionState,
        phone: session.phone,
        qr: session.qrCodeData,
    });
});

/**
 * POST /session/:merchantId/pairing-code
 * Request an 8-digit WhatsApp pairing code for linking without camera
 * Body: { phoneNumber: "94786800086" }
 */
app.post('/session/:merchantId/pairing-code', verifySecret, async (req, res) => {
    const { merchantId } = req.params;
    let { phoneNumber } = req.body;

    if (!phoneNumber) {
        return res.status(400).json({ success: false, error: 'phoneNumber is required' });
    }

    // Clean phone number: keep only digits
    let cleanPhone = String(phoneNumber).replace(/[^0-9]/g, '');
    if (cleanPhone.startsWith('0')) {
        cleanPhone = '94' + cleanPhone.slice(1);
    }
    if (cleanPhone.startsWith('+')) {
        cleanPhone = cleanPhone.slice(1);
    }
    if (cleanPhone.length === 9 && !cleanPhone.startsWith('94')) {
        cleanPhone = '94' + cleanPhone;
    }

    try {
        // If there is an existing incomplete or connecting session, reset it so pairing code gets a clean fresh socket
        if (sessions.has(merchantId)) {
            const currentSession = sessions.get(merchantId);
            if (currentSession.connectionState === 'connected') {
                return res.json({
                    success: true,
                    already_connected: true,
                    state: 'connected',
                    phone: currentSession.phone
                });
            }
            await disconnectSession(merchantId);
        }

        const session = await connectSession(merchantId);

        if (session.connectionState === 'connected') {
            return res.json({
                success: true,
                already_connected: true,
                state: 'connected',
                phone: session.phone
            });
        }

        if (!session.sock) {
            return res.status(500).json({ success: false, error: 'Socket initialization failed' });
        }

        // Wait up to 5 seconds for socket authState to be ready
        for (let i = 0; i < 25; i++) {
            if (session.sock.authState && session.sock.authState.creds) break;
            await delay(200);
        }

        if (session.sock.authState && session.sock.authState.creds && session.sock.authState.creds.registered) {
            return res.json({
                success: true,
                already_connected: true,
                state: 'connected',
                phone: session.phone
            });
        }

        // Wait up to 6 seconds for websocket connection to be active
        for (let i = 0; i < 20; i++) {
            if (session.sock.ws && session.sock.ws.readyState === 1) break;
            await delay(300);
        }
        await delay(1200);

        console.log(`[Merchant ${merchantId}] 🔢 Requesting Baileys pairing code for phone: ${cleanPhone}...`);
        let rawCode;
        try {
            rawCode = await session.sock.requestPairingCode(cleanPhone);
        } catch (initialErr) {
            console.warn(`[Merchant ${merchantId}] First pairing code attempt failed (${initialErr.message}). Retrying in 2s...`);
            await delay(2000);
            rawCode = await session.sock.requestPairingCode(cleanPhone);
        }
        
        // Format code as XXXX-XXXX if it is an 8-char string
        let formattedCode = rawCode;
        if (rawCode && rawCode.length === 8) {
            formattedCode = rawCode.slice(0, 4) + '-' + rawCode.slice(4);
        }

        console.log(`[Merchant ${merchantId}] ✅ Pairing code generated: ${formattedCode}`);

        res.json({
            success: true,
            pairing_code: formattedCode,
            raw_code: rawCode,
            phone: cleanPhone,
            expires_in_seconds: 120
        });

    } catch (err) {
        console.error(`[Merchant ${merchantId}] ❌ Pairing code error:`, err);
        res.status(500).json({
            success: false,
            error: err.message || 'Failed to request pairing code'
        });
    }
});

/**
 * POST /session/:merchantId/disconnect
 * Disconnect or Logout a merchant's WhatsApp
 */
app.post('/session/:merchantId/disconnect', verifySecret, async (req, res) => {
    const { merchantId } = req.params;
    await disconnectSession(merchantId);
    res.json({ success: true, merchant_id: merchantId, state: 'disconnected' });
});

/**
 * POST /session/:merchantId/reset
 * Fully wipe local session & cloud backup to cleanly recover from any corrupted Signal keys
 */
app.post('/session/:merchantId/reset', verifySecret, async (req, res) => {
    const { merchantId } = req.params;
    await disconnectSession(merchantId);
    res.json({ success: true, merchant_id: merchantId, state: 'disconnected', message: 'Session wiped cleanly' });
});

/**
 * POST /session/:merchantId/send
 * Send a message via a specific merchant's WhatsApp
 * Body: { phone: "94786800086", message: "Hello!" }
 */
app.post('/session/:merchantId/send', verifySecret, async (req, res) => {
    const { merchantId } = req.params;
    const { phone, message } = req.body;

    if (!phone || !message) {
        return res.status(400).json({ error: 'phone and message are required' });
    }

    const session = sessions.get(String(merchantId));
    if (!session || session.connectionState !== 'connected' || !session.sock) {
        return res.status(503).json({ error: `WhatsApp for merchant ${merchantId} is not connected` });
    }

    try {
        const jid = formatJID(phone);

        // Typing simulation
        try {
            await session.sock.sendPresenceUpdate('composing', jid);
            await delay(400 + Math.random() * 600);
            await session.sock.sendPresenceUpdate('paused', jid);
        } catch (e) {}

        const sendResult = await session.sock.sendMessage(jid, { text: message });
        res.json({ success: true, messageId: sendResult.key?.id, to: jid });
    } catch (err) {
        console.error(`[Merchant ${merchantId}] Send error:`, err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /send-message (Unified alias endpoint)
 * Body: { merchant_id: 1, phone: "94786800086", message: "Hello!" }
 */
app.post('/send-message', verifySecret, async (req, res) => {
    const merchantId = req.body.merchant_id || req.body.merchantId;
    const { phone, message } = req.body;

    if (!merchantId || !phone || !message) {
        return res.status(400).json({ error: 'merchant_id, phone and message are required' });
    }

    const session = sessions.get(String(merchantId));
    if (!session || session.connectionState !== 'connected' || !session.sock) {
        return res.status(503).json({ error: `WhatsApp for merchant ${merchantId} is not connected` });
    }

    try {
        const jid = formatJID(phone);
        try {
            await session.sock.sendPresenceUpdate('composing', jid);
            await delay(400 + Math.random() * 600);
            await session.sock.sendPresenceUpdate('paused', jid);
        } catch (e) {}

        const sendResult = await session.sock.sendMessage(jid, { text: message });
        res.json({ success: true, messageId: sendResult.key?.id, to: jid });
    } catch (err) {
        console.error(`[Merchant ${merchantId}] Send error:`, err);
        res.status(500).json({ error: err.message });
    }
});

// ============================================
// AUTO RESTORE EXISTING SESSIONS ON STARTUP
// ============================================
async function restoreSessions() {
    const restoredIds = new Set();
    try {
        // 1. Restore from local disk if folders exist
        if (existsSync(SESSIONS_BASE)) {
            const dirs = await readdir(SESSIONS_BASE, { withFileTypes: true });
            for (const dir of dirs) {
                if (dir.isDirectory() && dir.name.startsWith('merchant_')) {
                    const merchantId = dir.name.replace('merchant_', '');
                    restoredIds.add(String(merchantId));
                    console.log(`[Startup] Restoring local session for merchant ${merchantId}...`);
                    connectSession(merchantId).catch(err => {
                        console.error(`[Startup] Failed to restore merchant ${merchantId}:`, err.message);
                    });
                }
            }
        }

        // 2. Query PHP backend for active merchants with saved backups
        try {
            const activeRes = await fetch(`${PHP_BACKEND_URL}/api/bridge_session_sync.php?action=list_active`, {
                headers: { 'X-Bridge-Secret': BRIDGE_SECRET },
                signal: AbortSignal.timeout(10000),
            });
            if (activeRes.ok) {
                const activeData = await activeRes.json();
                if (activeData && activeData.success && Array.isArray(activeData.merchants)) {
                    for (const mId of activeData.merchants) {
                        const idStr = String(mId);
                        if (!restoredIds.has(idStr)) {
                            restoredIds.add(idStr);
                            console.log(`[Startup] Restoring cloud-backed session for merchant ${idStr}...`);
                            connectSession(idStr).catch(err => {
                                console.error(`[Startup] Failed to restore cloud merchant ${idStr}:`, err.message);
                            });
                        }
                    }
                }
            }
        } catch (cloudErr) {
            console.warn('[Startup] Cloud active sessions check:', cloudErr.message);
        }

        // 3. Always ensure primary cleora is reconnected on startup
        if (!restoredIds.has('cleora')) {
            console.log('[Startup] Auto-checking primary merchant cleora...');
            connectSession('cleora').catch(err => {
                console.warn('[Startup] cleora auto-connect:', err.message);
            });
        }

    } catch (err) {
        console.warn('[Startup] Error restoring sessions:', err.message);
    }
}

// Start Server
app.listen(PORT, async () => {
    console.log(`===============================================`);
    console.log(`🚀 Baileys Multi-Merchant Bridge running on :${PORT}`);
    console.log(`📡 Connected PHP Backend: ${PHP_BACKEND_URL}`);
    console.log(`===============================================`);
    await restoreSessions();

    // Keepalive self-ping every 8 minutes to prevent Render free-tier containers from spinning down
    setInterval(async () => {
        try {
            const selfUrl = process.env.RENDER_EXTERNAL_URL ? `${process.env.RENDER_EXTERNAL_URL}/health` : 'https://cleora-whatsapp-bridge.onrender.com/health';
            await fetch(selfUrl, { signal: AbortSignal.timeout(5000) });
            // Also keep alive PHP backend
            await fetch(`${PHP_BACKEND_URL}/api/cron_keepalive.php`, { signal: AbortSignal.timeout(8000) });
        } catch (e) {}
    }, 8 * 60 * 1000);
});

// Suppress unhandled libsignal background companion history decryption noise
process.on('unhandledRejection', (reason) => {
    const msg = String(reason?.message || reason || '');
    if (msg.includes('Bad MAC') || msg.includes('decrypt message') || msg.includes('Session error')) {
        return;
    }
    console.warn('Unhandled rejection:', msg);
});

process.on('uncaughtException', (err) => {
    const msg = String(err?.message || err || '');
    if (msg.includes('Bad MAC') || msg.includes('decrypt message') || msg.includes('Session error')) {
        return;
    }
    console.error('Uncaught exception:', err);
});
