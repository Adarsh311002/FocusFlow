import {Router} from "express"
import { userSignup,userLogin,refreshToken } from "../controllers/user.controller.js"


const router = Router();

router.route("/signup").post(userSignup)
router.route("/login").post(userLogin)
router.route("/refresh").post(refreshToken)


export default router;