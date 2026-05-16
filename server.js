const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

// Serve os arquivos estáticos da mesma pasta
app.use(express.static(__dirname));

// Rota para expor a variável de ambiente de forma controlada
app.get('/api/config', (req, res) => {
    res.json({
        CHAVE_FIXA: process.env.CHAVE_FIXA || ""
    });
});

// Qualquer outra rota redireciona para o index.html
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Servidor Fenixflix rodando na porta ${PORT}`);
});
