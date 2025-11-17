import {Router} from "express"
import { userSignup,userLogin } from "../controllers/user.controller.js"


const router = Router();

router.route("/signup").post(userSignup)
router.route("/login").post(userLogin)


export default router;