import {Router} from "express"
import { jwtVerify } from "../middlewares/auth.middleware.js"
import { createRoom,getRooms,joinRoom } from "../controllers/room.controller"

const router = Router();

router.route("/").get(jwtVerify , getRooms);
router.route("/create").post(jwtVerify, createRoom);
router.route("/join").post(jwtVerify,joinRoom);

export default router;