import React, { useState, useEffect, useRef } from "react";
import { Send, MessageSquare } from "lucide-react";

const ChatBox = ({socket, roomId, userName, userId}) => {
    const [currentMessage, setCurrentMessage] = useState("");
    const [messageList, setMessageList] = useState([]);
    const scrollRef = useRef(null);

    const sendMessage = async (e) => {
        e.preventDefault();
        if(currentMessage.trim() === "") return;

        const messageData = {
            socket,
            roomId,
            userId,
            message : currentMessage,
        }

        await socket.emit("send_message",messageData);
        setCurrentMessage("");
        
    }

    useEffect(() => {
        if(!socket) return;

        const handleMessageReceive = (data) => {
            setMessageList((list) =>  [...list, data])
        }

        socket.on("receive_message", handleMessageReceive);

        return () => {
            socket.off("receive_message", handleMessageReceive);
        }
    },[socket])

    useEffect(() => {
        scrollRef.current?.scrollIntoView({behaviour: "smooth"})
    },[messageList])

    const formatTime = (isoString) => {
        return new Date(isoString).toLocaleTimeString([],{
            hour : "2-digit",
            minute: "2-digit"
        })
    }


    return (
        <div>

        </div>
    )

}

export default ChatBox;