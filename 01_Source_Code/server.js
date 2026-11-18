'use strict';

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const WebSocket = require('ws');

const ROOT = path.resolve(__dirname, 'public');
const PORT = Number(process.env.PORT || 8080);
const CERT_FILE = process.env.TLS_CERT || path.join(__dirname, 'certs', 'lan-cert.pem');
const KEY_FILE = process.env.TLS_KEY || path.join(__dirname, 'certs', 'lan-key.pem');
const TLS_ENABLED = fs.existsSync(CERT_FILE) && fs.existsSync(KEY_FILE);
const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml'
};

const requestHandler = (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Method not allowed');
        return;
    }

    let pathname;
    try {
        pathname = decodeURIComponent(new URL(req.url, `${TLS_ENABLED ? 'https' : 'http'}://localhost`).pathname);
    } catch {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Bad request');
        return;
    }

    if (pathname === '/') pathname = '/index.html';
    const file = path.resolve(ROOT, `.${pathname}`);
    if (file !== ROOT && !file.startsWith(`${ROOT}${path.sep}`)) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Forbidden');
        return;
    }

    fs.readFile(file, (error, data) => {
        if (error) {
            res.writeHead(error.code === 'ENOENT' || error.code === 'EISDIR' ? 404 : 500, {
                'Content-Type': 'text/plain; charset=utf-8',
                'Cache-Control': 'no-store'
            });
            res.end(error.code === 'ENOENT' || error.code === 'EISDIR' ? 'Not found' : 'Server error');
            return;
        }
        res.writeHead(200, {
            'Content-Type': MIME_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff'
        });
        res.end(req.method === 'HEAD' ? undefined : data);
    });
};

let server;
if (TLS_ENABLED) {
    server = https.createServer({ cert: fs.readFileSync(CERT_FILE), key: fs.readFileSync(KEY_FILE) }, requestHandler);
} else {
    server = http.createServer(requestHandler);
}

const wss = new WebSocket.Server({ server, maxPayload: 1024 * 1024 });
const rooms = new Map();
const ALLOWED_SIGNAL_TYPES = new Set(['offer', 'answer', 'candidate']);

function sendJson(socket, message) {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function removeFromRoom(socket, announce = true) {
    if (!socket.room) return;
    const oldRoom = socket.room;
    const peers = rooms.get(oldRoom);
    socket.room = null;
    if (!peers) return;
    peers.delete(socket);
    if (announce) {
        for (const peer of peers) sendJson(peer, { type: 'peer-left' });
    }
    if (peers.size === 0) rooms.delete(oldRoom);
}

wss.on('connection', socket => {
    socket.id = crypto.randomUUID();
    socket.room = null;

    socket.on('message', raw => {
        let message;
        try {
            message = JSON.parse(raw.toString());
        } catch {
            sendJson(socket, { type: 'error', message: 'Invalid JSON signaling message.' });
            return;
        }
        if (!message || typeof message !== 'object' || Array.isArray(message)) {
            sendJson(socket, { type: 'error', message: 'Invalid JSON signaling message.' });
            return;
        }

        if (message.type === 'join') {
            const room = String(message.room || 'experiment').trim().slice(0, 64) || 'experiment';
            if (socket.room === room) {
                sendJson(socket, { type: 'joined', id: socket.id, peers: Math.max(0, (rooms.get(room)?.size || 1) - 1) });
                return;
            }
            const existingPeers = rooms.get(room) || new Set();
            if (!existingPeers.has(socket) && existingPeers.size >= 2) {
                sendJson(socket, { type: 'error', message: 'This room already has two participants.' });
                return;
            }

            removeFromRoom(socket);
            let peers = rooms.get(room);
            if (!peers) {
                peers = new Set();
                rooms.set(room, peers);
            }
            sendJson(socket, { type: 'joined', id: socket.id, peers: peers.size });
            for (const peer of peers) sendJson(peer, { type: 'peer-joined' });
            peers.add(socket);
            socket.room = room;
            return;
        }

        if (!socket.room || !rooms.has(socket.room)) {
            sendJson(socket, { type: 'error', message: 'Join a room before signaling.' });
            return;
        }
        if (!ALLOWED_SIGNAL_TYPES.has(message.type)) {
            sendJson(socket, { type: 'error', message: 'Unsupported signaling message type.' });
            return;
        }

        const peers = rooms.get(socket.room);
        for (const peer of peers) {
            if (peer !== socket) sendJson(peer, { ...message, from: socket.id });
        }
    });

    socket.on('close', () => removeFromRoom(socket));
    socket.on('error', error => {
        process.stderr.write(`WebSocket client error: ${error.message}\n`);
    });
});

server.on('error', error => {
    process.stderr.write(`Server error: ${error.message}\n`);
    process.exitCode = 1;
});

server.listen(PORT, '0.0.0.0', () => {
    const protocol = TLS_ENABLED ? 'https' : 'http';
    console.log(`WebRTC experiment app: ${protocol}://localhost:${PORT}`);
    if (TLS_ENABLED) console.log(`TLS enabled using certificate: ${CERT_FILE}`);
    else console.log('TLS is not configured. Remote browsers will usually block camera/microphone access. See README.md for local HTTPS setup.');
});
