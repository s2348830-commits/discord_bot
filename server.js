const express = require('express');
const path = require('path');
const app = express();

const PORT = process.env.PORT || 3000;

// JSONデータを受け取れるようにする設定（必須）
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// --- 独自のプロキシ（中継）機能 ---
// スマホ（HTML）からここへ依頼を受け、サーバーが代わりにDiscordへ送信します
app.post('/api/send-message', async (req, res) => {
    const { channelId, content, token } = req.body;

    try {
        // Node.jsサーバーからの送信なら、ブラウザ特有のCORSエラーは起きません
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
            return res.status(response.status).send(errText);
        }

        const data = await response.json();
        res.status(200).json(data);
    } catch (err) {
        res.status(500).send(err.message);
    }
});

// Renderスリープ対策用
app.get('/ping', (req, res) => {
    res.status(200).send('pong');
});

// 基本は index.html を表示
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
    console.log(`サーバーがポート ${PORT} で起動しました。`);
});