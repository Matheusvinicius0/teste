require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path'); // Necessário para enviar o index.html

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const PASSWORD = process.env.ADMIN_PASSWORD;
const DB_FILE = './links.json';

// Função para carregar os links salvos
const loadLinks = () => {
    if (fs.existsSync(DB_FILE)) {
        const data = fs.readFileSync(DB_FILE, 'utf8');
        return data ? JSON.parse(data) : [];
    }
    return [];
};

// Função para salvar no JSON
const saveLinks = (links) => {
    fs.writeFileSync(DB_FILE, JSON.stringify(links, null, 2));
};

// ==========================================
// 1. Rota da Página Inicial (Index)
// ==========================================
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ==========================================
// 2. API: Listar todos
// ==========================================
app.get('/api/all', (req, res) => {
    const links = loadLinks();
    const sortedLinks = links.sort((a, b) => new Date(b.date) - new Date(a.date));
    const top200 = sortedLinks.slice(0, 200);
    res.json(top200);
});

// ==========================================
// 3. API: Adicionar um Link
// ==========================================
app.post('/api/add', (req, res) => {
    const { url, name, password } = req.body;

    if (password !== PASSWORD) {
        return res.status(401).json({ error: "Acesso Negado: Senha incorreta" });
    }
    if (!url || !name) {
        return res.status(400).json({ error: "Você precisa enviar a 'url' e o 'name'" });
    }

    let links = loadLinks();
    links = links.filter(l => l.name !== name); // Remove se já existir para substituir

    const newLink = {
        id: Date.now().toString(),
         name: name,
         url: url,
         date: new Date().toISOString()
    };

    links.push(newLink);
    saveLinks(links);

    res.json({ message: "Link salvo com sucesso!", link: newLink });
});

// ==========================================
// 4. Redirecionamento Final (DEVE SER A ÚLTIMA ROTA)
// ==========================================
app.get('/:name', (req, res) => {
    // Evita que o navegador tente buscar um favicon e acabe buscando um link
    if (req.params.name === 'favicon.ico') return res.status(204).end();

    const links = loadLinks();
    const linkBuscado = links.find(l => l.name === req.params.name);

    if (linkBuscado) {
        res.redirect(linkBuscado.url);
    } else {
        res.status(404).send("Link não encontrado.");
    }
});

// Inicia o servidor
app.listen(PORT, () => {
    console.log(`Sistema rodando na porta ${PORT}`);
});
