import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { ToastProvider } from "./toast";
import "./styles.css";
/* PROTOTYPE (branch prototype/dark-palette-v2) — dark-palette switcher.
   Remove this import and the render below when the palette is settled. */
import { PrototypePaletteSwitcher } from "./prototype-palette-switcher";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ToastProvider>
      <App />
      {import.meta.env.DEV && <PrototypePaletteSwitcher />}
    </ToastProvider>
  </React.StrictMode>
);
