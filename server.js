const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(__dirname));

// Rota antiga de configuração
app.get('/api/config', (req, res) => {
    res.json({ CHAVE_FIXA: process.env.CHAVE_FIXA || "" });
});

// ==========================================
// NOVA ROTA: Entrega o seu novo HTML de API
// ==========================================
app.get('/api/all', (req, res) => {
    res.sendFile(path.join(__dirname, 'all.html'));
});

// Qualquer outra rota redireciona para o index.html principal
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Servidor Fenixflix rodando na porta ${PORT}`);
});
