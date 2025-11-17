import { User } from "../models/user.models.js";
import jwt from "jsonwebtoken";

const refreshToken = async (req, res) => {
  try {
    const token = req.cookies?.refreshToken;

    if (!token) {
      return res.status(401).json({
        success: false,
        message: "Refresh Token required",
      });
    }

    const decoded = jwt.verify(token, process.env.REFRESH_TOKEN_SECRET);
    const user = await User.findOne({
      _id: decoded._id,
      refreshToken: token
    }).select("+refreshToken");

    if (!user) {
        res.clearCookie("refreshToken")
      return res.status(401).json({
        success: false,
        message: "Invalid refresh token",
      });
    }

    const accessToken = user.generateAccessToken();

    res.status(200).json({
      success: true,
      accessToken,
    });
  } catch (error) {
    res.clearCookie("refreshToken");
    return res.status(401).json({
      success: false,
      message: "Invalid refresh token",
      error: error.message,
    });
  }
};

export { refreshToken };
