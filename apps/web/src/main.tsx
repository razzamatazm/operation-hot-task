import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { ToastProvider } from "./toast";
/* PROTOTYPE — throwaway, branch prototype/instructions-edit-gesture. Renders
   nothing in a production build. Delete with the prototype. */
import { PrototypeSwitcher } from "./instructions-gesture-prototype";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ToastProvider>
      <App />
      <PrototypeSwitcher />
    </ToastProvider>
  </React.StrictMode>
);
