import os
import json
from flask import Flask, request, jsonify, send_file
import psycopg2
from psycopg2.extras import RealDictCursor

app = Flask(__name__)

# Credenciais pegas automaticamente das Variáveis de Ambiente do Render
DATABASE_URL = os.environ.get("DATABASE_URL")
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "sua_senha_padrao_aqui")

def get_db_connection():
    return psycopg2.connect(DATABASE_URL)

# Cria a tabela no banco automaticamente quando o app inicia
def init_db():
    if not DATABASE_URL:
        return
    with get_db_connection() as conn:
        with conn.cursor() as cur:
            cur.execute('''
                CREATE TABLE IF NOT EXISTS arquivos_json (
                    id SERIAL PRIMARY KEY,
                    nome VARCHAR(255) UNIQUE NOT NULL,
                    conteudo JSONB NOT NULL,
                    data_criacao TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            ''')
        conn.commit()

# ==========================================
# AS SUAS 4 ROTAS PRINCIPAIS
# ==========================================

# 1. Página de Upload / Envio (protegida por senha)
@app.route('/upload', methods=['POST'])
def upload_json():
    senha = request.form.get('senha')
    nome = request.form.get('nome')
    conteudo = request.form.get('conteudo') # O JSON em formato de texto

    if senha != ADMIN_PASSWORD:
        return jsonify({"erro": "Acesso negado: Senha incorreta"}), 403

    try:
        # Valida se o texto enviado é realmente um JSON
        json_valido = json.loads(conteudo)
    except json.JSONDecodeError:
        return jsonify({"erro": "O conteúdo enviado não é um JSON válido"}), 400

    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                # O comando ON CONFLICT atualiza o JSON se o nome já existir
                cur.execute('''
                    INSERT INTO arquivos_json (nome, conteudo) 
                    VALUES (%s, %s)
                    ON CONFLICT (nome) DO UPDATE SET conteudo = EXCLUDED.conteudo;
                ''', (nome, json.dumps(json_valido)))
            conn.commit()
        return jsonify({"sucesso": True, "mensagem": f"Arquivo '{nome}' salvo no PostgreSQL!"})
    except Exception as e:
        return jsonify({"erro": str(e)}), 500

# 2. Rota para ver todos os JSONs em ordem do mais recente
@app.route('/api/all', methods=['GET'])
def listar_todos():
    with get_db_connection() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            # Retorna apenas o nome e a data, sem pesar carregando o conteúdo todo
            cur.execute('SELECT nome, data_criacao FROM arquivos_json ORDER BY data_criacao DESC')
            rows = cur.fetchall()
    return jsonify(rows)

# 3. Rota do Contador
@app.route('/count', methods=['GET'])
def contar():
    with get_db_connection() as conn:
        with conn.cursor() as cur:
            cur.execute('SELECT COUNT(*) FROM arquivos_json')
            total = cur.fetchone()[0]
    return jsonify({"total_jsons": total})

# 4. Rota para ler o conteúdo de um JSON específico (meuseiterender/nomedojson)
@app.route('/<nomedojson>', methods=['GET'])
def ver_json(nomedojson):
    # Proteção para não conflitar com as rotas do sistema
    if nomedojson in ['upload', 'api', 'count']:
        return "Rota reservada", 404

    with get_db_connection() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute('SELECT conteudo FROM arquivos_json WHERE nome = %s', (nomedojson,))
            row = cur.fetchone()
            
    if row:
        return jsonify(row['conteudo'])
    return jsonify({"erro": "JSON não encontrado no banco de dados"}), 404


# Rota para servir o seu frontend HTML
@app.route('/')
def index():
    return send_file('index.html')

if __name__ == '__main__':
    init_db()
    # Pega a porta automaticamente do Render
    port = int(os.environ.get("PORT", 10000))
    app.run(host='0.0.0.0', port=port)
