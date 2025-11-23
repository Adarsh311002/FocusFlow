import React from "react";
import { Navigate} from "react-router-dom";
import { useAuth } from "../context/AuthContext";

const ProtectedRoute = ({children}) => {
    const {isAuthenticated,loading} = useAuth();

    if (loading) {
      return (
        <div className="h-screen flex justify-center items-center text-white">
          Loading...
        </div>
      );
    }

   return isAuthenticated ? children : <Navigate to="/login" replace />;
}

export default ProtectedRoute;

