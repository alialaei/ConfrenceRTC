const express = require('express');
const path = require('path');
const { Server } = require('socket.io');
const mediasoup = require('mediasoup');

const rooms = new Map();

const app = express();
const http = require('http');
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: '*'
  }
});

const port = 3000;

let worker;
let router;
let peers = new Map(); // key: socket.id → { transports, producers, consumers }

const mediaCodecs = [
  {
    kind: 'audio',
    mimeType: 'audio/opus',
    clockRate: 48000,
    channels: 2
  },
  {
    kind: 'video',
    mimeType: 'video/VP8',
    clockRate: 90000
  }
];

(async () => {
  worker = await mediasoup.createWorker();
  console.log('✅ mediasoup worker created');

  router = await worker.createRouter({ mediaCodecs });
  console.log('✅ mediasoup router created');

  server.listen(3000, () => {
    console.log('✅ Server running on port 3000');
  });
})();

io.on('connection', socket => {
  console.log('🔌 New client:', socket.id);
  peers.set(socket.id, { transports: [], producers: [], consumers: [] });

  socket.on('getRouterRtpCapabilities', (cb) => {
    cb(router.rtpCapabilities);
  });

  socket.on('createTransport', async (cb) => {
    const transport = await router.createWebRtcTransport({
      listenIps: [{ ip: '0.0.0.0', announcedIp: 'webrtcserver.mmup.org' }],
      enableUdp: true,
      enableTcp: true,
      preferUdp: true
    });

    peers.get(socket.id).transports.push(transport);

    cb({
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters
    });

    transport.on('dtlsstatechange', dtlsState => {
      if (dtlsState === 'closed') {
        transport.close();
      }
    });
  });

  socket.on('connectTransport', async ({ transportId, dtlsParameters }, cb) => {
    const transport = peers.get(socket.id).transports.find(t => t.id === transportId);
    await transport.connect({ dtlsParameters });
    cb();
  });

  socket.on('produce', async ({ transportId, kind, rtpParameters }, cb) => {
    const transport = peers.get(socket.id).transports.find(t => t.id === transportId);
    const producer = await transport.produce({ kind, rtpParameters });
    peers.get(socket.id).producers.push(producer);
    cb({ id: producer.id });

    // inform others
    socket.broadcast.emit('newProducer', { producerId: producer.id });
  });

  socket.on('consume', async ({ producerId, rtpCapabilities }, cb) => {
    if (!router.canConsume({ producerId, rtpCapabilities })) {
      return cb({ error: 'Cannot consume' });
    }

    const transport = peers.get(socket.id).transports[0];
    const consumer = await transport.consume({
      producerId,
      rtpCapabilities,
      paused: false
    });

    peers.get(socket.id).consumers.push(consumer);

    cb({
      id: consumer.id,
      producerId,
      kind: consumer.kind,
      rtpParameters: consumer.rtpParameters
    });
  });

  socket.on('join-room', ({ roomId, isOwnerCandidate }, cb) => {
    console.log(`[join-room] socket: ${socket.id}, roomId: ${roomId}, isOwnerCandidate: ${isOwnerCandidate}`);
    if (!rooms.has(roomId)) {
      if (isOwnerCandidate) {
        rooms.set(roomId, {
          ownerId: socket.id,
          participants: [socket.id],
          waiting: []
        });
        cb({ isOwner: true });
        return;
      }
    }

    const room = rooms.get(roomId);
    if (!room) {
      return cb({ isOwner: false, waitForApproval: true });
    }

    room.waiting.push(socket.id);
    const ownerSocket = io.sockets.sockets.get(room.ownerId);
    if (ownerSocket) {
      console.log(`[EMIT] join-request to owner: ${room.ownerId}, from guest: ${socket.id}`);
      ownerSocket.emit('join-request', { socketId: socket.id });
    } else {
      console.log(`[ERROR] Owner socket not found for room: ${roomId}`);
    }
    cb({ isOwner: false, waitForApproval: true });
  });



  socket.on('approve-join', ({ targetSocketId }) => {
    const room = [...rooms.values()].find(r => r.ownerId === socket.id);
    if (room) {
      room.waiting = room.waiting.filter(id => id !== targetSocketId);
      room.participants.push(targetSocketId);
      io.to(targetSocketId).emit('join-approved');
    }
  });

  socket.on('deny-join', ({ targetSocketId }) => {
    io.to(targetSocketId).emit('join-denied');
  });

  socket.on('disconnect', () => {
    rooms.forEach((room, roomId) => {
      room.participants = room.participants.filter(id => id !== socket.id);
      room.waiting = room.waiting.filter(id => id !== socket.id);
      if (room.ownerId === socket.id) {
        io.to(room.participants).emit('room-closed');
        rooms.delete(roomId);
      }
    });
  });
});

const fallback = require('express-history-api-fallback');
const root = path.join(__dirname, 'public');

app.use(express.static(root));
app.use(fallback('index.html', { root }));