import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.openspace.mailcollector",
  appName: "Mail Collector",
  webDir: "public",
  bundledWebRuntime: false,
  server: {
    androidScheme: "https"
  }
};

export default config;
