import { createBot, createFlow, MemoryDB, createProvider, addKeyword } from '@bot-whatsapp/bot'
import { BaileysProvider, handleCtx } from "@bot-whatsapp/provider-baileys";
import fs from 'fs';

// Configurar registro de logs
const logMessage = (message: string): void => {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] ${message}\n`;
    
    fs.appendFileSync('bot-log.txt', logEntry);
    console.log(logEntry.trim());
};

// Tipos e interfaces
interface ConnectionState {
    isConnected: boolean;
    reconnectAttempts: number;
    pingInterval: NodeJS.Timeout | null;
}

interface FailedNumber {
    number: string;
    lastAttempt: Date;
    attempts: number;
}

// Estado de la conexión
const state: ConnectionState = {
    isConnected: false,
    reconnectAttempts: 0,
    pingInterval: null
};

const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_INTERVAL = 30000; // 30 segundos
const MAX_ATTEMPTS_PER_NUMBER = 3;
const RETRY_DELAY_MINUTES = 60; // 1 hora antes de reintentar

let failedNumbers: FailedNumber[] = [];

// Función para limpiar intervalos
const clearIntervals = (): void => {
    if (state.pingInterval) {
        clearInterval(state.pingInterval);
        state.pingInterval = null;
    }
};

// Función para verificar si un número puede ser reintentado
const canRetryNumber = (number: string): boolean => {
    const failed = failedNumbers.find(f => f.number === number);
    if (!failed) return true;
    
    const now = new Date();
    const timeDiff = (now.getTime() - failed.lastAttempt.getTime()) / (1000 * 60);
    
    return failed.attempts < MAX_ATTEMPTS_PER_NUMBER || 
           timeDiff > RETRY_DELAY_MINUTES;
};

// Función para registrar un fallo
const registerFailedNumber = (number: string): void => {
    const existingIndex = failedNumbers.findIndex(f => f.number === number);
    
    if (existingIndex >= 0) {
        failedNumbers[existingIndex].attempts++;
        failedNumbers[existingIndex].lastAttempt = new Date();
    } else {
        failedNumbers.push({
            number,
            attempts: 1,
            lastAttempt: new Date()
        });
    }
    
    // Limpiar números antiguos
    const now = new Date();
    failedNumbers = failedNumbers.filter(f => {
        const timeDiff = (now.getTime() - f.lastAttempt.getTime()) / (1000 * 60);
        return timeDiff <= RETRY_DELAY_MINUTES * 2;
    });
};

// Inicializar bot con manejo de reconexión
const initializeBot = async (): Promise<any> => {
    try {
        logMessage("Inicializando bot de WhatsApp...");
        
        const provider = createProvider(BaileysProvider);
        
        if (provider.vendor && provider.vendor.ev) {
            const vendorEvents = provider.vendor.ev as any;
            
            vendorEvents.on('connection.update', (update: any) => {
                const { connection, lastDisconnect } = update || {};
                
                if (connection === 'open') {
                    state.isConnected = true;
                    state.reconnectAttempts = 0;
                    logMessage("¡Bot conectado correctamente!");
                    
                    clearIntervals();
                    state.pingInterval = setInterval(() => {
                        if (state.isConnected) {
                            logMessage("Verificación periódica: Bot activo y conectado");
                        } else {
                            logMessage("Verificación periódica: Bot desconectado");
                            clearIntervals();
                            
                            if (state.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
                                state.reconnectAttempts++;
                                logMessage(`Intentando reconectar (intento ${state.reconnectAttempts})...`);
                                setTimeout(initializeBot, RECONNECT_INTERVAL);
                            }
                        }
                    }, 300000); // cada 5 minutos
                }
                
                if (connection === 'close') {
                    state.isConnected = false;
                    const statusCode = lastDisconnect?.error?.output?.statusCode;
                    logMessage(`Conexión cerrada. Código de estado: ${statusCode || 'desconocido'}`);
                    
                    clearIntervals();
                    
                    if (state.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
                        state.reconnectAttempts++;
                        const delay = RECONNECT_INTERVAL * state.reconnectAttempts;
                        logMessage(`Intentando reconectar en ${delay/1000} segundos (intento ${state.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
                        
                        setTimeout(initializeBot, delay);
                    } else {
                        logMessage("Máximo de intentos de reconexión alcanzados. Por favor, reinicie el servicio manualmente.");
                    }
                }
            });
        }

        // Configurar servidor HTTP para endpoint de API
        provider.initHttpServer(3002);

        if (provider.http?.server) {
            // Endpoint de verificación de salud
            provider.http.server.get('/health', (req, res) => {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({
                    status: state.isConnected ? 'conectado' : 'desconectado',
                    uptime: process.uptime(),
                    reconnectAttempts: state.reconnectAttempts,
                    timestamp: new Date().toISOString(),
                    failedNumbers: failedNumbers.map(f => ({
                        number: f.number,
                        attempts: f.attempts,
                        lastAttempt: f.lastAttempt.toISOString()
                    }))
                }));
            });

            // Endpoint para reinicio manual
            provider.http.server.get('/restart', (req, res) => {
                logMessage("Reiniciando el bot manualmente...");
                clearIntervals();
                state.reconnectAttempts = 0;
                state.isConnected = false;
                
                setTimeout(() => {
                    initializeBot().then(() => {
                        logMessage("Bot reiniciado correctamente");
                    }).catch(error => {
                        logMessage(`Error al reiniciar el bot: ${error instanceof Error ? error.message : String(error)}`);
                    });
                }, 1000);
                
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({
                    success: true,
                    message: "Reinicio del bot iniciado"
                }));
            });

            // Endpoint mejorado para envío de mensajes
            provider.http.server.post('/send-message', handleCtx(async (bot, req, res) => {
                try {
                    const body = req.body;
                    const message = body.message;
                    const mediaUrl = body.mediaUrl;
                    const numbers = Array.isArray(body.number) ? body.number : [body.number];
                    
                    if (!numbers || numbers.length === 0) {
                        throw new Error('Se requiere al menos un número de teléfono');
                    }

                    const successfulNumbers: string[] = [];
                    const failedNumbersResponse: {number: string, error: string}[] = [];
                    
                    for (const number of numbers) {
                        if (!canRetryNumber(number)) {
                            logMessage(`Saltando número ${number} - demasiados intentos fallidos`);
                            failedNumbersResponse.push({
                                number,
                                error: 'Demasiados intentos fallidos, reintentar más tarde'
                            });
                            continue;
                        }
                        
                        try {
                            logMessage(`Intentando enviar mensaje a ${number}`);
                            
                            const response = await bot.sendMessage(number, message, {
                                media: mediaUrl
                            });
                            
                            logMessage(`Mensaje enviado correctamente a ${number}`);
                            successfulNumbers.push(number);
                            
                            // Limpiar de la lista de fallidos si estaba allí
                            failedNumbers = failedNumbers.filter(f => f.number !== number);
                            
                        } catch (error) {
                            const errorMessage = error instanceof Error ? error.message : String(error);
                            logMessage(`Error al enviar mensaje a ${number}: ${errorMessage}`);
                            
                            registerFailedNumber(number);
                            failedNumbersResponse.push({
                                number,
                                error: errorMessage
                            });
                            
                            continue;
                        }
                    }
                
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({
                        success: successfulNumbers.length > 0,
                        successful: successfulNumbers,
                        failed: failedNumbersResponse,
                        message: successfulNumbers.length > 0 ? 
                               `Mensajes enviados a ${successfulNumbers.length} de ${numbers.length} números` :
                               'No se pudo enviar a ningún número'
                    }));
                    
                } catch (error) {
                    const errorMessage = error instanceof Error ? error.message : String(error);
                    logMessage(`Error en el endpoint de envío: ${errorMessage}`);
                    res.writeHead(500, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({
                        success: false,
                        message: 'Error al procesar la solicitud',
                        error: errorMessage
                    }));
                }
            }));
        }

        // Crear la instancia del bot
        const botInstance = await createBot({
            flow: createFlow([]),
            database: new MemoryDB(),
            provider
        });
        
        return botInstance;
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logMessage(`Error crítico al inicializar el bot: ${errorMessage}`);
        
        if (state.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
            state.reconnectAttempts++;
            const delay = RECONNECT_INTERVAL * state.reconnectAttempts;
            logMessage(`Reintentando inicialización en ${delay/1000} segundos...`);
            setTimeout(initializeBot, delay);
        }
        return null;
    }
};

// Manejar rechazos y excepciones no controladas
process.on('unhandledRejection', (error: unknown) => {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logMessage(`Rechazo de promesa no manejado: ${errorMessage}`);
});

process.on('uncaughtException', (error: Error) => {
    logMessage(`Excepción no capturada: ${error.message}`);
});

// Iniciar el bot
const main = async (): Promise<void> => {
    logMessage("Iniciando servicio de bot de WhatsApp...");
    await initializeBot();
};

main();