import { Router } from "express";
import { logSession } from "../controllers/session.controller.js";
import { jwtVerify } from "../middlewares/auth.middleware.js";

const router = Router();

router.route("/log").post(jwtVerify, logSession);

export default router;
