/* ------------------------------------------------------------------ */
/*  Simple mediasoup + socket.io room server                          */
/* ------------------------------------------------------------------ */
const path       = require('path');
const http       = require('http');
const express    = require('express');
const fallback   = require('express-history-api-fallback');
const { Server } = require('socket.io');
const mediasoup  = require('mediasoup');

/* ---------- constants --------------------------------------------- */
const PORT        = process.env.PORT       || 3000;
const PUBLIC_IP   = process.env.PUBLIC_IP  || '52.47.158.117';
const TURN_USER   = process.env.TURN_USER  || 'testuser';
const TURN_PASS   = process.env.TURN_PASS  || 'testpassword';
const TURN_URL    = `turn:conference.mmup.org:3478?transport=udp`;

const mediaCodecs = [
  { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
  { kind: 'video', mimeType: 'video/VP8',   clockRate: 90000 }
];

const ICE_SERVERS = [
    { urls: ['turn:conference.mmup.org:3478?transport=tcp'],
        username: 'testuser', credential: 'testpassword' 
    },
    { urls: ['stun:stun.l.google.com:19302'] }
];

const IO_OPTS = {
  listenIps  : [{ ip: '0.0.0.0', announcedIp: PUBLIC_IP }],
  enableUdp  : true,
  enableTcp  : true,
  preferUdp  : true,
  iceServers : ICE_SERVERS
};

/* ---------- express ------------------------------------------------ */
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: ['https://conference.mmup.org'], credentials: true }
});

const ROOT = path.join(__dirname, 'public');
app.use(express.static(ROOT));
app.use(fallback('index.html', { root: ROOT }));

/* ---------- mediasoup bootstrap ------------------------------------ */
let worker, router;
(async () => {
  worker = await mediasoup.createWorker();
  router = await worker.createRouter({ mediaCodecs });
  server.listen(PORT, () => console.log(`✅  Server listening on :${PORT}`));
})();

/* ---------- in-memory state ---------------------------------------- */
const rooms = new Map();  // roomId -> { ownerId, participants[], producers[] }
const peers = new Map();  // socketId -> { transports[], producers[], consumers[] }
const timers = new Map(); // roomId  -> disconnectTimeoutId

const roomOf = id =>
  [...rooms.entries()].find(([, r]) => r.participants.includes(id))?.[0] ?? null;

/* ---------- socket.io flow ---------------------------------------- */
io.on('connection', socket => {
  console.log('🔌', socket.id, 'connected');
  peers.set(socket.id, { transports: [], producers: [], consumers: [] });

  /* ---- mediasoup primitives --------------------------------------- */
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
    if (!dtlsParameters?.fingerprints?.length)
      return cb({ error: 'bad dtlsParameters' });

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

    const roomId = roomOf(socket.id);
    if (roomId) {
      const room = rooms.get(roomId);
      room.producers.push({ socketId: socket.id, producer });
      room.participants
        .filter(id => id !== socket.id)
        .forEach(id => io.to(id).emit('newProducer',
          { producerId: producer.id, socketId: socket.id }));
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
    cb({
      id: consumer.id, producerId, kind: consumer.kind, rtpParameters: consumer.rtpParameters
    });
  });

  /* ---- room orchestration ----------------------------------------- */
  socket.on('join-room', ({ roomId }, cb) => {
    if (timers.has(roomId)) clearTimeout(timers.get(roomId));

    if (!rooms.has(roomId)) {
      rooms.set(roomId, { ownerId: socket.id, participants: [socket.id],
                          waiting: [], producers: [] });
      return cb({ isOwner: true, existingProducers: [] });
    }

    const room = rooms.get(roomId);
    room.waiting.push(socket.id);
    io.to(room.ownerId).emit('join-request', { socketId: socket.id });
    cb({ isOwner: false, waitForApproval: true });
  });

  socket.on('approve-join', ({ targetSocketId }) => {
    const roomId = roomOf(socket.id); if (!roomId) return;
    const room   = rooms.get(roomId);

    room.waiting      = room.waiting.filter(id => id !== targetSocketId);
    room.participants.push(targetSocketId);

    io.to(targetSocketId).emit('join-approved', {
      existingProducers: room.producers
        .filter(p => p.socketId !== targetSocketId)
        .map(p => ({ producerId: p.producer.id, socketId: p.socketId }))
    });
  });

  socket.on('deny-join', ({ targetSocketId }) =>
    io.to(targetSocketId).emit('join-denied'));

  socket.on('disconnect', () => {
    const roomId = roomOf(socket.id);
    if (!roomId) return peers.delete(socket.id);

    const room = rooms.get(roomId);
    if (socket.id === room.ownerId) {
      timers.set(roomId, setTimeout(() => {
        io.to(room.participants).emit('room-closed');
        rooms.delete(roomId);
      }, 30_000));
    } else {
      room.participants = room.participants.filter(id => id !== socket.id);
      room.producers    = room.producers.filter(p => p.socketId !== socket.id);
    }
    peers.delete(socket.id);
  });
});
