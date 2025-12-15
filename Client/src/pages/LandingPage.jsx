import React from "react";
import {
  motion,
  useScroll,
  useSpring,
} from "framer-motion";
import Navbar from "../components/Navbar";
import {
  Play,
  CloudRain,
  Volume2,
  ArrowRight,
  CheckCircle2,
  Activity,
  Zap,
  Coffee,
  Globe,
} from "lucide-react";

//  Animated Audio Bars (Blue Theme)
import AudioBars from "../components/AudioBars.jsx";
//  3D Tilt Card
import TiltCard from "../components/TiltCard.jsx";

const LandingPage = () => {
  const { scrollYProgress } = useScroll();
  const scaleX = useSpring(scrollYProgress, {
    stiffness: 100,
    damping: 30,
    restDelta: 0.001,
  });

  // Animation Variants
  const fadeUp = {
    hidden: { opacity: 0, y: 30 },
    visible: {
      opacity: 1,
      y: 0,
      transition: { duration: 0.6, ease: "easeOut" },
    },
  };

  const staggerContainer = {
    visible: { transition: { staggerChildren: 0.1 } },
  };

  const drawPath = {
    hidden: { pathLength: 0, opacity: 0 },
    visible: {
      pathLength: 1,
      opacity: 1,
      transition: {
        pathLength: { delay: 0.2, type: "spring", duration: 1.5, bounce: 0 },
      },
    },
  };

  return (
    <div className="min-h-screen bg-[url('/web.jpg')] bg-cover bg-center bg-fixed text-[#1e293b] font-sans overflow-x-hidden selection:bg-blue-200 selection:text-blue-900 relative">
      <div className="absolute inset-0 bg-white/30 pointer-events-none z-0"></div>

      {/* Scroll Progress Bar */}
      <motion.div
        className="fixed top-0 left-0 right-0 h-1 bg-blue-600 origin-left z-[100]"
        style={{ scaleX }}
      />

      <Navbar />

      {/* Hero Section */}
      <motion.section
        initial="hidden"
        animate="visible"
        variants={staggerContainer}
        className="relative pt-32 pb-20 px-6 md:px-12 max-w-7xl mx-auto z-10"
      >
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-12 items-center">
          <div className="lg:col-span-7 space-y-8">
            <motion.div
              variants={fadeUp}
              className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-blue-50/80 backdrop-blur-sm border border-blue-100 text-blue-600 text-xs font-bold uppercase tracking-wider"
            >
              <Zap size={12} fill="currentColor" /> v2.0 is now live
            </motion.div>

            <motion.h1
              variants={fadeUp}
              className="font-serif text-5xl md:text-6xl leading-[1.1] text-slate-900"
            >
              Find clarity in a <br />
              <span className="italic text-blue-600">noisy world.</span>
            </motion.h1>

            <motion.p
              variants={fadeUp}
              className="text-lg text-slate-700 max-w-xl leading-relaxed"
            >
              A mindful productivity workspace designed to help you enter a
              state of deep work effortlessly. No distractions, just flow.
            </motion.p>

            <motion.div
              variants={fadeUp}
              className="flex flex-col sm:flex-row gap-4 pt-4"
            >
              <motion.button
                whileHover={{
                  y: -2,
                  boxShadow: "0 20px 25px -5px rgb(37 99 235 / 0.3)",
                }}
                whileTap={{ scale: 0.98 }}
                className="flex items-center justify-center gap-2 bg-blue-600 text-white px-8 py-4 rounded-xl font-medium shadow-lg shadow-blue-600/20 transition-all"
              >
                Start Focusing <ArrowRight size={18} />
              </motion.button>
              <motion.button
                whileHover={{ y: -2, backgroundColor: "#f8fafc" }}
                whileTap={{ scale: 0.98 }}
                className="flex items-center justify-center gap-2 bg-white/80 backdrop-blur-sm text-slate-700 border border-slate-200 px-8 py-4 rounded-xl font-medium transition-all"
              >
                <Play size={18} className="text-slate-400" /> Watch Demo
              </motion.button>
            </motion.div>
          </div>

          {/* Interactive 3D Hero Visual */}
          <motion.div
            variants={fadeUp}
            className="lg:col-span-5 perspective-1000"
          >
            <TiltCard>
              <div className="relative z-10 bg-white rounded-2xl shadow-2xl shadow-blue-900/10 overflow-hidden border border-slate-100 aspect-[4/5] transform transition-transform">
                <div className="p-6 border-b border-slate-100 flex justify-between items-center bg-slate-50/50">
                  <div className="flex gap-2">
                    <div className="w-3 h-3 rounded-full bg-red-400" />
                    <div className="w-3 h-3 rounded-full bg-amber-400" />
                    <div className="w-3 h-3 rounded-full bg-green-400" />
                  </div>
                  <div className="text-xs text-slate-400 font-mono">
                    SESSION: DEEP WORK
                  </div>
                </div>
                <div className="p-8 flex flex-col items-center justify-center h-full text-center space-y-6">
                  <div className="w-48 h-48 rounded-full border-4 border-blue-50 flex items-center justify-center relative">
                    <motion.svg
                      className="absolute inset-0 w-full h-full -rotate-90"
                      viewBox="0 0 100 100"
                    >
                      <motion.circle
                        initial={{ pathLength: 0 }}
                        animate={{ pathLength: 0.75 }}
                        transition={{ duration: 2, ease: "easeInOut" }}
                        cx="50"
                        cy="50"
                        r="46"
                        fill="none"
                        stroke="#2563eb"
                        strokeWidth="4"
                        strokeLinecap="round"
                      />
                    </motion.svg>
                    <span className="font-serif text-4xl text-slate-800">
                      24:59
                    </span>
                  </div>
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.5 }}
                  >
                    <h3 className="font-medium text-slate-700">
                      Soundscape Active
                    </h3>
                    <p className="text-sm text-slate-500 flex items-center justify-center gap-2 mt-1">
                      <CloudRain
                        size={14}
                        className="text-blue-400 animate-bounce"
                      />{" "}
                      Heavy Rain
                    </p>
                  </motion.div>
                </div>
              </div>
            </TiltCard>
          </motion.div>
        </div>
      </motion.section>

      {/* Bento Grid Features */}
      <section
        id="features"
        className="relative z-10 py-24 px-6 md:px-12 max-w-7xl mx-auto"
      >
        <div className="text-center mb-16">
          <h2 className="font-serif text-4xl text-slate-900 mb-4">
            Tools for the modern mind
          </h2>
          <p className="text-slate-800 max-w-2xl mx-auto font-medium">
            We stripped away the clutter to provide you with the essential tools
            needed to maintain focus.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <motion.div
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true, margin: "-100px" }}
            variants={fadeUp}
            whileHover={{ y: -5 }}
            className="md:col-span-2 bg-white/90 backdrop-blur-sm p-8 rounded-3xl shadow-sm border border-slate-100 hover:shadow-xl transition-all duration-300 relative overflow-hidden group"
          >
            <div className="relative z-10">
              <div className="w-12 h-12 bg-blue-100 rounded-xl flex items-center justify-center text-blue-600 mb-6">
                <Activity size={24} />
              </div>
              <h3 className="text-2xl font-serif mb-2">Real-time Analytics</h3>
              <p className="text-slate-500 max-w-md">
                Visualize your peak productivity times.
              </p>
            </div>
            {/* Animated Line Graph SVG */}
            <div className="absolute bottom-0 right-0 w-full h-32 opacity-20 group-hover:opacity-40 transition-opacity">
              <svg
                className="w-full h-full"
                viewBox="0 0 400 100"
                preserveAspectRatio="none"
              >
                <motion.path
                  d="M0,80 C50,80 50,20 100,20 C150,20 150,60 200,60 C250,60 250,10 300,10 C350,10 350,90 400,90"
                  fill="none"
                  stroke="#2563eb"
                  strokeWidth="3"
                  variants={drawPath}
                />
                <motion.path
                  d="M0,80 C50,80 50,20 100,20 C150,20 150,60 200,60 C250,60 250,10 300,10 C350,10 350,90 400,90 L400,100 L0,100 Z"
                  fill="url(#gradient)"
                  stroke="none"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 0.5 }}
                  transition={{ delay: 1, duration: 1 }}
                />
                <defs>
                  <linearGradient
                    id="gradient"
                    x1="0%"
                    y1="0%"
                    x2="0%"
                    y2="100%"
                  >
                    <stop offset="0%" stopColor="#2563eb" />
                    <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
                  </linearGradient>
                </defs>
              </svg>
            </div>
          </motion.div>

          {/* Card 2: Audio Visualization */}
          <motion.div
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true }}
            variants={fadeUp}
            whileHover={{ scale: 1.02 }}
            className="md:row-span-2 bg-gradient-to-b from-blue-600 to-indigo-700 p-8 rounded-3xl shadow-lg text-white flex flex-col justify-between relative overflow-hidden group"
          >
            <div className="relative z-20">
              <div className="w-12 h-12 bg-white/20 backdrop-blur-md rounded-xl flex items-center justify-center text-white mb-6">
                <Volume2 size={24} />
              </div>
              <div className="flex justify-between items-start">
                <h3 className="text-2xl font-serif mb-2">Spatial Audio</h3>
                <AudioBars />
              </div>
              <p className="text-blue-100 mt-2">
                Binaural beats engineered to lower brainwave frequency.
              </p>
            </div>

            <div className="space-y-3 mt-8 relative z-20">
              {["Pink Noise", "Library", "Deep Space", "Monastery"].map(
                (sound, idx) => (
                  <motion.div
                    key={sound}
                    initial={{ x: -20, opacity: 0 }}
                    whileInView={{ x: 0, opacity: 1 }}
                    transition={{ delay: 0.2 + idx * 0.1 }}
                    className="flex items-center justify-between p-3 bg-white/10 rounded-lg cursor-pointer hover:bg-white/20 transition-colors border border-white/5"
                  >
                    <span className="text-sm font-medium">{sound}</span>
                    <Play
                      size={12}
                      fill="currentColor"
                      className="opacity-0 group-hover:opacity-100 transition-opacity"
                    />
                  </motion.div>
                )
              )}
            </div>
            <div className="absolute -bottom-20 -left-20 w-64 h-64 bg-indigo-500 rounded-full blur-[80px] opacity-50 group-hover:opacity-100 transition-opacity duration-700" />
          </motion.div>

          {/* Card 3: Smart Breaks */}
          <motion.div
            variants={fadeUp}
            whileHover={{ y: -5 }}
            className="bg-white/90 backdrop-blur-sm p-8 rounded-3xl shadow-sm border border-slate-100 hover:shadow-xl transition-all group"
          >
            <div className="w-12 h-12 bg-orange-100 rounded-xl flex items-center justify-center text-orange-600 mb-6 group-hover:rotate-12 transition-transform duration-300">
              <Coffee size={24} />
            </div>
            <h3 className="text-xl font-serif mb-2">Smart Breaks</h3>
            <p className="text-slate-500 text-sm">
              Reminders that know when you're fatigued before you do.
            </p>
          </motion.div>

          {/* Card 4: Offline Mode */}
          <motion.div
            variants={fadeUp}
            whileHover={{ y: -5 }}
            className="bg-white/90 backdrop-blur-sm p-8 rounded-3xl shadow-sm border border-slate-100 hover:shadow-xl transition-all group"
          >
            <div className="w-12 h-12 bg-purple-100 rounded-xl flex items-center justify-center text-purple-600 mb-6 group-hover:scale-110 transition-transform duration-300">
              <Globe size={24} />
            </div>
            <h3 className="text-xl font-serif mb-2">Offline Mode</h3>
            <p className="text-slate-500 text-sm">
              Full functionality without the internet. No wifi, no distractions.
            </p>
          </motion.div>
        </div>
      </section>

      {/* Methodology Section */}
      <section
        id="methodology"
        className="relative z-10 py-24 bg-white/95 backdrop-blur-sm border-y border-slate-100"
      >
        <div className="max-w-4xl mx-auto px-6 md:px-12 text-center">
          <span className="text-blue-600 font-bold tracking-widest uppercase text-xs mb-4 block">
            The Philosophy
          </span>
          <h2 className="font-serif text-4xl md:text-5xl text-slate-900 mb-12">
            Why we built Focus Flow
          </h2>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-12 text-left">
            <div className="prose prose-lg text-slate-600">
              <p>
                In an age of constant connectivity, our attention span has
                become the most valuable currency. We found ourselves constantly
                switching contexts, checking emails, and losing hours to
                "shallow work."
              </p>
            </div>
            <div className="prose prose-lg text-slate-600">
              <p>
                Focus Flow isn't just a timer. It's a commitment to yourself. By
                combining{" "}
                <span className="text-blue-600 font-semibold">
                  Pomodoro techniques
                </span>{" "}
                with{" "}
                <span className="text-blue-600 font-semibold">
                  psycho-acoustic soundscapes
                </span>
                , we create a digital environment where your best work happens
                naturally.
              </p>
            </div>
          </div>

          <div className="mt-16 inline-flex flex-wrap justify-center items-center gap-4 md:gap-8 p-4 bg-blue-100/80 rounded-full border border-slate-100">
            <div className="px-6 py-2 bg-white rounded-full shadow-sm text-sm font-medium text-slate-900">
              Step 1: Set Intention
            </div>
            <ArrowRight size={16} className="text-slate-600" />
            <div className="px-6 py-2 bg-white rounded-full shadow-sm text-sm font-medium text-slate-900">
              Step 2: Choose Sound
            </div>
            <ArrowRight size={16} className="text-slate-600" />
            <div className="px-6 py-2 bg-white rounded-full shadow-sm text-sm font-medium text-slate-900">
              Step 3: Deep Work
            </div>
          </div>
        </div>
      </section>

      {/* Pricing Section */}
      <section
        id="pricing"
        className="relative z-10 py-24 px-6 md:px-12 max-w-7xl mx-auto"
      >
        <div className="grid grid-cols-1 md:grid-cols-2 gap-16 items-center">
          <div>
            <h2 className="font-serif text-4xl md:text-5xl text-slate-900 mb-6">
              Invest in your <br />
              attention span.
            </h2>
            <ul className="space-y-4 mb-8">
              {[
                "Unlimited Focus Sessions",
                "Full Sound Library (50+ sounds)",
                "Weekly Productivity Reports",
                "Cross-device Sync",
              ].map((item, i) => (
                <motion.li
                  key={item}
                  initial={{ opacity: 0, x: -20 }}
                  whileInView={{ opacity: 1, x: 0 }}
                  viewport={{ once: true }}
                  transition={{ delay: i * 0.1 }}
                  className="flex items-center gap-3 text-slate-700 font-medium"
                >
                  <CheckCircle2 size={20} className="text-blue-600" /> {item}
                </motion.li>
              ))}
            </ul>
          </div>

          <motion.div
            whileHover={{ scale: 1.02 }}
            className="bg-white/95 backdrop-blur-sm p-10 rounded-3xl shadow-xl border border-slate-100 relative overflow-hidden group"
          >
            {/* Shimmer Effect */}
            <div className="absolute inset-0 -translate-x-full group-hover:animate-[shimmer_1.5s_infinite] bg-gradient-to-r from-transparent via-white/50 to-transparent z-10 pointer-events-none" />
            <style>{`
                 @keyframes shimmer {
                   100% { transform: translateX(100%); }
                 }
               `}</style>

            <div className="absolute top-0 right-0 bg-blue-600 text-white text-xs font-bold px-3 py-1 rounded-bl-xl rounded-tr-2xl">
              MOST POPULAR
            </div>
            <h3 className="text-slate-500 font-medium uppercase tracking-wider text-sm mb-4">
              Pro Membership
            </h3>
            <div className="flex items-end gap-2 mb-6">
              <span className="text-5xl font-serif font-bold text-slate-900">
                $12
              </span>
              <span className="text-slate-500 mb-1">/ month</span>
            </div>
            <button className="w-full bg-slate-900 text-white py-4 rounded-xl font-medium hover:bg-blue-600 transition-colors shadow-lg shadow-slate-900/10 group-hover:shadow-blue-600/30">
              Start 14-Day Free Trial
            </button>
          </motion.div>
        </div>
      </section>

      {/* Footer */}
      <footer className="relative z-10 bg-[#1e293b] text-slate-400 py-20 px-6 md:px-12">
        <div className="max-w-7xl mx-auto flex flex-col items-center text-center">
          <span className="text-white text-2xl font-serif font-bold block mb-6">
            Focus Flow
          </span>
          <p className="max-w-md mb-8">
            Crafted with intent for those who seek depth.
          </p>
          <div className="text-xs border-t border-slate-800 pt-8 w-full">
            &copy; 2024 Focus Flow Inc.
          </div>
        </div>
      </footer>
    </div>
  );
};

export default LandingPage;
