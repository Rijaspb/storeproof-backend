import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const REQUIRED = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'];
const missing = REQUIRED.filter((name) => !process.env[name]);
if (missing.length) {
  throw new Error(`Missing required env vars: ${missing.join(', ')}`);
}

const bucket = process.env.R2_BUCKET;

export const UPLOAD_EXPIRES_SECONDS = 15 * 60;
export const DOWNLOAD_EXPIRES_SECONDS = 10 * 60;

const client = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
  // Newer SDK versions add a CRC32 checksum header to presigned PUTs, which browsers
  // can't satisfy and R2 doesn't need
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
  maxAttempts: 3,
  requestHandler: { connectionTimeout: 5_000, requestTimeout: 15_000, throwOnRequestTimeout: true },
});

// Content-Type and Content-Length are signed, so R2 rejects a PUT that differs from what was approved
export const presignUpload = (key, contentType, contentLength) =>
  getSignedUrl(
    client,
    new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType, ContentLength: contentLength }),
    {
      expiresIn: UPLOAD_EXPIRES_SECONDS,
      signableHeaders: new Set(['content-type', 'content-length']),
    },
  );

// With a filename the browser saves the file under that name instead of playing it in the tab
export const presignDownload = (key, filename) =>
  getSignedUrl(
    client,
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      ...(filename && {
        ResponseContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(filename).replace(
          /['()*]/g,
          (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
        )}`,
      }),
    }),
    { expiresIn: DOWNLOAD_EXPIRES_SECONDS },
  );

// Returns { contentLength, contentType }, or null if the object doesn't exist
export const headObject = async (key) => {
  try {
    const res = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return { contentLength: res.ContentLength, contentType: res.ContentType };
  } catch (err) {
    if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) return null;
    throw err;
  }
};

// Deleting a missing key succeeds, so this is safe to retry
export const deleteObject = (key) =>
  client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));

// Multipart uploads for large files: the browser PUTs each part to its own presigned URL
export const createMultipartUpload = async (key, contentType) =>
  (await client.send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: key, ContentType: contentType })))
    .UploadId;

// Each part's Content-Length is signed, so the parts can't add up to more than the approved size
export const presignUploadPart = (key, uploadId, partNumber, contentLength) =>
  getSignedUrl(
    client,
    new UploadPartCommand({
      Bucket: bucket,
      Key: key,
      UploadId: uploadId,
      PartNumber: partNumber,
      ContentLength: contentLength,
    }),
    { expiresIn: UPLOAD_EXPIRES_SECONDS, signableHeaders: new Set(['content-length']) },
  );

// parts: [{ partNumber, etag }]
export const completeMultipartUpload = (key, uploadId, parts) =>
  client.send(
    new CompleteMultipartUploadCommand({
      Bucket: bucket,
      Key: key,
      UploadId: uploadId,
      MultipartUpload: { Parts: parts.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })) },
    }),
  );

// An already completed or aborted upload counts as done
export const abortMultipartUpload = async (key, uploadId) => {
  try {
    await client.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId }));
  } catch (err) {
    if (err.name !== 'NoSuchUpload') throw err;
  }
};
