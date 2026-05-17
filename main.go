package main

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	_ "github.com/lib/pq"
)

// ==== CONSTANTES TMDB E RPDB ====
const (
	RPDBBaseURL = "https://api.ratingposterdb.com/t0-free-rpdb"
	TMDBAPIKey  = "eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiJlZTBmMzJmNzY5Mzc0YTkzYTI0ZmNiYzcyMWRlODYzNCIsIm5iZiI6MTc1NjA2MzM2NC4yMzksInN1YiI6IjY4YWI2Njg0ZDAyMjdhYTVlMjlkYjE2MSIsInNjb3BlcyI6WyJhcGlfcmVhZCJdLCJ2ZXJzaW9uIjoxfQ.z1hG61Z5RCvn6qEZj60sHxrDZ0hR8QQi4rt18erzF-w"
)

var (
	db         *sql.DB
	tmdbCache  sync.Map
	httpClient = &http.Client{Timeout: 10 * time.Second}
)

// ==== ESTRUTURAS DO TMDB ====
type TMDBFindResponse struct {
	MovieResults []struct {
		Title       string `json:"title"`
		ReleaseDate string `json:"release_date"`
	} `json:"movie_results"`
	TvResults []struct {
		Name         string `json:"name"`
		FirstAirDate string `json:"first_air_date"`
	} `json:"tv_results"`
}

type TMDBData struct {
	Title string
	Year  string
	Type  string
}

// ==== FUNÇÃO DE BUSCA NO TMDB ====
func getTMDBInfo(id string, client *http.Client) TMDBData {
	if cached, ok := tmdbCache.Load(id); ok {
		return cached.(TMDBData)
	}
	url := fmt.Sprintf("https://api.themoviedb.org/3/find/%s?api_key=%s&external_source=imdb_id&language=pt-BR", id, TMDBAPIKey)
	
	req, _ := http.NewRequest("GET", url, nil)
	req.Header.Set("User-Agent", "Mozilla/5.0")
	
	resp, err := client.Do(req)
	if err != nil || resp.StatusCode != 200 {
		return TMDBData{}
	}
	defer resp.Body.Close()

	var tmdb TMDBFindResponse
	data := TMDBData{Type: "movie"}
	if err := json.NewDecoder(resp.Body).Decode(&tmdb); err == nil {
		if len(tmdb.MovieResults) > 0 {
			data.Title = tmdb.MovieResults[0].Title
			data.Type = "movie"
			if len(tmdb.MovieResults[0].ReleaseDate) >= 4 {
				data.Year = tmdb.MovieResults[0].ReleaseDate[:4]
			}
		} else if len(tmdb.TvResults) > 0 {
			data.Title = tmdb.TvResults[0].Name
			data.Type = "series"
			if len(tmdb.TvResults[0].FirstAirDate) >= 4 {
				data.Year = tmdb.TvResults[0].FirstAirDate[:4]
			}
		}
	}
	if data.Title != "" {
		tmdbCache.Store(id, data)
	}
	return data
}

// ==== INICIALIZAÇÃO DO BANCO ====
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

	err = db.Ping()
	if err != nil {
		log.Fatalf("❌ Falha na comunicação com o PostgreSQL: %v", err)
	}

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

	mux.HandleFunc("/upload", uploadHandler)
	mux.HandleFunc("/api/all", listAllHandler)
	mux.HandleFunc("/api/catalog", listAllHandler)
	mux.HandleFunc("/count", countHandler)
	mux.HandleFunc("/ping", pingHandler)
	
	mux.HandleFunc("/", rootHandler)

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
		adminPassword = "sua_senha_padrao_aqui"
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

	// =========================================================================
	// MAGIA TMDB/RPDB: Interceptar o JSON e injetar o Nome, Ano e Capa
	// =========================================================================
	if strings.HasPrefix(nome, "tt") {
		var data map[string]interface{}
		if err := json.Unmarshal([]byte(conteudo), &data); err == nil {
			
			// Busca dados no TMDB
			info := getTMDBInfo(nome, httpClient)
			if info.Title != "" {
				data["title"] = info.Title
				data["year"] = info.Year
				if _, exists := data["type"]; !exists {
					data["type"] = info.Type
				}
			}
			
			// Injeta a capa do RPDB baseada no ID do IMDb
			data["poster"] = fmt.Sprintf("%s/imdb/poster-default/%s.jpg", RPDBBaseURL, nome)
			
			// Garante que o ID está presente no JSON
			if _, exists := data["id"]; !exists {
				data["id"] = nome
			}

			// Converte de volta para string para gravar no banco de dados
			if enrichedBytes, err := json.Marshal(data); err == nil {
				conteudo = string(enrichedBytes)
			}
		}
	}
	// =========================================================================

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

	if db == nil {
		http.Error(w, `[{"erro": "Banco de dados offline"}]`, http.StatusInternalServerError)
		return
	}

	rows, err := db.Query("SELECT conteudo FROM arquivos_json ORDER BY data_criacao DESC")
	if err != nil {
		http.Error(w, `[{"erro": "Falha ao buscar arquivos"}]`, http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	w.Write([]byte("["))
	first := true
	for rows.Next() {
		var conteudo string
		if err := rows.Scan(&conteudo); err == nil {
			if !first {
				w.Write([]byte(","))
			}
			w.Write([]byte(conteudo))
			first = false
		}
	}
	w.Write([]byte("]"))
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

	if path == "/" || path == "/index.html" {
		http.ServeFile(w, r, "index.html")
		return
	}

	w.Header().Set("Content-Type", "application/json")

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
		// Opcão DELETE readicionada conforme o seu snippet anterior
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS, DELETE")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == "OPTIONS" {
			w.WriteHeader(http.StatusOK)
			return
		}
		next.ServeHTTP(w, r)
	})
}
