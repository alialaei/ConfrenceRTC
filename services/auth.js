// services/auth.js
const express  = require('express');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const mongoose = require('mongoose');
const multer   = require('multer');
const upload   = multer({ dest: '/tmp' });
const { putAvatar, deleteAvatar } = require('./s3'); // S3 helpers

const { JWT_SECRET, JWT_EXPIRES = '30d' } = process.env;

if (!process.env.JWT_SECRET)
  throw new Error('JWT_SECRET env var is required');

/* ─── Mongoose User model (imported once here) ─────────────────── */
const userSchema = new mongoose.Schema({
  email   : { type:String, required:true, unique:true, lowercase:true },
  password: { type:String, required:true, select:false },
  name    : { type:String, required:true },
  avatar  : { type:String }
});
userSchema.methods.validPassword = function (pw) {
  return bcrypt.compare(pw, this.password);
};
const User = mongoose.models.User || mongoose.model('User', userSchema);

/* ─── router factory ────────────────────────────────────────────── */
module.exports = function authRouter () {
  const router = express.Router();

  /* register ----------------------------------------------------- */
  router.post('/register', async (req,res)=>{
    try{
      const { email, password, name, avatar } = req.body;
      if(!email || !password || !name) return res.status(400).json({msg:'missing'});
      const hash = await bcrypt.hash(password, 12);
      const user = await User.create({ email, password:hash, name, avatar });
      const token = jwt.sign({ id:user._id }, JWT_SECRET, { expiresIn:JWT_EXPIRES });
      res.json({ token, user:{ id:user._id, email:user.email, name:user.name, avatar:user.avatar }});
    }catch(err){
      if(err.code === 11000) return res.status(409).json({msg:'email exists'});
      console.error(err); res.status(500).end();
    }
  });

  /* login -------------------------------------------------------- */
  router.post('/login', async (req,res)=>{
    try{
      const { email, password } = req.body;
      const user = await User.findOne({ email }).select('+password');
      if(!user || !(await user.validPassword(password)))
        return res.status(401).json({msg:'bad creds'});
      const token = jwt.sign({ id:user._id }, JWT_SECRET, { expiresIn:JWT_EXPIRES });
      res.json({ token, user:{ id:user._id, email:user.email, name:user.name, avatar:user.avatar }});
    }catch(err){ console.error(err); res.status(500).end(); }
  });

  /* ─────────── UPDATE AVATAR ──────────── */
    router.put(
    '/profile/avatar',
    verifyToken,                      // <-- add a simple JWT-check middleware (below)
    upload.single('avatar'),
    async (req, res) => {
        try {
        if (!req.file) return res.status(400).json({ msg: 'file missing' });

        // push to S3
        const url = await putAvatar(req.file);

        // update user doc (and delete old if present)
        const user = await User.findById(req.user.id);
        if (user.avatar) await deleteAvatar(user.avatar);
        user.avatar = url;
        await user.save();

        res.json({ avatar: url });
        } catch (err) {
        console.error(err);
        res.status(500).end();
        }
    }
    );

    /* ---------- helper: JWT verify ------------ */
    function verifyToken(req, res, next) {
        const hdr = req.headers.authorization || '';
        const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : null;
        if (!token) return res.status(401).end();
        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            req.user = decoded;
            next();
        } catch (_) {
            res.status(401).end();
        }
    }
  router.get('/profile', verifyToken, async (req, res) => {
    try {
      const user = await User.findById(req.user.id).lean();
      if (!user) return res.status(404).end();
      delete user.password;                // never expose hash
      res.json(user);
    } catch (err) { console.error(err); res.status(500).end(); }
  });

  return router;
};
