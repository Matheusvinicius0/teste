require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();

// Otimização: Limita o tamanho do JSON para 2MB para não estourar a RAM no plano gratuito
app.use(express.json({ limit: '2mb' })); 
app.use(cors());

// Configuração do banco de dados (Pool pequeno para economizar memória)
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 5, // Limita as conexões simultâneas
    ssl: { rejectUnauthorized: false } // Necessário para serviços gerenciados como Render/Supabase
});

// Criação automática da tabela caso não exista
const initDB = async () => {
    const query = `
        CREATE TABLE IF NOT EXISTS arquivos_json (
            id SERIAL PRIMARY KEY,
            nome_do_json VARCHAR(255) UNIQUE NOT NULL,
            conteudo JSONB NOT NULL,
            criado_em TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
    `;
    try {
        await pool.query(query);
        console.log('Tabela de arquivos_json verificada/criada com sucesso.');
    } catch (err) {
        console.error('Erro ao criar tabela:', err);
    }
};
initDB();

// ==========================================
// ROTA 1: Enviar JSON (Protegida por senha)
// ==========================================
app.post('/upload', async (req, res) => {
    const { senha, nome, conteudo } = req.body;

    // Validação da senha
    if (senha !== process.env.ADMIN_PASSWORD) {
        return res.status(401).json({ erro: 'Senha incorreta ou ausente.' });
    }

    if (!nome || !conteudo) {
        return res.status(400).json({ erro: 'O nome e o conteúdo do JSON são obrigatórios.' });
    }

    try {
        // Usa ON CONFLICT para atualizar o JSON se o nome já existir (comportamento de UPSERT)
        const query = `
            INSERT INTO arquivos_json (nome_do_json, conteudo) 
            VALUES ($1, $2)
            ON CONFLICT (nome_do_json) 
            DO UPDATE SET conteudo = EXCLUDED.conteudo, criado_em = CURRENT_TIMESTAMP
            RETURNING *;
        `;
        const values = [nome, JSON.stringify(conteudo)];
        
        await pool.query(query, values);
        res.status(201).json({ mensagem: `JSON '${nome}' salvo com sucesso!` });
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro interno ao salvar no banco de dados.' });
    }
});

// ==========================================
// ROTA 2: Listar todos os JSONs (/api/all)
// ==========================================
app.get('/api/all', async (req, res) => {
    try {
        const query = 'SELECT nome_do_json, conteudo FROM arquivos_json ORDER BY criado_em DESC;';
        const result = await pool.query(query);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao buscar os dados.' });
    }
});

// ==========================================
// ROTA 3: Contar total de JSONs (/count)
// ==========================================
app.get('/count', async (req, res) => {
    try {
        const query = 'SELECT COUNT(*) FROM arquivos_json;';
        const result = await pool.query(query);
        // Retorna o número como inteiro
        res.json({ total: parseInt(result.rows[0].count, 10) }); 
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao contar os arquivos.' });
    }
});

// ==========================================
// ROTA 4: Visualizar JSON específico (/:nome)
// ==========================================
app.get('/:nome', async (req, res) => {
    try {
        const query = 'SELECT conteudo FROM arquivos_json WHERE nome_do_json = $1;';
        const result = await pool.query(query, [req.params.nome]);

        if (result.rows.length === 0) {
            return res.status(404).json({ erro: 'JSON não encontrado.' });
        }

        // Retorna diretamente o objeto JSON, sem encapsular
        res.json(result.rows[0].conteudo);
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro interno ao buscar o arquivo.' });
    }
});

// ==========================================
// INICIALIZAÇÃO DO SERVIDOR
// ==========================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});