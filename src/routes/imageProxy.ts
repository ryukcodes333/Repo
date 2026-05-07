import { Router, Request, Response } from "express";
import axios from "axios";

const router = Router();

router.get("/", async (req: Request, res: Response) => {
  const rawUrl = String(req.query.url || "");
  const scale = Math.min(parseInt(String(req.query.scale || "2")), 4);

  if (!rawUrl || !rawUrl.startsWith("http")) {
    res.status(400).json({ error: "Missing or invalid url parameter" });
    return;
  }

  try {
    const response = await axios.get(rawUrl, {
      responseType: "arraybuffer",
      timeout: 15000,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Referer: "https://shoob.gg/",
        Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
      },
      maxRedirects: 5,
    });

    const contentType =
      response.headers["content-type"] || "image/jpeg";

    if (!contentType.startsWith("image/")) {
      res.status(400).json({ error: "URL did not return an image" });
      return;
    }

    const buffer = Buffer.from(response.data);

    try {
      const sharp = (await import("sharp")).default;
      const metadata = await sharp(buffer).metadata();
      const newWidth = (metadata.width || 400) * scale;
      const newHeight = (metadata.height || 600) * scale;

      const upscaled = await sharp(buffer)
        .resize(Math.min(newWidth, 2400), Math.min(newHeight, 3600), {
          kernel: sharp.kernel.lanczos3,
          fit: "fill",
        })
        .png({ quality: 95 })
        .toBuffer();

      res.set({
        "Content-Type": "image/png",
        "Cache-Control": "public, max-age=86400",
        "Access-Control-Allow-Origin": "*",
      });
      res.send(upscaled);
    } catch {
      res.set({
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=86400",
        "Access-Control-Allow-Origin": "*",
      });
      res.send(buffer);
    }
  } catch (err) {
    req.log.error({ err }, "Image proxy error");
    res.status(502).json({ error: "Failed to fetch image from source" });
  }
});

export { router as imageProxyRouter };
