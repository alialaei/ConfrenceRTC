// services/auth.js
const express  = require('express');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const mongoose = require('mongoose');

const { JWT_SECRET, JWT_EXPIRES = '30d' } = process.env;

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

  return router;
};
