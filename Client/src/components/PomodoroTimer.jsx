import React, { useState, useEffect, useRef } from "react";
import { Settings, X, RotateCcw, Newspaper } from "lucide-react";
import logCompletedSession from "../utils/sessionService.js";
import {useAuth} from "../context/AuthContext.jsx";
import api from "../utils/api.js";
import { useSocket } from "../context/SocketContext.jsx";
import { useParams } from "react-router-dom";




const PomodoroTimer = ({
  isGroupMode = false,
  isHost = false,
  roomId = null,
}) => {
  const [customTimes, setCustomTimes] = useState({
    pomodoro: 25,
    short: 5,
    long: 15,
  });

  const { user } = useAuth();

  const [mode, setMode] = useState("pomodoro");
  const [timeLeft, setTimeLeft] = useState(customTimes.pomodoro * 60);
  const [isActive, setIsActive] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  const intervalRef = useRef(null);

  const getThemeColor = () => {
    switch (mode) {
      case "pomodoro":
        return "bg-[#ba4949]";
      case "short":
        return "bg-[#38858a]";
      case "long":
        return "bg-[#397097]";
      default:
        return "bg-[#ba4949]";
    }
  };



  useEffect(() => {
    if (isActive && timeLeft > 0) {
      intervalRef.current = setInterval(() => {
        setTimeLeft((prev) => {
          const newVal = prev - 1;

          if (isGroupMode && isHost && socket && newVal % 5 === 0) {
            socket.emit("timer_update", {
              roomId,
              timerState: { timeLeft: newVal, isActive: true, mode },
            });
          }
          return newVal;
        });
      }, 1000);
    }
    else if (isActive && timeLeft === 0) {
     setIsActive(false);

      const audio = new Audio(
        "https://actions.google.com/sounds/v1/alarms/beep_short.ogg"
      );
      audio.play().catch((e) => console.log("Audio play failed", e));

      if (user && mode === "pomodoro") {
        const durationInMinutes = customTimes[mode];
        handleSaveSession(durationInMinutes, mode);
      }

      let nextMode = "pomodoro";
      if (mode === "pomodoro") {
        nextMode = "short";
      } else {
        nextMode = "pomodoro";
      }

      setMode(nextMode);
      setTimeLeft(customTimes[nextMode] * 60);

      if(isGroupMode && isHost && socket ){
        socket.emit("timer_update", {
          roomId,
          timerState : {
            timeLeft: customTimes[nextMode] * 60 ,
            isActive: false,
            mode: nextMode
          }
        })
      }
    }

    return () => clearInterval(intervalRef.current);
 
  }, [isActive, timeLeft, mode, user, customTimes, isGroupMode, isHost, roomId, socket]);

  useEffect(() => {
      if(!isGroupMode || !socket) return;

      const handleTimerUpdate = (newState) => {
        if(!isHost){
          console.log("⏰ Syncing from Host:", newState);
          setTimeLeft(newState.timeLeft);
          setIsActive(newState.isActive);
          setMode(newState.mode);
        }
      }
      socket.on("receive_timer_update", handleTimerUpdate);

      return () => {
        socket.off("receive_timer_update",handleTimerUpdate)
      }
  },[socket, isGroupMode, isHost])

  useEffect(() => {
    if(!isHost || !socket || !isGroupMode) return;

    const handleNewUSer = ({userName}) => {
      console.log(`New user ${userName} joined. Sending Current state...`);

      socket.emit("timer_update",{
        roomId,
        timerState : {
          timeLeft: timeLeft,
          isActive: isActive,
          mode: mode
        }
      });
    }

    socket.on("user_joined", handleNewUSer);

    return () => {
      socket.off("user_joined", handleNewUSer);
    }
  }, [
    socket,
    isHost,
    isGroupMode,
    roomId,
    timeLeft,
    isActive,
    mode,
  ]);

  const switchMode = (newMode) => {
    if (isGroupMode && !isHost) return;

    setMode(newMode);
    setTimeLeft(customTimes[newMode] * 60);
    setIsActive(false);

    if(isGroupMode && isHost && socket ){
      socket.emit("timer_update",{
        roomId,
        timerState: {
          timeLeft: customTimes[newMode] * 60, isActive: false, mode:newMode
        } 
      })
    }
  };

 

  const formatTime = (seconds) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins < 10 ? "0" : ""}${mins}:${secs < 10 ? "0" : ""}${secs}`;
  };

  const toggleTimer = () => {

    if(isGroupMode && !isHost) return;

    if (timeLeft === 0) {
      setTimeLeft(customTimes[mode] * 60);
      setIsActive(true);

      if (isGroupMode && isHost && socket) {
        socket.emit("timer_update", {
          roomId,
          timerState: { timeLeft: newTime, isActive: true, mode },
        });
      }
    } else {
      const newState = !isActive;
      setIsActive(newState);

      if (isGroupMode && isHost && socket) {
        socket.emit("timer_update", {
          roomId,
          timerState: { timeLeft, isActive: newState, mode },
        });
      }
    }
  };

  const handleTimeChange = (e) => {
    const { name, value } = e.target;
    const intValue = parseInt(value);
    if (value !== "" && (isNaN(intValue) || intValue > 100)) {
      return;
    }
    setCustomTimes((prev) => ({
      ...prev,
      [name]: parseInt(value) || 0,
    }));
  };

  const saveSettings = () => {
    setShowSettings(false);
    if (!isActive) {
      setTimeLeft(customTimes[mode] * 60);
    }
  };

  return (
    <div
      className={`relative w-full max-w-lg mx-auto rounded-3xl p-8 transition-colors duration-500 ease-in-out shadow-xl ${getThemeColor()}`}
    >
      <div className="flex justify-between items-center mb-12">
        <div className="flex gap-2">
          {["pomodoro", "short", "long"].map((key) => (
            <button
              key={key}
              onClick={() => switchMode(key)}
              className={`
                px-4 py-1 rounded-full text-sm font-medium text-white transition-all capitalize
                ${
                  mode === key
                    ? "bg-black/20 font-bold"
                    : "bg-transparent hover:bg-black/10"
                }
              `}
            >
              {key === "short"
                ? "Short Break"
                : key === "long"
                ? "Long Break"
                : key}
            </button>
          ))}
        </div>

        <button
          onClick={() => setShowSettings(true)}
          className="p-2 bg-white/10 rounded-lg text-white hover:bg-white/20 transition-all"
        >
          <Settings size={20} />
        </button>
      </div>

      <div className="text-center mb-12">
        <div className="text-[7.5rem] leading-none font-bold text-white tracking-tight drop-shadow-md">
          {formatTime(timeLeft)}
        </div>
      </div>

      <div className="flex justify-center h-24">
        <button
          onClick={toggleTimer}
          className={`
            uppercase font-bold text-2xl px-10 py-4 rounded-xl transition-all duration-100 w-48
            bg-white
            ${
              isActive
                ? "translate-y-[4px] shadow-none text-gray-400"
                : "shadow-[0_6px_0_rgb(235,235,235)] hover:scale-[1.02] text-[#ba4949]"
            }
          `}
          style={{
            color:
              mode === "pomodoro"
                ? "#ba4949"
                : mode === "short"
                ? "#38858a"
                : "#397097",
          }}
        >
          {isActive ? "STOP" : "START"}
        </button>
      </div>

      {showSettings && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/20 backdrop-blur-sm rounded-3xl">
          <div className="bg-white text-slate-700 w-11/12 p-6 rounded-2xl shadow-2xl animate-in fade-in zoom-in duration-200">
            <div className="flex justify-between items-center mb-6 border-b border-slate-100 pb-4">
              <h3 className="text-lg font-bold text-slate-500 uppercase tracking-widest">
                Settings
              </h3>
              <button
                onClick={() => setShowSettings(false)}
                className="text-slate-400 hover:text-slate-600"
              >
                <X size={24} />
              </button>
            </div>

            <div className="space-y-4 mb-6">
              <label className="block text-xs font-bold text-slate-400 uppercase">
                Timer (minutes)
              </label>
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <label className="text-xs text-slate-400 mb-1 block">
                    Pomodoro
                  </label>
                  <input
                    type="number"
                    name="pomodoro"
                    value={customTimes.pomodoro}
                    onChange={handleTimeChange}
                    className="w-full bg-slate-100 p-2 rounded-lg font-bold text-slate-700 focus:outline-none focus:ring-2 focus:ring-slate-300"
                  />
                </div>
                <div>
                  <label className="text-xs text-slate-400 mb-1 block">
                    Short Break
                  </label>
                  <input
                    type="number"
                    name="short"
                    value={customTimes.short}
                    onChange={handleTimeChange}
                    className="w-full bg-slate-100 p-2 rounded-lg font-bold text-slate-700 focus:outline-none focus:ring-2 focus:ring-slate-300"
                  />
                </div>
                <div>
                  <label className="text-xs text-slate-400 mb-1 block">
                    Long Break
                  </label>
                  <input
                    type="number"
                    name="long"
                    value={customTimes.long}
                    onChange={handleTimeChange}
                    className="w-full bg-slate-100 p-2 rounded-lg font-bold text-slate-700 focus:outline-none focus:ring-2 focus:ring-slate-300"
                  />
                </div>
              </div>
            </div>

            <button
              onClick={saveSettings}
              className="w-full bg-slate-800 text-white py-3 rounded-xl font-bold hover:bg-slate-900 transition-colors"
            >
              OK
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default PomodoroTimer;
