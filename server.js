/* ------------------------------------------------------------------ */
/*  mediasoup + socket.io + PDF-upload + chat + CodePad               */
/* ------------------------------------------------------------------ */
const path    = require('path');
const fs      = require('fs');
const http    = require('http');
const express = require('express');
const multer  = require('multer');
const { Server } = require('socket.io');
const fallback  = require('express-history-api-fallback');
const mediasoup = require('mediasoup');

/* ---------- config ------------------------------------------------ */
const PORT      = process.env.PORT      || 3000;
const PUBLIC_IP = process.env.PUBLIC_IP || '52.47.158.117';

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

const mediaCodecs = [
  { kind:'audio', mimeType:'audio/opus', clockRate:48000, channels:2 },
  { kind:'video', mimeType:'video/VP8',  clockRate:90000,
    parameters:{ 'x-google-start-bitrate':1000 } },
  { kind:'video', mimeType:'video/H264', clockRate:90000,
    parameters:{ 'packetization-mode':1,
                 'level-asymmetry-allowed':1,
                 'profile-level-id':'42e01f' } }
];

/* ---------- express + static + upload ----------------------------- */
const ROOT = path.join(__dirname, 'public');
const UPLOAD_DIR = path.join(ROOT, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive:true });

const app = express();
const upload = multer({ dest: UPLOAD_DIR });

app.use(express.static(ROOT));                // serves /uploads/** too
app.post('/upload/pdf', upload.single('file'), (req,res)=>{
  const safe   = Date.now()+'_'+req.file.originalname.replace(/\s+/g,'_');
  fs.renameSync(req.file.path, path.join(UPLOAD_DIR, safe));
  res.json({ url:`/uploads/${safe}`, name:req.file.originalname });
});
app.use(fallback('index.html', { root:ROOT }));

const server = http.createServer(app);
const io     = new Server(server, { cors:{origin:['https://conference.mmup.org'],credentials:true}});

/* ---------- mediasoup bootstrap ---------------------------------- */
let worker, router;
(async ()=>{
  worker = await mediasoup.createWorker();
  router = await worker.createRouter({ mediaCodecs });
  server.listen(PORT, ()=>console.log('✅  server on :'+PORT));
})();

/* ---------- in-memory state -------------------------------------- */
const rooms  = new Map();   // roomId → { ownerId, participants[], waiting[], producers[] }
const peers  = new Map();   // socket.id → { transports, producers, consumers }
const codeStore = new Map();
const timers = new Map();

/* helpers */
const safeJoin = (sock, roomId) => {
  if (sock.roomId) sock.leave(sock.roomId);
  sock.join(roomId);
  sock.roomId = roomId;
};

/* ---------- socket.io flow --------------------------------------- */
io.on('connection', socket=>{
  console.log('🔌',socket.id);
  peers.set(socket.id,{ transports:[],producers:[],consumers:[] });

  /* mediasoup primitives ---------------------------------------- */
  socket.on('getRouterRtpCapabilities', cb=>cb(router.rtpCapabilities));

  socket.on('createTransport', async({consuming=false}={},cb)=>{
    const t = await router.createWebRtcTransport({ ...IO_OPTS, appData:{consuming}});
    peers.get(socket.id).transports.push(t);
    cb({ id:t.id, iceParameters:t.iceParameters,
         iceCandidates:t.iceCandidates, dtlsParameters:t.dtlsParameters,
         iceServers:ICE_SERVERS });
    t.on('dtlsstatechange', s=>s==='closed' && t.close());
  });

  socket.on('connectTransport', async({transportId,dtlsParameters},cb)=>{
    const t = peers.get(socket.id).transports.find(x=>x.id===transportId);
    if(!t) return cb({error:'transport?'}); await t.connect({dtlsParameters}); cb();
  });

  socket.on('produce', async({transportId,kind,rtpParameters,appData},cb)=>{
    const t = peers.get(socket.id).transports.find(x=>x.id===transportId);
    if(!t) return cb({error:'transport?'});  
    const producer = await t.produce({kind,rtpParameters,appData});
    peers.get(socket.id).producers.push(producer);

    const roomId = socket.roomId;
    if(roomId){
      const room = rooms.get(roomId);
      room.producers.push({socketId:socket.id,producer});
      room.participants.filter(id=>id!==socket.id)
           .forEach(id=>io.to(id).emit('newProducer',{
             producerId:producer.id,socketId:socket.id,
             mediaTag:producer.appData?.mediaTag
           }));
    }
    cb({id:producer.id});
  });

  socket.on('consume', async({producerId,rtpCapabilities},cb)=>{
    const t = peers.get(socket.id).transports.find(x=>x.appData.consuming);
    if(!t)   return cb({error:'no recv transport'});
    if(!router.canConsume({producerId,rtpCapabilities}))
      return cb({error:'can’t consume'});
    const consumer = await t.consume({producerId,rtpCapabilities,paused:false});
    peers.get(socket.id).consumers.push(consumer);
    cb({ id:consumer.id,producerId,kind:consumer.kind,
         rtpParameters:consumer.rtpParameters,
         mediaTag:consumer.appData.mediaTag });
  });

  socket.on('stop-screen', ()=>{
    const roomId = socket.roomId;
    if(!roomId) return;
    io.to(roomId).except(socket.id).emit('screen-stopped');
  });

  /* room orchestration ------------------------------------------ */
  socket.on('join-room',({roomId},cb)=>{
    if(timers.has(roomId)) clearTimeout(timers.get(roomId));

    if(!rooms.has(roomId)){                 // first user ⇒ owner
      rooms.set(roomId,{ ownerId:socket.id, participants:[socket.id],
                         waiting:[], producers:[] });
      safeJoin(socket,roomId);
      return cb({isOwner:true,existingProducers:[]});
    }

    const room = rooms.get(roomId);
    room.waiting.push(socket.id);
    io.to(room.ownerId).emit('join-request',{socketId:socket.id});
    cb({isOwner:false,waitForApproval:true});
  });

  socket.on('approve-join',({targetSocketId})=>{
    const roomId = socket.roomId; if(!roomId) return;
    const room   = rooms.get(roomId);
    room.waiting = room.waiting.filter(id=>id!==targetSocketId);
    room.participants.push(targetSocketId);

    const target = io.sockets.sockets.get(targetSocketId);
    if(target){
      safeJoin(target,roomId);
      target.emit('join-approved',{
        existingProducers: room.producers
          .filter(p=>p.socketId!==targetSocketId)
          .map(p=>({producerId:p.producer.id,
                    socketId:p.socketId,
                    mediaTag:p.producer.appData.mediaTag}))
      });
    }
  });

  socket.on('deny-join',({targetSocketId})=>io.to(targetSocketId).emit('join-denied'));

  socket.on('disconnect',()=>{
    const roomId = socket.roomId;
    if(!roomId){ peers.delete(socket.id); return; }

    const room = rooms.get(roomId);
    if(!room){ peers.delete(socket.id); return; }

    if(socket.id === room.ownerId){
      timers.set(roomId,setTimeout(()=>{
        io.to(roomId).emit('room-closed');
        rooms.delete(roomId);
      },30_000));
    }else{
      room.participants = room.participants.filter(id=>id!==socket.id);
      room.producers    = room.producers.filter(p=>p.socketId!==socket.id);
      io.to(roomId).emit('participant-left',{socketId:socket.id});
    }
    peers.delete(socket.id);
  });

  /* collaborative IDE -------------------------------------------- */
  socket.on('code-get',({roomId},cb)=>cb(codeStore.get(roomId)??''));
  socket.on('code-set',({roomId,text})=>{
    codeStore.set(roomId,text);
    io.to(roomId).emit('code-update',{text});
  });

  /* chat ---------------------------------------------------------- */
  socket.on('chat-send',({roomId,text,from})=>{
    io.to(roomId).emit('chat-recv',{text,from});
  });

  /* PDF share ----------------------------------------------------- */
  socket.on('pdf-share',({roomId,url,name})=>{
    io.to(roomId).emit('pdf-recv',{url,name});
  });
});
