import crypto from "node:crypto";
import type { RequestHandler } from "express";

export const requireApiKey: RequestHandler = (req, res, next) => {
  const clientKey = req.header("x-api-key");
  const serverKey = process.env.API_KEY;

  if (!clientKey || !serverKey) {
    res.status(401).json({
      error: {
        code: "UNAUTHORIZED",
        message: "Invalid or missing X-API-Key header",
      },
    });
    return;
  }

  const clientBuf = Buffer.from(clientKey, "utf8");
  const serverBuf = Buffer.from(serverKey, "utf8");

  if (
    clientBuf.length !== serverBuf.length ||
    !crypto.timingSafeEqual(clientBuf, serverBuf)
  ) {
    res.status(401).json({
      error: {
        code: "UNAUTHORIZED",
        message: "Invalid or missing X-API-Key header",
      },
    });
    return;
  }

  next();
};
