import jwt from "jsonwebtoken";
import { User } from "../models/user.models.js";

const jwtVerify = async (req, res, next) => {
  const authHeader = req.header("Authorization");
  const bearer =
    authHeader && authHeader.startsWith("Bearer ")
      ? authHeader.replace("Bearer ", "")
      : null;

  const token = bearer || req.cookies?.accessToken;

  if (!token) {
    return res.status(401).json({ message: "Unauthorized: token required" });
  }

  try {
    const decoded = jwt.verify(token, process.env.ACCESS_TOKEN_SECRET);
    const user = await User.findById(decoded?._id).select(
      "-password -refreshToken"
    );

    if (!user) {
      return res.status(401).json({ message: "Unauthorised!" });
    }

    req.user = user;
    next();
  } catch (error) {
    console.error("JWT verify error:", error.message);
    return res.status(401).json({
      message: "Invalid or Expired Access Token",
    });
  }
};


export {jwtVerify}