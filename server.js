const express = require('express');
const path = require('path');
const WebSocket = require('ws');
const app = express();

const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname)));

let botWS = null;
let heartbeatInterval = null;
let isBotRunning = false;
let serverLogs = [];

// ログ記録用の関数
function addLog(message) {
    const time = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }).split(' ')[1];
    serverLogs.push(`[${time}] ${message}`);
    if (serverLogs.length > 100) serverLogs.shift();
    console.log(message);
}

app.post('/api/start-bot', (req, res) => {
    const { token, code } = req.body;
    if (!token) return res.status(400).send('Token is required');

    if (botWS) {
        botWS.close();
        clearInterval(heartbeatInterval);
        botWS = null;
    }

    serverLogs = [];
    addLog('Renderサーバー上でDiscord Gatewayへ接続中...');

    const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
    let userScriptFunc;
    try {
        // 新仕様: eventType, data, send, reply の4つを扱えるように定義
        userScriptFunc = new AsyncFunction('eventType', 'data', 'send', 'reply', code);
    } catch (e) {
        addLog('コードの文法エラー: ' + e.message);
        return res.status(400).send('Syntax Error');
    }

    // ★進化版: テキスト、ボタン(components)、画像(embeds)を送信できる関数
    const sendMessage = async (channelId, content, components = null, embeds = null) => {
        try {
            const body = {};
            if (content) body.content = content;
            if (components && components.length > 0) body.components = components;
            if (embeds && embeds.length > 0) body.embeds = embeds; // 画像や埋め込みデータ用

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
                addLog(`送信エラー: ${response.status} ${errText}`);
            } else {
                addLog(`チャンネルへメッセージ(画像/ボタン含む)を送信しました`);
            }
        } catch (e) {
            addLog('通信エラー: ' + e.message);
        }
    };

    // ★進化版: ボタンが押された時に、本人にだけ「こっそり(画像やボタン付きで)」返信する関数
    const replyInteraction = async (interactionId, interactionToken, content, components = null, embeds = null) => {
        try {
            const dataPayload = { flags: 64 }; // 64 = Ephemeral（本人にしか見えない設定）
            if (content) dataPayload.content = content;
            if (components && components.length > 0) dataPayload.components = components;
            if (embeds && embeds.length > 0) dataPayload.embeds = embeds;

            const response = await fetch(`https://discord.com/api/v10/interactions/${interactionId}/${interactionToken}/callback`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    type: 4, 
                    data: dataPayload
                })
            });
            if (!response.ok) {
                const errText = await response.text();
                addLog(`ボタン応答エラー: ${response.status} ${errText}`);
            } else {
                addLog(`ボタンの応答完了(こっそり表示)`);
            }
        } catch (e) {
            addLog('インタラクション通信エラー: ' + e.message);
        }
    };

    // DiscordとのWebSocket接続
    botWS = new WebSocket('wss://gateway.discord.gg/?v=10&encoding=json');
    let sequence = null;

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

            botWS.send(JSON.stringify({
                op: 2,
                d: {
                    token: token,
                    intents: 33281, // メッセージ読み取り権限
                    properties: { os: 'linux', browser: 'render_server', device: 'render_server' }
                }
            }));
        }

        if (op === 0) {
            if (t === 'READY') {
                addLog(`成功: [${d.user.username}] として稼働開始しました✨`);
                isBotRunning = true;
            }
            
            // チャットを受信した時の処理 (eventType = 'MESSAGE')
            if (t === 'MESSAGE_CREATE') {
                try {
                    await userScriptFunc('MESSAGE', d, sendMessage, replyInteraction);
                } catch (err) {
                    addLog('コード実行時エラー(MESSAGE): ' + err.message);
                }
            }
            
            // ボタンが押された時の処理 (eventType = 'INTERACTION')
            if (t === 'INTERACTION_CREATE') {
                try {
                    await userScriptFunc('INTERACTION', d, sendMessage, replyInteraction);
                } catch (err) {
                    addLog('コード実行時エラー(INTERACTION): ' + err.message);
                }
            }
        }

        if (op === 9) {
            addLog('セッションが無効です。トークンを確認してください。');
            isBotRunning = false;
        }
    });

    botWS.on('close', (code) => {
        addLog(`切断されました。(コード: ${code})`);
        isBotRunning = false;
    });

    botWS.on('error', (err) => {
        addLog('WebSocketエラー: ' + err.message);
        isBotRunning = false;
    });

    res.status(200).send('Bot Started');
});

// スマホから「停止して！」という依頼を受け取る窓口
app.post('/api/stop-bot', (req, res) => {
    if (botWS) {
        botWS.close();
        clearInterval(heartbeatInterval);
        botWS = null;
        addLog('Botを停止しました。');
    }
    isBotRunning = false;
    res.status(200).send('Stopped');
});

// スマホからログを取得するための窓口
app.get('/api/logs', (req, res) => {
    res.json({ isRunning: isBotRunning, logs: serverLogs });
});

// Renderのスリープ防止用（cron-job.orgからのノック窓口）
app.get('/ping', (req, res) => {
    res.status(200).send('pong');
});

// 通常のアクセスはスマホ用ツール(index.html)を表示
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
    console.log(`サーバーがポート ${PORT} で起動しました。`);
});