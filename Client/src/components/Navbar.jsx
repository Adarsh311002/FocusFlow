import React, { useRef } from "react";
import { motion, useMotionValue, useSpring, useTransform } from "framer-motion";
import {
  Home,
  LayoutGrid,
  Settings,
  User,
  LineChart,
  Bell,
  Zap,
} from "lucide-react";

const Navbar = () => {
  return (
    <div className="fixed top-8 left-0 right-0 flex justify-center z-50 pointer-events-none">
      <Dock className="pointer-events-auto" />
    </div>
  );
};

export default Navbar;

function Dock({ className }) {
  let mouseX = useMotionValue(Infinity);

  return (
    <motion.div
      onMouseMove={(e) => mouseX.set(e.pageX)}
      onMouseLeave={() => mouseX.set(Infinity)}
      className={`
        mx-auto flex h-16 items-start gap-4 rounded-2xl bg-blue/90 px-4 pt-3 
        backdrop-blur-2xl border border-green/40 shadow-2xl shadow-slate-500/20
        ${className}
      `}
    >
      {navItems.map((item) => (
        <DockIcon mouseX={mouseX} key={item.title} {...item} />
      ))}
    </motion.div>
  );
}

function DockIcon({ mouseX, title, icon: Icon, href }) {
  let ref = useRef(null);

  let distance = useTransform(mouseX, (val) => {
    let bounds = ref.current?.getBoundingClientRect() ?? { x: 0, width: 0 };
    return val - bounds.x - bounds.width / 2;
  });

  let widthSync = useTransform(distance, [-150, 0, 150], [40, 80, 40]);

  let width = useSpring(widthSync, { mass: 0.1, stiffness: 150, damping: 12 });

  return (
    <div className="group relative flex flex-col items-center">
      <span className="absolute top-14 hidden whitespace-nowrap rounded bg-blue-900 px-2 py-1 text-xs text-white opacity-0 transition-all group-hover:block group-hover:opacity-100 z-50">
        {title}
      </span>

      <motion.a
        ref={ref}
        href={href}
        style={{ width }}
        className="aspect-square flex items-center justify-center rounded-full bg-blue-200/50 hover:bg-blue-100 border border-transparent hover:border-blue-200 transition-colors text-slate-600 hover:text-blue-600 shadow-inner shadow-white/50"
      >
        <Icon className="h-5 w-5 sm:h-2/5 sm:w-2/5" />
      </motion.a>
      <div className="absolute -bottom-1 h-1 w-1 rounded-full bg-slate-400 group-hover:bg-blue-500 opacity-0 group-hover:opacity-100 transition-opacity" />
    </div>
  );
}

const navItems = [
  { title: "Home", icon: Home, href: "#" },
  { title: "Dashboard", icon: LayoutGrid, href: "/dashboard" },
  { title: "Analytics", icon: LineChart, href: "#" },
  { title: "Alerts", icon: Bell, href: "#" },
  { title: "Features", icon: Zap, href: "#" },
  { title: "Settings", icon: Settings, href: "#" },
  { title: "Profile", icon: User, href: "#" },
];
