import zod from "zod"
import { User } from "../models/user.models.js"


const generateAccessRefreshToken = async (userId) => {
    try {
        
    } catch (error) {
        
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

  const existedUser = await User.find({
    $or : [{fullname},{email}]
  })

  if(existedUser){
    return res.status(401).json({
        message:"User already exists"
    })
  }

  try {
    const user = new User({
        fullname,
        email,
        password
    })

    const createdUser = User.findById(user._id).select("-password")

    if(!createdUser){
        return res.status(403).json({
            message: "Something went wrong while registering user."
        })
    }

    return res.status(200).json({
        message:"User created successfully!"
    })


  } catch (error) {
    
  }


}