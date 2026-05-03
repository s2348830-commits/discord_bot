const express = require('express');
const path = require('path');
const WebSocket = require('ws'); 
const app = express();

const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' })); 

// 万が一、フロントからのJSON形式が壊れていた場合のエラーハンドリングを追加
app.use((err, req, res, next) => {
    if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
        return res.status(200).json({ success: false, error: 'リクエストデータが不正です' });
    }
    next();
});

app.use(express.static(path.join(__dirname))); 

// Map構造で複数のBotを管理する「シェアハウス」化
const botConnections = new Map(); 
let serverLogs = []; 

// どのBotのログかが分かるように関数を改修
function addLog(botName, message) {
    const time = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }).split(' ')[1];
    const logText = `[${time}] [${botName}] ${message}`;
    serverLogs.push(logText);
    if (serverLogs.length > 200) serverLogs.shift(); // 少しログ件数を拡張
    console.log(logText);
}

app.post('/api/start-bot', (req, res) => {
    // フロントからIDと名前も受け取る
    const { id, name, token, code } = req.body;
    
    // 修正箇所: 400エラーで落とさず、200 OKの中でエラー内容をフロントへ返す
    if (!id || !token) {
        addLog(name || 'Unknown', '起動失敗: IDまたはTokenが不足しています。');
        return res.status(200).json({ success: false, error: 'IDとTokenが必要です' }); 
    }

    // 既存のBotを全体切断するのではなく、該当IDのBotのみ上書き切断
    if (botConnections.has(id)) {
        const existing = botConnections.get(id);
        if (existing.ws) existing.ws.close();
        clearInterval(existing.heartbeatInterval);
        botConnections.delete(id);
    }

    addLog(name, 'Renderサーバー上でDiscord Gatewayへ接続中...'); 

    const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
    let userScriptFunc;
    try {
        userScriptFunc = new AsyncFunction('eventType', 'data', 'send', 'reply', code);
    } catch (e) {
        addLog(name, 'コードの文法エラー: ' + e.message);
        // 修正箇所: 400エラーで落とさず、200 OKの中でエラー内容をフロントへ返す
        return res.status(200).json({ success: false, error: 'Syntax Error: ' + e.message });
    }

    // メッセージ送信関数
    const sendMessage = async (channelId, content, components = null, embeds = null) => {
        try {
            const body = {};
            if (content) body.content = content;
            if (components && components.length > 0) body.components = components;
            if (embeds && embeds.length > 0) body.embeds = embeds; 

            const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bot ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(body)
            });
            if (!response.ok) {
                const errText = await response.text();
                addLog(name, `送信エラー: ${response.status} ${errText}`);
            } else {
                addLog(name, `メッセージを送信しました`);
            }
        } catch (e) {
            addLog(name, '通信エラー: ' + e.message);
        }
    };

    // ボタン返信関数
    const replyInteraction = async (interactionId, interactionToken, content, components = null, embeds = null) => {
        try {
            const dataPayload = { flags: 64 }; 
            if (content) dataPayload.content = content;
            if (components && components.length > 0) dataPayload.components = components;
            if (embeds && embeds.length > 0) dataPayload.embeds = embeds;

            const response = await fetch(`https://discord.com/api/v10/interactions/${interactionId}/${interactionToken}/callback`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type: 4, data: dataPayload }) 
            });
            if (!response.ok) {
                const errText = await response.text();
                addLog(name, `ボタン応答エラー: ${response.status} ${errText}`);
            } else {
                addLog(name, `ボタンの応答完了`);
            }
        } catch (e) {
            addLog(name, 'インタラクション通信エラー: ' + e.message);
        }
    };

    const botWS = new WebSocket('wss://gateway.discord.gg/?v=10&encoding=json'); 
    let sequence = null;
    let heartbeatInterval = null;

    // Mapに接続を登録
    botConnections.set(id, { ws: botWS, heartbeatInterval: null, isRunning: false, name: name });

    botWS.on('message', async (messageData) => {
        const payload = JSON.parse(messageData);
        const { t, op, d, s } = payload;
        if (s) sequence = s;

        if (op === 10) {
            const heartbeatMs = d.heartbeat_interval;
            heartbeatInterval = setInterval(() => {
                if (botWS && botWS.readyState === WebSocket.OPEN) {
                    botWS.send(JSON.stringify({ op: 1, d: sequence }));
                }
            }, heartbeatMs);
            
            // Map内のインターバルを更新
            const botData = botConnections.get(id);
            if (botData) botData.heartbeatInterval = heartbeatInterval;

            botWS.send(JSON.stringify({
                op: 2,
                d: {
                    token: token,
                    intents: 33281, 
                    properties: { os: 'linux', browser: 'render_server', device: 'render_server' }
                }
            }));
        }

        if (op === 0) {
            if (t === 'READY') {
                addLog(name, `成功: [${d.user.username}] として稼働開始✨`); 
                const botData = botConnections.get(id);
                if (botData) botData.isRunning = true;
            }
            if (t === 'MESSAGE_CREATE') {
                try { await userScriptFunc('MESSAGE', d, sendMessage, replyInteraction); } 
                catch (err) { addLog(name, 'コード実行時エラー: ' + err.message); }
            }
            if (t === 'INTERACTION_CREATE') {
                try { await userScriptFunc('INTERACTION', d, sendMessage, replyInteraction); } 
                catch (err) { addLog(name, 'コード実行時エラー: ' + err.message); }
            }
        }

        if (op === 9) {
            addLog(name, 'セッションが無効です。');
            const botData = botConnections.get(id);
            if (botData) botData.isRunning = false;
        }
    });

    botWS.on('close', (code) => {
        addLog(name, `切断されました。(コード: ${code})`);
        const botData = botConnections.get(id);
        if (botData) botData.isRunning = false;
    });

    botWS.on('error', (err) => {
        addLog(name, 'WebSocketエラー: ' + err.message);
        const botData = botConnections.get(id);
        if (botData) botData.isRunning = false;
    });

    // JSON形式で成功レスポンスを返すように修正
    res.status(200).json({ success: true, message: 'Bot Started' });
});

// 特定のBotのみ停止する処理
app.post('/api/stop-bot', (req, res) => {
    const { id } = req.body;
    if (botConnections.has(id)) {
        const botData = botConnections.get(id);
        if (botData.ws) botData.ws.close();
        clearInterval(botData.heartbeatInterval);
        addLog(botData.name, 'Botを手動停止しました。'); 
        botConnections.delete(id);
    }
    // JSON形式で成功レスポンスを返すように修正
    res.status(200).json({ success: true, message: 'Stopped' });
});

// 全Botの稼働状態をMap形式でフロントエンドへ返却する
app.get('/api/logs', (req, res) => {
    const runningBots = {};
    for (const [id, botData] of botConnections.entries()) {
        runningBots[id] = botData.isRunning;
    }
    res.json({ runningBots, logs: serverLogs }); 
});

app.get('/ping', (req, res) => {
    res.status(200).send('pong'); 
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html')); 
});

app.listen(PORT, () => {
    console.log(`サーバーがポート ${PORT} で起動しました。`); 
});