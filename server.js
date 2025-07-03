const express = require('express');
const path = require('path');
const { Server } = require('socket.io');
const mediasoup = require('mediasoup');
const http = require('http');
const fallback = require('express-history-api-fallback');

const rooms = new Map();
const peers = new Map(); // socketId -> { transports, producers, consumers }
const ownerDisconnectTimers = {};

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: ['https://conference.mmup.org'],
    methods: ["GET", "POST"],
    credentials: true
  }
});

const port = 3000;

let worker;
let router;

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

  server.listen(port, () => {
    console.log(`✅ Server running on port ${port}`);
  });
})();

io.on('connection', socket => {
  peers.set(socket.id, { transports: [], producers: [], consumers: [] });

  socket.on('getRouterRtpCapabilities', cb => cb(router.rtpCapabilities));

  socket.on('createTransport', async cb => {
    const transport = await router.createWebRtcTransport({
      listenIps: [{ ip: '0.0.0.0', announcedIp: 'webrtcserver.mmup.org' }],
      enableUdp: true, enableTcp: true, preferUdp: true
    });
    peers.get(socket.id).transports.push(transport);
    cb({
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters
    });
    transport.on('dtlsstatechange', dtlsState => {
      if (dtlsState === 'closed') transport.close();
    });
  });

  socket.on('connectTransport', async ({ transportId, dtlsParameters }, cb) => {
    const transport = peers.get(socket.id).transports.find(t => t.id === transportId);
    if (!transport) return cb({ error: 'Transport not found' });
    await transport.connect({ dtlsParameters });
    cb();
  });

  socket.on('produce', async ({ transportId, kind, rtpParameters }, cb) => {
    const transport = peers.get(socket.id).transports.find(t => t.id === transportId);
    if (!transport) return cb({ error: 'Transport not found' });
    const producer = await transport.produce({ kind, rtpParameters });
    peers.get(socket.id).producers.push(producer);

    // Add to room producers
    let roomId = findRoomByParticipant(socket.id);
    if (roomId) {
      const room = rooms.get(roomId);
      if (!room.producers) room.producers = [];
      room.producers.push({ socketId: socket.id, producer });

      // Broadcast to other participants
      room.participants.forEach(pid => {
        if (pid !== socket.id) io.to(pid).emit('newProducer', { producerId: producer.id, socketId: socket.id });
      });
    }
    cb({ id: producer.id });
  });

  socket.on('consume', async ({ producerId, rtpCapabilities }, cb) => {
    if (!router.canConsume({ producerId, rtpCapabilities })) return cb({ error: 'Cannot consume' });

    let transport = peers.get(socket.id).transports.find(t => t.appData && t.appData.consuming);
    if (!transport) {
      transport = await router.createWebRtcTransport({
        listenIps: [{ ip: '0.0.0.0', announcedIp: 'webrtcserver.mmup.org' }],
        enableUdp: true, enableTcp: true, preferUdp: true,
        appData: { consuming: true }
      });
      peers.get(socket.id).transports.push(transport);
    }
    const consumer = await transport.consume({
      producerId, rtpCapabilities, paused: false
    });
    peers.get(socket.id).consumers.push(consumer);
    cb({
      id: consumer.id, producerId, kind: consumer.kind, rtpParameters: consumer.rtpParameters
    });
  });

  // -------- Fix: Room Owner role and Existing Producers --------
  socket.on('join-room', ({ roomId }, cb) => {
    // Owner reconnected, clear the grace period timer
    if (ownerDisconnectTimers[roomId]) {
      clearTimeout(ownerDisconnectTimers[roomId]);
      delete ownerDisconnectTimers[roomId];
    }

    if (!rooms.has(roomId)) {
      // First join = owner
      rooms.set(roomId, {
        ownerId: socket.id,
        participants: [socket.id],
        waiting: [],
        producers: [],
      });
      cb({ isOwner: true, existingProducers: [] });
      return;
    }
    const room = rooms.get(roomId);
    if (!room.participants.includes(socket.id)) room.waiting.push(socket.id);
    // Send join-request to owner
    const ownerSocket = io.sockets.sockets.get(room.ownerId);
    if (ownerSocket) ownerSocket.emit('join-request', { socketId: socket.id });
    cb({ isOwner: false, waitForApproval: true });
  });

  socket.on('approve-join', ({ targetSocketId }) => {
    const room = [...rooms.values()].find(r => r.ownerId === socket.id);
    if (room) {
      room.waiting = room.waiting.filter(id => id !== targetSocketId);
      if (!room.participants.includes(targetSocketId)) room.participants.push(targetSocketId);
      io.to(targetSocketId).emit('join-approved', {
        existingProducers: (room.producers || []).filter(p => p.socketId !== targetSocketId).map(p => ({
          producerId: p.producer.id, socketId: p.socketId
        }))
      });
    }
  });

  socket.on('deny-join', ({ targetSocketId }) => {
    io.to(targetSocketId).emit('join-denied');
  });

  socket.on('disconnect', () => {
    let roomId = findRoomByParticipant(socket.id);
    if (roomId) {
      const room = rooms.get(roomId);

      // If the owner disconnects, start a timer instead of deleting instantly
      if (room.ownerId === socket.id) {
        ownerDisconnectTimers[roomId] = setTimeout(() => {
          io.to(room.participants).emit('room-closed');
          rooms.delete(roomId);
        }, 30000); // 30 seconds grace period (change as needed)
      } else {
        // For other users, just remove them immediately
        room.participants = room.participants.filter(id => id !== socket.id);
        room.waiting = room.waiting.filter(id => id !== socket.id);
        room.producers = (room.producers || []).filter(p => p.socketId !== socket.id);
      }
    }
    peers.delete(socket.id);
  });
});

function findRoomByParticipant(socketId) {
  for (const [roomId, room] of rooms.entries()) {
    if (room.participants && room.participants.includes(socketId)) return roomId;
  }
  return null;
}

// Static and fallback routing
const root = path.join(__dirname, 'public');
app.use(express.static(root));
app.use(fallback('index.html', { root }));
