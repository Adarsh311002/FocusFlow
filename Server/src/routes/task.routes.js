import { Router } from "express";
import { getTask, createTasks, updateTask, deleteTask } from "../controllers/task.controller.js";
import { jwtVerify } from "../middlewares/auth.middleware.js";

const router = Router();

router.route("/").get(jwtVerify,getTask);
router.route("/addTask").post(jwtVerify, createTasks);
router.route("/updateTask/:id").patch(jwtVerify, updateTask);
router.route("/deleteTask/:id").delete(jwtVerify,deleteTask);

export default router;

