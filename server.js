const express = require('express');
const path = require('path');
const WebSocket = require('ws'); // サーバー側で通信するための追加機能
const app = express();

const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname)));

// サーバー側のBot状態を管理する変数
let botWS = null;
let heartbeatInterval = null;
let isBotRunning = false;
let serverLogs = []; // スマホへ送るためのログ履歴

// ログ記録用の関数
function addLog(message) {
    // 日本時間で時間を取得
    const time = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }).split(' ')[1];
    serverLogs.push(`[${time}] ${message}`);
    if (serverLogs.length > 100) serverLogs.shift(); // ログが溜まりすぎないように100件で維持
    console.log(message);
}

// 📱スマホから「起動して！」という依頼を受け取る窓口
app.post('/api/start-bot', (req, res) => {
    const { token, code } = req.body;
    if (!token) return res.status(400).send('Token is required');

    // 既に動いている場合は一旦停止する（再起動処理）
    if (botWS) {
        botWS.close();
        clearInterval(heartbeatInterval);
        botWS = null;
    }

    serverLogs = []; // 起動時にログをリセット
    addLog('Renderサーバー上でDiscord Gatewayへ接続中...');

    // スマホから送られてきたコードを関数として組み立てる
    const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
    let userScriptFunc;
    try {
        userScriptFunc = new AsyncFunction('msg', 'send', code);
    } catch (e) {
        addLog('コードの文法エラー: ' + e.message);
        return res.status(400).send('Syntax Error');
    }

    // サーバーから直接Discordへ送信する関数
    const sendMessage = async (channelId, content) => {
        try {
            const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bot ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ content: content })
            });
            if (!response.ok) {
                const errText = await response.text();
                addLog(`送信エラー: ${response.status} ${errText}`);
            } else {
                addLog(`チャンネル ${channelId} へ送信完了`);
            }
        } catch (e) {
            addLog('通信エラー: ' + e.message);
        }
    };

    // サーバーからDiscordへWebSocket接続を開始
    botWS = new WebSocket('wss://gateway.discord.gg/?v=10&encoding=json');
    let sequence = null;

    botWS.on('message', async (data) => {
        const payload = JSON.parse(data);
        const { t, op, d, s } = payload;
        if (s) sequence = s;

        // 接続直後の認証手続き
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
                addLog(`成功: [${d.user.username}] としてサーバーで稼働開始しました✨`);
                isBotRunning = true;
            }
            if (t === 'MESSAGE_CREATE') {
                try {
                    await userScriptFunc(d, sendMessage);
                } catch (err) {
                    addLog('コード実行時エラー: ' + err.message);
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

// 📱スマホから「停止して！」という依頼を受け取る窓口
app.post('/api/stop-bot', (req, res) => {
    if (botWS) {
        botWS.close();
        clearInterval(heartbeatInterval);
        botWS = null;
        addLog('Renderサーバー上のBotを停止しました。');
    }
    isBotRunning = false;
    res.status(200).send('Stopped');
});

// 📱スマホからログを取得するための窓口
app.get('/api/logs', (req, res) => {
    res.json({ isRunning: isBotRunning, logs: serverLogs });
});

// スリープ防止用の死活監視ルート
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