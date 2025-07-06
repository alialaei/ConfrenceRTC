// services/s3.js
const fs       = require('fs');
const path     = require('path');
const crypto   = require('crypto');
const {
  S3Client,
  DeleteObjectCommand
} = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');

const REGION  = process.env.AWS_REGION;
const BUCKET  = process.env.S3_BUCKET;

/* one shared client ------------------------------------------------ */
const s3 = new S3Client({
  region: REGION,
  credentials: {
    accessKeyId    : process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});

/* helper – get https url (bucket is public-read) ------------------- */
const publicURL = key =>
  `https://${BUCKET}.s3.${REGION}.amazonaws.com/${key}`;

/* ---------- upload avatar ---------------------------------------- */
exports.putAvatar = async file => {
  const ext = path.extname(file.originalname).toLowerCase();  // .png / .jpg
  const key = `avatars/${crypto.randomUUID()}${ext}`;

  await new Upload({
    client: s3,
    params: {
      Bucket: BUCKET,
      Key   : key,
      Body  : fs.createReadStream(file.path),
      ContentType: file.mimetype,
      ACL: 'public-read'          // bucket already public, redundant but explicit
    }
  }).done();

  fs.unlink(file.path, () => {});
  return publicURL(key);          // store ready-to-use https link
};

/* ---------- delete old avatar ------------------------------------ */
exports.deleteAvatar = async url => {
  if (!url?.includes(BUCKET)) return;
  const key = url.split(`/${BUCKET}/`).pop()?.replace(BUCKET + '/', '') ||
              url.split('.amazonaws.com/').pop();

  await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
};
