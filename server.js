// server.js
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import fallback from 'express-history-api-fallback';
import { Server } from 'socket.io';
import * as mediasoup from 'mediasoup';

/* ---------- constants --------------------------------------------------- */

const PORT            = process.env.PORT         ?? 3000;
const PUBLIC_IP       = process.env.PUBLIC_IP    ?? '52.47.158.117';
const PRIVATE_IP      = process.env.PRIVATE_IP   ?? '172.31.47.235';
const TURN_USER       = process.env.TURN_USER    ?? 'testuser';
const TURN_PASS       = process.env.TURN_PASS    ?? 'testpassword';
const TURN_URL        = `turn:conference.mmup.org:3478?transport=udp`;

const mediaCodecs = [
  { kind: 'audio', mimeType: 'audio/opus', clockRate: 48_000, channels: 2 },
  { kind: 'video', mimeType: 'video/VP8',   clockRate: 90_000            }
];

const ICE_SERVERS = [{ urls: [TURN_URL], username: TURN_USER, credential: TURN_PASS }];

/* ---------- express & socket.io ----------------------------------------- */

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: ['https://conference.mmup.org'], credentials: true }
});

const ROOT = path.join(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname), 'public');
app.use(express.static(ROOT));
app.use(fallback('index.html', { root: ROOT }));

/* ---------- mediasoup bootstrap ----------------------------------------- */

let worker, router;
const rooms      = new Map(); // roomId -> roomData
const peers      = new Map(); // socketId -> {transports, producers, consumers}
const ownerTimer = new Map(); // roomId  -> disconnectTimeoutId

(async () => {
  worker  = await mediasoup.createWorker();
  router  = await worker.createRouter({ mediaCodecs });
  server.listen(PORT, () => console.log(`✅  HTTP / WebSocket listening on :${PORT}`));
})();

/* ---------- helpers ----------------------------------------------------- */

const IO_OPTS = {
  listenIps     : [{ ip: '0.0.0.0', announcedIp: PUBLIC_IP }],
  enableUdp     : true,
  enableTcp     : true,
  preferUdp     : true,
  iceServers    : ICE_SERVERS
};

const findRoomBySocket = id =>
  [...rooms.entries()].find(([, r]) => r.participants.includes(id))?.[0] ?? null;

/* ---------- socket.io flow --------------------------------------------- */

io.on('connection', socket => {
  console.log(`🔌  ${socket.id} connected`);
  peers.set(socket.id, { transports: [], producers: [], consumers: [] });

  /* ----- mediasoup primitives ------------------------------------------ */
  socket.on('getRouterRtpCapabilities', cb => cb(router.rtpCapabilities));

  socket.on('createTransport', async cb => {
    const transport = await router.createWebRtcTransport(IO_OPTS);
    peers.get(socket.id).transports.push(transport);

    cb({
      id            : transport.id,
      iceParameters : transport.iceParameters,
      iceCandidates : transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters,
      iceServers    : ICE_SERVERS
    });

    transport.on('dtlsstatechange', s => s === 'closed' && transport.close());
  });

  socket.on('connectTransport', async ({ transportId, dtlsParameters }, cb) => {
    const t = peers.get(socket.id).transports.find(x => x.id === transportId);
    if (!t) return cb({ error: 'transport not found' });
    await t.connect({ dtlsParameters });
    cb();
  });

  socket.on('produce', async ({ transportId, kind, rtpParameters }, cb) => {
    const t = peers.get(socket.id).transports.find(x => x.id === transportId);
    if (!t) return cb({ error: 'transport not found' });

    const producer = await t.produce({ kind, rtpParameters });
    peers.get(socket.id).producers.push(producer);

    const roomId = findRoomBySocket(socket.id);
    if (roomId) {
      const room = rooms.get(roomId);
      room.producers.push({ socketId: socket.id, producer });
      room.participants
        .filter(p => p !== socket.id)
        .forEach(p => io.to(p).emit('newProducer', { producerId: producer.id, socketId: socket.id }));
    }
    cb({ id: producer.id });
  });

  socket.on('consume', async ({ producerId, rtpCapabilities }, cb) => {
    if (!router.canConsume({ producerId, rtpCapabilities }))
      return cb({ error: 'cannot consume' });

    let t = peers.get(socket.id).transports.find(x => x.appData?.consuming);
    if (!t) {
      t = await router.createWebRtcTransport({ ...IO_OPTS, appData: { consuming: true } });
      peers.get(socket.id).transports.push(t);
    }
    const consumer = await t.consume({ producerId, rtpCapabilities, paused: false });
    peers.get(socket.id).consumers.push(consumer);
    cb({ id: consumer.id, producerId, kind: consumer.kind, rtpParameters: consumer.rtpParameters });
  });

  /* ----- room orchestration ------------------------------------------- */
  socket.on('join-room', ({ roomId }, cb) => {
    if (ownerTimer.has(roomId)) clearTimeout(ownerTimer.get(roomId));

    if (!rooms.has(roomId)) {
      rooms.set(roomId, { ownerId: socket.id, participants: [socket.id], waiting: [], producers: [] });
      return cb({ isOwner: true, existingProducers: [] });
    }

    const room = rooms.get(roomId);
    room.waiting.push(socket.id);
    io.to(room.ownerId).emit('join-request', { socketId: socket.id });
    cb({ isOwner: false, waitForApproval: true });
  });

  socket.on('approve-join', ({ targetSocketId }) => {
    const roomId = findRoomBySocket(socket.id);
    if (!roomId) return;
    const room = rooms.get(roomId);
    room.waiting = room.waiting.filter(id => id !== targetSocketId);
    room.participants.push(targetSocketId);

    io.to(targetSocketId).emit('join-approved', {
      existingProducers: room.producers
        .filter(p => p.socketId !== targetSocketId)
        .map(p => ({ producerId: p.producer.id, socketId: p.socketId }))
    });
  });

  socket.on('deny-join', ({ targetSocketId }) => io.to(targetSocketId).emit('join-denied'));

  socket.on('disconnect', () => {
    const roomId = findRoomBySocket(socket.id);
    if (!roomId) return peers.delete(socket.id);

    const room = rooms.get(roomId);
    if (socket.id === room.ownerId) {
      const timer = setTimeout(() => {
        io.to(room.participants).emit('room-closed');
        rooms.delete(roomId);
      }, 30_000);
      ownerTimer.set(roomId, timer);
    } else {
      room.participants = room.participants.filter(id => id !== socket.id);
      room.producers   = room.producers.filter(p => p.socketId !== socket.id);
    }
    peers.delete(socket.id);
  });
});
