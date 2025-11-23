import React, {createContext,useContext,useState,useEffect} from 'react'
import { api } from '../utils/api'


const AuthContext = createContext();

export const AuthProvider = ({children}) => {
    const [user , setUser] = useState(null);
    const [isAuthenticated, setIsAuthenticated] = useState(false);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const checkAuthStatus = async () => {
            try {
                const accessToken = localStorage.getItem("accessToken");
                const storedUser = localStorage.getItem("user");

                if(accessToken && storedUser){
                    setUser(JSON.parse(storedUser));
                    setIsAuthenticated(true);
                }
            } catch (error) {
                console.log("Auth check failed",error);
                localStorage.clear();
                
            }finally {
                setLoading(false);
            }
        };

        checkAuthStatus();
    },[])

    const login = (userData, token , refreshToken) => {
        setUser(userData);
        setIsAuthenticated(true);
        localStorage.setItem("accessToken", token);
        localStorage.setItem("refreshToken", refreshToken);
        localStorage.setItem("user", JSON.stringify(userData));
    }

    const logout = async () => {
        try {
            await api.post("/users/logout");
        } catch (error) {
            console.log("Logout failed on server, clearing client anyway");      
        } finally {
            setUser(null);
            setIsAuthenticated(false);
            localStorage.clear();
        }
    }

    return (
        <AuthContext.Provider value={{user,isAuthenticated,loading,login,logout}}>
            {children}
        </AuthContext.Provider>
    )
}

export const useAuth = () => {
    return useContext(AuthContext);
}
