import {Router} from "express"
import { userSignup,userLogin,refreshToken, userLogout } from "../controllers/user.controller.js"
import { jwtVerify } from "../middlewares/auth.middleware.js";


const router = Router();

router.route("/signup").post(userSignup)
router.route("/login").post(userLogin)
router.route("/refresh").post(refreshToken)
router.route("/logout").post(jwtVerify,userLogout)


export default router;