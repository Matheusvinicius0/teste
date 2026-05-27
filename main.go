package main

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/joho/godotenv"
	_ "github.com/lib/pq" // Driver do PostgreSQL
)

// Estruturas de dados esperadas do frontend
type SaveRequest struct {
	FileName string      `json:"fileName"`
	Content  interface{} `json:"content"`
}

type DeleteRequest struct {
	FileName string `json:"fileName"`
}

const dataDir = "./data"

// Variável global para a Base de Dados (caso precises de a usar noutras funções no futuro)
var DB *sql.DB

func main() {
	// 0. Carregar as variáveis do ficheiro .env
	err := godotenv.Load()
	if err != nil {
		log.Println("⚠️  Aviso: Ficheiro .env não encontrado. A tentar usar as variáveis do sistema.")
	}

	// 0.1 Iniciar Ligação à Base de Dados PostgreSQL
	dbURL := os.Getenv("DATABASE_URL")
	if dbURL != "" {
		DB, err = sql.Open("postgres", dbURL)
		if err != nil {
			log.Fatalf("❌ Erro ao abrir a ligação à base de dados: %v\n", err)
		}
		// Testa se a ligação está realmente a funcionar
		err = DB.Ping()
		if err != nil {
			log.Fatalf("❌ Erro ao comunicar com a base de dados: %v\n", err)
		}
		fmt.Println("✅ Ligação ao PostgreSQL estabelecida com sucesso!")
	} else {
		fmt.Println("⚠️  Nenhum DATABASE_URL encontrado. O servidor vai arrancar sem BD.")
	}

	// Cria a pasta "data" automaticamente para guardar os arquivos JSON locais
	if err := os.MkdirAll(dataDir, 0755); err != nil {
		fmt.Println("Erro ao criar diretório de dados:", err)
		return
	}

	mux := http.NewServeMux()

	// 1. Servir o index.html na raiz do site
	mux.HandleFunc("/", serveIndex)

	// 2. API que lê a pasta e envia todos os JSONs para o frontend
	mux.HandleFunc("/api/catalog", handleCatalog)

	// --- ROTAS PROTEGIDAS PELA SENHA DO ADMIN ---
	// Usamos a função "adminAuth" para bloquear quem não tem a senha
	// 3. API para Salvar / Editar um JSON
	mux.HandleFunc("/api/save", adminAuth(handleSave))

	// 4. API para Apagar um JSON
	mux.HandleFunc("/api/delete", adminAuth(handleDelete))

	// 8. Rota para receber uploads múltiplos de JSONs
	mux.HandleFunc("/api/upload-bulk", adminAuth(handleBulkUpload))
	// ----------------------------------------------

	// 5. Proxy Seguro para o TMDB (Puxa a chave do .env escondida do utilizador)
	mux.HandleFunc("/api/tmdb", handleTMDBProxy)

	// 6. API de Pedidos dos utilizadores
	mux.HandleFunc("/api/pedidos", handlePedidos)

	// 7. Servir os ficheiros JSON diretamente para visualização/leitura
	mux.Handle("/json/", http.StripPrefix("/json/", http.FileServer(http.Dir(dataDir))))

	// 9. Rota para fazer pedidos diretamente pelo URL
	mux.HandleFunc("/pedido/", handlePedidoPorURL)

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	fmt.Println("=========================================")
	fmt.Printf("🚀 Servidor FenixFlix a correr!\n")
	fmt.Printf("🌐 Aceda no navegador: http://localhost:%s\n", port)
	fmt.Printf("📂 Os JSONs serão guardados na pasta: %s\n", dataDir)
	if os.Getenv("ADMIN_PASSWORD") != "" {
		fmt.Println("🔒 Sistema de Segurança (Admin) ATIVADO!")
	} else {
		fmt.Println("⚠️  ATENÇÃO: ADMIN_PASSWORD não configurada, rotas desprotegidas!")
	}
	fmt.Println("=========================================")

	http.ListenAndServe(":"+port, mux)
}

// === MIDDLEWARE DE AUTENTICAÇÃO ===
// Esta função verifica se a senha fornecida pelo frontend corresponde à do .env
func adminAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		expectedPass := os.Getenv("ADMIN_PASSWORD")
		
		// Se não houver senha no .env, deixamos passar (útil para desenvolvimento local)
		if expectedPass == "" {
			next(w, r)
			return
		}

		// Tenta procurar a senha no Header "X-Admin-Password" ou como parâmetro no URL "?password=..."
		providedPass := r.Header.Get("X-Admin-Password")
		if providedPass == "" {
			providedPass = r.URL.Query().Get("password")
		}

		if providedPass != expectedPass {
			http.Error(w, `{"status":"error","message":"Acesso Negado: Senha Incorreta."}`, http.StatusUnauthorized)
			return
		}

		// Se a senha estiver correta, segue para a função original (save, delete, etc)
		next(w, r)
	}
}

func serveIndex(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}
	http.ServeFile(w, r, "index.html")
}

// Lê a pasta "data" e junta todos os filmes para exibir
func handleCatalog(w http.ResponseWriter, r *http.Request) {
	files, err := os.ReadDir(dataDir)
	if err != nil {
		http.Error(w, "Erro ao ler diretório", http.StatusInternalServerError)
		return
	}

	var catalog []interface{}

	for _, file := range files {
		if !file.IsDir() && strings.HasSuffix(file.Name(), ".json") && !strings.HasPrefix(file.Name(), "_") {
			filePath := filepath.Join(dataDir, file.Name())
			bytes, err := os.ReadFile(filePath)
			if err != nil {
				continue
			}

			var data map[string]interface{}
			if err := json.Unmarshal(bytes, &data); err == nil {
				data["fileName"] = file.Name()
				catalog = append(catalog, data)
			}
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(catalog)
}

// Grava um novo ficheiro na pasta "data"
func handleSave(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Método não permitido", http.StatusMethodNotAllowed)
		return
	}

	var req SaveRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Erro ao processar dados", http.StatusBadRequest)
		return
	}

	fileName := filepath.Base(req.FileName)
	if !strings.HasSuffix(fileName, ".json") {
		fileName += ".json"
	}
	filePath := filepath.Join(dataDir, fileName)

	bytes, err := json.MarshalIndent(req.Content, "", "    ")
	if err != nil {
		http.Error(w, "Erro ao gerar JSON", http.StatusInternalServerError)
		return
	}

	if err := os.WriteFile(filePath, bytes, 0644); err != nil {
		http.Error(w, "Erro ao guardar ficheiro", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.Write([]byte(`{"status":"success","message":"Guardado com sucesso!"}`))
}

// Apaga um ficheiro da pasta "data"
func handleDelete(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Método não permitido", http.StatusMethodNotAllowed)
		return
	}

	var req DeleteRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Erro ao processar dados", http.StatusBadRequest)
		return
	}

	fileName := filepath.Base(req.FileName)
	filePath := filepath.Join(dataDir, fileName)

	if err := os.Remove(filePath); err != nil {
		http.Error(w, "Erro ao apagar ficheiro", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.Write([]byte(`{"status":"success","message":"Ficheiro apagado!"}`))
}

// Proxy Seguro para o TMDB
func handleTMDBProxy(w http.ResponseWriter, r *http.Request) {
	rawID := r.URL.Query().Get("id")
	tmdbType := r.URL.Query().Get("type") // "movie" ou "tv"

	if rawID == "" || tmdbType == "" {
		http.Error(w, "Parâmetros id e type são obrigatórios", http.StatusBadRequest)
		return
	}

	apiKey := os.Getenv("TMDB_API_KEY")
	if apiKey == "" {
		http.Error(w, "Chave da API do TMDB não configurada", http.StatusInternalServerError)
		return
	}

	tmdbID := rawID
	if strings.HasPrefix(rawID, "tt") {
		findURL := fmt.Sprintf("https://api.themoviedb.org/3/find/%s?api_key=%s&language=pt-PT&external_source=imdb_id", rawID, apiKey)
		findResp, err := http.Get(findURL)
		if err != nil {
			http.Error(w, "Erro ao converter IMDb ID", http.StatusInternalServerError)
			return
		}
		defer findResp.Body.Close()

		var findData map[string]interface{}
		if err := json.NewDecoder(findResp.Body).Decode(&findData); err != nil {
			http.Error(w, "Erro ao descodificar resposta", http.StatusInternalServerError)
			return
		}

		resultKey := "movie_results"
		if tmdbType == "tv" {
			resultKey = "tv_results"
		}
		results, ok := findData[resultKey].([]interface{})
		if !ok || len(results) == 0 {
			http.Error(w, "Título não encontrado no TMDB via IMDb ID", http.StatusNotFound)
			return
		}
		firstResult := results[0].(map[string]interface{})
		idFloat, ok := firstResult["id"].(float64)
		if !ok {
			http.Error(w, "ID do TMDB inválido", http.StatusInternalServerError)
			return
		}
		tmdbID = fmt.Sprintf("%d", int(idFloat))
	}

	detailURL := fmt.Sprintf("https://api.themoviedb.org/3/%s/%s?api_key=%s&language=pt-PT", tmdbType, tmdbID, apiKey)
	resp, err := http.Get(detailURL)
	if err != nil {
		http.Error(w, "Erro ao consultar TMDB", http.StatusInternalServerError)
		return
	}
	defer resp.Body.Close()

	w.Header().Set("Content-Type", "application/json")
	io.Copy(w, resp.Body)
}

// === API DE PEDIDOS ===
type PedidoRequest struct {
	Nome   string `json:"nome"`
	Titulo string `json:"titulo"`
	Tipo   string `json:"tipo"`
}

func handlePedidos(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Content-Type", "application/json")

	if r.Method == http.MethodGet {
		pedidosPath := filepath.Join(dataDir, "_pedidos.json")
		rawBytes, err := os.ReadFile(pedidosPath)
		if err != nil {
			w.Write([]byte("[]"))
			return
		}

		var todos []map[string]interface{}
		if err := json.Unmarshal(rawBytes, &todos); err != nil {
			w.Write([]byte("[]"))
			return
		}

		filtroTipo := r.URL.Query().Get("tipo")
		if filtroTipo != "" && filtroTipo != "all" {
			var filtrado []map[string]interface{}
			for _, p := range todos {
				if fmt.Sprintf("%v", p["tipo"]) == filtroTipo {
					filtrado = append(filtrado, p)
				}
			}
			if filtrado == nil {
				filtrado = []map[string]interface{}{}
			}
			out, _ := json.Marshal(filtrado)
			w.Write(out)
			return
		}

		w.Write(rawBytes)
		return
	}

	if r.Method == http.MethodPost {
		var req PedidoRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "Dados inválidos", http.StatusBadRequest)
			return
		}
		if req.Nome == "" || req.Titulo == "" {
			http.Error(w, "Nome e título são obrigatórios", http.StatusBadRequest)
			return
		}
		if req.Tipo == "" {
			req.Tipo = "desconhecido"
		}

		pedidosPath := filepath.Join(dataDir, "_pedidos.json")
		var pedidos []map[string]interface{}
		if existing, err := os.ReadFile(pedidosPath); err == nil {
			json.Unmarshal(existing, &pedidos)
		}

		tituloNorm := strings.ToLower(strings.TrimSpace(req.Titulo))
		found := false
		for i, p := range pedidos {
			if strings.ToLower(fmt.Sprintf("%v", p["titulo"])) == tituloNorm {
				count := 1.0
				if c, ok := p["pedidos"].(float64); ok {
					count = c
				}
				pedidos[i]["pedidos"] = count + 1
				if req.Tipo != "desconhecido" {
					pedidos[i]["tipo"] = req.Tipo
				}
				solicitantes, _ := pedidos[i]["solicitantes"].([]interface{})
				pedidos[i]["solicitantes"] = append(solicitantes, req.Nome)
				found = true
				break
			}
		}

		if !found {
			pedidos = append(pedidos, map[string]interface{}{
				"titulo":       req.Titulo,
				"tipo":         req.Tipo,
				"pedidos":      1,
				"solicitantes": []string{req.Nome},
			})
		}

		out, _ := json.MarshalIndent(pedidos, "", "    ")
		os.WriteFile(pedidosPath, out, 0644)

		txtPath := filepath.Join(dataDir, "_pedidos.txt")
		var txtLines []string
		txtLines = append(txtLines, "=== PEDIDOS FENIXFLIX ===\n")
		for _, p := range pedidos {
			titulo := fmt.Sprintf("%v", p["titulo"])
			tipo := fmt.Sprintf("%v", p["tipo"])
			countStr := "1"
			if c, ok := p["pedidos"].(float64); ok {
				countStr = fmt.Sprintf("%.0f", c)
			}
			solicitantes := []interface{}{}
			if s, ok := p["solicitantes"].([]interface{}); ok {
				solicitantes = s
			}
			var nomes []string
			for _, s := range solicitantes {
				nomes = append(nomes, fmt.Sprintf("%v", s))
			}
			txtLines = append(txtLines, fmt.Sprintf("📌 %s [%s] — %s pedido(s) por: %s", titulo, tipo, countStr, strings.Join(nomes, ", ")))
		}
		os.WriteFile(txtPath, []byte(strings.Join(txtLines, "\n")), 0644)

		w.Write([]byte(`{"status":"success","message":"Pedido registado com sucesso!"}`))
		return
	}

	http.Error(w, "Método não permitido", http.StatusMethodNotAllowed)
}

// Upload Múltiplo
func handleBulkUpload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Método não permitido", http.StatusMethodNotAllowed)
		return
	}

	err := r.ParseMultipartForm(10 << 20)
	if err != nil {
		http.Error(w, "Erro ao processar formulário", http.StatusBadRequest)
		return
	}

	files := r.MultipartForm.File["jsons"]
	if len(files) == 0 {
		http.Error(w, "Nenhum ficheiro enviado", http.StatusBadRequest)
		return
	}

	for _, fileHeader := range files {
		if !strings.HasSuffix(fileHeader.Filename, ".json") {
			continue
		}

		file, err := fileHeader.Open()
		if err != nil {
			continue
		}
		defer file.Close()

		destPath := filepath.Join(dataDir, filepath.Base(fileHeader.Filename))
		destFile, err := os.Create(destPath)
		if err != nil {
			continue
		}
		defer destFile.Close()

		io.Copy(destFile, file)
	}

	w.Header().Set("Content-Type", "application/json")
	w.Write([]byte(`{"status":"success","message":"Ficheiros enviados com sucesso!"}`))
}

// === FAZER PEDIDO PELO URL ===
func handlePedidoPorURL(w http.ResponseWriter, r *http.Request) {
	titulo := strings.TrimPrefix(r.URL.Path, "/pedido/")
	if titulo == "" || titulo == "/" {
		http.Error(w, "Precisa de informar o título ou ID no URL. Exemplo: /pedido/tt0066921", http.StatusBadRequest)
		return
	}

	pedidosPath := filepath.Join(dataDir, "_pedidos.json")
	var pedidos []map[string]interface{}
	if existing, err := os.ReadFile(pedidosPath); err == nil {
		json.Unmarshal(existing, &pedidos)
	}

	tituloNorm := strings.ToLower(strings.TrimSpace(titulo))
	found := false
	nomeSolicitante := "Anónimo (Via URL)"

	for i, p := range pedidos {
		if strings.ToLower(fmt.Sprintf("%v", p["titulo"])) == tituloNorm {
			count := 1.0
			if c, ok := p["pedidos"].(float64); ok {
				count = c
			}
			pedidos[i]["pedidos"] = count + 1
			solicitantes, _ := pedidos[i]["solicitantes"].([]interface{})
			pedidos[i]["solicitantes"] = append(solicitantes, nomeSolicitante)
			found = true
			break
		}
	}

	if !found {
		pedidos = append(pedidos, map[string]interface{}{
			"titulo":       titulo,
			"tipo":         "desconhecido",
			"pedidos":      1,
			"solicitantes": []string{nomeSolicitante},
		})
	}

	out, _ := json.MarshalIndent(pedidos, "", "    ")
	os.WriteFile(pedidosPath, out, 0644)

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Write([]byte(fmt.Sprintf(`
		<body style="background-color: #09090b; margin: 0; font-family: sans-serif;">
			<div style="text-align: center; margin-top: 50px; color: white; padding: 20px;">
				<h2 style="color: #10b981;">✅ Pedido registado com sucesso!</h2>
				<p style="color: #a1a1aa;">O título/ID <b style="color: white;">%s</b> foi adicionado à lista de pedidos.</p>
				<a href="/" style="display: inline-block; margin-top: 20px; padding: 10px 20px; background: #4f46e5; color: white; text-decoration: none; border-radius: 8px; font-weight: bold;">Voltar ao Catálogo</a>
			</div>
		</body>
	`, titulo)))
}
