import zod from "zod"
import { User } from "../models/user.models.js"


const generateAccessRefreshToken = async (userId) => {
    try {
        const user = await User.findById(userId);

        if(!user){
           throw new Error("User not find while generating tokens")
        }

        const accessToken = user.generateAccessToken();
        const refreshToken = user.generateRefreshToken();

        user.refreshToken = refreshToken;
        await user.save({validateBeforeSave: false})

        return {accessToken,refreshToken}

    } catch (error) {
        console.error("Error generating tokens:", error.message);
        throw new Error("Failed to generate access and refresh tokens");
    }
}


const userSchema = zod.object({
    fullname:zod.string().nonempty("fullname is required"),
    email:zod.email("Invalid email address"),
    password:zod.string().min(8,"Password must be atleast 8 character long")

})

const userSignup = async (req,res) => {
  const {fullname,email,password} = req.body;

  const validateUser = userSchema.safeParse(req.body);
  
  if(!validateUser.success){
    return res.status(400).json({
        message: "Validation failed",
        error: validateUser.error.errors
    });
  }

  const existedUser = await User.findOne({
    $or : [{fullname},{email}]
  })

  if(existedUser){
    return res.status(409).json({
        message:"User already exists"
    })
  }

  try {
    const user = await User.create({
        fullname,
        email,
        password
    })

    const {accessToken,refreshToken} = await generateAccessRefreshToken(user._id);

    const options = {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    };

    const createdUser = await User.findById(user._id).select("-password -refreshToken");

    if (!createdUser) {
      return res.status(500).json({
        message: "Something went wrong while registering user.",
      });
    }


    return res
    .status(201)
    .cookie("refreshToken", refreshToken,options)
       .json({
        message:"User created successfully!",
        user: createdUser,
        accessToken,
       
    })


  } catch (error) {
    console.error("Signup error:",error.message);
    return res.status(500).json({
        message: "Server error while signing up user",
        error: error.message,
    })
  }


}

export {userSignup}