import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { MobileBackendGate } from "./components/MobileBackendGate";
import { DesktopTitleBar } from "./components/DesktopTitleBar";
import { SyncRuntime } from "./components/SyncRuntime";
import { initializeAppSettings } from "./settings";
import "./styles.css";
import "./visual-polish.css";
import "./interaction-settings.css";
import "./account-sync.css";
import "./mobile.css";

initializeAppSettings();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <div className={window.__TAURI_INTERNALS__ ? "desktop-frame" : "web-frame"}>
      <DesktopTitleBar />
      <MobileBackendGate>
        <SyncRuntime />
        <App />
      </MobileBackendGate>
    </div>
  </StrictMode>
);
