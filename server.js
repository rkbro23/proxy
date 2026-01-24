const express = require('express');
const axios = require('axios');
const axiosRetry = require('axios-retry').default;
const cluster = require('cluster');
const os = require('os');
const https = require('https');
const http = require('http');
const url = require('url'); // Needed for path resolution

const PORT = process.env.PORT || 8080;
const TIMEOUT_MS = 20000;
const MAX_REDIRECTS = 15;

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 1000, maxFreeSockets: 100 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 1000, maxFreeSockets: 100 });

if (cluster.isPrimary) {
    const numCPUs = os.cpus().length;
    console.log(`🔥 MANIFEST REWRITER ACTIVE: Master ${process.pid} is running`);
    
    for (let i = 0; i < numCPUs; i++) {
        cluster.fork();
    }

    cluster.on('exit', (worker, code, signal) => {
        console.log(`⚠️ Worker ${worker.process.pid} died. Respawning in 5s...`);
        setTimeout(() => cluster.fork(), 5000);
    });

} else {
    const app = express();

    axiosRetry(axios, { 
        retries: 3,
        retryDelay: axiosRetry.exponentialDelay,
        retryCondition: (error) => axiosRetry.isNetworkOrIdempotentRequestError(error)
    });

    app.use((req, res, next) => {
        res.header('Access-Control-Allow-Origin', '*');
        res.header('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
        res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Range');
        res.header('Access-Control-Expose-Headers', 'Content-Length, Content-Type, Content-Range, Accept-Ranges');
        if (req.method === 'OPTIONS') return res.sendStatus(200);
        next();
    });

    app.get('/health', (req, res) => res.send('🔥 PROXY ONLINE'));

    // --- PLAYER UI ---
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
                    hls.loadSource(videoSrc);
                    hls.attachMedia(video);
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
        let targetUrl = rawRequest.replace(/[?&]raw=true/, '');

        if (!targetUrl || !targetUrl.startsWith('http')) {
            if (targetUrl.includes('favicon')) return res.status(404).end();
            return res.status(400).json({ error: 'Invalid URL' });
        }

        // Detect if this is an M3U8 Request
        const isM3u8 = targetUrl.includes('.m3u8');
        const isBrowser = req.headers.accept && req.headers.accept.includes('text/html');

        // 1. Serve Player if Browser + M3U8 + No Raw Flag
        if (isBrowser && isM3u8 && !wantsRaw) {
            const playerSrc = req.originalUrl + (req.originalUrl.includes('?') ? '&raw=true' : '?raw=true');
            res.setHeader('Content-Type', 'text/html');
            return res.send(getHtmlPlayer(playerSrc));
        }

        console.log(`[Worker ${process.pid}] ⚡ Request: ${targetUrl}`);

        try {
            // 2. FETCH DATA
            // If it is an M3U8, we need 'text' to rewrite it. If it's video (TS), we need 'stream'.
            const responseType = isM3u8 ? 'text' : 'stream';

            const headers = {
                'User-Agent': 'OTT Navigator/1.6.9.4 (Android)',
                'Referer': 'https://allinonereborn.com',
                'Origin': 'https://allinonereborn.com',
                'Accept': '*/*',
                'Connection': 'keep-alive'
            };
            if (req.headers.range) headers['Range'] = req.headers.range;

            const response = await axios.get(targetUrl, {
                headers,
                responseType: responseType, // Dynamic Type
                maxRedirects: MAX_REDIRECTS,
                timeout: TIMEOUT_MS,
                httpAgent: httpAgent,
                httpsAgent: httpsAgent,
                decompress: false,
                validateStatus: (status) => status < 400
            });

            // 3. HANDLE M3U8 REWRITING (The Magic Fix)
            if (isM3u8) {
                // Determine the "Folder" of the target URL to resolve relative paths
                // e.g. Target: http://site.com/live/stream.m3u8 -> Base: http://site.com/live/
                const targetBaseUrl = targetUrl.substring(0, targetUrl.lastIndexOf('/') + 1);
                
                let m3u8Content = response.data;
                if (typeof m3u8Content !== 'string') {
                    m3u8Content = m3u8Content.toString(); // Safety catch
                }

                // Rewrite every line
                const rewrittenM3u8 = m3u8Content.split('\n').map(line => {
                    const trimmed = line.trim();
                    // Ignore comments and empty lines
                    if (!trimmed || trimmed.startsWith('#')) return line;

                    // It's a file path! Resolve it.
                    let absoluteUrl;
                    if (trimmed.startsWith('http')) {
                        absoluteUrl = trimmed; // Already absolute
                    } else {
                        absoluteUrl = url.resolve(targetBaseUrl, trimmed); // Make relative absolute
                    }

                    // Wrap it in our Proxy URL
                    // We point it back to THIS server: /http://site.com/segment.ts
                    return `${req.protocol}://${req.headers.host}/${absoluteUrl}`;
                }).join('\n');

                // Send Rewritten M3U8
                res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
                res.setHeader('Access-Control-Allow-Origin', '*');
                res.send(rewrittenM3u8);
                return;
            }

            // 4. HANDLE NORMAL STREAMS (TS, MP4) - Zero Copy Pipe
            res.status(response.status);
            
            // Forward Headers
            const headersToForward = ['content-length', 'content-range', 'accept-ranges', 'content-type'];
            Object.entries(response.headers).forEach(([key, value]) => {
                if (headersToForward.includes(key.toLowerCase())) res.setHeader(key, value);
            });
            
            // Force Correct Content Type for TS files
            if (targetUrl.includes('.ts')) res.setHeader('Content-Type', 'video/MP2T');
            
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.removeHeader('Content-Disposition');
            
            response.data.pipe(res);
            req.on('close', () => response.data.destroy && response.data.destroy());

        } catch (error) {
            const status = error.response?.status || 500;
            if (status !== 404) console.error(`[Worker ${process.pid}] ❌ Error: ${error.message}`);
            if (!res.headersSent) res.status(status).end();
        }
    });

    app.listen(PORT, () => {});
}
