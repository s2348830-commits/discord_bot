const express = require('express');
const path = require('path');
const app = express();

// Renderが自動で割り当てるポート番号、またはローカル環境用の3000番を使用
const PORT = process.env.PORT || 3000;

// 現在のディレクトリにあるファイル（index.html, style.cssなど）を公開設定
app.use(express.static(path.join(__dirname)));

// スリープ対策用の軽量な応答ルート（アクセスされたら'pong'を返すだけ）
app.get('/ping', (req, res) => {
    res.status(200).send('pong');
});

// どのURLにアクセスされても基本的にはindex.htmlを表示する
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// サーバー起動
app.listen(PORT, () => {
    console.log(`サーバーがポート ${PORT} で起動しました。`);
});