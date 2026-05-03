const express = require('express');
const path = require('path');
const WebSocket = require('ws');
const app = express();

const PORT = process.env.PORT || 3000;

// 画像データを含むため、制限を緩和（10MBまで）
app.use(express.json({ limit: '10mb' }));

app.use((err, req, res, next) => {
    if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
        return res.status(200).json({ success: false, error: 'リクエストデータが不正です' });
    }
    next();
});

app.use(express.static(path.join(__dirname)));

const botConnections = new Map();
let serverLogs = [];

function addLog(botName, message) {
    const time = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }).split(' ')[1];
    const logText = `[${time}] [${botName}] ${message}`;
    serverLogs.push(logText);
    if (serverLogs.length > 200) serverLogs.shift();
    console.log(logText);
}

/**
 * Base64データURLをバイナリ（FormData）に変換してDiscordに送信する関数
 */
async function sendDiscordMessage(botToken, channelId, content, components, embeds, interactionInfo = null) {
    const formData = new FormData();
    const payload = {};

    if (content) payload.content = content;
    if (components) payload.components = components;

    // 画像処理: Embeds内のBase64をファイル添付に変換
    const files = [];
    if (embeds && embeds.length > 0) {
        embeds.forEach((embed, index) => {
            if (embed.image && embed.image.url && embed.image.url.startsWith('data:')) {
                const base64Data = embed.image.url.split(',')[1];
                const mimeType = embed.image.url.split(',')[0].split(':')[1].split(';')[0];
                const extension = mimeType.split('/')[1] || 'png';
                const fileName = `upload_${index}.${extension}`;

                // バイナリに変換
                const buffer = Buffer.from(base64Data, 'base64');
                const blob = new Blob([buffer], { type: mimeType });

                formData.append(`files[${index}]`, blob, fileName);
                
                // EmbedのURLを添付ファイル参照に書き換え
                embed.image.url = `attachment://${fileName}`;
            }
        });
        payload.embeds = embeds;
    } else if (embeds) {
        payload.embeds = embeds;
    }

    formData.append('payload_json', JSON.stringify(interactionInfo ? { type: 4, data: payload } : payload));

    let url = `https://discord.com/api/v10/channels/${channelId}/messages`;
    let headers = { 'Authorization': `Bot ${botToken}` };

    if (interactionInfo) {
        url = `https://discord.com/api/v10/interactions/${interactionInfo.id}/${interactionInfo.token}/callback`;
        headers = {}; // インタラクション応答にAuthヘッダーは不要
    }

    return await fetch(url, {
        method: 'POST',
        headers: headers,
        body: formData
    });
}

app.post('/api/start-bot', (req, res) => {
    const { id, name, token, code } = req.body;

    if (!id || !token) {
        addLog(name || 'Unknown', '起動失敗: IDまたはTokenが不足しています。');
        return res.status(200).json({ success: false, error: 'IDとTokenが必要です' });
    }

    if (botConnections.has(id)) {
        const existing = botConnections.get(id);
        if (existing.ws) existing.ws.close();
        clearInterval(existing.heartbeatInterval);
        botConnections.delete(id);
    }

    addLog(name, 'Discord Gatewayへ接続中...');

    const AsyncFunction = Object.getPrototypeOf(async function () { }).constructor;
    let userScriptFunc;
    try {
        userScriptFunc = new AsyncFunction('eventType', 'data', 'send', 'reply', code);
    } catch (e) {
        addLog(name, 'コードの文法エラー: ' + e.message);
        return res.status(200).json({ success: false, error: 'Syntax Error: ' + e.message });
    }

    // メッセージ送信（ファイル添付対応）
    const sendMessage = async (channelId, content, components = null, embeds = null) => {
        try {
            const response = await sendDiscordMessage(token, channelId, content, components, embeds);
            if (!response.ok) {
                const errText = await response.text();
                addLog(name, `送信エラー: ${response.status} ${errText}`);
            } else {
                addLog(name, `メッセージ(画像含む)を送信しました`);
            }
        } catch (e) {
            addLog(name, '通信エラー: ' + e.message);
        }
    };

    // ボタン応答（ファイル添付対応）
    const replyInteraction = async (interactionId, interactionToken, content, components = null, embeds = null) => {
        try {
            const response = await sendDiscordMessage(null, null, content, components, embeds, { id: interactionId, token: interactionToken });
            if (!response.ok) {
                const errText = await response.text();
                addLog(name, `ボタン応答エラー: ${response.status} ${errText}`);
            } else {
                addLog(name, `ボタンの応答完了(画像含む)`);
            }
        } catch (e) {
            addLog(name, 'インタラクションエラー: ' + e.message);
        }
    };

    const botWS = new WebSocket('wss://gateway.discord.gg/?v=10&encoding=json');
    let sequence = null;

    botConnections.set(id, { ws: botWS, heartbeatInterval: null, isRunning: false, name: name });

    botWS.on('message', async (messageData) => {
        const payload = JSON.parse(messageData);
        const { t, op, d, s } = payload;
        if (s) sequence = s;

        if (op === 10) {
            const heartbeatInterval = setInterval(() => {
                if (botWS.readyState === WebSocket.OPEN) botWS.send(JSON.stringify({ op: 1, d: sequence }));
            }, d.heartbeat_interval);
            botConnections.get(id).heartbeatInterval = heartbeatInterval;
            botWS.send(JSON.stringify({
                op: 2,
                d: { token: token, intents: 33281, properties: { os: 'linux', browser: 'render', device: 'render' } }
            }));
        }

        if (op === 0) {
            if (t === 'READY') {
                addLog(name, `成功: [${d.user.username}] として稼働開始✨`);
                botConnections.get(id).isRunning = true;
            }
            if (t === 'MESSAGE_CREATE') {
                try { await userScriptFunc('MESSAGE', d, sendMessage, replyInteraction); }
                catch (err) { addLog(name, '実行エラー: ' + err.message); }
            }
            if (t === 'INTERACTION_CREATE') {
                try { await userScriptFunc('INTERACTION', d, sendMessage, replyInteraction); }
                catch (err) { addLog(name, '実行エラー: ' + err.message); }
            }
        }
    });

    botWS.on('close', () => {
        const botData = botConnections.get(id);
        if (botData) botData.isRunning = false;
        addLog(name, '切断されました。');
    });

    res.status(200).json({ success: true, message: 'Bot Started' });
});

app.post('/api/stop-bot', (req, res) => {
    const { id } = req.body;
    if (botConnections.has(id)) {
        const botData = botConnections.get(id);
        if (botData.ws) botData.ws.close();
        clearInterval(botData.heartbeatInterval);
        addLog(botData.name, '停止しました。');
        botConnections.delete(id);
    }
    res.json({ success: true });
});

app.get('/api/logs', (req, res) => {
    const runningBots = {};
    for (const [id, botData] of botConnections.entries()) {
        runningBots[id] = botData.isRunning;
    }
    res.json({ runningBots, logs: serverLogs });
});

app.get('/ping', (req, res) => res.send('pong'));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));