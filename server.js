const express = require('express');
const path = require('path');
const WebSocket = require('ws');
const app = express();

const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));

app.use((err, req, res, next) => {
    if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
        return res.status(200).json({ success: false, error: 'リクエストデータが不正です' });
    }
    next();
});

app.use(express.static(path.join(__dirname)));

const botConnections = new Map();
// ログをBotIDごとに管理するMapに変更
const botLogs = new Map();

function addLog(botId, botName, message) {
    const time = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }).split(' ')[1];
    const logText = `[${time}] [${botName}] ${message}`;
    
    if (!botLogs.has(botId)) botLogs.set(botId, []);
    const logs = botLogs.get(botId);
    
    logs.push(logText);
    if (logs.length > 200) logs.shift(); // 最大200行
    
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

    const files = [];
    if (embeds && embeds.length > 0) {
        embeds.forEach((embed, index) => {
            if (embed.image && embed.image.url && embed.image.url.startsWith('data:')) {
                const base64Data = embed.image.url.split(',')[1];
                const mimeType = embed.image.url.split(',')[0].split(':')[1].split(';')[0];
                const extension = mimeType.split('/')[1] || 'png';
                const fileName = `upload_${index}.${extension}`;

                const buffer = Buffer.from(base64Data, 'base64');
                const blob = new Blob([buffer], { type: mimeType });

                formData.append(`files[${index}]`, blob, fileName);
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
        headers = {}; 
    }

    return await fetch(url, {
        method: 'POST',
        headers: headers,
        body: formData
    });
}

// Bot接続処理を関数化（自動再接続のため）
function connectDiscordBot(id, name, token, code) {
    if (botConnections.has(id)) {
        const existing = botConnections.get(id);
        if (existing.ws) existing.ws.close();
        clearInterval(existing.heartbeatInterval);
    }

    addLog(id, name, 'Discord Gatewayへ接続中...');

    const AsyncFunction = Object.getPrototypeOf(async function () { }).constructor;
    let userScriptFunc;
    try {
        userScriptFunc = new AsyncFunction('eventType', 'data', 'send', 'reply', code);
    } catch (e) {
        addLog(id, name, `コードの文法エラー:\n${e.message}\n${e.stack}`);
        return { success: false, error: 'Syntax Error: ' + e.message };
    }

    const sendMessage = async (channelId, content, components = null, embeds = null) => {
        try {
            const response = await sendDiscordMessage(token, channelId, content, components, embeds);
            if (!response.ok) {
                const errText = await response.text();
                addLog(id, name, `[Error] 送信失敗 (Status: ${response.status}):\n${errText}`);
            } else {
                addLog(id, name, `メッセージを送信しました`);
            }
        } catch (e) {
            addLog(id, name, `[Error] 通信エラー:\n${e.message}\n${e.stack}`);
        }
    };

    const replyInteraction = async (interactionId, interactionToken, content, components = null, embeds = null) => {
        try {
            const response = await sendDiscordMessage(null, null, content, components, embeds, { id: interactionId, token: interactionToken });
            if (!response.ok) {
                const errText = await response.text();
                addLog(id, name, `[Error] ボタン応答失敗 (Status: ${response.status}):\n${errText}`);
            } else {
                addLog(id, name, `ボタンの応答完了`);
            }
        } catch (e) {
            addLog(id, name, `[Error] インタラクション通信エラー:\n${e.message}\n${e.stack}`);
        }
    };

    const botWS = new WebSocket('wss://gateway.discord.gg/?v=10&encoding=json');
    let sequence = null;

    botConnections.set(id, { ws: botWS, heartbeatInterval: null, isRunning: false, name: name, intentionalStop: false });

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
                addLog(id, name, `成功: [${d.user.username}] として稼働開始✨`);
                botConnections.get(id).isRunning = true;
            }
            if (t === 'MESSAGE_CREATE') {
                try { await userScriptFunc('MESSAGE', d, sendMessage, replyInteraction); }
                catch (err) { addLog(id, name, `[Runtime Error] 実行エラー:\n${err.message}\n${err.stack || ''}`); }
            }
            if (t === 'INTERACTION_CREATE') {
                try { await userScriptFunc('INTERACTION', d, sendMessage, replyInteraction); }
                catch (err) { addLog(id, name, `[Runtime Error] 実行エラー:\n${err.message}\n${err.stack || ''}`); }
            }
        }
    });

    botWS.on('close', (codeReason) => {
        const botData = botConnections.get(id);
        if (botData) {
            botData.isRunning = false;
            clearInterval(botData.heartbeatInterval);
            addLog(id, name, `切断されました。(Code: ${codeReason})`);
            
            // 意図的な停止でない場合、cron-job対策として自動再接続を試みる
            if (!botData.intentionalStop) {
                addLog(id, name, '⚠️意図しない切断を検知しました。5秒後に自動再接続を試みます...');
                setTimeout(() => {
                    // 再度意図的停止がされていなければ再接続
                    if (botConnections.has(id) && !botConnections.get(id).intentionalStop) {
                        connectDiscordBot(id, name, token, code);
                    }
                }, 5000);
            }
        }
    });

    return { success: true };
}

app.post('/api/start-bot', (req, res) => {
    const { id, name, token, code } = req.body;

    if (!id || !token) {
        return res.status(200).json({ success: false, error: 'IDとTokenが必要です' });
    }

    const result = connectDiscordBot(id, name, token, code);
    if (!result.success) {
        return res.status(200).json(result);
    }

    res.status(200).json({ success: true, message: 'Bot Started' });
});

app.post('/api/stop-bot', (req, res) => {
    const { id } = req.body;
    if (botConnections.has(id)) {
        const botData = botConnections.get(id);
        botData.intentionalStop = true; // 意図的停止フラグをオン
        if (botData.ws) botData.ws.close();
        clearInterval(botData.heartbeatInterval);
        addLog(id, botData.name, '⏹ 正常に停止しました。');
    }
    res.json({ success: true });
});

app.get('/api/logs', (req, res) => {
    const runningBots = {};
    for (const [id, botData] of botConnections.entries()) {
        runningBots[id] = botData.isRunning;
    }
    // botLogs(Map)をオブジェクトに変換して返す
    const logsObj = {};
    for (const [id, logs] of botLogs.entries()) {
        logsObj[id] = logs;
    }
    res.json({ runningBots, logs: logsObj });
});

app.get('/ping', (req, res) => res.send('pong'));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));