require('dotenv').config();
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const readline = require('readline');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});
const askQuestion = (query) => new Promise((resolve) => rl.question(query, resolve));

async function main() {
    const apiId = parseInt(process.env.TELEGRAM_API_ID);
    const apiHash = process.env.TELEGRAM_API_HASH;

    if (!apiId || !apiHash) {
        console.error("❌ Erro: Defina TELEGRAM_API_ID e TELEGRAM_API_HASH no arquivo .env primeiro!");
        console.log("Obtenha essas credenciais em https://my.telegram.org");
        rl.close();
        process.exit(1);
    }

    console.log("Iniciando login no Telegram...");
    const stringSession = new StringSession(""); // Cria uma nova sessão
    const client = new TelegramClient(stringSession, apiId, apiHash, {
        connectionRetries: 5,
    });

    await client.start({
        phoneNumber: async () => await askQuestion("Digite seu número de telefone (com DDI, ex: +5511999999999): "),
        password: async () => await askQuestion("Digite sua senha de 2 etapas (2FA) se houver (ou pressione Enter): "),
        phoneCode: async () => await askQuestion("Digite o código de verificação recebido: "),
        onError: (err) => console.error("Erro no login:", err.message),
    });

    console.log("✅ Login efetuado com sucesso!");
    const sessionString = client.session.save();
    console.log("\n================ COPIE A LINHA ABAIXO E COLE NO SEU ARQUIVO .env ================");
    console.log(`TELEGRAM_SESSION="${sessionString}"`);
    console.log("================================================================================\n");
    
    rl.close();
    await client.disconnect();
    process.exit(0);
}

main().catch(err => {
    console.error("Erro fatal:", err);
    rl.close();
    process.exit(1);
});
