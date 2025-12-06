import zod, { success } from "zod";
import { User } from "../models/user.models.js";
import jwt from "jsonwebtoken";
import {OAuth2Client} from 'google-auth-library'


const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

const googleLogin = async(req,res) => {
  try {
    const {idToken} = req.body;
  
    const ticket = await client.verifyIdToken({
      idToken : idToken,
      audience : process.env.GOOGLE_CLIENT_ID
    });
  
    if(!ticket){
      res.status(401).json({
        message: "Invalid ticket"
      })
    }
  
    const {name,email,picture} = ticket.getPayload();
  
    const user = await User.findOne({email});
  
    if(user){
      const {refreshToken,accessToken} = await user.generateAccessRefreshToken(user._id);
  
      user.refreshToken = refreshToken;
      await user.save({
        validateBeforeSave : false
      });
  
      const options = {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
      };
  
      return res
      .status(200)
      .cookie("accessToken",accessToken,options)
      .cookie("refreshToken",refreshToken,options)
      .json({
        success:true,
        user : user,
        accessToken : accessToken,
        refreshToken : refreshToken,
        message : "Google Login Successfull"
      })
  
  
    } else {
  
      const randomPassword = Math.random().toString(36).slice(-8) + Math.random().toString(36).slice(-8);
  
      user = await User.create({
        name : name,
        email : email,
        password : randomPassword,
        avatar : picture,
        googleId
      })
  
      const {accessToken,refreshToken}  = await user.generateAccessRefreshToken(user._id);
      user.refreshToken = refreshToken;
  
      await user.save({validateBeforeSave : false});
  
       const options = {
         httpOnly: true,
         secure: process.env.NODE_ENV === "production",
       };
  
      return res.status(200)
        .cookie("accessToken", accessToken, options)
        .cookie("refreshToken", refreshToken, options)
        .json({
          success: true,
          user: { _id: user._id, name: user.name, email: user.email, avatar: user.avatar },
          accessToken: accessToken,
          refreshToken: refreshToken,
          message: "User Registered via Google"
        });
    }
  } catch (error) {
    console.error("Google Auth Error:", error);
    res.status(401).json({ success: false, message: "Invalid Google Token" });
  }
}

const generateAccessRefreshToken = async (userId) => {
  try {
    const user = await User.findById(userId);

    if (!user) {
      throw new Error("User not find while generating tokens");
    }

    const accessToken = user.generateAccessToken();
    const refreshToken = user.generateRefreshToken();

    user.refreshToken = refreshToken;
    await user.save({ validateBeforeSave: false });

    return { accessToken, refreshToken };
  } catch (error) {
    console.error("Error generating tokens:", error.message);
    throw new Error("Failed to generate access and refresh tokens");
  }
};

const userSchema = zod.object({
  fullname: zod.string().nonempty("fullname is required"),
  email: zod.email("Invalid email address"),
  password: zod.string().min(8, "Password must be atleast 8 character long"),
});

const userSignup = async (req, res) => {
  const { fullname, email, password } = req.body;

  const validateUser = userSchema.safeParse(req.body);

  if (!validateUser.success) {
    return res.status(400).json({
      message: "Validation failed",
      error: validateUser.error.errors,
    });
  }

  const existedUser = await User.findOne({
    $or: [{ email }],
  });

  if (existedUser) {
    return res.status(409).json({
      message: "User already exists",
    });
  }

  try {
    const user = await User.create({
      fullname,
      email,
      password,
    });

    const { accessToken, refreshToken } = await generateAccessRefreshToken(
      user._id
    );

    const options = {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    };

    const createdUser = await User.findById(user._id).select(
      "-password -refreshToken"
    );

    if (!createdUser) {
      return res.status(500).json({
        message: "Something went wrong while registering user.",
      });
    }

    return res.status(201).cookie("refreshToken", refreshToken, options).json({
      message: "User created successfully!",
      user: createdUser,
      accessToken,
      refreshToken
    });
  } catch (error) {
    console.error("Signup error:", error.message);
    return res.status(500).json({
      message: "Server error while signing up user",
      error: error.message,
    });
  }
};

const loginSchema = zod.object({
  email: zod.email("Invalid emailId"),
  password: zod.string().min(8),
});

const userLogin = async (req, res) => {
  const { email, password } = req.body;
  const validateUser = loginSchema.safeParse(req.body);

  if (!validateUser.success) {
    return res.status(400).json({
      message: "Validation failed",
      error: validateUser.error.errors,
    });
  }

  try {
    const user = await User.findOne({ email }).select("+password");

    if (!user) {
      return res.status(401).json({
        message: "User not found",
      });
    }

    const passwordMatch = await user.comparePassword(password);

    if (!passwordMatch) {
      return res.status(401).json({
        message: "Invalid password or email",
      });
    }

    const { accessToken, refreshToken } = await generateAccessRefreshToken(
      user._id
    );

    const options = {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    };

    return res
      .status(200)
      .cookie("refreshToken", refreshToken, options)
      .cookie("accessToken", accessToken, options)
      .json({
        message: "Login Successful",
        accessToken,
        refreshToken,
        user: await User.findById(user._id).select("-password -refreshToken"),
      });
  } catch (error) {
    console.error("Login error:", error.message);
    return res.status(500).json({
      message: "Server error while logging up user",
      error: error.message,
    });
  }
};

const refreshToken = async (req, res) => {
  try {
    const token = req.cookies?.refreshToken || req.body?.refreshToken;

    if (!token) {
      return res.status(401).json({
        success: false,
        message: "Refresh Token required",
      });
    }

    const decoded = jwt.verify(token, process.env.REFRESH_TOKEN_SECRET);
    const user = await User.findOne({
      _id: decoded._id,
      refreshToken: token,
    }).select("+refreshToken");

    if (!user) {
      res.clearCookie("refreshToken");
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

const userLogout = async (req, res) => {
  try {
    await User.findByIdAndUpdate(
      req.user._id,
      {
        $set: {
          refreshToken: null,
        },
      },
      { new: true }
    );

    const options = {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
    };

    return res
      .status(200)
      .clearCookie("refreshToken", options)
      .clearCookie("accessToken", options)
      .json({ message: "User logged out successfully" });
  } catch (error) {
    console.error("Logout error:", error);
    return res.status(500).json({
      message: "Failed to logout user",
      error: error.message,
    });
  }
};

export { userSignup, userLogin, refreshToken, userLogout, googleLogin };
