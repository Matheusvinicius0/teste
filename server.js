const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

// O identificador da sua pasta no Internet Archive
const IA_IDENTIFIER = 'fenix-json';

// Rota antiga de configuração
app.get('/api/config', (req, res) => {
    res.json({ CHAVE_FIXA: process.env.CHAVE_FIXA || "" });
});

// =======================================================
// ROTA DA API: Processa no backend e retorna JSON legítimo
// =======================================================
app.get('/api/all', async (req, res) => {
    try {
        // Busca a lista de arquivos diretamente pelo servidor
        const response = await fetch(`https://archive.org/metadata/${IA_IDENTIFIER}?t=${Date.now()}`);

        if (!response.ok) {
            throw new Error("Falha ao buscar metadados no Internet Archive.");
        }

        const data = await response.json();
        const files = data.files || [];

        // 1. Filtra para pegar apenas os arquivos .enc
        let arquivosFiltrados = files.filter(f => f.name.endsWith('.enc'));

        // 2. Ordena pela data de modificação (mtime), do mais RECENTE para o mais antigo
        arquivosFiltrados.sort((a, b) => parseInt(b.mtime) - parseInt(a.mtime));

        // 3. Corta a lista para pegar apenas os 200 primeiros
        const top200 = arquivosFiltrados.slice(0, 200);

        // 4. Formata a saída dos metadados
        const resultadoLimpo = top200.map(arquivo => {
            const dataLegivel = new Date(parseInt(arquivo.mtime) * 1000).toLocaleString('pt-BR');
            return {
                id: arquivo.name.replace('.enc', ''),
                                          arquivo_completo: arquivo.name,
                                          tamanho: arquivo.size + " bytes",
                                          data_atualizacao: dataLegivel
            };
        });

        // Cria a estrutura do JSON final
        const respostaFinal = {
            sucesso: true,
            total_mostrado: resultadoLimpo.length,
            arquivos: resultadoLimpo
        };

        // Envia como JSON nativo (com o Content-Type: application/json)
        res.json(respostaFinal);

    } catch (error) {
        // Em caso de erro, envia o erro formatado em JSON com o status HTTP 500
        res.status(500).json({
            sucesso: false,
            erro: "Ocorreu um erro ao buscar os arquivos no servidor.",
            detalhe: error.message
        });
    }
});

// Qualquer outra rota (incluindo a raiz '/') vai redirecionar automaticamente para a API
app.get('*', (req, res) => {
    res.redirect('/api/all');
});

app.listen(PORT, () => {
    console.log(`Servidor Fenixflix rodando na porta ${PORT}`);
});
