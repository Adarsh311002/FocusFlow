import React,{useState,useEffect,useRef} from "react";

const PomodoroTimer = () => {

    const MODES ={
        pomodoro : {label : "pomodoro", time:25,},
        short : {label: "Short Break", time:5 },
        long: {label:"Long Break ", time:15}
    }

    const [mode,setMode] = useState("pomodoro");
    const [timeLeft, setTimeLeft] = useState(MODES.pomodoro.time * 60);
    const [isActive , setIsActive] = useState(false);
    const timerRef = useRef(null);

    const playSound = () => {
      const audio = new Audio(
        "https://actions.google.com/sounds/v1/alarms/beep_short.ogg"
      );
      audio.play();
    }

    const switchMode = (newMode) => {
        setMode(newMode);
        setTimeLeft(MODES[newMode].time * 60);
        setIsActive(false);
    }

    const formatTime = (seconds) => {
      const mins = Math.floor(seconds/ 60);
      const secs = seconds % 60;
      return `${mins < 10 ? '0' : ''}${mins}:${secs < 10 ? '0' : ''}${secs}`;
    }

    const toggleTimer = () => {
      setIsActive(!isActive);
    }

    

    useEffect(() => {
      if(isActive && timeLeft > 0){
        timerRef.current = setInterval(() => {
          setTimeLeft((prev) => prev-1);
        },1000);
      } else if(timeLeft === 0 ){
        clearInterval(timerRef.current);
        setIsActive(false);
        playSound();
      }

      return () => clearInterval(timerRef.current);

    },[isActive, timeLeft])

    
  return (
    <div className="bg-white w-[500px] h-[500px] ">
      <div className="flex justify-center gap-2 mb-10 ">
        {Object.keys(MODES).map((key) => (
          <button
            onClick={() => switchMode(key)}
            className={`
              px-4 py-1 rounded-full text-sm font-medium text-black transition-all
              ${
                mode === key
                  ? "bg-black text-white font-bold"
                  : "bg-transparent hover:bg-black/10"
              }
            `}
            key={key}
          >
            {MODES[key].label}
          </button>
        ))}
      </div>

      <div className="text-center mb-10">
        <div className="text-[7rem] leading-none font-bold text-white tabular-nums tracking-tight drop-shadow-sm">
          {formatTime(timeLeft)}
        </div>
      </div>
      
    </div>
  );
}

export default PomodoroTimer
