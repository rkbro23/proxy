const express = require('express');
const axios = require('axios');
const axiosRetry = require('axios-retry').default;
const cluster = require('cluster');
const os = require('os');
const https = require('https');
const http = require('http');
const url = require('url');

const PORT = process.env.PORT || 8080;
const TIMEOUT_MS = 20000;
const MAX_REDIRECTS = 15;

// Optimization: Keep sockets open
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 1000, maxFreeSockets: 100 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 1000, maxFreeSockets: 100 });

if (cluster.isPrimary) {
    const numCPUs = os.cpus().length;
    console.log(`🔥 PROXY V5 (BROWSER FIX): Master ${process.pid} running`);
    
    for (let i = 0; i < numCPUs; i++) {
        cluster.fork();
    }

    cluster.on('exit', (worker) => {
        console.log(`⚠️ Worker ${worker.process.pid} died. Respawning...`);
        setTimeout(() => cluster.fork(), 5000);
    });

} else {
    const app = express();

    // Resilience: Retry only on network errors
    axiosRetry(axios, { 
        retries: 3,
        retryDelay: axiosRetry.exponentialDelay,
        retryCondition: (error) => axiosRetry.isNetworkOrIdempotentRequestError(error)
    });

    // Global CORS
    app.use((req, res, next) => {
        res.header('Access-Control-Allow-Origin', '*');
        res.header('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
        res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Range');
        res.header('Access-Control-Expose-Headers', 'Content-Length, Content-Type, Content-Range, Accept-Ranges');
        if (req.method === 'OPTIONS') return res.sendStatus(200);
        next();
    });

    app.get('/health', (req, res) => res.send('🔥 PROXY ONLINE'));

    // --- HTML5 PLAYER GENERATOR ---
    const getHtmlPlayer = (streamUrl) => `
        <!DOCTYPE html>
        <html>
        <head>
            <title>M3U8 Player</title>
            <style>
                body { margin: 0; background: #000; height: 100vh; display: flex; align-items: center; justify-content: center; overflow: hidden; }
                video { width: 100%; height: 100%; max-height: 100vh; }
                .watermark { position: absolute; top: 20px; left: 20px; color: rgba(255,255,255,0.3); font-family: Arial; font-weight: bold; pointer-events: none; z-index: 99; }
            </style>
            <script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
        </head>
        <body>
            <div class="watermark">M3U PLAYLIST</div>
            <video id="video" controls autoplay></video>
            <script>
                var video = document.getElementById('video');
                var videoSrc = "${streamUrl}"; 
                if (Hls.isSupported()) {
                    var hls = new Hls();
                    hls.config.xhrSetup = function(xhr, url) {
                        xhr.withCredentials = false; // Fix CORS credentials
                    };
                    hls.loadSource(videoSrc);
                    hls.attachMedia(video);
                    hls.on(Hls.Events.ERROR, function (event, data) {
                        console.error("HLS Error:", data);
                    });
                } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
                    video.src = videoSrc;
                }
            </script>
        </body>
        </html>
    `;

    app.get('/*', async (req, res) => {
        let rawRequest = req.url.slice(1); 
        const wantsRaw = rawRequest.includes('raw=true');
        // Clean the internal flag from the target URL
        let targetUrl = rawRequest.replace(/[?&]raw=true/, '');

        if (!targetUrl || !targetUrl.startsWith('http')) {
            if (targetUrl.includes('favicon')) return res.status(404).end();
            return res.status(400).json({ error: 'Invalid URL' });
        }

        const isM3u8 = targetUrl.includes('.m3u8');
        const isBrowser = req.headers.accept && req.headers.accept.includes('text/html');

        // 1. SERVE PLAYER (if browser + m3u8 + no raw flag)
        if (isBrowser && isM3u8 && !wantsRaw) {
            const separator = req.originalUrl.includes('?') ? '&' : '?';
            const playerSrc = req.originalUrl + separator + 'raw=true';
            res.setHeader('Content-Type', 'text/html');
            return res.send(getHtmlPlayer(playerSrc));
        }

        try {
            // 2. PREPARE HEADERS (Using your new TiviMate setup)
            const headers = {
                'User-Agent': 'Dalvik/2.1.0 (Linux; Android 10; TiviMate/4.1.0)', // Updated UA
                'Referer': 'https://allinonereborn.xyz', // Updated Domain
                'Origin': 'https://allinonereborn.xyz',
                'Accept': '*/*',
                'Connection': 'keep-alive'
            };
            if (req.headers.range) headers['Range'] = req.headers.range;

            const responseType = isM3u8 ? 'text' : 'stream';

            console.log(`[Worker ${process.pid}] Fetching: ${targetUrl}`);

            const response = await axios.get(targetUrl, {
                headers,
                responseType: responseType,
                maxRedirects: MAX_REDIRECTS,
                timeout: TIMEOUT_MS,
                httpAgent: httpAgent,
                httpsAgent: httpsAgent,
                decompress: false,
                validateStatus: (status) => status < 400
            });

            // 3. MANIFEST REWRITER (The Fix for Render.com/Mixed Content)
            if (isM3u8) {
                const targetBaseUrl = targetUrl.substring(0, targetUrl.lastIndexOf('/') + 1);
                
                // FORCE HTTPS: Detect if we are behind a proxy (like Render)
                // If x-forwarded-proto is 'https', use 'https'. Otherwise fallback to req.protocol
                const currentProtocol = req.headers['x-forwarded-proto'] === 'https' ? 'https' : req.protocol;
                const currentHost = req.headers.host;
                const proxyBase = `${currentProtocol}://${currentHost}/`;

                let m3u8Content = response.data;
                if (typeof m3u8Content !== 'string') m3u8Content = m3u8Content.toString();

                const rewrittenM3u8 = m3u8Content.split('\n').map(line => {
                    const trimmed = line.trim();
                    if (!trimmed || trimmed.startsWith('#')) return line;

                    // Resolve relative path to absolute
                    const absoluteUrl = trimmed.startsWith('http') 
                        ? trimmed 
                        : url.resolve(targetBaseUrl, trimmed);

                    // Prepend OUR proxy URL
                    return `${proxyBase}${absoluteUrl}`;
                }).join('\n');

                res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
                res.send(rewrittenM3u8);
                return;
            }

            // 4. STREAM DATA (TS Segments)
            res.status(response.status);
            
            // Forward safe headers
            const headersToForward = ['content-length', 'content-range', 'accept-ranges', 'content-type'];
            Object.entries(response.headers).forEach(([key, value]) => {
                if (headersToForward.includes(key.toLowerCase())) res.setHeader(key, value);
            });

            // Fix Content-Type for TS
            if (targetUrl.includes('.ts')) res.setHeader('Content-Type', 'video/MP2T');
            
            res.removeHeader('Content-Disposition');
            response.data.pipe(res);

            req.on('close', () => response.data.destroy && response.data.destroy());

        } catch (error) {
            const status = error.response?.status || 500;
            if (status !== 404) console.error(`[Worker ${process.pid}] Error: ${error.message}`);
            if (!res.headersSent) res.status(status).end();
        }
    });

    app.listen(PORT, () => {});
}
