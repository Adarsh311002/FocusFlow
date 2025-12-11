import React from 'react';
import {GoogleLogin} from "@react-oauth/google"
import api from "../utils/api";
import {useAuth} from "../context/AuthContext"
import { useNavigate } from 'react-router-dom';

const GoogleAuthBtn = () => {
    const {login} = useAuth();
    const navigate = useNavigate();


    const handleSuccess = async(credentialResponse) => {
        try {
            
            const  {credential} = credentialResponse;

            const res = await api.post('/users/google',{
                idToken : credential
            })

            const {user,accessToken,refreshToken} = res.data;

            if (!user || !accessToken) {
              throw new Error("Login succeeded but no user data returned");
            }

            login(user,accessToken,refreshToken);
            navigate("/dashboard");

        } catch (error) {
            console.error(
              "Login Process Error:",
              error.response?.data?.message || error.message
            );
        }   
    }

    const handleError = () => {
      console.log("Google Login Failed");
    };

    return (
      <div className="w-full rounded-xl px-4 py-2 font-medium bg-slate-800 hover:bg-slate-700 active:bg-slate-600 border border-slate-700 flex items-center justify-center gap-2 shadow-sm hover:shadow-md transition-all duration-200">
        <GoogleLogin
          onSuccess={handleSuccess}
          onError={handleError}
          theme="filled_black"
          shape="pill"
          text="continue_with"
          width="350"
        />
      </div>
    );

}


export default GoogleAuthBtn;