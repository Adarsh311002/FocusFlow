import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser"


const app = express();


app.use(
  cors({
    origin: [
      "http://localhost:5173",
      "http://127.0.0.1:5173",
      "http://localhost:3000",
      process.env.CORS_ORIGIN,
    ],
    credentials: true,
  })
);

app.use(express.json({limit: "16kb"}))
app.use(express.urlencoded({extended:true}))
app.use(cookieParser());

import userRoutes from "./routes/user.routes.js"
import sessionRoutes from "./routes/session.routes.js"
import taskRoutes from "./routes/task.routes.js"
import roomRoutes from "./routes/room.routes.js"

//user route
app.use("/api/v1/users",userRoutes);
app.use("/api/v1/sessions",sessionRoutes);
app.use("/api/v1/tasks", taskRoutes );
app.use("/api/v1/rooms",roomRoutes);



export {app};