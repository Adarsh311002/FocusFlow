import React, { useState, useEffect, useRef } from "react";
import { Send, MessageSquare } from "lucide-react";

const ChatBox = ({socket, roomId, userName, userId}) => {
    const [currentMessage, setCurrentMessage] = useState("");
    const [messageList, setMessageList] = useState([]);
    const scrollRef = useRef(null);

    const sendMessage = async (e) => {
        e.preventDefault();
        if(currentMessage.trim() === "") return;

        console.log("Debug Payload:", { roomId, userName, userId });

        const messageData = {
          roomId: String(roomId), 
          userName: String(userName), 
          userId: String(userId), 
          message: currentMessage,
          time: new Date().toISOString(),
          type: "user",
        };

       try {
         await socket.emit("send_message", messageData);
         setCurrentMessage("");
       } catch (error) {
         console.error("Failed to send message:", error);
       }
        
    }

    useEffect(() => {
        if(!socket) return;

        const handleMessageReceive = (data) => {
            setMessageList((list) =>  [...list, data])
        }

        const handleSystemEvent = (data, type) => {
            const systemMsg = {
                type : "system",
                message: type === "join" ? `${data.userName} joined the room ` : `${data.userName} left the room`,
                time : new Date().toISOString()
            }

            setMessageList((list) => [...list,systemMsg]);
        }

        socket.on("receive_message", handleMessageReceive);
        socket.on("user_joined", (data) => handleSystemEvent(data,"join"));
        socket.on("user_left",(data) => handleSystemEvent(data, "leave"));

        return () => {
            socket.off("receive_message", handleMessageReceive);
            socket.off("user_joined");
            socket.off("user_left");
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
      <div className="bg-gray-800 rounded-xl border border-gray-700 h-1/2 flex flex-col overflow-hidden">
        <div className="p-4 border-b border-gray-700 flex items-center gap-2 bg-gray-800/50 backdrop-blur-sm">
          <MessageSquare size={18} className="text-indigo-400" />
          <h3 className="font-semibold text-sm uppercase tracking-wider text-gray-300">
            Group Chat
          </h3>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-3 custom-scrollbar">
          {messageList.length === 0 && (
            <div className="text-center text-gray-500 text-xs italic mt-4">
              Start the conversation...
            </div>
          )}

          {messageList.map((msg, index) => {
            if (msg.type === "system") {
              return (
                <div key={index} className="flex justify-center my-2">
                  <span className="text-[10px] text-gray-500 bg-gray-700/30 px-2 py-1 rounded-full uppercase tracking-wider font-bold">
                    {msg.message}
                  </span>
                </div>
              );
            }

            const isMe = msg.userId === userId;
            return (
              <div
                key={index}
                className={`flex flex-col ${
                  isMe ? "items-end" : "items-start"
                }`}
              >
                <div className="flex items-end gap-2 max-w-[85%]">
                  {!isMe && (
                    <div className="w-6 h-6 rounded-full bg-indigo-600 flex items-center justify-center text-[10px] font-bold uppercase shrink-0 text-white">
                      {msg.userName[0]}
                    </div>
                  )}
                  <div
                    className={`px-3 py-2 rounded-2xl text-sm ${
                      isMe
                        ? "bg-indigo-600 text-white rounded-br-none"
                        : "bg-gray-700 text-gray-200 rounded-bl-none"
                    }`}
                  >
                    <p>{msg.message}</p>
                  </div>
                </div>
                <div
                  className={`text-[10px] text-gray-500 mt-1 flex gap-1 ${
                    isMe ? "mr-1" : "ml-9"
                  }`}
                >
                  <span>{isMe ? "You" : msg.userName}</span>•
                  <span>{formatTime(msg.time)}</span>
                </div>
              </div>
            );
          })}
          <div ref={scrollRef} />
        </div>

        <form
          onSubmit={sendMessage}
          className="p-3 bg-gray-900 border-t border-gray-700 flex gap-2"
        >
          <input
            type="text"
            value={currentMessage}
            onChange={(e) => setCurrentMessage(e.target.value)}
            placeholder="Type a message..."
            className="flex-1 bg-gray-800 text-white text-sm rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500 border border-gray-700 placeholder-gray-500"
          />
          <button
            type="submit"
            className="bg-indigo-600 hover:bg-indigo-700 text-white p-2 rounded-lg transition-colors flex items-center justify-center"
          >
            <Send size={18} />
          </button>
        </form>
      </div>
    );

}

export default ChatBox;