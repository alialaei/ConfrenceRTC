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
const PORT      = process.env.PORT      || 3000;
const PUBLIC_IP = process.env.PUBLIC_IP || '52.47.158.117';

const mediaCodecs = [
  { kind:'audio', mimeType:'audio/opus', clockRate:48000, channels:2 },
  { kind:'video', mimeType:'video/VP8',  clockRate:90000,
    parameters:{ 'x-google-start-bitrate':1000 } },
  { kind:'video', mimeType:'video/H264', clockRate:90000,
    parameters:{ 'packetization-mode':1, 'level-asymmetry-allowed':1,
                 'profile-level-id':'42e01f' } }
];

const ICE_SERVERS = [
  { urls:'turn:conference.mmup.org:3478?transport=tcp',
    username:'testuser', credential:'testpassword' },
  { urls:'stun:stun.l.google.com:19302' }
];

const IO_OPTS = {
  listenIps : [{ ip:'0.0.0.0', announcedIp:PUBLIC_IP }],
  enableUdp : true, enableTcp:true, preferUdp:true,
  iceServers: ICE_SERVERS
};

/* ---------- express ------------------------------------------------ */
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors:{ origin:['https://conference.mmup.org'], credentials:true }
});
const ROOT = path.join(__dirname, 'public');
app.use(express.static(ROOT));
app.use(fallback('index.html', { root:ROOT }));

/* ---------- mediasoup bootstrap ------------------------------------ */
let worker, router;
(async () => {
  worker = await mediasoup.createWorker();
  router = await worker.createRouter({ mediaCodecs });
  server.listen(PORT, () => console.log(`✅  Server listening on :${PORT}`));
})();

/* ---------- in-memory state --------------------------------------- */
const rooms  = new Map();      // roomId → { ownerId, participants[], producers[] }
const peers  = new Map();      // socketId → { transports[], producers[], consumers[] }
const timers = new Map();      // roomId  → timeoutId

const roomOf = id =>
  [...rooms.entries()].find(([, r]) => r.participants.includes(id))?.[0] ?? null;

/* ---------- code store for IDE ------------------------------------- */
const codeStore = new Map();   // roomId → code text

/* ---------- socket.io flow ---------------------------------------- */
io.on('connection', socket => {
  console.log('🔌', socket.id, 'connected');
  peers.set(socket.id, { transports:[], producers:[], consumers:[] });
  socket.roomId = null;               // track which room the socket finally joins

  /* ---- mediasoup primitives ------------------------------------ */
  socket.on('getRouterRtpCapabilities', cb => cb(router.rtpCapabilities));

  // 1️⃣  create send/recv transports (client passes {consuming:true} for recv)
  socket.on('createTransport', async ({ consuming = false } = {}, cb) => {
    const transport = await router.createWebRtcTransport({
      ...IO_OPTS, appData:{ consuming }
    });
    peers.get(socket.id).transports.push(transport);

    cb({
      id:transport.id,
      iceParameters : transport.iceParameters,
      iceCandidates : transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters,
      iceServers    : ICE_SERVERS
    });

    transport.on('dtlsstatechange', s => s === 'closed' && transport.close());
  });

  socket.on('connectTransport', async ({ transportId, dtlsParameters }, cb) => {
    const t = peers.get(socket.id).transports.find(x => x.id === transportId);
    if (!t) return cb({ error:'transport not found' });
    await t.connect({ dtlsParameters });
    cb();
  });

  // 2️⃣  Produce ---------------------------------------------------
  socket.on('produce', async ({ transportId, kind, rtpParameters, appData }, cb) => {
    const t = peers.get(socket.id).transports.find(x => x.id === transportId);
    if (!t) return cb({ error:'transport not found' });

    const producer = await t.produce({ kind, rtpParameters, appData });
    peers.get(socket.id).producers.push(producer);

    const roomId = socket.roomId;
    if (roomId) {
      const room = rooms.get(roomId);
      room.producers.push({ socketId:socket.id, producer });
      const mediaTag = producer.appData?.mediaTag;
      room.participants
        .filter(id => id !== socket.id)
        .forEach(id =>
          io.to(id).emit('newProducer',
            { producerId:producer.id, socketId:socket.id, mediaTag }));
    }
    cb({ id:producer.id });
  });

  socket.on('stop-screen', () => {
    const roomId = socket.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);

    room.participants
        .filter(id => id !== socket.id)
        .forEach(id => io.to(id).emit('screen-stopped'));
  });

  // 3️⃣  Consume ---------------------------------------------------
  socket.on('consume', async ({ producerId, rtpCapabilities }, cb) => {
    const t = peers.get(socket.id).transports.find(x => x.appData.consuming);
    if (!t) return cb({ error:'no recv transport' });

    if (!router.canConsume({ producerId, rtpCapabilities }))
      return cb({ error:'cannot consume' });

    const consumer = await t.consume({ producerId, rtpCapabilities, paused:false });
    peers.get(socket.id).consumers.push(consumer);

    cb({
      id           : consumer.id,
      producerId,
      kind         : consumer.kind,
      rtpParameters: consumer.rtpParameters,
      mediaTag     : consumer.appData.mediaTag
    });
  });

  /* ---- room orchestration -------------------------------------- */
  socket.on('join-room', ({ roomId }, cb) => {
    if (timers.has(roomId)) clearTimeout(timers.get(roomId));

    // first user becomes owner
    if (!rooms.has(roomId)) {
      rooms.set(roomId, { ownerId:socket.id, participants:[socket.id], waiting:[], producers:[] });
      socket.roomId = roomId;      // remember
      socket.join(roomId);         // join Socket.IO room right away
      return cb({ isOwner:true, existingProducers:[] });
    }

    const room = rooms.get(roomId);
    room.waiting.push(socket.id);
    io.to(room.ownerId).emit('join-request', { socketId:socket.id });
    cb({ isOwner:false, waitForApproval:true });
  });

  socket.on('approve-join', ({ targetSocketId }) => {
    const roomId = socket.roomId; if (!roomId) return;
    const room   = rooms.get(roomId);

    room.waiting      = room.waiting.filter(id => id !== targetSocketId);
    room.participants.push(targetSocketId);

    io.to(targetSocketId).emit('join-approved', {
      existingProducers: room.producers
        .filter(p => p.socketId !== targetSocketId)
        .map(p => ({ producerId:p.producer.id, socketId:p.socketId, mediaTag:p.producer.appData.mediaTag }))
    });

    const target = io.sockets.sockets.get(targetSocketId);
    if (target) {
      target.roomId = roomId;
      target.join(roomId);
    }
  });

  socket.on('deny-join', ({ targetSocketId }) =>
    io.to(targetSocketId).emit('join-denied'));

  socket.on('disconnect', () => {
    const roomId = socket.roomId;
    if (!roomId) return peers.delete(socket.id);

    const room = rooms.get(roomId);
    if (!room) return peers.delete(socket.id);

    if (socket.id === room.ownerId) {
      timers.set(roomId, setTimeout(() => {
        io.to(room.participants).emit('room-closed');
        rooms.delete(roomId);
      }, 30_000));
    } else {
      room.participants = room.participants.filter(id => id !== socket.id);
      room.producers    = room.producers.filter(p => p.socketId !== socket.id);
      io.to(room.participants).emit('participant-left', { socketId:socket.id });
    }
    peers.delete(socket.id);
  });

  /* ---- collaborative IDE --------------------------------------- */
  socket.on('code-get', ({ roomId }, cb) => {
    cb(codeStore.get(roomId) ?? '');
  });

  socket.on('code-set', ({ roomId, text }) => {
    codeStore.set(roomId, text);
    io.to(roomId).emit('code-update', { text });   // broadcast to *everyone* in room
  });
});