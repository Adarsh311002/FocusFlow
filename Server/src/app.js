import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser"


const app = express();


app.use(
  cors({
    origin: process.env.CORS_ORIGIN || "http://localhost:5173",
    credentials: true,
  })
);

app.use(express.json({limit: "16kb"}))
app.use(express.urlencoded({extended:true}))
app.use(cookieParser());

import userRoutes from "./routes/user.routes.js"
import sessionRoutes from "./routes/session.routes.js"
import taskRoutes from "./routes/task.routes.js"

//user route
app.use("/api/v1/users",userRoutes);
app.use("/api/v1/sessions",sessionRoutes);
app.use("/api/v1/tasks", taskRoutes );



export {app};