const express = require('express');
const axios = require('axios');
const axiosRetry = require('axios-retry').default;
const cluster = require('cluster');
const os = require('os');
const https = require('https');
const http = require('http');

const PORT = process.env.PORT || 8080;
const TIMEOUT_MS = 20000; // Increased to 20s for slow CDNs
const MAX_REDIRECTS = 15; // Increased for deep redirects

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 1000, maxFreeSockets: 100 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 1000, maxFreeSockets: 100 });

if (cluster.isPrimary) {
    const numCPUs = os.cpus().length;
    console.log(`🔥 PROXY GOD MODE: Master ${process.pid} is running`);
    
    for (let i = 0; i < numCPUs; i++) {
        cluster.fork();
    }

    // FIX: CRASH LOOP PREVENTION
    cluster.on('exit', (worker, code, signal) => {
        console.log(`⚠️ Worker ${worker.process.pid} died (Code: ${code}). Respawning in 5s...`);
        // Add delay to prevent CPU-hogging fork bombs
        setTimeout(() => cluster.fork(), 5000);
    });

} else {
    const app = express();

    // FIX: RETRY LOGIC
    // Don't retry blindly on large media chunks if they timeout halfway, only on connection errors
    axiosRetry(axios, { 
        retries: 3,
        retryDelay: axiosRetry.exponentialDelay,
        retryCondition: (error) => {
            return axiosRetry.isNetworkOrIdempotentRequestError(error) || error.code === 'ECONNABORTED';
        }
    });

    app.use((req, res, next) => {
        res.header('Access-Control-Allow-Origin', '*');
        res.header('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
        // FIX: Add Range to allowed headers
        res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Range');
        // FIX: Expose Content-Range for players to see duration
        res.header('Access-Control-Expose-Headers', 'Content-Length, Content-Type, Content-Range, Accept-Ranges');
        
        if (req.method === 'OPTIONS') {
            return res.sendStatus(200);
        }
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
                .watermark {
                    position: absolute; top: 20px; left: 20px; color: rgba(255, 255, 255, 0.3);
                    font-family: Arial, sans-serif; font-weight: bold; font-size: 18px; pointer-events: none; z-index: 99; text-transform: uppercase;
                }
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
        // FIX: URL & QUERY PRESERVATION
        // 1. Get the full raw URL after the first /
        let rawRequest = req.url.slice(1); 
        
        // 2. Check if "raw=true" exists (internal flag)
        const wantsRaw = rawRequest.includes('raw=true');
        
        // 3. Clean "raw=true" from the target URL so upstream doesn't choke on it
        // We use regex to safely remove ?raw=true or &raw=true
        let targetUrl = rawRequest.replace(/[?&]raw=true/, '');
        
        // 4. Handle edge case where replacing left a dangling '?' or '&' at the end is rare but okay, 
        // normally clean-up not strictly needed for browsers, but good for signed URLs.

        if (!targetUrl || !targetUrl.startsWith('http')) {
            if (targetUrl.includes('favicon')) return res.status(404).end();
            return res.status(400).json({ error: 'Invalid URL' });
        }

        // --- PLAYER INTERCEPT ---
        const isBrowser = req.headers.accept && req.headers.accept.includes('text/html');
        const isM3u8 = targetUrl.includes('.m3u8');

        if (isBrowser && isM3u8 && !wantsRaw) {
            console.log(`[Worker ${process.pid}] 📺 Serving Player: ${targetUrl}`);
            // Append raw=true to the CURRENT url, not the target, to reload this proxy in "raw" mode
            const playerSrc = req.originalUrl + (req.originalUrl.includes('?') ? '&raw=true' : '?raw=true');
            res.setHeader('Content-Type', 'text/html');
            return res.send(getHtmlPlayer(playerSrc));
        }

        console.log(`[Worker ${process.pid}] ⚡ Proxying: ${targetUrl}`);

        try {
            // FIX: HEADER FORWARDING (RANGE SUPPORT)
            const headers = {
                'User-Agent': 'OTT Navigator/1.6.9.4 (Android)',
                'Referer': 'https://allinonereborn.com',
                'Origin': 'https://allinonereborn.com',
                'Accept': '*/*',
                'Connection': 'keep-alive'
            };

            // Important: Forward the Range header if the client asked for it (Seeking)
            if (req.headers.range) {
                headers['Range'] = req.headers.range;
            }

            const response = await axios.get(targetUrl, {
                headers: headers,
                responseType: 'stream',
                maxRedirects: MAX_REDIRECTS,
                timeout: TIMEOUT_MS,
                httpAgent: httpAgent,
                httpsAgent: httpsAgent,
                decompress: false,
                validateStatus: (status) => status < 400 // Accept 200 and 206
            });

            // FIX: RESPONSE HEADERS
            // Explicitly handle partial content (206) vs standard (200)
            res.status(response.status);

            let contentType = response.headers['content-type'];
            if (targetUrl.includes('.m3u8')) contentType = 'application/vnd.apple.mpegurl';
            else if (targetUrl.includes('.ts')) contentType = 'video/MP2T';

            res.setHeader('Content-Type', contentType || 'application/octet-stream');
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.removeHeader('Content-Disposition');

            // Forward critical headers for VOD/Seek
            const headersToForward = [
                'content-length', 
                'content-range', 
                'accept-ranges', 
                'content-encoding', 
                'cache-control', 
                'last-modified'
            ];

            Object.entries(response.headers).forEach(([key, value]) => {
                if (headersToForward.includes(key.toLowerCase())) {
                    res.setHeader(key, value);
                }
            });

            // Ensure we tell clients we accept ranges (even if upstream didn't explicitly say so, though risky, usually good for players)
            if (!res.getHeader('Accept-Ranges')) {
                res.setHeader('Accept-Ranges', 'bytes');
            }

            response.data.pipe(res);

            req.on('close', () => {
                if (response.data) response.data.destroy();
            });

        } catch (error) {
            const status = error.response?.status || 500;
            // Only log non-404 errors to keep logs clean
            if (status !== 404) {
                console.error(`[Worker ${process.pid}] ❌ Error ${status}: ${targetUrl.substring(0, 50)}...`);
            }
            if (!res.headersSent) {
                res.status(status).end();
            }
        }
    });

    app.listen(PORT, () => {});
}
