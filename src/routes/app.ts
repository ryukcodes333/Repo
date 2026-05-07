import express, { type Express } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { authMiddleware } from "./middlewares/authMiddleware";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors({ credentials: true, origin: true }));
app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(authMiddleware);

app.get("/", (_req, res) => {
  res.json({
    status: "ok",
    message: "Shadow Cards API",
    endpoints: {
      health: "/api/healthz",
      cards: "/api/cards",
      stats: "/api/cards/stats",
      featured: "/api/cards/featured",
      random: "/api/cards/random",
      cardById: "/api/cards/:id",
      imageProxy: "/api/image-proxy?url=<imageUrl>",
    },
  });
});

app.use("/api", router);

export default app;
