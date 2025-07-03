// server.js
const express = require('express');
const path = require('path');
const { Server } = require('socket.io');
const mediasoup = require('mediasoup');
const http = require('http');
const fallback = require('express-history-api-fallback');

const rooms = new Map();
const peers = new Map();
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
let worker, router;
const mediaCodecs = [
  { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
  { kind: 'video', mimeType: 'video/VP8', clockRate: 90000 }
];

(async () => {
  worker = await mediasoup.createWorker();
  router = await worker.createRouter({ mediaCodecs });
  server.listen(port, () => console.log(`✅ Server running on port ${port}`));
})();

io.on('connection', socket => {
  console.log(`🔌 [CONNECT] ${socket.id}`);
  peers.set(socket.id, { transports: [], producers: [], consumers: [] });

  // === Mediasoup standard ===
  socket.on('getRouterRtpCapabilities', cb => {
    console.log(`[${socket.id}] getRouterRtpCapabilities`);
    cb(router.rtpCapabilities);
  });

  socket.on('createTransport', async cb => {
    console.log(`[${socket.id}] createTransport`);
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
    console.log(`[${socket.id}] connectTransport ${transportId}`);
    const transport = peers.get(socket.id).transports.find(t => t.id === transportId);
    if (!transport) {
      console.log(`[${socket.id}] ERROR: connectTransport transport not found!`);
      return cb({ error: 'Transport not found' });
    }
    await transport.connect({ dtlsParameters });
    cb();
  });

  socket.on('produce', async ({ transportId, kind, rtpParameters }, cb) => {
    console.log(`[${socket.id}] produce (${kind}) on transport ${transportId}`);
    const transport = peers.get(socket.id).transports.find(t => t.id === transportId);
    if (!transport) {
      console.log(`[${socket.id}] ERROR: produce transport not found!`);
      return cb({ error: 'Transport not found' });
    }
    const producer = await transport.produce({ kind, rtpParameters });
    peers.get(socket.id).producers.push(producer);

    let roomId = findRoomByParticipant(socket.id);
    if (roomId) {
      const room = rooms.get(roomId);
      room.producers.push({ socketId: socket.id, producer });
      console.log(`[${socket.id}] produced for room ${roomId}. Now notifying other participants.`);

      // Inform everyone else in the room about the new producer (not the producer themself!)
      room.participants.forEach(pid => {
        if (pid !== socket.id) {
          io.to(pid).emit('newProducer', { producerId: producer.id, socketId: socket.id });
          console.log(`-- [room:${roomId}] Notifying ${pid} about newProducer ${producer.id} from ${socket.id}`);
        }
      });
    }
    cb({ id: producer.id });
  });

  socket.on('consume', async ({ producerId, rtpCapabilities }, cb) => {
    console.log(`[${socket.id}] consume producerId: ${producerId}`);
    if (!router.canConsume({ producerId, rtpCapabilities })) {
      console.log(`[${socket.id}] ERROR: Cannot consume producer ${producerId}`);
      return cb({ error: 'Cannot consume' });
    }

    let transport = peers.get(socket.id).transports.find(t => t.appData && t.appData.consuming);
    if (!transport) {
      transport = await router.createWebRtcTransport({
        listenIps: [{ ip: '0.0.0.0', announcedIp: 'webrtcserver.mmup.org' }],
        enableUdp: true, enableTcp: true, preferUdp: true,
        appData: { consuming: true }
      });
      peers.get(socket.id).transports.push(transport);
      console.log(`[${socket.id}] Created new consuming transport: ${transport.id}`);
    }
    const consumer = await transport.consume({
      producerId, rtpCapabilities, paused: false
    });
    peers.get(socket.id).consumers.push(consumer);
    console.log(`[${socket.id}] consumer created for ${producerId}: ${consumer.id}`);
    cb({
      id: consumer.id, producerId, kind: consumer.kind, rtpParameters: consumer.rtpParameters
    });
  });

  // ===== Room Logic =====
  socket.on('join-room', ({ roomId }, cb) => {
    console.log(`[${socket.id}] join-room ${roomId}`);
    if (ownerDisconnectTimers[roomId]) {
      clearTimeout(ownerDisconnectTimers[roomId]);
      delete ownerDisconnectTimers[roomId];
      console.log(`[${socket.id}] Cleared disconnect timer for room ${roomId}`);
    }

    if (!rooms.has(roomId)) {
      // First user = owner
      rooms.set(roomId, {
        ownerId: socket.id,
        participants: [socket.id],
        waiting: [],
        producers: [],
      });
      console.log(`[${socket.id}] is now owner of room ${roomId}`);
      cb({ isOwner: true, existingProducers: [] });
      return;
    }
    const room = rooms.get(roomId);
    if (!room.participants.includes(socket.id)) room.waiting.push(socket.id);
    const ownerSocket = io.sockets.sockets.get(room.ownerId);
    if (ownerSocket) {
      ownerSocket.emit('join-request', { socketId: socket.id });
      console.log(`[${socket.id}] join-request sent to owner ${room.ownerId}`);
    }
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
      console.log(`[${socket.id}] approved join for ${targetSocketId} (sent existingProducers: ${room.producers.length})`);
    }
  });

  socket.on('deny-join', ({ targetSocketId }) => {
    io.to(targetSocketId).emit('join-denied');
    console.log(`[${socket.id}] denied join for ${targetSocketId}`);
  });

  socket.on('disconnect', () => {
    let roomId = findRoomByParticipant(socket.id);
    if (roomId) {
      const room = rooms.get(roomId);
      // Owner disconnects: 30s grace
      if (room.ownerId === socket.id) {
        ownerDisconnectTimers[roomId] = setTimeout(() => {
          io.to(room.participants).emit('room-closed');
          rooms.delete(roomId);
          console.log(`[${socket.id}] (owner) closed room ${roomId}`);
        }, 30000);
      } else {
        // Remove participant & their producers
        room.participants = room.participants.filter(id => id !== socket.id);
        room.waiting = room.waiting.filter(id => id !== socket.id);
        room.producers = (room.producers || []).filter(p => p.socketId !== socket.id);
        console.log(`[${socket.id}] left room ${roomId}`);
      }
    }
    peers.delete(socket.id);
    console.log(`❌ [DISCONNECT] ${socket.id}`);
  });
});

function findRoomByParticipant(socketId) {
  for (const [roomId, room] of rooms.entries()) {
    if (room.participants && room.participants.includes(socketId)) return roomId;
  }
  return null;
}

const root = path.join(__dirname, 'public');
app.use(express.static(root));
app.use(fallback('index.html', { root }));
