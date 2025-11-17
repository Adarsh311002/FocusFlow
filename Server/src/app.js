import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser"


const app = express();


app.use(cors({
    origin : "*",
    // credentials: true
}))

app.use(express.json({limit: "16kb"}))
app.use(express.urlencoded({extended:true}))
app.use(cookieParser());

import userRoutes from "./routes/user.routes.js"

//user route
app.use("/api/v1/users",userRoutes);


export {app};