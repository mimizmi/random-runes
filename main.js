const { app, BrowserWindow, ipcMain, Menu  } = require('electron');
const path = require('path');
const { authenticate, createHttp1Request } = require('league-connect');
const https = require('https');
const crypto = require('crypto');
const WebSocket = require('ws');
const net = require('net');
const zlib = require('zlib');

let mainWindow;

// === Danmaku (Bilibili) Logic ===
const danmakuState = {
    client: null,
    roomId: null,
    status: 'disconnected',
    lastError: '',
    reconnectTimer: null,
    reconnectAttempts: 0,
    manualClose: false,
    config: {
        voteDurationSec: 20,
        actionCooldownMs: 8000,
        startVoteCooldownMs: 20000,
        voteUpdateThrottleMs: 300,
        cookie: ''
    }
};

let voteState = {
    active: false,
    endsAt: 0,
    timer: null,
    counts: { one: 0, two: 0, three: 0 },
    voters: new Set(),
    lastUpdateTs: 0
};

const actionCooldownMap = new Map(); // uid -> ts
let lastGlobalActionTs = 0;
let lastVoteStartTs = 0;

function sendToRenderer(channel, payload) {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(channel, payload);
    }
}

function setDanmakuAuthState(ok, mid = 0, message = '') {
    sendToRenderer('danmaku-auth', {
        ok: !!ok,
        mid: Number(mid) || 0,
        message: message || '',
        ts: Date.now()
    });
}

const DANMAKU_DEBUG = false;
function sendDiag(message) {
    if (!DANMAKU_DEBUG) return;
    sendToRenderer('danmaku-diagnostic', { message, ts: Date.now() });
}

function encodeDanmakuPacket(op, bodyObj = null, ver = 1) {
    let bodyBuf = Buffer.alloc(0);
    if (bodyObj !== null && bodyObj !== undefined) {
        const text = typeof bodyObj === 'string' ? bodyObj : JSON.stringify(bodyObj);
        bodyBuf = Buffer.from(text, 'utf8');
    }
    const packetLen = 16 + bodyBuf.length;
    const buf = Buffer.alloc(packetLen);
    buf.writeUInt32BE(packetLen, 0);
    buf.writeUInt16BE(16, 4);
    buf.writeUInt16BE(ver, 6);
    buf.writeUInt32BE(op, 8);
    buf.writeUInt32BE(1, 12);
    if (bodyBuf.length > 0) bodyBuf.copy(buf, 16);
    return buf;
}

function decodeDanmakuBuffer(buffer) {
    const packets = [];
    let offset = 0;
    while (offset + 16 <= buffer.length) {
        const packetLen = buffer.readUInt32BE(offset);
        if (packetLen <= 0 || offset + packetLen > buffer.length) break;
        const headLen = buffer.readUInt16BE(offset + 4);
        const ver = buffer.readUInt16BE(offset + 6);
        const op = buffer.readUInt32BE(offset + 8);
        const bodyBuf = buffer.slice(offset + headLen, offset + packetLen);

        if (ver === 2 || ver === 3) {
            try {
                const decompressed = ver === 2
                    ? zlib.inflateSync(bodyBuf)
                    : zlib.brotliDecompressSync(bodyBuf);
                const nested = decodeDanmakuBuffer(decompressed);
                packets.push(...nested.packets);
            } catch (e) {
                packets.push({ op, ver, body: null, raw: bodyBuf });
            }
        } else {
            let body = null;
            if (op === 3 && bodyBuf.length >= 4) {
                body = bodyBuf.readUInt32BE(0);
            } else if (bodyBuf.length > 0) {
                const text = bodyBuf.toString('utf8');
                try {
                    body = JSON.parse(text);
                } catch {
                    body = text;
                }
            }
            packets.push({ op, ver, body, raw: bodyBuf });
        }

        offset += packetLen;
    }
    return { packets, remaining: buffer.slice(offset) };
}

function normalizeCookie(raw) {
    const c = (raw || '').trim();
    if (!c) return '';
    let cookie = c;
    if (!cookie.includes('SESSDATA=')) {
        // Treat raw value as SESSDATA
        cookie = `SESSDATA=${cookie}`;
    }
    return cookie;
}

function cookieKeys(cookie) {
    if (!cookie) return [];
    return cookie.split(';').map(s => s.trim().split('=')[0]).filter(Boolean);
}

function requestJson(url, headers = {}, timeoutMs = 6000) {
    return new Promise((resolve, reject) => {
        const req = https.request(url, { headers }, (res) => {
            let raw = '';
            res.setEncoding('utf8');
            res.on('data', (d) => raw += d);
            res.on('end', () => {
                let json = null;
                if (raw.trim()) {
                    try {
                        json = JSON.parse(raw);
                    } catch (e) {
                        reject(new Error(`JSON parse error: ${e.message || e}`));
                        return;
                    }
                }
                resolve({ statusCode: res.statusCode, json, raw, headers: res.headers });
            });
        });
        req.on('error', (e) => reject(e));
        req.setTimeout(timeoutMs, () => req.destroy(new Error('request timeout')));
        req.end();
    });
}

// --- QR login cookie helpers (pure, keep side-effect free) ---
// B 站扫码登录在 data.code === 0 时通过响应的 Set-Cookie 下发登录态
// （SESSDATA / bili_jct / DedeUserID / DedeUserID__ckMd5），不再保证 data.url 里带参数。
// 两种来源都接受，Set-Cookie 优先。
const QR_LOGIN_COOKIE_ORDER = [
    'SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5',
    'buvid3', 'buvid4', 'b_nut', 'b_lsid', 'sid', 'bili_ticket'
];
const QR_LOGIN_COOKIE_IGNORE = new Set([
    'CURRENT_FNVAL', 'CURRENT_QUALITY', 'header_theme_version', 'home_feed_column',
    'buvid_fp', 'buvid_fp_plain', 'PVID', 'LIVE_BUVID', 'fingerprint', 'fingerprint3'
]);

function parseSetCookieHeaders(setCookieRaw) {
    const map = new Map();
    if (!setCookieRaw) return map;
    const lines = Array.isArray(setCookieRaw) ? setCookieRaw : [setCookieRaw];
    for (const line of lines) {
        if (typeof line !== 'string') continue;
        // Each Set-Cookie line is one cookie; only the first name=value pair is the value.
        const pair = line.split(';')[0];
        const eq = pair.indexOf('=');
        if (eq <= 0) continue;
        const name = pair.slice(0, eq).trim();
        const value = pair.slice(eq + 1).trim();
        if (!name || !value || value.toLowerCase() === 'deleted') continue;
        map.set(name, value);
    }
    return map;
}

function extractCookieFromQrLoginUrl(loginUrl) {
    if (!loginUrl || typeof loginUrl !== 'string') return '';
    const keySet = new Set(['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5']);
    const candidates = [loginUrl];
    // Some responses hand back the whole login URL percent-encoded.
    if (/^https?%3A/i.test(loginUrl)) {
        try { candidates.push(decodeURIComponent(loginUrl)); } catch { /* ignore */ }
    }
    for (const candidate of candidates) {
        const query = candidate.includes('?') ? candidate.slice(candidate.indexOf('?') + 1) : '';
        if (!query) continue;
        const cookieParts = [];
        for (const part of query.split('&')) {
            if (!part) continue;
            const eq = part.indexOf('=');
            if (eq <= 0) continue;
            const k = part.slice(0, eq);
            const v = part.slice(eq + 1);
            if (!keySet.has(k) || !v) continue;
            cookieParts.push(`${k}=${v}`);
        }
        if (cookieParts.length) return cookieParts.join('; ');
    }
    return '';
}

function mergeCookieSources(primaryRaw, fallbackRaw) {
    const map = new Map();
    const add = (raw) => {
        if (!raw) return;
        for (const part of String(raw).split(';')) {
            const pair = part.trim();
            const eq = pair.indexOf('=');
            if (eq <= 0) continue;
            const name = pair.slice(0, eq).trim();
            const value = pair.slice(eq + 1).trim();
            if (!name || !value) continue;
            // Primary (Set-Cookie) wins; fallback only fills gaps.
            if (!map.has(name)) map.set(name, value);
        }
    };
    add(primaryRaw);
    add(fallbackRaw);
    return map;
}

function stringifyCookieMap(map) {
    if (!map || map.size === 0) return '';
    const parts = [];
    const seen = new Set();
    for (const name of QR_LOGIN_COOKIE_ORDER) {
        if (!map.has(name)) continue;
        parts.push(`${name}=${map.get(name)}`);
        seen.add(name);
    }
    for (const [name, value] of map) {
        if (seen.has(name) || QR_LOGIN_COOKIE_IGNORE.has(name)) continue;
        parts.push(`${name}=${value}`);
    }
    return parts.join('; ');
}

function cookieHasKey(cookie, key) {
    if (!cookie) return false;
    return new RegExp(`(?:^|;\\s*)${key}=`).test(cookie);
}

function buildQrLoginCookie(resHeaders, fallbackUrl) {
    const setCookieMap = parseSetCookieHeaders(resHeaders && (resHeaders['set-cookie'] || resHeaders['Set-Cookie']));
    const setCookieRaw = stringifyCookieMap(setCookieMap);
    const urlCookie = extractCookieFromQrLoginUrl(fallbackUrl || '')
        || extractCookieFromQrLoginUrl((resHeaders && resHeaders.location) || '');
    return stringifyCookieMap(mergeCookieSources(setCookieRaw, urlCookie));
}
// --- end QR login cookie helpers ---

function fetchBuvidCookies() {
    return requestJson('https://api.bilibili.com/x/frontend/finger/spi', {
        'User-Agent': 'Mozilla/5.0',
        'Referer': 'https://www.bilibili.com/',
        'Accept': 'application/json, text/plain, */*'
    }, 4000).then(({ json }) => {
        const data = json && json.code === 0 ? json.data : null;
        const pairs = [];
        if (data && data.b_3) pairs.push(`buvid3=${data.b_3}`);
        if (data && data.b_4) pairs.push(`buvid4=${data.b_4}`);
        return pairs.join('; ');
    }).catch(() => '');
}

async function finishQrLogin(cookie) {
    if (!cookieHasKey(cookie, 'buvid3')) {
        // buvid3 is not part of the login handshake but some live endpoints expect a device id.
        const buvid = await fetchBuvidCookies();
        if (buvid) cookie = stringifyCookieMap(mergeCookieSources(cookie, buvid));
    }
    danmakuState.config.cookie = cookie;
    const midMatch = cookie.match(/(?:^|;\s*)DedeUserID=([^;]+)/);
    const mid = midMatch ? Number(midMatch[1]) || 0 : 0;
    if (mid > 0) {
        setDanmakuAuthState(true, mid, '扫码登录成功');
    } else {
        setDanmakuAuthState(false, 0, '扫码登录成功，请重新连接校验');
    }
    return { success: true, state: 'confirmed', message: '扫码登录成功', cookie, mid };
}

function setDanmakuStatus(status, message = '') {
    danmakuState.status = status;
    danmakuState.lastError = message || '';
    sendToRenderer('danmaku-status', {
        status,
        message: message || '',
        roomId: danmakuState.roomId || null
    });
}

function clearVoteTimer() {
    if (voteState.timer) {
        clearTimeout(voteState.timer);
        voteState.timer = null;
    }
}

function resetVoteState() {
    clearVoteTimer();
    voteState = {
        active: false,
        endsAt: 0,
        timer: null,
        counts: { one: 0, two: 0, three: 0 },
        voters: new Set(),
        lastUpdateTs: 0
    };
}

function startVote(trigger = 'manual') {
    const now = Date.now();
    if (voteState.active) return false;
    if (now - lastVoteStartTs < danmakuState.config.startVoteCooldownMs) return false;
    lastVoteStartTs = now;

    resetVoteState();
    voteState.active = true;
    voteState.endsAt = now + danmakuState.config.voteDurationSec * 1000;
    voteState.timer = setTimeout(endVote, danmakuState.config.voteDurationSec * 1000);

    sendToRenderer('danmaku-vote-start', {
        endsAt: voteState.endsAt,
        counts: voteState.counts,
        probabilities: calculateVoteProbabilities(voteState.counts),
        trigger
    });
    return true;
}

function calculateVoteProbabilities(countsRaw) {
    const counts = {
        one: Math.max(0, Number(countsRaw && countsRaw.one) || 0),
        two: Math.max(0, Number(countsRaw && countsRaw.two) || 0),
        three: Math.max(0, Number(countsRaw && countsRaw.three) || 0)
    };
    const total = counts.one + counts.two + counts.three;
    if (total <= 0) {
        return { one: 33.33, two: 33.33, three: 33.34 };
    }
    return {
        one: counts.one * 100 / total,
        two: counts.two * 100 / total,
        three: counts.three * 100 / total
    };
}

function pickWinnerByProbability(countsRaw) {
    const counts = {
        one: Math.max(0, Number(countsRaw && countsRaw.one) || 0),
        two: Math.max(0, Number(countsRaw && countsRaw.two) || 0),
        three: Math.max(0, Number(countsRaw && countsRaw.three) || 0)
    };
    const total = counts.one + counts.two + counts.three;
    if (total <= 0) {
        const index = 1 + Math.floor(Math.random() * 3);
        return { index, roll: Math.random(), totalWeight: 3 };
    }
    const roll = Math.random() * total;
    if (roll < counts.one) return { index: 1, roll, totalWeight: total };
    if (roll < counts.one + counts.two) return { index: 2, roll, totalWeight: total };
    return { index: 3, roll, totalWeight: total };
}

function endVote() {
    if (!voteState.active) return;
    voteState.active = false;
    clearVoteTimer();

    const counts = { ...voteState.counts };
    const probabilities = calculateVoteProbabilities(counts);
    const pick = pickWinnerByProbability(counts);

    sendToRenderer('danmaku-vote-end', {
        counts,
        probabilities,
        winner: pick.index,
        total: voteState.voters.size
    });
}

function maybeSendVoteUpdate() {
    const now = Date.now();
    if (now - voteState.lastUpdateTs < danmakuState.config.voteUpdateThrottleMs) return;
    voteState.lastUpdateTs = now;
    sendToRenderer('danmaku-vote-update', {
        counts: { ...voteState.counts },
        probabilities: calculateVoteProbabilities(voteState.counts),
        total: voteState.voters.size,
        endsAt: voteState.endsAt
    });
}

function normalizeVoteChoice(textRaw) {
    if (!textRaw) return null;
    const text = String(textRaw).trim().toLowerCase();
    if (!text) return null;
    const compact = text
        .replace(/\s+/g, '')
        .replace(/１/g, '1')
        .replace(/２/g, '2')
        .replace(/３/g, '3');
    const noHash = compact.replace(/^#+/, '');
    if (['1', '①', '一'].includes(noHash)) return 'one';
    if (['2', '②', '二'].includes(noHash)) return 'two';
    if (['3', '③', '三'].includes(noHash)) return 'three';
    if (/^1+$/.test(noHash)) return 'one';
    if (/^2+$/.test(noHash)) return 'two';
    if (/^3+$/.test(noHash)) return 'three';
    return null;
}

function canTriggerAction(uid) {
    const now = Date.now();
    if (now - lastGlobalActionTs < danmakuState.config.actionCooldownMs) return false;
    const last = actionCooldownMap.get(uid) || 0;
    if (now - last < danmakuState.config.actionCooldownMs) return false;
    lastGlobalActionTs = now;
    actionCooldownMap.set(uid, now);
    return true;
}

function handleDanmaku(data) {
    try {
        const info = data && data.info;
        const text = info && info[1] ? String(info[1]).trim() : '';
        const uid = info && info[2] && info[2][0] ? String(info[2][0]) : '0';
        const uname = info && info[2] && info[2][1] ? String(info[2][1]) : '匿名';
        if (!text) return;

        sendToRenderer('danmaku-message', { user: uname, uid, text, ts: Date.now() });

        // Voting during active session
        if (voteState.active) {
            const choice = normalizeVoteChoice(text);
            if (choice && !voteState.voters.has(uid)) {
                voteState.voters.add(uid);
                voteState.counts[choice] += 1;
                maybeSendVoteUpdate();
            }
        }

        // Direct action commands removed for 3-choice vote flow
    } catch (err) {
        console.error('Danmaku parse error:', err);
    }
}

function normalizeDanmakuBody(body) {
    if (!body) return null;
    if (typeof body === 'object') return body;
    if (typeof body === 'string') {
        try { return JSON.parse(body); } catch { return null; }
    }
    return null;
}

function disconnectDanmakuInternal() {
    try {
        if (danmakuState.client) {
            danmakuState.manualClose = true;
            danmakuState.client.close();
        }
    } catch (e) {
        // ignore
    }
    danmakuState.client = null;
    danmakuState.roomId = null;
    danmakuState.reconnectAttempts = 0;
    if (danmakuState.reconnectTimer) {
        clearTimeout(danmakuState.reconnectTimer);
        danmakuState.reconnectTimer = null;
    }
    resetVoteState();
    setDanmakuStatus('disconnected');
    setDanmakuAuthState(false, 0, '未校验');
}

function resolveRoomId(inputId) {
    return new Promise((resolve, reject) => {
        const url = `https://api.live.bilibili.com/room/v1/Room/room_init?id=${encodeURIComponent(inputId)}`;
        const headers = {
            'User-Agent': 'Mozilla/5.0',
            'Referer': `https://live.bilibili.com/${encodeURIComponent(inputId)}`,
            'Origin': 'https://live.bilibili.com',
            'Accept': 'application/json, text/plain, */*'
        };
        const cookie = normalizeCookie(danmakuState.config.cookie);
        if (cookie) headers['Cookie'] = cookie;
        const req = https.request(url, {
            headers: {
                ...headers
            }
        }, (res) => {
            let raw = '';
            res.on('data', (d) => raw += d);
            res.on('end', () => {
                try {
                    sendDiag(`room_init status=${res.statusCode} len=${raw.length}`);
                    const json = JSON.parse(raw);
                    if (json && json.code === 0 && json.data && json.data.room_id) {
                        resolve(Number(json.data.room_id));
                    } else {
                        sendDiag(`room_init body=${raw.slice(0, 200)}`);
                        reject(new Error('房间号解析失败'));
                    }
                } catch (e) {
                    sendDiag(`room_init parse_error body=${raw.slice(0, 200)}`);
                    reject(new Error('房间号解析失败'));
                }
            });
        });
        req.on('error', (e) => reject(e));
        req.setTimeout(6000, () => {
            req.destroy(new Error('room_init timeout'));
        });
        req.end();
    });
}

function scheduleReconnect(roomId) {
    if (danmakuState.manualClose) return;
    if (danmakuState.reconnectTimer) return;
    danmakuState.reconnectAttempts += 1;
    const delay = Math.min(10000, 500 * Math.pow(2, Math.min(danmakuState.reconnectAttempts, 5)));
    setDanmakuStatus('reconnecting', `重连中，${Math.round(delay / 1000)}s 后重试`);
    danmakuState.reconnectTimer = setTimeout(() => {
        danmakuState.reconnectTimer = null;
        connectDanmaku(roomId);
    }, delay);
}

function fetchDanmuInfo(roomId, navData) {
    return new Promise((resolve, reject) => {
        const baseParams = { id: roomId, type: 0 };
        const wbi = getWbiKeys(navData);
        const query = wbi ? signWbi(baseParams, wbi.imgKey, wbi.subKey)
                          : `id=${encodeURIComponent(roomId)}&type=0`;
        const url = `https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo?${query}`;
        const headers = {
            'User-Agent': 'Mozilla/5.0',
            'Referer': `https://live.bilibili.com/${encodeURIComponent(roomId)}`,
            'Origin': 'https://live.bilibili.com',
            'Accept': 'application/json, text/plain, */*'
        };
        const cookie = normalizeCookie(danmakuState.config.cookie);
        if (cookie) headers['Cookie'] = cookie;
        const req = https.request(url, {
            headers: {
                ...headers
            }
        }, (res) => {
            let raw = '';
            res.on('data', (d) => raw += d);
            res.on('end', () => {
                try {
                    sendDiag(`danmuInfo status=${res.statusCode} len=${raw.length}`);
                    const json = JSON.parse(raw);
                    if (json && json.code === 0 && json.data && json.data.token) {
                        resolve(json.data);
                    } else {
                        sendDiag(`danmuInfo body=${raw.slice(0, 200)}`);
                        const err = new Error('获取弹幕信息失败');
                        err.code = json && typeof json.code === 'number' ? json.code : null;
                        reject(err);
                    }
                } catch (e) {
                    sendDiag(`danmuInfo parse_error body=${raw.slice(0, 200)}`);
                    reject(new Error('获取弹幕信息失败'));
                }
            });
        });
        req.on('error', (e) => reject(e));
        req.setTimeout(6000, () => {
            req.destroy(new Error('danmuInfo timeout'));
        });
        req.end();
    });
}

function fetchDanmuInfoLegacy(roomId) {
    return new Promise((resolve, reject) => {
        const url = `https://api.live.bilibili.com/room/v1/Danmu/getConf?room_id=${encodeURIComponent(roomId)}&platform=pc&player=web`;
        const headers = {
            'User-Agent': 'Mozilla/5.0',
            'Referer': `https://live.bilibili.com/${encodeURIComponent(roomId)}`,
            'Origin': 'https://live.bilibili.com',
            'Accept': 'application/json, text/plain, */*'
        };
        const cookie = normalizeCookie(danmakuState.config.cookie);
        if (cookie) headers['Cookie'] = cookie;
        const req = https.request(url, { headers }, (res) => {
            let raw = '';
            res.on('data', (d) => raw += d);
            res.on('end', () => {
                try {
                    sendDiag(`danmuConf status=${res.statusCode} len=${raw.length}`);
                    const json = JSON.parse(raw);
                    if (json && json.code === 0 && json.data) {
                        const token = json.data.token || json.data.host_server_list?.[0]?.token;
                        const list = json.data.host_server_list || json.data.host_server_list_v2 || [];
                        resolve({ token, host_list: list, legacy: true });
                    } else {
                        sendDiag(`danmuConf body=${raw.slice(0, 200)}`);
                        reject(new Error('获取弹幕配置失败'));
                    }
                } catch {
                    sendDiag(`danmuConf parse_error body=${raw.slice(0, 200)}`);
                    reject(new Error('获取弹幕配置失败'));
                }
            });
        });
        req.on('error', (e) => reject(e));
        req.setTimeout(6000, () => req.destroy(new Error('danmuConf timeout')));
        req.end();
    });
}

function connectDanmakuWithInfo(info, roomId, prefer = 'ws', uid = 0) {
    const forcedHost = 'broadcastlv.chat.bilibili.com';
    const host = (info.host_list && info.host_list[0]) || {};
    const hostName = forcedHost;
    const wssPort = 443;
    const tcpPort = 2243;
    const token = info.token;
    sendDiag(`danmuInfo host=${hostName} wss_port=${wssPort} port=${tcpPort} token_len=${token ? token.length : 0}`);

    const tryTcp = () => {
        sendDiag('fallback to TCP connect');
        const socket = net.connect(tcpPort, hostName);
        danmakuState.client = socket;
        let liveTimer = setTimeout(() => {
            setDanmakuStatus('error', '进入房间超时，稍后重试');
            socket.end();
        }, 8000);

        let heartbeatTimer = null;
        const heartbeat = () => {
            socket.write(encodeDanmakuPacket(2, null, 1));
            clearTimeout(heartbeatTimer);
            heartbeatTimer = setTimeout(heartbeat, 30000);
        };

        socket.on('ready', () => {
            setDanmakuStatus('connecting', '已连接，正在进入房间...');
            const body = { uid: Number(uid) || 0, roomid: roomId, protover: 3, platform: 'web', type: 2, key: token || '' };
            sendDiag(`send join(tcp) roomid=${roomId} uid=${Number(uid) || 0} protover=3 key_len=${token ? token.length : 0}`);
            socket.write(encodeDanmakuPacket(7, body, 1));
        });

        let buffer = Buffer.alloc(0);
        socket.on('data', (chunk) => {
            if (chunk && chunk.length) sendDiag(`message(${chunk.length} bytes)`);
            buffer = Buffer.concat([buffer, chunk]);
            const { packets, remaining } = decodeDanmakuBuffer(buffer);
            buffer = remaining;
            for (const pack of packets) {
                if (pack.op === 8) {
                    clearTimeout(liveTimer);
                    liveTimer = null;
                    danmakuState.reconnectAttempts = 0;
                    setDanmakuStatus('connected', '已进入房间');
                    heartbeat();
                } else if (pack.op === 5 && pack.body) {
                    const data = normalizeDanmakuBody(pack.body) || pack.body;
                    const cmd = data && (data.cmd || (data.msg && data.msg.cmd));
                    if (cmd && cmd.includes('DANMU_MSG')) handleDanmaku(data);
                }
            }
        });

        socket.on('close', () => {
            clearTimeout(heartbeatTimer);
            if (danmakuState.manualClose) {
                setDanmakuStatus('disconnected', '已断开');
                return;
            }
            sendDiag('tcp close');
            scheduleReconnect(roomId);
        });

        socket.on('error', (err) => {
            const msg = err && err.message ? err.message : '连接错误';
            setDanmakuStatus('error', msg);
            sendDiag(`tcp error: ${msg}`);
            scheduleReconnect(roomId);
        });
    };

    if (prefer === 'tcp') return tryTcp();

    const url = `wss://${hostName}:${wssPort}/sub`;
    const ws = new WebSocket(url, {
        perMessageDeflate: false,
        headers: {
            'User-Agent': 'Mozilla/5.0',
            'Origin': 'https://live.bilibili.com',
            'Referer': `https://live.bilibili.com/${roomId}`
        }
    });
    danmakuState.client = ws;
    let liveTimer = setTimeout(() => {
        setDanmakuStatus('error', '进入房间超时，稍后重试');
        ws.close();
    }, 8000);

    let heartbeatTimer = null;
    const heartbeat = () => {
        if (ws.readyState === 1) ws.send(encodeDanmakuPacket(2, null, 1));
        clearTimeout(heartbeatTimer);
        heartbeatTimer = setTimeout(heartbeat, 30000);
    };

    let enteredLive = false;
    ws.on('open', () => {
        setDanmakuStatus('connecting', '已连接，正在进入房间...');
        const body = { uid: Number(uid) || 0, roomid: roomId, protover: 3, platform: 'web', type: 2, key: token || '' };
        sendDiag(`send join(ws) roomid=${roomId} uid=${Number(uid) || 0} protover=3 key_len=${token ? token.length : 0}`);
        ws.send(encodeDanmakuPacket(7, body, 1));
    });

    ws.on('message', (buf) => {
        const dataBuf = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
        if (dataBuf && dataBuf.length) sendDiag(`message(${dataBuf.length} bytes)`);
        const { packets } = decodeDanmakuBuffer(dataBuf);
        for (const pack of packets) {
            if (pack.op === 8) {
                clearTimeout(liveTimer);
                liveTimer = null;
                enteredLive = true;
                danmakuState.reconnectAttempts = 0;
                setDanmakuStatus('connected', '已进入房间');
                heartbeat();
            } else if (pack.op === 5 && pack.body) {
                const data = normalizeDanmakuBody(pack.body) || pack.body;
                const cmd = data && (data.cmd || (data.msg && data.msg.cmd));
                if (cmd && cmd.includes('DANMU_MSG')) handleDanmaku(data);
            }
        }
    });

    ws.on('close', (code, reason) => {
        clearTimeout(heartbeatTimer);
        if (danmakuState.manualClose) {
            setDanmakuStatus('disconnected', '已断开');
            return;
        }
        sendDiag(`close: ${code} | ${reason ? reason.toString() : ''}`);
        // if ws closes before welcome, try TCP once
        if (!enteredLive) {
            tryTcp();
            return;
        }
        scheduleReconnect(roomId);
    });

    ws.on('error', (err) => {
        const msg = err && err.message ? err.message : '连接错误';
        setDanmakuStatus('error', msg);
        sendDiag(`error: ${msg}`);
        scheduleReconnect(roomId);
    });
}

function checkLogin() {
    return new Promise((resolve, reject) => {
        const url = `https://api.bilibili.com/x/web-interface/nav`;
        const headers = {
            'User-Agent': 'Mozilla/5.0',
            'Referer': 'https://live.bilibili.com/',
            'Origin': 'https://live.bilibili.com'
        };
        const cookie = normalizeCookie(danmakuState.config.cookie);
        if (cookie) headers['Cookie'] = cookie;
        const req = https.request(url, { headers }, (res) => {
            let raw = '';
            res.on('data', (d) => raw += d);
            res.on('end', () => {
                try {
                    sendDiag(`nav status=${res.statusCode} len=${raw.length}`);
                    const json = JSON.parse(raw);
                    if (json && json.code === 0 && json.data) {
                        resolve(json.data);
                    } else {
                        sendDiag(`nav body=${raw.slice(0, 200)}`);
                        reject(new Error('登录态校验失败'));
                    }
                } catch {
                    sendDiag(`nav parse_error body=${raw.slice(0, 200)}`);
                    reject(new Error('登录态校验失败'));
                }
            });
        });
        req.on('error', (e) => reject(e));
        req.setTimeout(6000, () => req.destroy(new Error('nav timeout')));
        req.end();
    });
}

const mixinKeyEncTab = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
    27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
    37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
    22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52
];

function getWbiKeys(navData) {
    if (!navData || !navData.wbi_img) return null;
    const imgUrl = navData.wbi_img.img_url || '';
    const subUrl = navData.wbi_img.sub_url || '';
    const imgKey = imgUrl.split('/').pop()?.split('.')[0] || '';
    const subKey = subUrl.split('/').pop()?.split('.')[0] || '';
    if (!imgKey || !subKey) return null;
    return { imgKey, subKey };
}

function getMixinKey(imgKey, subKey) {
    const s = (imgKey + subKey);
    let res = '';
    for (const i of mixinKeyEncTab) res += s[i] || '';
    return res.slice(0, 32);
}

function signWbi(params, imgKey, subKey) {
    const mixinKey = getMixinKey(imgKey, subKey);
    const wts = Math.floor(Date.now() / 1000);
    const p = { ...params, wts };
    const keys = Object.keys(p).sort();
    const query = keys.map(k => {
        const v = String(p[k]).replace(/[!'()*]/g, '');
        return `${k}=${encodeURIComponent(v)}`;
    }).join('&');
    const w_rid = crypto.createHash('md5').update(query + mixinKey).digest('hex');
    return `${query}&w_rid=${w_rid}`;
}

function connectDanmaku(roomId) {
    try {
        sendDiag(`connectDanmaku(roomId=${roomId})`);
        setDanmakuAuthState(false, 0, '登录态校验中...');
        const cookie = normalizeCookie(danmakuState.config.cookie);
        sendDiag(`cookie len=${cookie.length} has_sessdata=${cookie.includes('SESSDATA=')}`);
        const sessMatch = cookie.match(/SESSDATA=([^;]+)/);
        const encoded = !!(sessMatch && /%[0-9A-Fa-f]{2}/.test(sessMatch[1]));
        sendDiag(`sessdata_encoded=${encoded}`);
        const keys = cookieKeys(cookie);
        const need = ['SESSDATA','bili_jct','DedeUserID','DedeUserID__ckMd5','buvid3','buvid4','b_nut','b_lsid','sid','bili_ticket'];
        const present = need.filter(k => keys.includes(k));
        const missing = need.filter(k => !keys.includes(k));
        sendDiag(`cookie keys count=${keys.length} first=${keys.slice(0, 8).join(',')}`);
        sendDiag(`cookie present=${present.join(',')}`);
        sendDiag(`cookie missing=${missing.join(',')}`);
        const getUidStrict = () => checkLogin().then((data) => {
            if (!data || !data.isLogin) {
                sendDiag('nav isLogin=false');
                setDanmakuAuthState(false, 0, '登录态失效');
                throw new Error('Cookie 登录态失效，请重新保存最新 Cookie');
            }
            const uid = Number(data.mid) || 0;
            if (uid <= 0) {
                setDanmakuAuthState(false, 0, '登录态异常');
                throw new Error('Cookie 登录态异常（未获取到 mid）');
            }
            sendDiag(`nav isLogin=true mid=${uid}`);
            setDanmakuAuthState(true, uid, '登录态有效');
            return uid;
        });

        fetchDanmuInfoLegacy(roomId).then(async (info) => {
            if (!info) return;
            const uid = await getUidStrict();
            connectDanmakuWithInfo(info, roomId, 'ws', uid);
        }).catch((legacyErr) => {
            const legacyMsg = legacyErr && legacyErr.message ? legacyErr.message : String(legacyErr);
            if (legacyMsg.includes('登录态')) {
                setDanmakuStatus('error', legacyMsg);
                return;
            }
            sendDiag(`danmuConf error: ${legacyErr && legacyErr.message ? legacyErr.message : String(legacyErr)}`);
            let uid = 0;
            return checkLogin().then((data) => {
                if (!data.isLogin) {
                    setDanmakuStatus('error', 'Cookie 登录态失效，请重新保存最新 Cookie');
                    sendDiag('nav isLogin=false');
                    setDanmakuAuthState(false, 0, '登录态失效');
                    return;
                }
                uid = Number(data.mid) || 0;
                sendDiag(`nav isLogin=true mid=${uid}`);
                setDanmakuAuthState(true, uid, '登录态有效');
                return fetchDanmuInfo(roomId, data);
            }).then((info) => {
                if (!info) return;
                connectDanmakuWithInfo(info, roomId, 'ws', uid);
            }).catch((e) => {
                setDanmakuStatus('error', e.message || '获取弹幕信息失败');
                sendDiag(`danmuInfo error: ${e && e.message ? e.message : String(e)}`);
                scheduleReconnect(roomId);
            });
        });
    } catch (e) {
        setDanmakuStatus('error', e.message || '连接失败');
        sendDiag(`connect exception: ${e && e.message ? e.message : String(e)}`);
        scheduleReconnect(roomId);
    }
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1280,
        height: 800,
        frame: true, // Keep standard window frame for now
        autoHideMenuBar: true,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true
        }
    });
    mainWindow.setMenuBarVisibility(false);
    mainWindow.removeMenu();
    mainWindow.loadFile('index.html');
}

app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

// === Danmaku IPC ===
ipcMain.handle('danmaku-connect', async (_event, roomId) => {
    const rid = Number(roomId);
    if (!Number.isFinite(rid) || rid <= 0) return { success: false, message: '房间号无效' };

    disconnectDanmakuInternal();
    danmakuState.manualClose = false;
    setDanmakuStatus('connecting', '解析房间中...');

    try {
        const realRoomId = await resolveRoomId(rid).catch(() => rid);
        danmakuState.roomId = realRoomId;
        setDanmakuStatus('connecting', `连接中... (${realRoomId})`);

        connectDanmaku(realRoomId);

        return { success: true };
    } catch (e) {
        disconnectDanmakuInternal();
        return { success: false, message: e.message || '连接失败' };
    }
});

ipcMain.handle('danmaku-disconnect', async () => {
    disconnectDanmakuInternal();
    return { success: true };
});

ipcMain.handle('danmaku-config', async (_event, config) => {
    if (config && typeof config === 'object') {
        const c = danmakuState.config;
        if (Number.isFinite(config.voteDurationSec)) c.voteDurationSec = Math.max(5, Math.min(120, Number(config.voteDurationSec)));
        if (Number.isFinite(config.actionCooldownMs)) c.actionCooldownMs = Math.max(1000, Math.min(60000, Number(config.actionCooldownMs)));
        if (Number.isFinite(config.startVoteCooldownMs)) c.startVoteCooldownMs = Math.max(5000, Math.min(600000, Number(config.startVoteCooldownMs)));
        if (typeof config.cookie === 'string') c.cookie = config.cookie.trim();
    }
    return { success: true, config: { ...danmakuState.config } };
});

ipcMain.handle('danmaku-qr-generate', async () => {
    try {
        const headers = {
            'User-Agent': 'Mozilla/5.0',
            'Referer': 'https://www.bilibili.com/',
            'Origin': 'https://www.bilibili.com',
            'Accept': 'application/json, text/plain, */*'
        };
        const url = 'https://passport.bilibili.com/x/passport-login/web/qrcode/generate';
        const { json } = await requestJson(url, headers, 7000);
        if (!json || json.code !== 0 || !json.data || !json.data.qrcode_key || !json.data.url) {
            return { success: false, message: '生成扫码登录二维码失败' };
        }
        const loginUrl = String(json.data.url);
        const qrcodeKey = String(json.data.qrcode_key);
        const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=280x280&data=${encodeURIComponent(loginUrl)}`;
        return { success: true, qrcodeKey, loginUrl, qrImageUrl };
    } catch (e) {
        return { success: false, message: e && e.message ? e.message : '生成扫码登录二维码失败' };
    }
});

ipcMain.handle('danmaku-qr-poll', async (_event, qrcodeKey) => {
    const key = String(qrcodeKey || '').trim();
    if (!key) return { success: false, state: 'error', message: '二维码 key 为空' };
    try {
        const headers = {
            'User-Agent': 'Mozilla/5.0',
            'Referer': 'https://www.bilibili.com/',
            'Origin': 'https://www.bilibili.com',
            'Accept': 'application/json, text/plain, */*'
        };
        const url = `https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(key)}`;
        const { json, headers: resHeaders, statusCode } = await requestJson(url, headers, 7000);
        if (!json || json.code !== 0 || !json.data) {
            // Some deployments answer a confirmed poll with a redirect whose Set-Cookie
            // still carries the login state; accept that instead of reporting a hard failure.
            const redirectCookie = buildQrLoginCookie(resHeaders, '');
            if (cookieHasKey(redirectCookie, 'SESSDATA')) {
                return await finishQrLogin(redirectCookie);
            }
            sendDiag(`qr poll failed status=${statusCode} body_len=${(json ? JSON.stringify(json) : '').length}`);
            return { success: false, state: 'error', message: '轮询扫码状态失败' };
        }

        const stateCode = Number(json.data.code);
        if (stateCode === 86101) {
            return { success: true, state: 'pending', message: '等待扫码' };
        }
        if (stateCode === 86090) {
            return { success: true, state: 'scanned', message: '已扫码，请在手机确认' };
        }
        if (stateCode === 86038) {
            return { success: true, state: 'expired', message: '二维码已过期，请重新获取' };
        }
        if (stateCode !== 0) {
            return { success: true, state: 'error', message: json.data.message || `扫码状态异常(${stateCode})` };
        }

        // Confirmed. Current passport API delivers the session via Set-Cookie; older
        // responses put the same values in data.url. buildQrLoginCookie accepts both.
        const loginUrl = String(json.data.url || '');
        const cookie = buildQrLoginCookie(resHeaders, loginUrl);
        if (!cookieHasKey(cookie, 'SESSDATA')) {
            sendDiag(`qr confirmed without SESSDATA status=${statusCode} url=${loginUrl.slice(0, 120)}`);
            return {
                success: true,
                state: 'error',
                message: '扫码成功但服务器未下发 SESSDATA，请点击“刷新二维码”重试'
            };
        }
        return await finishQrLogin(cookie);
    } catch (e) {
        return { success: false, state: 'error', message: e && e.message ? e.message : '轮询扫码状态失败' };
    }
});

ipcMain.handle('danmaku-vote-start', async (_event, durationSec) => {
    if (Number.isFinite(durationSec)) {
        danmakuState.config.voteDurationSec = Math.max(5, Math.min(120, Number(durationSec)));
    }
    const ok = startVote('manual');
    return { success: ok, active: voteState.active, endsAt: voteState.endsAt };
});

// === LCU Logic ===

ipcMain.handle('apply-runes', async (event, runeData) => {
    try {
        // 1. Connect to Client
        const credentials = await authenticate();

        // 1.1 Fetch valid perk IDs (includes StatMods / shards).
        // Patch drift happens; renderer-side hardcoded shard IDs can become invalid.
        // We validate incoming IDs against the client, and fall back to current-page
        // shards if the incoming array is incomplete or contains invalid IDs.
        let validPerkIdSet = null;
        try {
            const perksRes = await createHttp1Request({ method: 'GET', url: '/lol-perks/v1/perks' }, credentials);
            if (perksRes.ok) {
                const perks = await perksRes.json();
                if (Array.isArray(perks)) validPerkIdSet = new Set(perks.map(p => Number(p.id)).filter(Number.isFinite));
            }
        } catch (e) {
            // Non-fatal: continue without validation.
            validPerkIdSet = null;
        }
        
        // 2. Get Current Page
        // We need to find a page to edit. 
        // Strategy: Get current page. If editable, update it. If not, find ANY editable page.
        
        const currentRes = await createHttp1Request({
            method: 'GET',
            url: '/lol-perks/v1/currentpage',
        }, credentials);
        
        let targetPageId;
        const currentPage = await currentRes.json();
        let targetPage = currentPage;

        if (currentPage.isEditable) {
            targetPageId = currentPage.id;
        } else {
            // Current is not editable (e.g. Preset). Find one that is.
            const allPagesRes = await createHttp1Request({ method: 'GET', url: '/lol-perks/v1/pages' }, credentials);
            const allPages = await allPagesRes.json();
            const editable = Array.isArray(allPages) ? allPages.find(p => p.isEditable) : null;
            
            if (editable) {
                targetPageId = editable.id;
                targetPage = editable;
                // Switch to this page
                await createHttp1Request({
                    method: 'PUT',
                    url: '/lol-perks/v1/currentpage',
                    body: targetPageId
                }, credentials);
            } else {
                // No editable pages? Create one if not full (max 2 or 3 usually?) 
                // but usually users have one. If we can't find one, we can try to create.
                // For now, simpler error.
                throw new Error("没有找到可编辑的符文页，请先在客户端新建一个。");
            }
        }

        // --- Build a robust selectedPerkIds ---
        const toNumArray = (a) => (Array.isArray(a) ? a.map(x => Number(x)).filter(Number.isFinite) : []);
        const incoming = toNumArray(runeData && runeData.selectedPerkIds);
        const baseSelected = toNumArray(targetPage && targetPage.selectedPerkIds);

        // Prefer keeping the current page's shards (last 3) if incoming is incomplete/invalid.
        let selectedPerkIds = [];
        if (baseSelected.length >= 9) selectedPerkIds = baseSelected.slice(0, 9);
        else if (incoming.length >= 9) selectedPerkIds = incoming.slice(0, 9);

        if (selectedPerkIds.length < 9) {
            throw new Error('符文数据不完整：selectedPerkIds 需要包含 9 个 ID（含 3 个属性碎片）。');
        }

        // Overlay incoming values if they exist and (optionally) are valid in the current client.
        for (let i = 0; i < Math.min(incoming.length, 9); i++) {
            const id = incoming[i];
            if (!Number.isFinite(id)) continue;
            if (validPerkIdSet && !validPerkIdSet.has(id)) continue;
            selectedPerkIds[i] = id;
        }

        // Final sanity check (best-effort): if we have validation data, ensure all IDs are valid.
        if (validPerkIdSet) {
            const invalid = selectedPerkIds.find(id => !validPerkIdSet.has(id));
            if (invalid !== undefined) {
                throw new Error(`符文ID校验失败：客户端不支持ID=${invalid}。建议先在客户端手动保存一次符文页后再试。`);
            }
        }

        // 3. Delete the page (to clear it) or just Overwrite. 
        // Overwriting is safer.
        
        const updatePayload = {
            name: "Magic Random",
            primaryStyleId: Number(runeData.primaryStyleId),
            subStyleId: Number(runeData.subStyleId),
            selectedPerkIds,
            current: true
        };

        const updateRes = await createHttp1Request({
            method: 'PUT',
            url: `/lol-perks/v1/pages/${targetPageId}`,
            body: updatePayload
        }, credentials);

        if (updateRes.ok) {
            return { success: true };
        } else {
            console.error(await updateRes.text());
            throw new Error("更新符文页失败，请检查客户端状态。");
        }

    } catch (error) {
        console.error(error);
        return { success: false, message: error.message || "连接客户端失败" };
    }
});

// === Item Set (装备) 一键配置 ===
// Renderer sends an array of item IDs (string/number).
ipcMain.handle('apply-items', async (_event, itemIds) => {
    try {
        const ids = Array.isArray(itemIds)
            ? itemIds.map(x => String(x).trim()).filter(Boolean)
            : [];

        if (ids.length === 0) {
            return { success: false, message: "没有装备数据，请先抽取装备。" };
        }

        // 1) Connect to client
        const credentials = await authenticate();

        // 2) SummonerId (required by lol-item-sets endpoints)
        const summonerRes = await createHttp1Request({ method: 'GET', url: '/lol-summoner/v1/current-summoner' }, credentials);
        if (!summonerRes.ok) {
            throw new Error("未检测到已登录的客户端（/lol-summoner/v1/current-summoner 失败）。");
        }
        const summoner = await summonerRes.json();
        const summonerId = Number(summoner && (summoner.summonerId ?? summoner.summonerId ?? summoner.accountId));
        if (!Number.isFinite(summonerId) || summonerId <= 0) {
            throw new Error("获取 SummonerId 失败，请确认已登录到客户端大厅。");
        }

        // 3) Optional: championId (if in champ select)
        let championId = 0;
        try {
            const champRes = await createHttp1Request({ method: 'GET', url: '/lol-champ-select/v1/current-champion' }, credentials);
            if (champRes.ok) {
                try {
                    championId = Number(await champRes.json());
                } catch {
                    const t = await champRes.text();
                    championId = Number(t);
                }
            }
        } catch {
            // ignore
        }
        if (!Number.isFinite(championId)) championId = 0;

        const url = `/lol-item-sets/v1/item-sets/${summonerId}/sets`;

        // 4) Read existing sets to preserve user's data
        let rawData = null;
        let existingSets = [];
        let wrapperMode = 'unknown'; // 'wrapper' | 'array' | 'unknown'

        try {
            const getRes = await createHttp1Request({ method: 'GET', url }, credentials);
            if (getRes.ok) {
                rawData = await getRes.json();
                if (Array.isArray(rawData)) {
                    wrapperMode = 'array';
                    existingSets = rawData;
                } else if (rawData && Array.isArray(rawData.itemSets)) {
                    wrapperMode = 'wrapper';
                    existingSets = rawData.itemSets;
                } else if (rawData && Array.isArray(rawData.sets)) {
                    wrapperMode = 'wrapper';
                    existingSets = rawData.sets;
                } else {
                    // Unknown shape – treat as empty, but keep rawData for later PUT attempts.
                    wrapperMode = 'unknown';
                    existingSets = [];
                }
            }
        } catch {
            // ignore – we'll still try to write
        }

        const sampleSet = Array.isArray(existingSets) && existingSets.length > 0 ? existingSets[0] : null;

        // 5) Build a new item set (compatible with the classic item set JSON format)
        const FIXED_ITEMSET_TITLE = 'Magic Random';
        const FIXED_ITEMSET_UID = 'magic-random';
        const title = FIXED_ITEMSET_TITLE;

        const newSet = {
            title,
            type: 'custom',
            map: 'any',
            mode: 'any',
            priority: false,
            sortrank: 0,
            blocks: [
                {
                    type: '随机出装',
                    recMath: false,
                    minSummonerLevel: -1,
                    maxSummonerLevel: -1,
                    showIfSummonerSpell: '',
                    hideIfSummonerSpell: '',
                    items: ids.map(id => ({ id: String(id), count: 1 }))
                }
            ]
        };

        // If client uses extra fields, keep them to improve compatibility
        if (sampleSet && typeof sampleSet === 'object') {
        if ('uid' in sampleSet) newSet.uid = FIXED_ITEMSET_UID;
        if ('associatedChampions' in sampleSet) newSet.associatedChampions = championId > 0 ? [championId] : [];
        if ('associatedMaps' in sampleSet) newSet.associatedMaps = [];

        // ✅ FIX: preferredItemSlots 在部分客户端是 vector(数组)，不能发 {}
        if ('preferredItemSlots' in sampleSet) {
            const v = sampleSet.preferredItemSlots;
            if (Array.isArray(v)) newSet.preferredItemSlots = [];   // vector -> array
            else if (v && typeof v === 'object') newSet.preferredItemSlots = {}; // 少数客户端可能是对象
            else newSet.preferredItemSlots = []; // 兜底按 vector 处理
        }
        }


        // 6) Upsert into existing sets list (keep only ONE "Magic Random" set)
        const isOurSet = (s) => {
            if (!s) return false;
            const t = typeof s.title === 'string' ? s.title : '';
            const uid = typeof s.uid === 'string' ? s.uid : '';
            return uid === FIXED_ITEMSET_UID || t === FIXED_ITEMSET_TITLE || t.startsWith('Magic Random 出装');
        };

        const prevSet = Array.isArray(existingSets) ? existingSets.find(isOurSet) : null;
        if (prevSet && typeof prevSet === 'object' && prevSet.uid && !newSet.uid) {
            newSet.uid = prevSet.uid;
        }

        const setsCopy = Array.isArray(existingSets) ? existingSets.filter(s => !isOurSet(s)) : [];
        setsCopy.unshift(newSet);


        // 7) Try writing back with multiple strategies (LCU shape differs across versions/regions)
        const attempts = [];

        // Preferred: PUT full payload preserving wrapper
        if (wrapperMode === 'wrapper' && rawData && typeof rawData === 'object') {
            const payload = { ...rawData };
            if (Array.isArray(rawData.itemSets)) payload.itemSets = setsCopy;
            else if (Array.isArray(rawData.sets)) payload.sets = setsCopy;
            else payload.itemSets = setsCopy;
            attempts.push({ method: 'PUT', body: payload });
        }

        // Alternate: PUT array
        attempts.push({ method: 'PUT', body: setsCopy });

        // Alternate: POST newSet (some clients support append semantics)
        attempts.push({ method: 'POST', body: newSet });

        let lastErrText = '';
        for (const a of attempts) {
            const res = await createHttp1Request({ method: a.method, url, body: a.body }, credentials);
            if (res.ok) return { success: true };
            try { lastErrText = await res.text(); } catch { lastErrText = ''; }
        }

        throw new Error(`更新出装失败。${lastErrText ? "客户端返回: " + lastErrText : ""}`);

    } catch (error) {
        console.error(error);
        return { success: false, message: error.message || "连接客户端失败" };
    }
});
