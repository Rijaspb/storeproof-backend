// Express identifies error handlers by their 4-argument signature
export default function errorHandler(err, _req, res, next) {
  // Response already started (e.g. mid-stream): let Express close the connection
  if (res.headersSent) return next(err);

  const raw = err.status ?? err.statusCode;
  const status = Number.isInteger(raw) && raw >= 400 && raw < 600 ? raw : 500;

  if (status >= 500) console.error(err);

  res.status(status).json({
    error: status < 500 ? err.message : 'Internal server error',
  });
}