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
	// Token Bearer do TMDB
	TMDBAPIKey  = "eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiJlZTBmMzJmNzY5Mzc0YTkzYTI0ZmNiYzcyMWRlODYzNCIsIm5iZiI6MTc1NjA2MzM2NC4yMzksInN1YiI6IjY4YWI2Njg0ZDAyMjdhYTVlMjlkYjE2MSIsInNjb3BlcyI6WyJhcGlfcmVhZCJdLCJ2ZXJzaW9uIjoxfQ.z1hG61Z5RCvn6qEZj60sHxrDZ0hR8QQi4rt18erzF-w"
)

var (
	db            *sql.DB
	tmdbCache     sync.Map
	cinemetaCache sync.Map // Cache para não sobrecarregar o Cinemeta
	httpClient    = &http.Client{Timeout: 10 * time.Second}
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
	
	url := fmt.Sprintf("https://api.themoviedb.org/3/find/%s?external_source=imdb_id&language=pt-BR", id)
	
	req, _ := http.NewRequest("GET", url, nil)
	req.Header.Set("User-Agent", "Mozilla/5.0")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Authorization", "Bearer "+TMDBAPIKey)
	
	resp, err := client.Do(req)
	if err != nil {
		log.Printf("❌ Erro de rede ao contactar TMDB para o ID %s: %v", id, err)
		return TMDBData{}
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		log.Printf("⚠️ TMDB recusou o pedido para o ID %s. Código de erro: %d (Verifique se a chave TMDB está correta)", id, resp.StatusCode)
		return TMDBData{}
	}

	var tmdb TMDBFindResponse
	data := TMDBData{Type: "movie"}
	if err := json.NewDecoder(resp.Body).Decode(&tmdb); err == nil {
		if len(tmdb.MovieResults) > 0 {
			data.Title = tmdb.MovieResults[0].Title
			data.Type = "movie"
			if len(tmdb.MovieResults[0].ReleaseDate) >= 4 {
				data.Year = tmdb.MovieResults[0].ReleaseDate[:4]
			}
			log.Printf("✅ TMDB encontrou Filme: %s", data.Title)
		} else if len(tmdb.TvResults) > 0 {
			data.Title = tmdb.TvResults[0].Name
			data.Type = "series"
			if len(tmdb.TvResults[0].FirstAirDate) >= 4 {
				data.Year = tmdb.TvResults[0].FirstAirDate[:4]
			}
			log.Printf("✅ TMDB encontrou Série: %s", data.Title)
		} else {
			log.Printf("⚠️ TMDB respondeu com sucesso, mas não encontrou o ID %s", id)
		}
	} else {
		log.Printf("❌ Erro ao ler resposta do TMDB para o ID %s: %v", id, err)
	}

	if data.Title != "" {
		tmdbCache.Store(id, data)
	}
	return data
}

// ==== FUNÇÃO DE BUSCA NO CINEMETA (STREMIO) ====
func getCinemetaInfo(id string, cType string, client *http.Client) map[string]interface{} {
	cacheKey := id + "_" + cType
	if cached, ok := cinemetaCache.Load(cacheKey); ok {
		return cached.(map[string]interface{})
	}

	url := fmt.Sprintf("https://v3-cinemeta.strem.io/meta/%s/%s.json", cType, id)
	req, _ := http.NewRequest("GET", url, nil)
	req.Header.Set("User-Agent", "Mozilla/5.0")
	
	resp, err := client.Do(req)
	if err != nil || resp.StatusCode != 200 {
		return nil
	}
	defer resp.Body.Close()

	var result struct {
		Meta map[string]interface{} `json:"meta"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err == nil && result.Meta != nil {
		cinemetaCache.Store(cacheKey, result.Meta)
		return result.Meta
	}
	return nil
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
	mux.HandleFunc("/api/delete", deleteHandler) 
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
		w.Write([]byte(`{"erro": "Servidor sem conexão com o banco de dados."}`))
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
	// MAGIA TMDB/CINEMETA/RPDB: Agora lê o ID por dentro do JSON!
	// =========================================================================
	var data map[string]interface{}
	if err := json.Unmarshal([]byte(conteudo), &data); err == nil {
		
		imdbID := ""
		
		// 1. Procura o ID dentro do próprio JSON (Onde o editor sempre coloca o 'tt')
		if idVal, ok := data["id"].(string); ok && strings.HasPrefix(idVal, "tt") {
			imdbID = idVal
		} else if strings.HasPrefix(nome, "tt") {
			// Fallback: tenta ver pelo nome do arquivo
			imdbID = nome
		}

		// 2. Se achamos um IMDb ID válido, processa os metadados
		if imdbID != "" {
			// Busca dados no TMDB
			info := getTMDBInfo(imdbID, httpClient)
			if info.Title != "" {
				data["title"] = info.Title
				data["year"] = info.Year
				if _, exists := data["type"]; !exists {
					data["type"] = info.Type
				}
			}
			
			// Determina o tipo (movie ou series)
			cType := "movie"
			if t, ok := data["type"].(string); ok && t != "" {
				cType = t
			}

			// Busca dados no Cinemeta (Stremio)
			cinemeta := getCinemetaInfo(imdbID, cType, httpClient)
			if cinemeta != nil {
				if videos, ok := cinemeta["videos"]; ok {
					data["cinemetaVideos"] = videos
				}
				if desc, ok := cinemeta["description"]; ok && data["description"] == nil {
					data["description"] = desc
				}
				if bg, ok := cinemeta["background"]; ok && data["background"] == nil {
					data["background"] = bg
				}
			}
			
			// Injeta a capa do RPDB
			if data["poster"] == nil {
				data["poster"] = fmt.Sprintf("%s/imdb/poster-default/%s.jpg", RPDBBaseURL, imdbID)
			}
			
			// Garante que o ID está presente
			if _, exists := data["id"]; !exists {
				data["id"] = imdbID
			}
		}

		// Reconstroi a string JSON sempre (mesmo se falhar o enriquecimento, preserva o JSON limpo)
		if enrichedBytes, err := json.Marshal(data); err == nil {
			conteudo = string(enrichedBytes)
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

// 2. Rota para apagar (Protegida)
func deleteHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	
	if db == nil {
		w.WriteHeader(http.StatusInternalServerError)
		w.Write([]byte(`{"erro": "Servidor offline"}`))
		return
	}

	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		w.Write([]byte(`{"erro": "Método não permitido"}`))
		return
	}

	var reqData struct {
		ID    string `json:"id"`
		Senha string `json:"senha"`
	}

	if err := json.NewDecoder(r.Body).Decode(&reqData); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		w.Write([]byte(`{"erro": "Dados inválidos"}`))
		return
	}

	adminPassword := os.Getenv("ADMIN_PASSWORD")
	if adminPassword == "" {
		adminPassword = "sua_senha_padrao_aqui"
	}

	if reqData.Senha != adminPassword {
		w.WriteHeader(http.StatusForbidden)
		w.Write([]byte(`{"erro": "Acesso negado: Senha incorreta"}`))
		return
	}

	_, err := db.Exec("DELETE FROM arquivos_json WHERE nome = $1", reqData.ID)
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		w.Write([]byte(fmt.Sprintf(`{"erro": "%s"}`, err.Error())))
		return
	}

	w.Write([]byte(`{"sucesso": true}`))
}

// 3. Rota para listar todos (Catálogo)
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

// 4. Rota do Contador
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

// 5. Rota Dinâmica (Serve o index.html OU o JSON)
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

// 6. Rota de Teste de Conexão
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
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS, DELETE")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == "OPTIONS" {
			w.WriteHeader(http.StatusOK)
			return
		}
		next.ServeHTTP(w, r)
	})
}
