import React from "react";
import { motion } from "framer-motion";

const AudioBars = () => {
  return (
    <div className="flex items-end justify-center gap-1 h-8">
      {[...Array(6)].map((_, i) => (
        <motion.div
          key={i}
          className="w-1.5 bg-white/80 rounded-t-sm"
          animate={{
            height: [
              `${Math.random() * 40 + 20}%`,
              `${Math.random() * 90 + 10}%`,
              `${Math.random() * 40 + 20}%`,
            ],
          }}
          transition={{
            duration: 0.8,
            repeat: Infinity,
            repeatType: "mirror",
            delay: i * 0.1,
            ease: "easeInOut",
          }}
        />
      ))}
    </div>
  );
};

export default AudioBars;
