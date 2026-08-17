import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { DesktopTitleBar } from "./components/DesktopTitleBar";
import { initializeAppSettings } from "./settings";
import "./styles.css";
import "./visual-polish.css";
import "./interaction-settings.css";

initializeAppSettings();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <div className={window.__TAURI_INTERNALS__ ? "desktop-frame" : "web-frame"}>
      <DesktopTitleBar />
      <App />
    </div>
  </StrictMode>
);
