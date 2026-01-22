const express = require('express');
const axios = require('axios');
const axiosRetry = require('axios-retry').default; // Robustness
const cluster = require('cluster');
const os = require('os');
const https = require('https');
const http = require('http');

// CONFIGURATION
const PORT = process.env.PORT || 8080;
const TIMEOUT_MS = 15000;
const MAX_REDIRECTS = 5;

// 1. PERFORMANCE: CONNECTION POOLING
// This keeps TCP connections open so we don't waste time handshaking for every segment.
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 1000, maxFreeSockets: 100 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 1000, maxFreeSockets: 100 });

// 2. SCALABILITY: CLUSTER MODE
// If this is the Master process, fork workers for every CPU core.
if (cluster.isPrimary) {
    const numCPUs = os.cpus().length;
    console.log(`🔥 BEAST MODE ACTIVATED: Master ${process.pid} is running`);
    console.log(`🔥 Spawning ${numCPUs} worker threads for maximum throughput...`);

    for (let i = 0; i < numCPUs; i++) {
        cluster.fork();
    }

    cluster.on('exit', (worker, code, signal) => {
        console.log(`⚠️ Worker ${worker.process.pid} died. Respawning immediately...`);
        cluster.fork(); // Auto-heal if a thread crashes
    });

} else {
    // WORKER PROCESS
    const app = express();

    // 3. RESILIENCE: AUTO-RETRY
    // If the target fails (5xx error) or network blips, retry 3 times automatically.
    axiosRetry(axios, { 
        retries: 3,
        retryDelay: axiosRetry.exponentialDelay,
        retryCondition: (error) => {
            return axiosRetry.isNetworkOrIdempotentRequestError(error) || error.code === 'ECONNABORTED';
        }
    });

    // Optimized CORS for Speed
    app.use((req, res, next) => {
        res.header('Access-Control-Allow-Origin', '*');
        res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
        res.header('Access-Control-Expose-Headers', 'Content-Length, Content-Type');
        
        // Handle preflight immediately to save resources
        if (req.method === 'OPTIONS') {
            return res.sendStatus(200);
        }
        next();
    });

    // Health Check (Good for monitoring)
    app.get('/health', (req, res) => res.send('🔥 BEAST MODE ONLINE'));

    // THE PROXY HANDLER
    app.get('/*', async (req, res) => {
        const targetUrl = req.url.slice(1);

        if (!targetUrl || !targetUrl.startsWith('http')) {
            // Silently ignore favicon or bad requests to keep logs clean
            if (targetUrl.includes('favicon')) return res.status(404).end();
            return res.status(400).json({ error: 'Invalid Target URL' });
        }

        console.log(`[Worker ${process.pid}] ⚡ Proxying: ${targetUrl}`);

        try {
            const response = await axios.get(targetUrl, {
                headers: {
                    'User-Agent': 'OTT Navigator/1.6.9.4 (Android)',
                    'Referer': 'https://allinonereborn.com',
                    'Origin': 'https://allinonereborn.com',
                    'X-Requested-With': 'XMLHttpRequest',
                    'Accept': '*/*',
                    'Connection': 'keep-alive' // Crucial
                },
                responseType: 'stream',
                maxRedirects: MAX_REDIRECTS,
                timeout: TIMEOUT_MS,
                httpAgent: httpAgent,   // Use our turbo agents
                httpsAgent: httpsAgent,
                decompress: false, // 4. CPU SAVER: Don't unzip; let the browser do it.
                validateStatus: (status) => status < 400 // Reject 400+ immediately
            });

            // Forward Headers Cleanly
            const headersToForward = ['content-type', 'content-length', 'content-encoding', 'cache-control', 'last-modified'];
            Object.entries(response.headers).forEach(([key, value]) => {
                if (headersToForward.includes(key.toLowerCase())) {
                    res.setHeader(key, value);
                }
            });

            // Pipe data directly (Zero-Copy approach)
            response.data.pipe(res);

            // Cleanup on Client Disconnect (Stop downloading if user closes tab)
            req.on('close', () => {
                if (response.data) response.data.destroy();
            });

        } catch (error) {
            const status = error.response?.status || 500;
            // Only log actual errors, not just 404s from target
            if (status !== 404) {
                console.error(`[Worker ${process.pid}] ❌ Error: ${error.message} on ${targetUrl}`);
            }
            if (!res.headersSent) {
                res.status(status).json({ error: 'Proxy Request Failed', details: error.message });
            }
        }
    });

    app.listen(PORT, () => {
        // Quiet startup log per worker
    });
      }
