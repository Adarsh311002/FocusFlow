import React,{ createContext,useState,useEffect } from "react";
import io from "socket.io-client"
import {useAuth} from "./AuthContext"
import { useContext } from "react";

const SocketContext = createContext();

export const useSocket = () => {
    return useContext(SocketContext);
}


export const SocketProvider = ({children}) => {
    const [socket , setSocket] = useState(null);
    const {user} = useAuth();

    useEffect(() => {
        if(user) {

            const newSocket = new io("http://localhost:8001",{
                withCredentials: true,
                transports : ['websocket']
            })

            setSocket(newSocket);

            return () => newSocket.close();
        } else {
            if(socket){
                socket.close();
                setSocket(null)
            }
        }
    },[user]);

    return (
        <SocketContext.Provider value={{socket}} >
            {children}
        </SocketContext.Provider>
    )


}

