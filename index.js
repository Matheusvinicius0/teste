require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const { Pool } = require('pg');

const app = express();
const upload = multer();

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
    const queryPedidos = `
        CREATE TABLE IF NOT EXISTS pedidos_sugeridos (
            id SERIAL PRIMARY KEY,
            imdb_id VARCHAR(50) NOT NULL,
            tipo VARCHAR(20) NOT NULL,
            episodio VARCHAR(50),
            criado_em TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
    `;
    try {
        await pool.query(query);
        await pool.query(queryPedidos);
        console.log('Tabelas de banco de dados verificadas/criadas com sucesso.');
    } catch (err) {
        console.error('Erro ao criar tabelas:', err);
    }
};
initDB();

// ==========================================
// ROTA 0: Servir o Frontend (index.html)
// ==========================================
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ==========================================
// CONFIGURAÇÕES TMDB E RPDB
// ==========================================
const TMDB_API_KEY = "eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiJlZTBmMzJmNzY5Mzc0YTkzYTI0ZmNiYzcyMWRlODYzNCIsIm5iZiI6MTc1NjA2MzM2NC4yMzksInN1YiI6IjY4YWI2Njg0ZDAyMjdhYTVlMjlkYjE2MSIsInNjb3BlcyI6WyJhcGlfcmVhZCJdLCJ2ZXJzaW9uIjoxfQ.z1hG61Z5RCvn6qEZj60sHxrDZ0hR8QQi4rt18erzF-w";
const RPDB_BASE_URL = "https://api.ratingposterdb.com/t0-free-rpdb";

async function getTMDBInfo(id) {
    try {
        const url = `https://api.themoviedb.org/3/find/${id}?external_source=imdb_id&language=pt-BR`;
        const res = await fetch(url, {
            headers: {
                "User-Agent": "Mozilla/5.0",
                "Accept": "application/json",
                "Authorization": `Bearer ${TMDB_API_KEY}`
            }
        });
        if (!res.ok) {
            console.warn(`⚠️ TMDB recusou o pedido para o ID ${id}. Status: ${res.status}`);
            return null;
        }
        const data = await res.json();
        
        if (data.movie_results && data.movie_results.length > 0) {
            const movie = data.movie_results[0];
            return {
                title: movie.title,
                year: movie.release_date ? movie.release_date.substring(0, 4) : "",
                type: "movie"
            };
        } else if (data.tv_results && data.tv_results.length > 0) {
            const show = data.tv_results[0];
            return {
                title: show.name,
                year: show.first_air_date ? show.first_air_date.substring(0, 4) : "",
                type: "series"
            };
        }
    } catch (err) {
        console.error(`❌ Erro ao buscar dados no TMDB para o ID ${id}:`, err.message);
    }
    return null;
}

async function getCinemetaInfo(id, type) {
    try {
        const url = `https://v3-cinemeta.strem.io/meta/${type}/${id}.json`;
        const res = await fetch(url, {
            headers: {
                "User-Agent": "Mozilla/5.0"
            }
        });
        if (!res.ok) return null;
        const data = await res.json();
        return data.meta || null;
    } catch (err) {
        console.error(`❌ Erro ao buscar no Cinemeta para o ID ${id}:`, err.message);
    }
    return null;
}

// ==========================================
// ROTA 1: Enviar JSON (Protegida por senha)
// ==========================================
app.post('/upload', upload.none(), async (req, res) => {
    const { senha, nome, conteudo } = req.body;

    // Validação da senha
    if (senha !== process.env.ADMIN_PASSWORD) {
        return res.status(401).json({ erro: 'Senha incorreta ou ausente.' });
    }

    if (!nome || !conteudo) {
        return res.status(400).json({ erro: 'O nome e o conteúdo do JSON são obrigatórios.' });
    }

    let parsedConteudo = conteudo;
    if (typeof conteudo === 'string') {
        try {
            parsedConteudo = JSON.parse(conteudo);
        } catch (e) {
            return res.status(400).json({ erro: 'O conteúdo enviado não é um JSON válido.' });
        }
    }

    // ==========================================
    // ENRIQUECIMENTO TMDB/CINEMETA/RPDB
    // ==========================================
    try {
        let imdbID = "";
        if (typeof parsedConteudo.id === 'string' && parsedConteudo.id.startsWith('tt')) {
            imdbID = parsedConteudo.id;
        } else if (nome && nome.startsWith('tt')) {
            imdbID = nome;
        }

        if (imdbID) {
            const tmdbData = await getTMDBInfo(imdbID);
            if (tmdbData) {
                parsedConteudo.title = tmdbData.title;
                if (!parsedConteudo.type) {
                    parsedConteudo.type = tmdbData.type;
                }
            }

            const cType = parsedConteudo.type || "movie";
            const cinemetaData = await getCinemetaInfo(imdbID, cType);
            if (cinemetaData) {
                if (cinemetaData.videos) {
                    parsedConteudo.cinemetaVideos = cinemetaData.videos;
                }
            }

            if (!parsedConteudo.poster) {
                parsedConteudo.poster = `${RPDB_BASE_URL}/imdb/poster-default/${imdbID}.jpg`;
            }

            if (!parsedConteudo.id) {
                parsedConteudo.id = imdbID;
            }
        }
    } catch (enrichErr) {
        console.error("⚠️ Falha ao enriquecer metadados do JSON:", enrichErr.message);
    }
    // ==========================================

    try {
        // Usa ON CONFLICT para atualizar o JSON se o nome já existir (comportamento de UPSERT)
        const query = `
            INSERT INTO arquivos_json (nome_do_json, conteudo) 
            VALUES ($1, $2)
            ON CONFLICT (nome_do_json) 
            DO UPDATE SET conteudo = EXCLUDED.conteudo, criado_em = CURRENT_TIMESTAMP
            RETURNING *;
        `;
        const values = [nome, JSON.stringify(parsedConteudo)];
        
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
// ROTA 2b: Listar todos para o Catálogo (/api/catalog)
// ==========================================
app.get('/api/catalog', async (req, res) => {
    try {
        const query = 'SELECT conteudo FROM arquivos_json ORDER BY criado_em DESC;';
        const result = await pool.query(query);
        res.json(result.rows.map(r => r.conteudo));
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao carregar o catálogo.' });
    }
});

// ==========================================
// ROTA 2c: Apagar JSON (/api/delete)
// ==========================================
app.post('/api/delete', async (req, res) => {
    const { id, senha } = req.body;
    const adminPassword = process.env.ADMIN_PASSWORD || "sua_senha_padrao_aqui";

    if (senha !== adminPassword) {
        return res.status(401).json({ erro: 'Senha incorreta.' });
    }

    if (!id) {
        return res.status(400).json({ erro: 'O nome/ID é obrigatório.' });
    }

    try {
        const query = `
            DELETE FROM arquivos_json 
            WHERE nome_do_json = $1 OR conteudo->>'id' = $1;
        `;
        await pool.query(query, [id]);
        res.json({ sucesso: true, mensagem: `Arquivo '${id}' removido com sucesso.` });
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao apagar o arquivo do banco.' });
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
    if (req.params.nome === 'favicon.ico') return res.status(204).end();
    if (['upload', 'api', 'count'].includes(req.params.nome)) {
        return res.status(404).json({ erro: 'Rota reservada.' });
    }
    try {
        const query = `
            UPDATE arquivos_json 
            SET conteudo = jsonb_set(
                conteudo, 
                '{views}', 
                to_jsonb(COALESCE((conteudo->>'views')::int, 0) + 1)
            ) 
            WHERE nome_do_json = $1 
            RETURNING conteudo;
        `;
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
// ROTA 4b: Ranking de Acessos (/api/vistos)
// ==========================================
app.get('/api/vistos', async (req, res) => {
    try {
        const query = `
            SELECT 
                nome_do_json AS id, 
                COALESCE((conteudo->>'views')::int, 0) AS v
            FROM arquivos_json
            ORDER BY v DESC;
        `;
        const result = await pool.query(query);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao buscar ranking de acessos.' });
    }
});

// ==========================================
// ROTA 5: Estatísticas de Armazenamento (/api/stats)
// ==========================================
app.get('/api/stats', async (req, res) => {
    try {
        const query = `
            SELECT 
                (pg_total_relation_size('arquivos_json') + COALESCE(pg_total_relation_size('pedidos_sugeridos'), 0)) AS total_size,
                (SELECT COALESCE(SUM(octet_length(conteudo::text)), 0) FROM arquivos_json WHERE conteudo->>'type' = 'movie') AS movie_size,
                (SELECT COALESCE(SUM(octet_length(conteudo::text)), 0) FROM arquivos_json WHERE conteudo->>'type' = 'series') AS series_size,
                (SELECT COUNT(*) FROM arquivos_json WHERE conteudo->>'type' = 'movie') AS movie_count,
                (SELECT COUNT(*) FROM arquivos_json WHERE conteudo->>'type' = 'series') AS series_count,
                (SELECT COUNT(*) FROM arquivos_json) AS total_count;
        `;
        const result = await pool.query(query);
        const stats = result.rows[0];
        
        res.json({
            total_bytes: parseInt(stats.total_size, 10),
            movie_bytes: parseInt(stats.movie_size, 10),
            series_bytes: parseInt(stats.series_size, 10),
            movie_count: parseInt(stats.movie_count, 10),
            series_count: parseInt(stats.series_count, 10),
            total_count: parseInt(stats.total_count, 10)
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao buscar estatísticas do banco de dados.' });
    }
});

// ==========================================
// ROTA 6: Verificar Senha (/api/verify)
// ==========================================
app.post('/api/verify', (req, res) => {
    const { senha } = req.body;
    const adminPassword = process.env.ADMIN_PASSWORD || "sua_senha_padrao_aqui";

    if (senha === adminPassword) {
        return res.json({ sucesso: true });
    }
    return res.status(401).json({ erro: 'Senha incorreta.' });
});

// ==========================================
// ROTA 7: Adicionar Pedido (/api/pedidos)
// ==========================================
app.post('/api/pedidos', async (req, res) => {
    const { id, type, episode } = req.body;

    if (!id || !type) {
        return res.status(400).json({ erro: 'ID (IMDb) e tipo são obrigatórios.' });
    }

    try {
        const query = `
            INSERT INTO pedidos_sugeridos (imdb_id, tipo, episodio)
            VALUES ($1, $2, $3)
            RETURNING *;
        `;
        const values = [id, type, episode || null];
        await pool.query(query, values);
        res.status(201).json({ mensagem: 'Pedido registrado com sucesso!' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao registrar pedido no banco.' });
    }
});

// ==========================================
// ROTA 8: Listar e Somar Pedidos (/api/pedidos)
// ==========================================
app.get('/api/pedidos', async (req, res) => {
    const { id, type, episode } = req.query;

    // Se o usuário passou parâmetros de busca na URL (GET), ele quer criar um pedido direto pelo link do navegador
    if (id && type) {
        try {
            const queryInsert = `
                INSERT INTO pedidos_sugeridos (imdb_id, tipo, episodio)
                VALUES ($1, $2, $3);
            `;
            await pool.query(queryInsert, [id, type, episode || null]);
            return res.json({ sucesso: true, mensagem: `Pedido para o ID '${id}' registrado com sucesso no banco de dados!` });
        } catch (err) {
            console.error(err);
            return res.status(500).json({ erro: 'Erro ao registrar pedido via URL.' });
        }
    }

    // Caso contrário (sem parâmetros), apenas lista todos
    try {
        const query = `
            SELECT 
                imdb_id AS id, 
                tipo AS type, 
                COUNT(*)::int AS count,
                COALESCE(
                    array_to_json(array_remove(array_agg(DISTINCT episodio), NULL)),
                    '[]'::json
                ) AS episodes
            FROM pedidos_sugeridos
            GROUP BY imdb_id, tipo
            ORDER BY count DESC;
        `;
        const result = await pool.query(query);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao buscar pedidos no banco.' });
    }
});

// ==========================================
// ROTA 9: Apagar Pedido (/api/pedidos/delete)
// ==========================================
app.post('/api/pedidos/delete', async (req, res) => {
    const { id, senha } = req.body;
    const adminPassword = process.env.ADMIN_PASSWORD || "sua_senha_padrao_aqui";

    if (senha !== adminPassword) {
        return res.status(401).json({ erro: 'Senha incorreta.' });
    }

    if (!id) {
        return res.status(400).json({ erro: 'ID (IMDb) é obrigatório.' });
    }

    try {
        const query = 'DELETE FROM pedidos_sugeridos WHERE imdb_id = $1;';
        await pool.query(query, [id]);
        res.json({ sucesso: true, mensagem: `Pedidos para o ID '${id}' removidos.` });
    } catch (err) {
        console.error(err);
        res.status(500).json({ erro: 'Erro ao apagar pedidos do banco.' });
    }
});

// ==========================================
// TAREFA AGENDADA: Limpeza semanal dos arquivos mais vistos
// ==========================================
const verificarELimparMaisVistos = async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS agenda_tarefas (
                chave VARCHAR(50) PRIMARY KEY,
                ultimo_executado TIMESTAMP WITH TIME ZONE NOT NULL
            );
        `);

        const res = await pool.query("SELECT ultimo_executado FROM agenda_tarefas WHERE chave = 'limpeza_mais_vistos';");
        
        const agora = new Date();
        if (res.rows.length === 0) {
            await pool.query("INSERT INTO agenda_tarefas (chave, ultimo_executado) VALUES ('limpeza_mais_vistos', $1);", [agora]);
            await executarLimpezaMaisVistosNode();
        } else {
            const ultimoExecutado = new Date(res.rows[0].ultimo_executado);
            const seteDiasEmMs = 7 * 24 * 60 * 60 * 1000;
            if (agora - ultimoExecutado >= seteDiasEmMs) {
                console.log("Executando limpeza semanal dos arquivos mais vistos...");
                await executarLimpezaMaisVistosNode();
                await pool.query("UPDATE agenda_tarefas SET ultimo_executado = $1 WHERE chave = 'limpeza_mais_vistos';", [agora]);
            }
        }
    } catch (err) {
        console.error("Erro ao verificar/executar limpeza semanal:", err);
    }
};

const executarLimpezaMaisVistosNode = async () => {
    try {
        const resetQuery = `
            UPDATE arquivos_json 
            SET conteudo = jsonb_set(conteudo, '{views}', '0'::jsonb)
            WHERE id IN (
                SELECT id 
                FROM arquivos_json 
                WHERE COALESCE((conteudo->>'views')::int, 0) > 0 
                ORDER BY COALESCE((conteudo->>'views')::int, 0) DESC 
                LIMIT 10
            );
        `;
        const res = await pool.query(resetQuery);
        console.log(`Limpeza semanal concluída. Total de visualizações zeradas: ${res.rowCount}`);
    } catch (err) {
        console.error("Erro na query de limpeza de visualizações:", err);
    }
};

// ==========================================
// INICIALIZAÇÃO DO SERVIDOR
// ==========================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
    console.log(`Servidor rodando na porta ${PORT}`);
    
    // Executa verificação inicial de limpeza
    await verificarELimparMaisVistos();
    
    // Agenda para rodar a cada 1 hora
    setInterval(verificarELimparMaisVistos, 60 * 60 * 1000);
});