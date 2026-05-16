require('dotenv').config();
const express = require('express');
const fs = require('fs');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const PASSWORD = process.env.ADMIN_PASSWORD; // Puxa a senha do ENV
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
// 1. API: Listar todos (Máximo 200, mais recentes primeiro)
// ==========================================
app.get('/api/all', (req, res) => {
    const links = loadLinks();
    
    // Ordena por data (decrescente/mais novo pro mais velho)
    const sortedLinks = links.sort((a, b) => new Date(b.date) - new Date(a.date));
    
    // Pega apenas os 200 primeiros
    const top200 = sortedLinks.slice(0, 200);
    
    res.json(top200);
});

// ==========================================
// 2. API: Adicionar um Link
// ==========================================
app.post('/api/add', (req, res) => {
    const { url, name, password } = req.body;

    // Verifica a senha do ENV
    if (password !== PASSWORD) {
        return res.status(401).json({ error: "Acesso Negado: Senha incorreta" });
    }
    if (!url || !name) {
        return res.status(400).json({ error: "Você precisa enviar a 'url' e o 'name'" });
    }

    let links = loadLinks();

    // Se já existir um link com esse nome, remove para substituir
    links = links.filter(l => l.name !== name);

    const newLink = {
        id: Date.now().toString(), // ID único baseado no tempo
        name: name,
        url: url,
        date: new Date().toISOString() // Salva a data atual
    };

    links.push(newLink);
    saveLinks(links);

    res.json({ message: "Link salvo com sucesso!", link: newLink });
});

// ==========================================
// 3. API: Remover um Link
// ==========================================
app.post('/api/remove', (req, res) => {
    const { name, password } = req.body;

    if (password !== PASSWORD) {
        return res.status(401).json({ error: "Acesso Negado: Senha incorreta" });
    }

    let links = loadLinks();
    const tamanhoOriginal = links.length;
    
    links = links.filter(l => l.name !== name);
    saveLinks(links);

    if (links.length < tamanhoOriginal) {
        res.json({ message: `Link /${name} deletado com sucesso!` });
    } else {
        res.status(404).json({ error: "Link não encontrado!" });
    }
});

// ==========================================
// 4. Redirecionamento Final (meu-site.com/onome)
// ==========================================
app.get('/:name', (req, res) => {
    const links = loadLinks();
    const linkBuscado = links.find(l => l.name === req.params.name);

    if (linkBuscado) {
        // Manda o usuário para a URL original
        res.redirect(linkBuscado.url);
    } else {
        res.status(404).send("Link não encontrado.");
    }
});

// Inicia o servidor
app.listen(PORT, () => {
    console.log(`Sistema rodando na porta ${PORT}`);
});