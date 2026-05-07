import { Router, type IRouter } from "express";
  import healthRouter from "./health";
  import { cardsRouter } from "./cards";
  import authRouter from "./auth";
  import { imageProxyRouter } from "./imageProxy";

  const router: IRouter = Router();

  router.use(healthRouter);
  router.use("/cards", cardsRouter);
  router.use(authRouter);
  router.use("/image-proxy", imageProxyRouter);

  export default router;
  