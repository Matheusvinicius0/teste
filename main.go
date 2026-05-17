package main

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	_ "github.com/lib/pq"
)

var db *sql.DB

// Estrutura para a rota de listagem
type ResumoArquivo struct {
	Nome        string    `json:"nome"`
	DataCriacao time.Time `json:"data_criacao"`
}

func initDB() {
	connStr := os.Getenv("DATABASE_URL")
	if connStr == "" {
		log.Println("⚠️ AVISO CRÍTICO: DATABASE_URL não está configurada! A API não conseguirá gravar nem ler do banco de dados.")
		return
	}

	var err error
	db, err = sql.Open("postgres", connStr)
	if err != nil {
		log.Fatalf("❌ Erro ao abrir conexão: %v", err)
	}

	// Testa se a comunicação com o banco realmente funciona
	err = db.Ping()
	if err != nil {
		log.Fatalf("❌ Falha na comunicação com o PostgreSQL: %v", err)
	}

	// Cria a tabela caso não exista
	query := `
		CREATE TABLE IF NOT EXISTS arquivos_json (
			id SERIAL PRIMARY KEY,
			nome VARCHAR(255) UNIQUE NOT NULL,
			conteudo JSONB NOT NULL,
			data_criacao TIMESTAMP DEFAULT CURRENT_TIMESTAMP
		)
	`
	_, err = db.Exec(query)
	if err != nil {
		log.Fatalf("❌ Erro ao criar tabela: %v", err)
	}
	fmt.Println("✅ Banco de dados PostgreSQL conectado e tabela verificada.")
}

func main() {
	initDB()

	mux := http.NewServeMux()

	// Rotas da API
	mux.HandleFunc("/upload", uploadHandler)
	mux.HandleFunc("/api/all", listAllHandler)
	mux.HandleFunc("/count", countHandler)
	mux.HandleFunc("/ping", pingHandler) // Nova rota para testar a ligação
	
	// Rota Raiz (Serve o HTML ou busca o JSON pelo nome)
	mux.HandleFunc("/", rootHandler)

	// Middleware de CORS
	handler := corsMiddleware(mux)

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	fmt.Printf("🚀 FenixFlix (Go) a rodar na porta %s\n", port)
	log.Fatal(http.ListenAndServe(":"+port, handler))
}

// 1. Rota de Upload (Protegida)
func uploadHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	
	// Proteção contra crash se o banco estiver off
	if db == nil {
		w.WriteHeader(http.StatusInternalServerError)
		w.Write([]byte(`{"erro": "Servidor sem conexão com o banco de dados. Configure a DATABASE_URL."}`))
		return
	}

	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		w.Write([]byte(`{"erro": "Método não permitido"}`))
		return
	}

	senha := r.FormValue("senha")
	nome := r.FormValue("nome")
	conteudo := r.FormValue("conteudo")

	adminPassword := os.Getenv("ADMIN_PASSWORD")
	if adminPassword == "" {
		adminPassword = "sua_senha_padrao_aqui" // Fallback
	}

	if senha != adminPassword {
		w.WriteHeader(http.StatusForbidden)
		w.Write([]byte(`{"erro": "Acesso negado: Senha incorreta"}`))
		return
	}

	if nome == "" || conteudo == "" {
		w.WriteHeader(http.StatusBadRequest)
		w.Write([]byte(`{"erro": "Nome e conteúdo são obrigatórios"}`))
		return
	}

	if !json.Valid([]byte(conteudo)) {
		w.WriteHeader(http.StatusBadRequest)
		w.Write([]byte(`{"erro": "O conteúdo enviado não é um JSON válido"}`))
		return
	}

	query := `
		INSERT INTO arquivos_json (nome, conteudo) 
		VALUES ($1, $2)
		ON CONFLICT (nome) DO UPDATE SET conteudo = EXCLUDED.conteudo;
	`
	_, err := db.Exec(query, nome, conteudo)
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		w.Write([]byte(fmt.Sprintf(`{"erro": "%s"}`, err.Error())))
		return
	}

	w.Write([]byte(fmt.Sprintf(`{"sucesso": true, "mensagem": "'%s' salvo com sucesso no banco de dados!"}`, nome)))
}

// 2. Rota para listar todos (Catálogo)
func listAllHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	// Proteção contra crash
	if db == nil {
		http.Error(w, `[{"erro": "Banco de dados offline"}]`, http.StatusInternalServerError)
		return
	}

	rows, err := db.Query("SELECT nome, data_criacao FROM arquivos_json ORDER BY data_criacao DESC")
	if err != nil {
		http.Error(w, `{"erro": "Falha ao buscar arquivos"}`, http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	var arquivos []ResumoArquivo
	for rows.Next() {
		var a ResumoArquivo
		if err := rows.Scan(&a.Nome, &a.DataCriacao); err == nil {
			arquivos = append(arquivos, a)
		}
	}

	if arquivos == nil {
		arquivos = []ResumoArquivo{}
	}

	json.NewEncoder(w).Encode(arquivos)
}

// 3. Rota do Contador
func countHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	if db == nil {
		http.Error(w, `{"erro": "Banco offline"}`, http.StatusInternalServerError)
		return
	}

	var total int
	err := db.QueryRow("SELECT COUNT(*) FROM arquivos_json").Scan(&total)
	if err != nil {
		http.Error(w, `{"erro": "Falha ao contar arquivos"}`, http.StatusInternalServerError)
		return
	}

	w.Write([]byte(fmt.Sprintf(`{"total_jsons": %d}`, total)))
}

// 4. Rota Dinâmica (Serve o index.html OU o JSON)
func rootHandler(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path

	// Se acessou a raiz, retorna o frontend HTML
	if path == "/" || path == "/index.html" {
		http.ServeFile(w, r, "index.html")
		return
	}

	w.Header().Set("Content-Type", "application/json")

	// Proteção contra crash ao tentar ler json
	if db == nil {
		w.WriteHeader(http.StatusInternalServerError)
		w.Write([]byte(`{"erro": "Servidor offline ou sem banco de dados configurado"}`))
		return
	}
	
	nome := strings.TrimPrefix(path, "/")
	
	var conteudo string
	err := db.QueryRow("SELECT conteudo FROM arquivos_json WHERE nome = $1", nome).Scan(&conteudo)
	if err != nil {
		if err == sql.ErrNoRows {
			w.WriteHeader(http.StatusNotFound)
			w.Write([]byte(`{"erro": "JSON não encontrado no servidor"}`))
		} else {
			w.WriteHeader(http.StatusInternalServerError)
			w.Write([]byte(`{"erro": "Erro no banco de dados"}`))
		}
		return
	}

	w.Write([]byte(conteudo))
}

// 5. Rota de Teste de Conexão
func pingHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	
	if db == nil {
		w.WriteHeader(http.StatusInternalServerError)
		w.Write([]byte(`{"status": "erro", "mensagem": "Banco de dados não configurado (db está nulo)."}`))
		return
	}

	err := db.Ping()
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		w.Write([]byte(fmt.Sprintf(`{"status": "erro", "mensagem": "A ligação ao PostgreSQL falhou: %v"}`, err)))
		return
	}

	w.Write([]byte(`{"status": "sucesso", "mensagem": "A comunicação com o PostgreSQL está a funcionar perfeitamente! 🚀"}`))
}

func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == "OPTIONS" {
			w.WriteHeader(http.StatusOK)
			return
		}
		next.ServeHTTP(w, r)
	})
}