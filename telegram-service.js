require('dotenv').config();
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const fs = require('fs');
const { CustomFile } = require('telegram/client/uploads');
const path = require('path');
const https = require('https');
const http = require('http');

const apiId = parseInt(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;
const sessionString = process.env.TELEGRAM_SESSION;

let client = null;
let isConnected = false;

// Mapa para armazenar logins pendentes da web
const pendingLogins = new Map();

// Função para obter o status da conexão global (servidor)
function getStatus() {
    return {
        configured: !!(apiId && apiHash && sessionString),
        connected: isConnected
    };
}

// Inicializa o cliente Telegram global (usado se configurado no .env)
async function initClient() {
    if (!apiId || !apiHash || !sessionString) {
        console.warn("⚠️ Telegram Global não configurado no .env");
        return null;
    }

    if (client) return client;

    try {
        const stringSession = new StringSession(sessionString);
        client = new TelegramClient(stringSession, apiId, apiHash, {
            connectionRetries: 5,
            requestRetries: 5,
            floodSleepThreshold: 300
        });

        await client.connect();
        isConnected = true;
        console.log("✅ Telegram Client Global conectado!");
        return client;
    } catch (err) {
        console.error("❌ Erro ao conectar ao Telegram Client Global:", err.message);
        isConnected = false;
        client = null;
        return null;
    }
}

// Desconectar o cliente global
async function disconnectClient() {
    if (client) {
        await client.disconnect();
        isConnected = false;
        client = null;
        console.log("Telegram Client Global desconectado.");
    }
}

// Mapa para armazenar clientes dinâmicos compartilhados por sessão
// Formato: sessionString -> { clientPromise, client, refCount, disconnectTimeout }
const sharedClients = new Map();

async function getSharedClient(customSessionString) {
    if (!apiId || !apiHash) {
        throw new Error("TELEGRAM_API_ID e TELEGRAM_API_HASH não configurados no servidor.");
    }

    let entry = sharedClients.get(customSessionString);

    if (entry) {
        // Cancela o timeout de desconexão se houver um agendado
        if (entry.disconnectTimeout) {
            clearTimeout(entry.disconnectTimeout);
            entry.disconnectTimeout = null;
        }
        entry.refCount++;
        console.log(`[Telegram] Reutilizando conexão existente/pendente (refCount atual: ${entry.refCount})`);
        
        // Aguarda a promessa de conexão se resolver
        const client = await entry.clientPromise;
        if (!client.connected) {
            await client.connect();
        }
        return client;
    }

    console.log("[Telegram] Inicializando nova conexão dinâmica do usuário (canal único)...");

    // Cria a promessa de conexão imediatamente e salva no mapa de forma síncrona para evitar race conditions
    const connectPromise = (async () => {
        const stringSession = new StringSession(customSessionString);
        const tempClient = new TelegramClient(stringSession, apiId, apiHash, {
            connectionRetries: 5,
            requestRetries: 5,
            floodSleepThreshold: 300
        });
        await tempClient.connect();
        
        // Atualiza a entrada com o cliente conectado quando terminar
        const currentEntry = sharedClients.get(customSessionString);
        if (currentEntry) {
            currentEntry.client = tempClient;
        }
        return tempClient;
    })();

    entry = {
        clientPromise: connectPromise,
        client: null,
        refCount: 1,
        disconnectTimeout: null
    };

    sharedClients.set(customSessionString, entry);

    return connectPromise;
}

async function releaseSharedClient(customSessionString) {
    if (!sharedClients.has(customSessionString)) return;
    
    const entry = sharedClients.get(customSessionString);
    entry.refCount--;
    console.log(`[Telegram] Liberando conexão (refCount restante: ${entry.refCount})`);
    
    if (entry.refCount <= 0) {
        // Agenda a desconexão para daqui a 15 segundos para evitar reconexões frequentes
        entry.disconnectTimeout = setTimeout(async () => {
            try {
                if (sharedClients.has(customSessionString)) {
                    const currentEntry = sharedClients.get(customSessionString);
                    if (currentEntry.refCount <= 0) {
                        const client = currentEntry.client || await currentEntry.clientPromise;
                        await client.disconnect().catch(() => {});
                        sharedClients.delete(customSessionString);
                        console.log("[Telegram] Conexão dinâmica compartilhada encerrada por inatividade.");
                    }
                }
            } catch (err) {
                console.error("[Telegram] Erro ao fechar conexão inativa:", err);
            }
        }, 15000); // 15 segundos de carência
    }
}

// Mapa para armazenar clientes dinâmicos de Bot
// Formato: botToken -> { clientPromise, client }
const sharedBots = new Map();

async function getSharedBot(botToken) {
    if (!apiId || !apiHash) {
        throw new Error("TELEGRAM_API_ID e TELEGRAM_API_HASH não configurados no servidor.");
    }

    let entry = sharedBots.get(botToken);

    if (entry) {
        // Aguarda a promessa de conexão se resolver
        const client = await entry.clientPromise;
        if (!client.connected) {
            await client.connect();
        }
        return client;
    }

    console.log("[Telegram] Inicializando nova conexão dinâmica de Bot...");

    // Cria a promessa de conexão imediatamente e salva no mapa de forma síncrona
    const connectPromise = (async () => {
        const stringSession = new StringSession("");
        const tempClient = new TelegramClient(stringSession, apiId, apiHash, {
            connectionRetries: 5,
            requestRetries: 5,
            floodSleepThreshold: 300
        });
        await tempClient.start({
            botAuthToken: botToken
        });
        
        // Atualiza a entrada com o cliente conectado quando terminar
        const currentEntry = sharedBots.get(botToken);
        if (currentEntry) {
            currentEntry.client = tempClient;
        }
        return tempClient;
    })();

    entry = {
        clientPromise: connectPromise,
        client: null
    };

    sharedBots.set(botToken, entry);

    return connectPromise;
}

function getMessageFromForward(forwarded) {
    if (!forwarded) return null;
    if (forwarded.id !== undefined) return forwarded;
    
    // Se for array
    if (Array.isArray(forwarded)) {
        for (const item of forwarded) {
            const found = getMessageFromForward(item);
            if (found) return found;
        }
    }
    
    // Se for Updates (objeto com array de updates)
    if (forwarded.updates && Array.isArray(forwarded.updates)) {
        for (const upd of forwarded.updates) {
            if (upd.message) return upd.message;
            if (upd.id !== undefined) return upd;
        }
    }
    
    // Se tiver messages array
    if (forwarded.messages && Array.isArray(forwarded.messages)) {
        return forwarded.messages[0];
    }
    
    return null;
}

/**
 * Envia um arquivo para o bot fenix_flixbot e aguarda a resposta contendo o link.
 * @param {string} filePath - Caminho absoluto do arquivo no disco
 * @param {string} fileName - Nome original do arquivo
 * @param {function} onProgress - Callback para progresso do upload (recebe valor de 0 a 1)
 * @param {string} [customSessionString] - Sessão do Telegram enviada pelo cliente (opcional)
 * @param {string} [botToken] - Token de bot próprio para upload (opcional)
 * @param {string} [channelId] - ID ou username do canal de backup (opcional)
 * @returns {Promise<string>} O link gerado pelo bot
 */
async function uploadFileAndGetLink(filePath, fileName, onProgress, customSessionString, botToken, channelId) {
    let activeClient = null; // Cliente do usuário (necessário para ler respostas e encaminhar)
    let isDynamic = false;

    if (customSessionString) {
        activeClient = await getSharedClient(customSessionString);
        isDynamic = true;
    } else {
        activeClient = await initClient();
    }

    if (!activeClient) {
        throw new Error("Nenhum cliente Telegram ativo. Faça login no Telegram primeiro!");
    }

    if (!fs.existsSync(filePath)) {
        throw new Error(`Arquivo não encontrado no caminho: ${filePath}`);
    }

    // Define o cliente responsável pelo upload físico do arquivo (usuário ou bot próprio)
    let activeUploader = activeClient;
    let isBotUploader = false;
    if (botToken && channelId) {
        activeUploader = await getSharedBot(botToken);
        isBotUploader = true;
        console.log(`[Telegram] Usando Bot próprio para fazer o upload de ${fileName}...`);
    } else {
        console.log(`[Telegram] Usando Conta de Usuário para fazer o upload de ${fileName}...`);
    }

    const botUsername = 'fenix_flixbot';

    let newMessageHandler = null;

    try {
        // 1. Prepara o arquivo para upload no Node (usando CustomFile)
        const fileStats = fs.statSync(filePath);
        const customFile = new CustomFile(fileName, fileStats.size, filePath);

        // 2. Faz o upload das partes do arquivo
        const inputFile = await activeUploader.uploadFile({
            file: customFile,
            workers: 16,
            onProgress: (progress) => {
                if (onProgress) onProgress(progress);
            }
        });

        console.log(`[Telegram] Upload concluído para ${fileName}! (Uploader: ${isBotUploader ? 'Bot' : 'Usuário'})`);

        // 3. Loop de envio e escuta (com retentativas caso o bot responda com erro ou ocorra FLOOD_WAIT)
        let link = null;
        let attempts = 0;
        const maxAttempts = 3;

        while (attempts < maxAttempts) {
            attempts++;
            
            let sentMsg = null;
            let sentMsgToBot = null;

            try {
                if (channelId) {
                    console.log(`[Telegram] Enviando arquivo para o canal ${channelId}... (Tentativa ${attempts}/${maxAttempts})`);
                    
                    // Resolve peer do canal para o uploader
                    let channelPeer = channelId;
                    try {
                        if (/^-?\d+$/.test(channelId)) {
                            channelPeer = await activeUploader.getEntity(BigInt(channelId));
                        } else {
                            channelPeer = await activeUploader.getEntity(channelId);
                        }
                    } catch (entityErr) {
                        console.warn(`[Telegram] Falha ao obter entidade para o canal ${channelId}:`, entityErr.message);
                    }

                    // Envia para o canal
                    sentMsg = await activeUploader.sendFile(channelPeer, {
                        file: inputFile,
                        forceDocument: true,
                        attributes: [
                            new Api.DocumentAttributeFilename({
                                fileName: fileName
                            })
                        ]
                    });

                    console.log(`[Telegram] Arquivo postado no canal (ID: ${sentMsg.id}). Encaminhando para o bot @${botUsername}...`);

                    // Resolve peer do canal para o usuário (quem faz o encaminhamento)
                    let userChannelPeer = channelId;
                    try {
                        if (/^-?\d+$/.test(channelId)) {
                            userChannelPeer = await activeClient.getEntity(BigInt(channelId));
                        } else {
                            userChannelPeer = await activeClient.getEntity(channelId);
                        }
                    } catch (entityErr) {
                        console.warn(`[Telegram] Usuário falhou ao obter entidade para o canal ${channelId}:`, entityErr.message);
                    }

                    // Conta do usuário faz o encaminhamento do canal para o bot @fenix_flixbot
                    const forwardedMsgs = await activeClient.forwardMessages(botUsername, {
                        messages: [sentMsg.id],
                        fromPeer: userChannelPeer
                    });

                    const resolvedMsg = getMessageFromForward(forwardedMsgs);
                    if (resolvedMsg) {
                        sentMsgToBot = resolvedMsg;
                    } else {
                        console.warn("[Telegram Warning] Não foi possível extrair a mensagem do retorno do forward. Retorno completo:", typeof forwardedMsgs, JSON.stringify(forwardedMsgs));
                        sentMsgToBot = forwardedMsgs || {};
                    }
                } else {
                    console.log(`[Telegram] Enviando arquivo diretamente para o bot @${botUsername}... (Tentativa ${attempts}/${maxAttempts})`);
                    sentMsg = await activeClient.sendFile(botUsername, {
                        file: inputFile,
                        forceDocument: true,
                        attributes: [
                            new Api.DocumentAttributeFilename({
                                fileName: fileName
                            })
                        ]
                    });
                    sentMsgToBot = sentMsg;
                }
            } catch (err) {
                const errMessage = err.message || "";
                if (errMessage.includes("FLOOD_WAIT")) {
                    const waitMatch = errMessage.match(/FLOOD_WAIT_(\d+)/i);
                    const waitSeconds = waitMatch ? parseInt(waitMatch[1], 10) : 5;
                    console.warn(`⚠️ [Telegram] Limite de flood atingido. Aguardando ${waitSeconds}s antes de tentar novamente...`);
                    await new Promise(resolve => setTimeout(resolve, (waitSeconds + 1) * 1000));
                    attempts--; // Não conta como tentativa falha, tenta reenviar o arquivo já carregado
                    continue;
                }
                throw err;
            }

            console.log(`[Telegram] Arquivo ${fileName} enviado/encaminhado com sucesso (ID no bot chat: ${sentMsgToBot.id})! Aguardando resposta...`);

            // Escuta a resposta para este envio específico
            try {
                link = await new Promise((resolve, reject) => {
                    let replyTimeout = setTimeout(() => {
                        cleanup();
                        reject(new Error("TIMEOUT_WAITING_BOT"));
                    }, 45000); // 45 segundos para o bot responder a esta tentativa específica

                    function cleanup() {
                        if (replyTimeout) clearTimeout(replyTimeout);
                        if (newMessageHandler && activeClient) {
                            activeClient.removeEventHandler(newMessageHandler);
                        }
                    }

                    newMessageHandler = async (event) => {
                        try {
                            const message = event.message;
                            const sender = await message.getSender();
                            
                            if (sender && sender.username && sender.username.toLowerCase() === botUsername.toLowerCase()) {
                                // Verifica se é uma resposta à nossa mensagem encaminhada/enviada ou se contém o nome do arquivo
                                const isReply = message.replyTo && message.replyTo.replyToMsgId === sentMsgToBot.id;
                                
                                const nameWithoutExt = path.parse(fileName).name.toLowerCase();
                                const textLower = message.text.toLowerCase();
                                const containsOriginalName = nameWithoutExt && textLower.includes(nameWithoutExt);
                                const cleanFileName = nameWithoutExt.replace(/[^a-zA-Z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
                                const containsCleanName = cleanFileName && textLower.includes(cleanFileName);
                                const containsFileName = containsOriginalName || containsCleanName;

                                if (isReply || containsFileName) {
                                    console.log(`[Telegram] Resposta associada a ${fileName}: ${message.text}`);
                                    
                                    const linkRegex = /(https?:\/\/[^\s]+)/g;
                                    const matches = message.text.match(linkRegex);
                                    
                                    if (matches && matches.length > 0) {
                                        cleanup();
                                        const cleanedLink = matches[0].replace(/['"`.,;)]+$/, '');
                                        resolve(cleanedLink);
                                    } else {
                                        // Verifica se o bot enviou uma mensagem de erro explícita
                                        const isError = textLower.includes('erro') || 
                                                        textLower.includes('error') || 
                                                        textLower.includes('falha') || 
                                                        textLower.includes('limite') ||
                                                        textLower.includes('tamanho excedido') ||
                                                        textLower.includes('flood_wait');
                                        
                                        if (isError) {
                                            cleanup();
                                            reject(new Error(`BOT_ERROR: ${message.text}`));
                                        } else {
                                            console.log(`[Telegram] Mensagem intermediária ignorada do bot para ${fileName}: ${message.text}`);
                                        }
                                    }
                                }
                            }
                        } catch (err) {
                            console.error("[Telegram] Erro no event handler:", err);
                        }
                    };

                    activeClient.addEventHandler(newMessageHandler, new NewMessage({ incoming: true }));
                });

                // Se conseguimos o link com sucesso, sai do loop!
                break;
            } catch (err) {
                console.warn(`⚠️ [Telegram] Tentativa ${attempts}/${maxAttempts} falhou para ${fileName}: ${err.message}`);
                if (attempts < maxAttempts) {
                    console.log(`[Telegram] Aguardando 5 segundos antes de reenviar o arquivo...`);
                    await new Promise(resolve => setTimeout(resolve, 5000));
                } else {
                    throw err; // Estourou o limite de tentativas, propaga o erro
                }
            }
        }

        return link;
    } catch (err) {
        if (newMessageHandler && activeClient) {
            activeClient.removeEventHandler(newMessageHandler);
        }
        throw err;
    } finally {
        if (isDynamic && customSessionString) {
            await releaseSharedClient(customSessionString);
        }
    }
}

/**
 * Envia o código de login para o telefone informado
 */
async function sendPhoneCode(phone) {
    if (!apiId || !apiHash) {
        throw new Error("TELEGRAM_API_ID ou TELEGRAM_API_HASH ausente no servidor.");
    }

    const stringSession = new StringSession("");
    const tempClient = new TelegramClient(stringSession, apiId, apiHash, {
        connectionRetries: 5,
        requestRetries: 5,
        floodSleepThreshold: 300
    });
    
    await tempClient.connect();
    
    console.log(`[Telegram Login] Solicitando código para ${phone}...`);
    const { phoneCodeHash } = await tempClient.sendCode({
        apiId,
        apiHash
    }, phone);

    const loginId = Date.now() + '-' + Math.round(Math.random() * 1e9);
    pendingLogins.set(loginId, { client: tempClient, phone, phoneCodeHash });

    // Limpeza automática após 5 minutos
    setTimeout(() => {
        if (pendingLogins.has(loginId)) {
            const info = pendingLogins.get(loginId);
            info.client.disconnect().catch(() => {});
            pendingLogins.delete(loginId);
            console.log(`[Telegram Login] Sessão pendente ${loginId} expirou e foi limpa.`);
        }
    }, 300000);

    return { loginId, phoneCodeHash };
}

/**
 * Confirma o código recebido e a senha 2FA (se aplicável)
 */
async function verifyPhoneCode(loginId, code, password) {
    const info = pendingLogins.get(loginId);
    if (!info) {
        throw new Error("Sessão de login expirada ou inválida. Digite o telefone novamente.");
    }

    const { client: tempClient, phone, phoneCodeHash } = info;

    try {
        console.log(`[Telegram Login] Efetuando signIn para ${phone}...`);
        
        try {
            await tempClient.invoke(
                new Api.auth.SignIn({
                    phoneNumber: phone,
                    phoneCodeHash: phoneCodeHash,
                    phoneCode: code
                })
            );
        } catch (err) {
            if (err.message && err.message.includes("SESSION_PASSWORD_NEEDED")) {
                if (!password) {
                    throw new Error("SESSION_PASSWORD_NEEDED");
                }

                console.log(`[Telegram Login] 2FA necessária. Verificando senha para ${phone}...`);
                await tempClient.signInWithPassword(
                    { apiId, apiHash },
                    {
                        password: async () => password,
                        onError: (error) => {
                            throw error;
                        }
                    }
                );
            } else {
                throw err;
            }
        }

        // Login bem-sucedido! Salva e gera a sessionString
        const sessionString = tempClient.session.save();
        
        // Desconecta o cliente temporário
        await tempClient.disconnect().catch(() => {});
        pendingLogins.delete(loginId);

        console.log(`[Telegram Login] Login bem-sucedido para ${phone}!`);
        return sessionString;
    } catch (err) {
        if (err.message === "SESSION_PASSWORD_NEEDED") {
            throw err;
        }
        throw err;
    }
}

/**
 * Baixa um arquivo de uma URL de forma stremada para economizar RAM
 */
function downloadFile(url, destPath, onProgress) {
    return new Promise((resolve, reject) => {
        const protocol = url.startsWith('https') ? https : http;
        
        const options = new URL(url);
        const requestOptions = {
            host: options.host,
            path: options.pathname + options.search,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
            }
        };

        protocol.get(url, requestOptions, (response) => {
            if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
                let redirectUrl = response.headers.location;
                if (!redirectUrl.startsWith('http')) {
                    const origin = new URL(url).origin;
                    redirectUrl = origin + redirectUrl;
                }
                return downloadFile(redirectUrl, destPath, onProgress).then(resolve).catch(reject);
            }

            if (response.statusCode !== 200) {
                return reject(new Error(`Falha ao baixar arquivo. Status: ${response.statusCode}`));
            }

            const totalLength = parseInt(response.headers['content-length'], 10) || 0;
            let downloaded = 0;
            const fileStream = fs.createWriteStream(destPath);

            response.on('data', (chunk) => {
                downloaded += chunk.length;
                if (totalLength > 0 && onProgress) {
                    onProgress(downloaded / totalLength);
                }
            });

            response.pipe(fileStream);

            fileStream.on('finish', () => {
                fileStream.close();
                resolve();
            });

            fileStream.on('error', (err) => {
                fs.unlink(destPath, () => {});
                reject(err);
            });
        }).on('error', (err) => {
            fs.unlink(destPath, () => {});
            reject(err);
        });
    });
}

/**
 * Baixa e faz upload de uma URL de vídeo diretamente para o Telegram
 */
async function downloadAndUploadUrl(url, fileName, onDownloadProgress, onUploadProgress, customSessionString, botToken, channelId) {
    const tempDir = path.join(__dirname, 'temp_uploads');
    if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
    }

    const uniqueId = Date.now() + '-' + Math.round(Math.random() * 1e9);
    let fileExt = path.extname(fileName);
    if (!fileExt) {
        try {
            const urlObj = new URL(url);
            fileExt = path.extname(urlObj.pathname) || '.mp4';
        } catch (e) {
            fileExt = '.mp4';
        }
    }
    const tempFilePath = path.join(tempDir, `migrate-${uniqueId}${fileExt}`);

    try {
        await downloadFile(url, tempFilePath, onDownloadProgress);
        const link = await uploadFileAndGetLink(tempFilePath, fileName, onUploadProgress, customSessionString, botToken, channelId);
        return link;
    } finally {
        if (fs.existsSync(tempFilePath)) {
            fs.unlinkSync(tempFilePath);
        }
    }
}

module.exports = {
    getStatus,
    initClient,
    disconnectClient,
    uploadFileAndGetLink,
    downloadAndUploadUrl,
    sendPhoneCode,
    verifyPhoneCode
};
