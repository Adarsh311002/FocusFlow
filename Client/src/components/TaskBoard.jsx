import React, { useState, useEffect } from "react";
import { Plus, Trash2, Check, Target, Loader2 } from "lucide-react";
import {
  getTask,
  createTask,
  updateTask,
  deleteTask,
} from "../utils/taskService"; 

const TaskBoard = () => {
  const [tasks, setTasks] = useState([]);
  const [newTaskTitle, setNewTaskTitle] = useState("");
  const [loading, setLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    loadTasks();
  }, []);

  const loadTasks = async () => {
    try {
      const data = await getTask();
      setTasks(data);
    } catch (error) {
      console.error("Failed to load tasks", error);
    } finally {
      setLoading(false);
    }
  };

  const handleAddTask = async (e) => {
    e.preventDefault();
    if (!newTaskTitle.trim()) return;

    setIsSubmitting(true);
    try {
      const newTask = await createTask({ title: newTaskTitle });
      setTasks([newTask, ...tasks]);
      setNewTaskTitle("");
    } catch (error) {
      console.error("Failed to add task", error);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSetActive = async (taskId) => {
    const updatedTasks = tasks.map((t) => ({
      ...t,
      isActive: t._id === taskId, 
    }));
    setTasks(updatedTasks);

    try {
      await updateTask(taskId, { isActive: true });
    } catch (error) {
      console.error("Failed to set active", error);
      loadTasks(); 
    }
  };

  const handleToggleComplete = async (task) => {
    const updatedTasks = tasks.map((t) =>
      t._id === task._id ? { ...t, isCompleted: !t.isCompleted } : t
    );
    setTasks(updatedTasks);

    try {
      await updateTask(task._id, { isCompleted: !task.isCompleted });
    } catch (error) {
      console.error("Failed to toggle complete", error);
      loadTasks();
    }
  };

  const handleDelete = async (taskId) => {
    setTasks(tasks.filter((t) => t._id !== taskId));

    try {
      await deleteTask(taskId);
    } catch (error) {
      console.error("Failed to delete", error);
      loadTasks();
    }
  };

  if (loading)
    return (
      <div className="h-full flex items-center justify-center text-slate-400">
        <Loader2 className="animate-spin" />
      </div>
    );

  return (
    <div className="flex flex-col h-full bg-white/60 backdrop-blur-xl rounded-[2rem] border border-white/60 p-6 shadow-sm overflow-hidden">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-serif text-xl text-slate-800">Objectives</h3>
        <span className="text-xs font-bold bg-blue-50 text-blue-600 px-3 py-1 rounded-full">
          {tasks.filter((t) => !t.isCompleted).length} Pending
        </span>
      </div>

      <form onSubmit={handleAddTask} className="relative mb-6">
        <input
          type="text"
          placeholder="What is your focus?"
          value={newTaskTitle}
          onChange={(e) => setNewTaskTitle(e.target.value)}
          className="w-full pl-4 pr-12 py-3 bg-white/50 border-2 border-transparent focus:border-blue-200 rounded-xl outline-none transition-all placeholder:text-slate-400 text-slate-700 font-medium"
        />
        <button
          type="submit"
          disabled={isSubmitting || !newTaskTitle}
          className="absolute right-2 top-2 p-1.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
        >
          <Plus size={18} />
        </button>
      </form>

      <div className="flex-1 overflow-y-auto pr-2 space-y-3 custom-scrollbar">
        {tasks.length === 0 ? (
          <div className="text-center text-slate-400 mt-10 text-sm italic">
            No active tasks. Add one to start focusing.
          </div>
        ) : (
          tasks.map((task) => (
            <div
              key={task._id}
              className={`
                group flex items-center gap-3 p-3 rounded-xl border transition-all duration-200
                ${
                  task.isActive
                    ? "bg-blue-50/80 border-blue-200 shadow-sm"
                    : "bg-white/40 border-transparent hover:bg-white/80 hover:shadow-sm"
                }
                ${task.isCompleted ? "opacity-60" : "opacity-100"}
              `}
            >

              <button
                onClick={() => handleSetActive(task._id)}
                className={`
                  flex-shrink-0 w-5 h-5 rounded-full border-2 flex items-center justify-center transition-all
                  ${
                    task.isActive
                      ? "border-blue-500"
                      : "border-slate-300 group-hover:border-blue-300"
                  }
                `}
                title="Set as Main Focus"
              >
                {task.isActive && (
                  <div className="w-2.5 h-2.5 rounded-full bg-blue-500" />
                )}
              </button>

              <div className="flex-1 min-w-0">
                <p
                  className={`text-sm font-medium truncate ${
                    task.isCompleted
                      ? "line-through text-slate-400"
                      : "text-slate-700"
                  }`}
                  onClick={() => handleToggleComplete(task)} 
                >
                  {task.title}
                </p>
              </div>

              <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                <button
                  onClick={() => handleToggleComplete(task)}
                  className={`p-1.5 rounded-lg transition-colors ${
                    task.isCompleted
                      ? "text-green-600 bg-green-50"
                      : "text-slate-400 hover:bg-slate-100"
                  }`}
                >
                  <Check size={14} />
                </button>

                <button
                  onClick={() => handleDelete(task._id)}
                  className="p-1.5 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
};

export default TaskBoard;
